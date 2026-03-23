# Apex A/B Validator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shadow Claude CLI validation alongside existing Grok validation in Apex, logging both results to Postgres for head-to-head accuracy comparison.

**Architecture:** Every confluence opportunity is sent to both Grok (blocking, controls trades) and Claude CLI (async, shadow-logged). Results are stored in `apex_validations` table. Claude never blocks the tick loop — its result is backfilled asynchronously via `.then()`.

**Tech Stack:** TypeScript (apex-agent.ts), Claude Code CLI (`spawn`), Postgres, TOML config, Docker

**Spec:** `docs/superpowers/specs/2026-03-23-apex-ab-validator-design.md`

---

## File Map

```
MODIFY packages/agents/src/apex/config.ts              # Add [ab_test] config type + defaults
MODIFY packages/agents/src/apex/apex-agent.ts           # Add validateWithClaude(), update evaluateAndExecute(), update monitorPositions()
MODIFY apex.toml                                        # Add [ab_test] section
MODIFY Dockerfile.apex                                  # Install claude-code CLI before USER node
MODIFY docker-compose.prod.yml                          # Add .claude volume mount to apex service
```

---

### Task 1: Add A/B Test Config

**Files:**
- Modify: `packages/agents/src/apex/config.ts`
- Modify: `apex.toml`

- [ ] **Step 1: Add AbTestConfig type and defaults in config.ts**

In `packages/agents/src/apex/config.ts`, add the `AbTestConfig` interface and merge it into `ApexConfig`. Find the existing config interfaces (near top of file) and add:

```typescript
export interface AbTestConfig {
    enabled: boolean;
    claude_model: string;
    shadow_mode: boolean;
}
```

Find the `ApexConfig` interface and add the field:

```typescript
ab_test: AbTestConfig;
```

Find the defaults object (where other sections like `grok`, `telegram` etc. have defaults) and add:

```typescript
ab_test: {
    enabled: true,
    claude_model: 'claude-sonnet-4-6',
    shadow_mode: true,
},
```

In `loadApexConfig()` (around line 158), add the merge line alongside the existing ones:

```typescript
grok: { ...APEX_DEFAULTS.grok, ...parsed.grok },
telegram: { ...APEX_DEFAULTS.telegram, ...parsed.telegram },
ab_test: { ...APEX_DEFAULTS.ab_test, ...parsed.ab_test },  // NEW
```

- [ ] **Step 2: Add [ab_test] section to apex.toml**

Append after the `[telegram]` section:

```toml
[ab_test]
enabled = true
claude_model = "claude-sonnet-4-6"
shadow_mode = true                    # true = Claude logs only, false = Claude controls trades
```

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/apex/config.ts apex.toml
git commit -m "feat(apex): add A/B test config for Claude shadow validation"
```

---

### Task 2: Create `apex_validations` Table

**Files:**
- Modify: `packages/agents/src/apex/apex-agent.ts:96-131` (inside `initialize()`, after `apex_trades` table creation)

- [ ] **Step 1: Add table creation SQL in initialize()**

Find the existing `CREATE TABLE IF NOT EXISTS apex_trades` block in `initialize()` (around line 96-131). After that block, add a second table creation:

```typescript
await this.pg.query(`
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
        grok_model VARCHAR(100),

        -- Claude result
        claude_approve BOOLEAN,
        claude_confidence DECIMAL(5,2),
        claude_reason TEXT,
        claude_model VARCHAR(100),

        -- Outcome
        trade_executed BOOLEAN DEFAULT FALSE,
        position_id VARCHAR(64),
        actual_pnl DECIMAL(20,8),
        actual_pnl_pct DECIMAL(10,4),

        validated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_apex_validations_symbol ON apex_validations(symbol);
    CREATE INDEX IF NOT EXISTS idx_apex_validations_date ON apex_validations(validated_at);
    CREATE INDEX IF NOT EXISTS idx_apex_validations_position ON apex_validations(position_id);
`);
```

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/apex/apex-agent.ts
git commit -m "feat(apex): create apex_validations table for A/B comparison"
```

---

### Task 3: Add `validateWithClaude()` Method

**Files:**
- Modify: `packages/agents/src/apex/apex-agent.ts` (add new method + import + semaphore)

- [ ] **Step 1: Add import for `spawn` at top of file**

Find the existing imports at top of `apex-agent.ts` and add:

```typescript
import { spawn } from 'child_process';
```

- [ ] **Step 2: Add semaphore property to the class**

Find the class properties section (near `private grokCache`, `private grokCallTimestamps` etc.) and add:

```typescript
private claudeValidationRunning = false;
```

- [ ] **Step 3: Add validateWithClaude() method**

Add this method after `validateWithGrok()` (around line 495):

```typescript
private async validateWithClaude(
    opp: ScoredOpportunity,
): Promise<{ approve: boolean; confidence: number; reason: string } | null> {
    if (!this.config.ab_test.enabled) return null;

    // Semaphore: max 1 concurrent Claude validation
    if (this.claudeValidationRunning) {
        console.log('[APEX/ab] Claude validation already running, skipping');
        return null;
    }
    this.claudeValidationRunning = true;

    try {
        const model = this.config.ab_test.claude_model;
        const signalList = opp.contributingSignals
            .map((s, i) => `${i + 1}. [${s.source}] ${s.signalType} — confidence ${s.confidence}%`)
            .join('\n');

        const prompt = [
            `You are a crypto trade validator. APEX detected confluence for ${opp.symbol} (${opp.direction}).`,
            `Each signal below is from a DIFFERENT source (already deduplicated — no duplicates):`,
            signalList,
            `Unique sources: ${new Set(opp.contributingSignals.map(s => s.source)).size}`,
            `Confluence score: ${opp.score}/100`,
            ``,
            `Should we enter this trade? Consider: macro environment, technical setup,`,
            `risk/reward. Approve if the setup has positive expected value.`,
            `Reply JSON only: {"approve": true/false, "confidence": 0-100, "reason": "..."}`,
        ].join('\n');

        const child = spawn('claude', ['-p', '--model', model, '--output-format', 'text'], {
            cwd: process.cwd(),
            stdio: ['pipe', 'pipe', 'inherit'],
            env: { ...process.env },
        });

        child.stdin.write(prompt);
        child.stdin.end();

        const chunks: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

        const timeoutHandle = setTimeout(() => child.kill('SIGTERM'), 120_000);

        const exitCode = await new Promise<number>((resolve) => {
            child.on('close', (code) => {
                clearTimeout(timeoutHandle);
                resolve(code ?? 1);
            });
        });

        const output = Buffer.concat(chunks).toString('utf-8');

        if (exitCode !== 0) {
            console.warn(`[APEX/ab] Claude CLI exited with code ${exitCode}`);
            return null;
        }

        // Parse JSON from response (same greedy regex as Grok's validateWithGrok)
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('[APEX/ab] Claude response not parseable as JSON');
            return null;
        }

        const parsed = JSON.parse(jsonMatch[0]);
        return {
            approve: parsed.approve === true,
            confidence: Number(parsed.confidence) || 0,
            reason: String(parsed.reason || ''),
        };
    } catch (err) {
        console.warn('[APEX/ab] Claude validation error:', err instanceof Error ? err.message : err);
        return null;
    } finally {
        this.claudeValidationRunning = false;
    }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/apex/apex-agent.ts
git commit -m "feat(apex): add validateWithClaude() with spawn, semaphore, 120s timeout"
```

---

### Task 4: Wire A/B Validation into `evaluateAndExecute()`

**Files:**
- Modify: `packages/agents/src/apex/apex-agent.ts:329-420` (inside `evaluateAndExecute()`)

- [ ] **Step 1: Add a private helper to insert validation rows**

Add this helper method to the class (after `validateWithClaude()`):

```typescript
private async insertValidation(
    opp: ScoredOpportunity,
    grokResult: { approve: boolean; confidence: number; reason: string } | null,
    tradeExecuted: boolean,
    positionId: string | null,
): Promise<number | null> {
    if (!this.pg) return null;
    try {
        const res = await this.pg.query(
            `INSERT INTO apex_validations
             (symbol, direction, score, mode, contributing_signals,
              grok_approve, grok_confidence, grok_reason, grok_model,
              trade_executed, position_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING id`,
            [
                opp.symbol, opp.direction, opp.score, opp.mode,
                JSON.stringify(opp.contributingSignals),
                grokResult?.approve ?? null,
                grokResult?.confidence ?? null,
                grokResult?.reason ?? null,
                this.config.grok.enabled ? this.config.grok.model : null,
                tradeExecuted,
                positionId,
            ],
        );
        return res.rows[0]?.id ?? null;
    } catch (err) {
        console.warn('[APEX/ab] Validation insert failed:', err instanceof Error ? err.message : err);
        return null;
    }
}

private async updateClaudeResult(
    validationId: number,
    result: { approve: boolean; confidence: number; reason: string },
): Promise<void> {
    if (!this.pg) return;
    try {
        await this.pg.query(
            `UPDATE apex_validations
             SET claude_approve = $1, claude_confidence = $2, claude_reason = $3, claude_model = $4
             WHERE id = $5`,
            [result.approve, result.confidence, result.reason, this.config.ab_test.claude_model, validationId],
        );
    } catch (err) {
        console.warn('[APEX/ab] Claude result update failed:', err instanceof Error ? err.message : err);
    }
}
```

- [ ] **Step 2: Modify evaluateAndExecute() to fire Claude + insert validation**

Find the Grok validation block in `evaluateAndExecute()`. Currently it looks like (around line 329):

```typescript
const approved = await this.validateWithGrok(opp);
if (!approved) return;
```

The current `validateWithGrok()` returns a `boolean`. We need the full result for logging. Look at how `validateWithGrok` parses the response — it stores the parsed result in `grokCache`. We need to extract the result object.

**Option A (simplest):** Keep the existing flow and reconstruct the Grok result from the cache after validation. Find the Grok cache lookup code. The cache key is `${opp.symbol}:${opp.direction}:${opp.mode}`. After `validateWithGrok()` returns, read the cached result:

At the top of `evaluateAndExecute()` (after the function signature), declare local variables for A/B tracking:

```typescript
let abClaudePromise: Promise<{ approve: boolean; confidence: number; reason: string } | null> | null = null;
let abGrokResult: { approve: boolean; confidence: number; reason: string } | null = null;
```

After the existing Grok validation block (after `const approved = await this.validateWithGrok(opp)`), add:

```typescript
// --- A/B: fire Claude validation (non-blocking) ---
if (this.config.ab_test.enabled) {
    const cacheKey = `${opp.symbol}:${opp.direction}:${opp.mode}`;
    const cachedGrok = this.grokCache.get(cacheKey);
    abGrokResult = cachedGrok
        ? { approve: cachedGrok.approve, confidence: cachedGrok.confidence, reason: cachedGrok.reason }
        : null;
    abClaudePromise = this.validateWithClaude(opp);
}
```

Then find the end of `evaluateAndExecute()` — after the Postgres trade INSERT and Telegram alert (around line 420). Before the final closing brace, add:

```typescript
// --- A/B: Insert validation row + backfill Claude result async ---
if (this.config.ab_test.enabled && abGrokResult) {
    const posId = pos?.id ?? null;  // pos is the ApexPosition created above

    const validationId = await this.insertValidation(opp, abGrokResult, true, posId);

    if (validationId && abClaudePromise) {
        abClaudePromise.then((claudeResult) => {
            if (claudeResult) {
                this.updateClaudeResult(validationId, claudeResult);
                console.log(`[APEX/ab] Claude: ${claudeResult.approve ? 'APPROVE' : 'REJECT'} (${claudeResult.confidence}%) — ${claudeResult.reason.slice(0, 80)}`);
            }
        }).catch(() => { /* fail-silent */ });
    }
}
```

**Important:** Also handle the case where Grok REJECTS (trade not executed). Find the `if (!approved) return;` line. Before the `return`, insert:

```typescript
if (this.config.ab_test.enabled) {
    // Only log A/B when Grok actually evaluated (skip rate-limited/disabled cases)
    const cacheKey = `${opp.symbol}:${opp.direction}:${opp.mode}`;
    const cachedGrok = this.grokCache.get(cacheKey);
    if (cachedGrok) {
        const grokResult = { approve: cachedGrok.approve, confidence: cachedGrok.confidence, reason: cachedGrok.reason };

        const claudePromise = this.validateWithClaude(opp);
        const validationId = await this.insertValidation(opp, grokResult, false, null);

        if (validationId && claudePromise) {
            claudePromise.then((claudeResult) => {
                if (claudeResult) {
                    this.updateClaudeResult(validationId, claudeResult);
                    console.log(`[APEX/ab] Claude (shadow): ${claudeResult.approve ? 'APPROVE' : 'REJECT'} (${claudeResult.confidence}%) — Grok rejected this one`);
                }
            }).catch(() => { /* fail-silent */ });
        }
    }
    // If no cache entry: Grok was rate-limited or disabled — don't pollute A/B data
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/apex/apex-agent.ts
git commit -m "feat(apex): wire A/B validation — fire Claude async, log both results to Postgres"
```

---

### Task 5: Add PnL Backfill to `monitorPositions()`

**Files:**
- Modify: `packages/agents/src/apex/apex-agent.ts:260-274` (inside monitorPositions exit handling)

- [ ] **Step 1: Add UPDATE apex_validations alongside existing apex_trades UPDATE**

Find the existing Postgres UPDATE in `monitorPositions()` (around line 260-273):

```typescript
await this.pg.query(
    `UPDATE apex_trades SET exit_price = $1, pnl = $2, ...`
```

After that block, add:

```typescript
// A/B validation PnL backfill
if (this.config.ab_test.enabled) {
    try {
        await this.pg.query(
            `UPDATE apex_validations
             SET actual_pnl = $1, actual_pnl_pct = $2
             WHERE position_id = $3`,
            [pnl, exitDecision.pnlPct, pos.id],
        );
    } catch (err) {
        console.warn('[APEX/ab] PnL backfill failed:', err instanceof Error ? err.message : err);
    }
}
```

Variable names from the existing code:
- `pnl` — computed at line 246 (correct)
- `exitDecision.pnlPct` — from `this.exitMonitor.evaluate(pos)` at line 242 (NOT a standalone `pnlPct` variable)
- `pos.id` — the position's unique identifier (e.g., `apex-BTC/USDC-1711234567890`)

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/apex/apex-agent.ts
git commit -m "feat(apex): backfill PnL to apex_validations on position close"
```

---

### Task 6: Update Dockerfile + Docker Compose

**Files:**
- Modify: `Dockerfile.apex`
- Modify: `docker-compose.prod.yml:472-495`

- [ ] **Step 1: Add Claude Code CLI to Dockerfile.apex**

Find the existing `RUN npm install -g` line in `Dockerfile.apex`. Add `@anthropic-ai/claude-code` to the install list. This must appear BEFORE any `USER node` directive. Example:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

This line must appear BEFORE the `USER node` directive (line 29). tsx and typescript are already installed locally — do NOT add them to the global install.

If `@anthropic-ai/claude-code` makes the image too large for the VM, use multi-stage build like Huntrix. But try single-stage first since Apex doesn't have a separate brain service.

- [ ] **Step 2: Add volume mount to docker-compose.prod.yml**

Find the `apex:` service block (around line 472-495). Add the Claude auth volume mount. Check the Dockerfile's USER directive:

- If `USER node` is set: mount to `/home/node/.claude`
- If no USER (runs as root): mount to `/root/.claude`

The current Dockerfile.apex uses `USER node`, so add:

```yaml
volumes:
  - ./apex.toml:/app/apex.toml:ro
  - ~/.claude:/home/node/.claude:ro   # Claude Code CLI auth for A/B validation
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.apex docker-compose.prod.yml
git commit -m "feat(apex): add Claude Code CLI to Docker for A/B validation"
```

---

### Task 7: Deploy and Verify

- [ ] **Step 1: Deploy to VM**

```bash
bash scripts/deploy/safe-deploy.sh apex
```

- [ ] **Step 2: Verify table exists**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c '\d apex_validations'"
```

Expected: table schema with all columns from the spec.

- [ ] **Step 3: Verify Claude CLI works in container**

```bash
ssh azureuser@openclaw-vm "docker exec apex claude --version"
```

Expected: version number (e.g., `1.x.x`). If it fails, check the volume mount path.

- [ ] **Step 4: Check logs for A/B activity**

```bash
ssh azureuser@openclaw-vm "docker logs apex --tail 30 2>&1 | grep -i 'ab\|claude\|validation'"
```

Expected: `[APEX/ab]` log lines when opportunities are evaluated. If no opportunities are firing yet, wait for the next confluence event.

- [ ] **Step 5: Query validation data**

After at least one opportunity has been evaluated:

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c 'SELECT id, symbol, direction, grok_approve, claude_approve, trade_executed, validated_at FROM apex_validations ORDER BY validated_at DESC LIMIT 5'"
```

- [ ] **Step 6: Commit any deployment fixes**

```bash
git add -A && git commit -m "fix(apex): deployment adjustments for A/B validator"
```

---

## Review Notes

### What changes in APEX behavior:

1. **New table:** `apex_validations` created on startup (idempotent)
2. **Every opportunity** gets logged with both Grok + Claude results
3. **Claude runs async** — never blocks tick, never delays trades
4. **Semaphore** prevents concurrent Claude invocations (max 1)
5. **PnL tracked** via position_id linking on trade close
6. **Grok-rejected opportunities** also logged (shadow comparison for missed trades)

### Deferred to Phase 2 (after 50+ data points):

- **`shadow_mode = false`** — switching Claude to control trades (replacing Grok). Config exists but is not wired yet. Will be implemented after A/B data proves Claude outperforms Grok.

### What does NOT change:

- Grok still controls all trade decisions
- Trade execution timing unchanged
- Position monitoring unchanged
- Risk gate unchanged
- No new API keys needed
