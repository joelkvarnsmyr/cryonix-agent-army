# Apex A/B Validator — Design Spec

## Overview

Head-to-head comparison of Grok vs Claude for trade validation in Apex. Every confluence opportunity is sent to BOTH validators. Grok's answer controls trades (status quo). Claude's answer is logged in shadow mode. After sufficient data, compare accuracy to determine which validator makes better decisions.

## Architecture

```
Opportunity (score >= threshold)
  ├── validateWithGrok()   → approve/reject → CONTROLS trade execution
  └── validateWithClaude() → approve/reject → SHADOW LOG only

Both results → apex_validations (Postgres)
  Fields: symbol, direction, score, mode,
          grok_approve, grok_confidence, grok_reason,
          claude_approve, claude_confidence, claude_reason,
          trade_executed (bool), actual_pnl (filled on exit),
          validated_at
```

## Components

### 1. `validateWithClaude()` method

New async method in `apex-agent.ts`. Mirrors `validateWithGrok()` but calls Claude Code CLI via child process.

**Invocation:**
```typescript
const child = execFile('claude', ['-p', '--model', model], {
    timeout: 60_000,
    cwd: process.cwd(),
    maxBuffer: 2 * 1024 * 1024,
});
child.stdin.write(prompt);
child.stdin.end();
```

**Key behaviors:**
- Runs async (non-blocking) — does NOT delay Grok validation or trade execution
- Same prompt as Grok (fair comparison)
- Parses JSON response: `{"approve": bool, "confidence": 0-100, "reason": "..."}`
- Fail-silent: errors are logged but never affect trades
- No caching (we want every opportunity evaluated fresh for comparison)
- No rate limiting (Claude CLI handles this internally)

**Prompt (identical to Grok):**
```
You are a crypto trade validator. APEX detected confluence for {SYMBOL} ({DIRECTION}).
Each signal below is from a DIFFERENT source (already deduplicated — no duplicates):
{SIGNALS}
Unique sources: {N}
Confluence score: {SCORE}/100

Should we enter this trade? Consider: macro environment, technical setup,
risk/reward. Approve if the setup has positive expected value.
Reply JSON: {"approve": true/false, "confidence": 0-100, "reason": "..."}
```

### 2. `apex_validations` Postgres table

```sql
CREATE TABLE IF NOT EXISTS apex_validations (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    score DECIMAL(5,2),
    mode VARCHAR(20),
    contributing_signals JSONB,

    -- Grok result
    grok_approve BOOLEAN,
    grok_confidence DECIMAL(5,2),
    grok_reason TEXT,

    -- Claude result
    claude_approve BOOLEAN,
    claude_confidence DECIMAL(5,2),
    claude_reason TEXT,
    claude_model VARCHAR(50),

    -- Outcome
    trade_executed BOOLEAN DEFAULT FALSE,
    position_id VARCHAR(64),
    actual_pnl DECIMAL(20,8),
    actual_pnl_pct DECIMAL(10,4),

    validated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_validations_symbol ON apex_validations(symbol);
CREATE INDEX IF NOT EXISTS idx_apex_validations_date ON apex_validations(validated_at);
```

**PnL tracking:** When a position closes in `monitorPositions()`, update `apex_validations` with `actual_pnl` by matching `position_id`.

### 3. Execution flow in `tick()`

```
for each opportunity:
  1. validateWithGrok()        → grokResult (sync, blocking)
  2. validateWithClaude()      → fire-and-forget (async, non-blocking)
  3. if grokResult.approve:
       execute trade
       trade_executed = true
  4. await claudeResult (with 60s timeout)
  5. INSERT INTO apex_validations (both results + trade_executed)
```

Claude validation runs concurrently with trade execution. If Claude times out, log `claude_approve = null`.

### 4. Config in `apex.toml`

```toml
[ab_test]
enabled = true
claude_model = "claude-sonnet-4-6"
shadow_mode = true                    # true = Claude logs only, false = Claude controls trades
```

When `shadow_mode = false`, Claude replaces Grok entirely (future switch after data proves Claude is better).

### 5. Comparison query

```sql
-- Agreement rate
SELECT
    COUNT(*) as total,
    SUM(CASE WHEN grok_approve = claude_approve THEN 1 ELSE 0 END) as agree,
    ROUND(100.0 * SUM(CASE WHEN grok_approve = claude_approve THEN 1 ELSE 0 END) / COUNT(*), 1) as agree_pct
FROM apex_validations
WHERE claude_approve IS NOT NULL;

-- Accuracy comparison (for executed trades with PnL)
SELECT
    'grok' as validator,
    COUNT(*) as trades,
    SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(100.0 * SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as win_rate
FROM apex_validations
WHERE trade_executed = true AND actual_pnl IS NOT NULL
UNION ALL
SELECT
    'claude_would_have' as validator,
    SUM(CASE WHEN claude_approve THEN 1 ELSE 0 END) as trades,
    SUM(CASE WHEN claude_approve AND actual_pnl > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(100.0 * SUM(CASE WHEN claude_approve AND actual_pnl > 0 THEN 1 ELSE 0 END) /
        NULLIF(SUM(CASE WHEN claude_approve THEN 1 ELSE 0 END), 0), 1) as win_rate
FROM apex_validations
WHERE actual_pnl IS NOT NULL;

-- Missed profits (Claude approved but Grok rejected)
SELECT symbol, direction, score, claude_confidence, claude_reason, validated_at
FROM apex_validations
WHERE claude_approve = true AND grok_approve = false
ORDER BY validated_at DESC LIMIT 20;

-- Avoided losses (Claude rejected but Grok approved)
SELECT symbol, direction, score, actual_pnl, claude_reason, validated_at
FROM apex_validations
WHERE claude_approve = false AND grok_approve = true AND actual_pnl < 0
ORDER BY validated_at DESC LIMIT 20;
```

## Docker changes

Apex Dockerfile needs Claude Code CLI installed:
```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

Apex container needs Claude auth volume mount:
```yaml
volumes:
  - ~/.claude:/root/.claude:ro
```

## Constraints

- Claude validation must NEVER block or delay Grok validation or trade execution
- Claude timeout: 60 seconds (vs Grok ~2-5s)
- If Claude CLI is not installed or fails, the feature degrades silently
- No additional API keys needed (Claude CLI uses account auth from volume mount)
- Table creation is idempotent (CREATE IF NOT EXISTS)

## Success criteria

After 50+ validated opportunities:
1. Agreement rate between Grok and Claude
2. If Claude would have had higher win rate on executed trades
3. If Claude would have caught losses that Grok approved
4. If Claude would have approved profitable trades that Grok rejected
