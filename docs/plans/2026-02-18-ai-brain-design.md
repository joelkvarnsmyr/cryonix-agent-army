# AI Brain — Autonomous Self-Improvement System

**Date:** 2026-02-18
**Status:** Approved
**Approach:** C (AI Brain)

## Problem

Cryonix har 7+ separata analysverktyg (calibrate.py, self_calibrate.py, morning_report.py, evolution engine, etc.) som körs oberoende utan att prata med varandra. Ingen aggregerar data. Ingen agerar på insikter automatiskt. Morning report körs men ingen läser den. Kalibrering mäter EV men applicerar inte. Evolution muterar men vet inte om det hjälpte. Resultat: 3 problem — för få trades (bottleneck), dåliga trades (quality), ingen lärdom (broken feedback loop).

## Lösning

En central AI-driven analysloop ("AI Brain") som var 6:e timme:
1. Samlar ALL data i en strukturerad kontext
2. Skickar till Grok för analys och beslut
3. Applicerar säkra automatiska åtgärder
4. Rapporterar till Telegram

## Arkitektur

### Skript: `scripts/strategy-lab/ai_brain.py`

**Schema:** Var 6:e timme via cron, plus akut trigger vid 3+ förluster i rad.

### Datakontext till AI

```json
{
  "period": "last_6h",
  "trades_closed": [
    {"symbol": "JTO/USDC", "pattern": "DIP_BUY,MACD", "pnl": 0.98, "exit_reason": "SOLD_TP", "holding_h": 6.0, "config_version": "a3f2b1c8"}
  ],
  "open_positions": [
    {"symbol": "DOGE/USDC", "entry": 0.178, "current": 0.175, "pnl_pct": -1.7, "holding_h": 4.2}
  ],
  "pipeline_stats": {
    "signals_generated": 53,
    "risk_gate_passed": 13,
    "ai_validated": 9,
    "ai_approved": 2,
    "executed": 1,
    "rejection_rate": "98.1%"
  },
  "calibration": {
    "BOLLINGER_SQUEEZE": {"ev": 0.45, "win_rate": 75, "trades": 8},
    "RSI_OVERSOLD": {"ev": -0.32, "win_rate": 33, "trades": 6}
  },
  "config_changes_48h": [
    {"param": "min_confidence", "old": "0.60", "new": "0.62", "source": "evolution:evo_177..."}
  ],
  "evolution_runs_48h": [
    {"run_id": "evo_177...", "status": "SUCCESS", "changes": [...]}
  ],
  "capital": {"total": 41.69, "available": 35.20, "in_positions": 6.49},
  "market_regime": "normal",
  "current_config": {
    "min_confidence": 0.60,
    "sl_atr_multiplier": 3.5,
    "tp_atr_multiplier": 4.5,
    "trailing_stop_pct": 3.0,
    "max_positions": 5,
    "min_order_value": 7.50,
    "single_pattern_penalty": 15
  }
}
```

### AI System Prompt

```
You are Cryonix AI Brain — an autonomous trading system analyst.

Analyze the data and return a JSON response with:
1. "diagnosis": Array of problems found (each with severity: critical/warning/info)
2. "actions": Array of actions to take (each with type, target, old_value, new_value, reasoning, confidence 0-1)
3. "report": Compact Telegram-formatted text summary (HTML tags allowed)

Available action types and their constraints:
- block_pattern: Block a pattern. Min 3 patterns must stay active.
- unblock_pattern: Reactivate a blocked pattern. Requires positive EV trend.
- adjust_min_confidence: Change threshold. ±10% per run, range 0.50-0.85.
- adjust_stop_loss: Change SL multiplier. ±0.5 per run, range 1.5-5.0.
- adjust_take_profit: Change TP multiplier. ±0.5 per run, range 2.0-8.0.
- adjust_trailing_stop: Change trailing %. ±1% per run, range 1%-8%.
- adjust_position_size: Change min order value. Range $5-$15.
- adjust_max_positions: Change max concurrent positions. Range 3-10.
- pipeline_tuning: Adjust single_pattern_penalty or gainer_boost. ±5% per run.
- flag_stale_position: Flag position for review. Only if holding > 12h + < 1% movement.

Rules:
- Max 4 actions per run
- Only actions with confidence >= 0.7 will be auto-applied
- Lower confidence actions are logged as recommendations
- Be conservative: small incremental changes, not dramatic shifts
- Prioritize actions that address the ROOT CAUSE, not symptoms
- If pipeline is too restrictive (>95% rejection), consider loosening filters
- If win rate is dropping, consider tightening filters or blocking patterns
- Always explain WHY in reasoning field
```

### Action Application

Each action:
1. Validates against safety bounds (range checks, min active patterns, etc.)
2. Updates `cryonix.toml` via TOML parsing + write
3. Updates Redis immediately (for calibration overrides, blocked patterns)
4. Logs to `config_changes` table with `change_type = 'ai_brain'`
5. Logs to `autopilot_actions` table with full reasoning
6. Computes new `config_version` hash

### Telegram Report (every 6h)

```
🧠 AI Brain Report (6h)

📊 Performance:
  Trades: 3 closed | WR: 66% | P&L: +$1.42
  Pipeline: 28 signals → 6 risk → 2 AI → 1 exec

🔍 Diagnosis:
  ⚠️ EMA_BULLISH_CROSS solo: -$0.48 (3 trades, 33% WR)
  ⚠️ Pipeline bottleneck: 96% rejection rate
  ✅ BOLLINGER_SQUEEZE: +$0.74 (75% WR)

🔧 Actions taken:
  ✅ Blocked EMA_BULLISH_CROSS solo (EV: -0.32)
  ✅ Lowered min_confidence 0.60 → 0.55

📈 Config: a3f2b1c8 → 7d1e4f92

💡 Recommendations (not applied):
  Consider: increase max_positions to 6
```

### Acute Trigger

Auto-trader triggers an acute AI Brain run when 3+ trades lose in a row:
- Set Redis key `brain:acute_trigger` with loss streak count
- ai_brain.py checks on startup, runs immediately if trigger exists
- Acute runs have higher urgency in the prompt ("losses accelerating, assess immediately")

## New Table: `autopilot_actions`

| Column | Type | Description |
|--------|------|-------------|
| id | serial PK | |
| run_id | text | "brain_2026-02-18T12:00" |
| action_type | varchar(30) | block_pattern, adjust_min_confidence, etc. |
| target | text | What was changed |
| old_value | text | Previous value |
| new_value | text | New value |
| reasoning | text | AI's explanation |
| confidence | decimal(3,2) | AI confidence 0-1 |
| applied | boolean | true if auto-applied |
| created_at | timestamp | |

## AI Brain → Evolution Directives

AI Brain handles fast parameter tuning (cryonix.toml). But some insights require **code changes** — that's Evolution's domain. AI Brain communicates these via Redis directives.

### Mechanism

AI Brain writes to Redis key `evolution:directives` (JSON array, 24h TTL):
```json
[
  {
    "type": "code_change",
    "target": "risk_gate.py",
    "description": "Add volume confirmation to DIP_BUY pattern — solo DIP_BUY has 33% WR but DIP_BUY+VOLUME has 75% WR",
    "priority": "high",
    "created_at": "2026-02-18T12:00:00Z",
    "brain_run_id": "brain_2026-02-18T12:00"
  },
  {
    "type": "investigation",
    "target": "quant.py",
    "description": "MACD signals spike at 03:00 UTC but 0% win rate — possible low-liquidity false signals",
    "priority": "medium",
    "created_at": "2026-02-18T12:00:00Z",
    "brain_run_id": "brain_2026-02-18T12:00"
  }
]
```

### Directive Types
- **code_change**: AI Brain identified a pattern that needs code-level fix (Evolution acts on it)
- **investigation**: AI Brain flagged something suspicious but can't determine the fix (Evolution investigates)

### Evolution Side

`copilot-evolution.mjs` reads `evolution:directives` at startup and includes them in its analysis prompt:
```
AI Brain directives (from last 24h):
- [HIGH] risk_gate.py: Add volume confirmation to DIP_BUY pattern...
- [MEDIUM] quant.py: MACD signals spike at 03:00 UTC...

Consider these directives when planning mutations. High priority directives should be addressed first.
```

After processing, Evolution clears consumed directives from Redis.

### Flow
```
AI Brain (every 6h)
  → Grok analysis finds code-level insight
  → Writes directive to Redis evolution:directives (24h TTL)
  → Evolution (every 2h) reads directives
  → Claude Code mutation plan incorporates directives
  → Evolution applies code changes + clears directive
```

## Implementation Order

1. Add `autopilot_actions` table to schema
2. Create `ai_brain.py` — data collection layer
3. Add Grok analysis call with structured JSON output
4. Add action validators (safety bounds)
5. Add action applicators (TOML + Redis + config_changes)
6. Add Telegram report sender
7. Add cron job (every 6h)
8. Add acute trigger in auto-trade/route.ts (3+ loss streak)
9. Add evolution directive writing in ai_brain.py
10. Add evolution directive reading in copilot-evolution.mjs
11. Deploy and verify

## Relationship to Existing Systems

- **Replaces:** morning_report.py (AI Brain subsumes its analysis)
- **Enhances:** calibrate.py (AI Brain reads calibration data but also acts on it)
- **Complements:** evolution engine (Evolution does code mutations every 2h, AI Brain does parameter tuning every 6h)
- **Evolution remains for:** Complex multi-file code changes that AI Brain can't do
- **AI Brain focuses on:** Fast parameter tuning within known safe ranges

## Cost Estimate

- 1 Grok API call per 6h = 4 calls/day
- ~2000 tokens input (data context) + ~500 tokens output (JSON response)
- Cost: ~$0.01/day (negligible with Grok pricing)

## Phase 2 (Future)

- Add Claude as "second opinion" for low-confidence decisions
- Backtest proposed changes before applying
- Learn from own action history (did previous adjustments help?)
- Auto-scale frequency based on trading activity
