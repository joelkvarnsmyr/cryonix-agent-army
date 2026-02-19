# AI Brain Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an autonomous AI Brain that collects all trading data, sends it to Grok for analysis, applies safe parameter tuning actions, reports to Telegram, and feeds directives to the Evolution engine.

**Architecture:** Python script (`scripts/strategy-lab/ai_brain.py`) using the existing `db.py` Postgres/Redis helpers + Grok xAI API. Runs every 6h via cron + acute trigger from auto-trade route on 3+ loss streak. Actions modify `cryonix.toml` via TOML parsing, update Redis, and log to `autopilot_actions` + `config_changes` tables.

**Tech Stack:** Python 3.11, psycopg2, redis-py, httpx (Grok API), toml (TOML R/W), existing `scripts/strategy-lab/db.py`

---

### Task 1: Add `autopilot_actions` table to schema

**Files:**
- Modify: `packages/database/src/schema.ts:228-247` (after `calibrationHistory` table)
- Run SQL: via `docker exec cryonix-postgres-1 psql`

**Step 1: Add Drizzle table definition**

Add after the `calibrationHistory` table definition (line 247) in `packages/database/src/schema.ts`:

```typescript
export const autopilotActions = pgTable('autopilot_actions', {
  id: serial('id').primaryKey(),
  runId: text('run_id').notNull(),
  actionType: varchar('action_type', { length: 30 }).notNull(),
  target: text('target'),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  reasoning: text('reasoning'),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  applied: boolean('applied').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});
```

Add type exports at the bottom of the file (after the `NewCalibrationHistoryRow` export):

```typescript
export type AutopilotAction = typeof autopilotActions.$inferSelect;
export type NewAutopilotAction = typeof autopilotActions.$inferInsert;
```

**Step 2: Create table in Postgres**

Run:
```bash
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "
CREATE TABLE IF NOT EXISTS autopilot_actions (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  action_type VARCHAR(30) NOT NULL,
  target TEXT,
  old_value TEXT,
  new_value TEXT,
  reasoning TEXT,
  confidence DECIMAL(3,2),
  applied BOOLEAN NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);"
```

Expected: `CREATE TABLE`

**Step 3: Commit**

```bash
git add packages/database/src/schema.ts
git commit -m "feat(db): add autopilot_actions table for AI Brain"
```

---

### Task 2: Create `ai_brain.py` — data collection layer

**Files:**
- Create: `scripts/strategy-lab/ai_brain.py`

**Step 1: Create the data collection script**

Create `scripts/strategy-lab/ai_brain.py` with:

```python
#!/usr/bin/env python3
"""
AI Brain — Autonomous Self-Improvement System

Collects all trading data, sends to Grok for analysis,
applies safe parameter actions, reports to Telegram.

Usage:
  python3 scripts/strategy-lab/ai_brain.py [--acute]

Cron: every 6h
Acute: triggered by auto-trader on 3+ consecutive losses
"""
import argparse
import hashlib
import httpx
import json
import os
import sys
import time
import toml
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TOML_PATH = os.path.join(PROJECT_ROOT, 'cryonix.toml')
GROK_API_URL = 'https://api.x.ai/v1/chat/completions'

# === Telegram ===
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_EVOLUTION_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', '')


def telegram_send(text):
    """Send message via Telegram bot."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print(f'[TELEGRAM] No token/chat_id, skipping: {text[:80]}...')
        return
    try:
        httpx.post(
            f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage',
            json={
                'chat_id': TELEGRAM_CHAT_ID,
                'text': text[:4096],
                'parse_mode': 'HTML',
                'disable_web_page_preview': True,
            },
            timeout=10,
        )
    except Exception as e:
        print(f'[TELEGRAM] Send failed: {e}')


def config_version(toml_content):
    """Compute 8-char SHA256 hash of TOML content."""
    return hashlib.sha256(toml_content.encode()).hexdigest()[:8]


def load_toml_config():
    """Load and return cryonix.toml as dict + raw content."""
    with open(TOML_PATH, 'r') as f:
        raw = f.read()
    return toml.loads(raw), raw


def collect_data(pg, r, period_hours=6, is_acute=False):
    """Collect all trading data into a structured context dict."""
    cur = pg.cursor()

    # 1. Closed trades in period
    cur.execute("""
        SELECT symbol, pattern, pnl, confidence, reasoning, config_version,
               timestamp,
               EXTRACT(EPOCH FROM (NOW() - timestamp)) / 3600.0 as hours_ago
        FROM trades
        WHERE status = 'CLOSED' AND pnl IS NOT NULL
          AND timestamp > NOW() - INTERVAL '%s hours'
        ORDER BY timestamp DESC
    """ % int(period_hours))
    cols = [d[0] for d in cur.description]
    closed_trades = [dict(zip(cols, row)) for row in cur.fetchall()]

    # Determine exit reason from reasoning field
    for t in closed_trades:
        r_text = (t.get('reasoning') or '').lower()
        if 'stop-loss' in r_text or 'native sl' in r_text:
            t['exit_reason'] = 'SOLD_SL'
        elif 'take-profit' in r_text:
            t['exit_reason'] = 'SOLD_TP'
        elif 'trailing' in r_text:
            t['exit_reason'] = 'SOLD_TRAILING'
        elif 'stagnation' in r_text:
            t['exit_reason'] = 'SOLD_STAGNATION'
        else:
            t['exit_reason'] = 'OTHER'
        # Clean up non-serializable types
        t['pnl'] = float(t['pnl']) if t['pnl'] else 0
        t['confidence'] = float(t['confidence']) if t['confidence'] else 0
        t['hours_ago'] = round(float(t['hours_ago']), 1) if t['hours_ago'] else 0
        t['timestamp'] = t['timestamp'].isoformat() if t['timestamp'] else None

    # 2. Open positions from Redis
    open_positions = []
    try:
        pos_raw = r.hgetall('positions:open')
        for symbol, data in pos_raw.items():
            p = json.loads(data) if isinstance(data, str) else data
            entry = float(p.get('entryPrice', 0))
            opened = p.get('openedAt', '')
            holding_h = 0
            if opened:
                try:
                    opened_dt = datetime.fromisoformat(opened.replace('Z', '+00:00'))
                    holding_h = round((datetime.now(timezone.utc) - opened_dt).total_seconds() / 3600, 1)
                except Exception:
                    pass
            open_positions.append({
                'symbol': symbol,
                'entry': entry,
                'pattern': p.get('pattern', ''),
                'holding_h': holding_h,
                'stop_loss': float(p.get('stopLoss', 0)),
                'take_profit': float(p.get('takeProfit', 0)),
            })
    except Exception as e:
        print(f'[BRAIN] Failed to read positions: {e}')

    # 3. Pipeline stats from Redis (signals generated/rejected/executed)
    pipeline_stats = {}
    try:
        stats_raw = r.get('stats:pipeline')
        if stats_raw:
            pipeline_stats = json.loads(stats_raw)
    except Exception:
        pass

    # 4. Calibration data from Redis
    calibration = {}
    try:
        cal_raw = r.get('calibration:patterns')
        if cal_raw:
            calibration = json.loads(cal_raw)
    except Exception:
        pass

    # 5. Config changes in last 48h
    cur.execute("""
        SELECT change_type, source, config_version, parameters, reasoning,
               created_at
        FROM config_changes
        WHERE created_at > NOW() - INTERVAL '48 hours'
        ORDER BY created_at DESC
    """)
    cols = [d[0] for d in cur.description]
    config_changes = []
    for row in cur.fetchall():
        c = dict(zip(cols, row))
        c['created_at'] = c['created_at'].isoformat() if c['created_at'] else None
        config_changes.append(c)

    # 6. Evolution runs in last 48h
    cur.execute("""
        SELECT run_id, status, changes_made, started_at, duration_seconds
        FROM evolution_runs
        WHERE started_at > NOW() - INTERVAL '48 hours'
        ORDER BY started_at DESC
    """)
    cols = [d[0] for d in cur.description]
    evolution_runs = []
    for row in cur.fetchall():
        e = dict(zip(cols, row))
        e['started_at'] = e['started_at'].isoformat() if e['started_at'] else None
        evolution_runs.append(e)

    # 7. Capital from Redis
    capital = {'total': 0, 'available': 0, 'in_positions': 0}
    try:
        cap_raw = r.get('risk:portfolio_state')
        if cap_raw:
            cap = json.loads(cap_raw)
            capital = {
                'total': float(cap.get('totalValue', 0)),
                'available': float(cap.get('availableBalance', 0)),
                'in_positions': float(cap.get('positionsValue', 0)),
            }
    except Exception:
        pass

    # 8. Market regime
    market_regime = r.get('market:regime') or 'normal'

    # 9. Current config (key tunable params)
    cfg, cfg_raw = load_toml_config()
    current_config = {
        'min_confidence': cfg.get('risk', {}).get('min_confidence', 0.60),
        'sl_atr_multiplier': cfg.get('exits', {}).get('sl_atr_multiplier', 3.5),
        'tp_atr_multiplier': cfg.get('exits', {}).get('tp_atr_multiplier', 6.5),
        'trailing_stop_pct': cfg.get('exits', {}).get('trailing_stop_pct', 3.0),
        'trailing_activation_pct': cfg.get('exits', {}).get('trailing_activation_pct', 2.5),
        'max_positions': cfg.get('limits', {}).get('max_open_positions', 5),
        'min_order_value': cfg.get('capital', {}).get('min_order_value', 7.50),
        'single_pattern_penalty': cfg.get('consensus', {}).get('single_pattern_penalty', 0.65),
        'gainer_confidence_boost': cfg.get('boosting', {}).get('gainer_confidence_boost', 0.10),
    }

    # 10. Previous AI Brain actions (last 48h)
    cur.execute("""
        SELECT run_id, action_type, target, old_value, new_value, reasoning, confidence, applied
        FROM autopilot_actions
        WHERE created_at > NOW() - INTERVAL '48 hours'
        ORDER BY created_at DESC
    """)
    cols = [d[0] for d in cur.description]
    prev_actions = [dict(zip(cols, row)) for row in cur.fetchall()]
    for a in prev_actions:
        a['confidence'] = float(a['confidence']) if a['confidence'] else 0

    cur.close()

    # Check acute trigger
    acute_data = None
    if is_acute:
        try:
            acute_raw = r.get('brain:acute_trigger')
            if acute_raw:
                acute_data = json.loads(acute_raw)
        except Exception:
            pass

    return {
        'period': f'last_{period_hours}h',
        'is_acute': is_acute,
        'acute_data': acute_data,
        'trades_closed': closed_trades,
        'open_positions': open_positions,
        'pipeline_stats': pipeline_stats,
        'calibration': calibration,
        'config_changes_48h': config_changes,
        'evolution_runs_48h': evolution_runs,
        'capital': capital,
        'market_regime': market_regime,
        'current_config': current_config,
        'previous_brain_actions': prev_actions,
        'config_version': config_version(cfg_raw),
    }


# === Safety Bounds ===
SAFETY_BOUNDS = {
    'adjust_min_confidence':   {'min': 0.50, 'max': 0.85, 'max_delta': 0.10, 'section': 'risk', 'key': 'min_confidence'},
    'adjust_stop_loss':        {'min': 1.5,  'max': 5.0,  'max_delta': 0.5,  'section': 'exits', 'key': 'sl_atr_multiplier'},
    'adjust_take_profit':      {'min': 2.0,  'max': 8.0,  'max_delta': 0.5,  'section': 'exits', 'key': 'tp_atr_multiplier'},
    'adjust_trailing_stop':    {'min': 1.0,  'max': 8.0,  'max_delta': 1.0,  'section': 'exits', 'key': 'trailing_stop_pct'},
    'adjust_position_size':    {'min': 5.0,  'max': 15.0, 'max_delta': 2.0,  'section': 'capital', 'key': 'min_order_value'},
    'adjust_max_positions':    {'min': 3,    'max': 10,   'max_delta': 2,    'section': 'limits', 'key': 'max_open_positions'},
    'pipeline_tuning':         {'min': 0.30, 'max': 1.0,  'max_delta': 0.05, 'section': 'consensus', 'key': 'single_pattern_penalty'},
}

MIN_ACTIVE_PATTERNS = 3
MAX_ACTIONS_PER_RUN = 4
MIN_CONFIDENCE_TO_APPLY = 0.7


def validate_action(action, cfg, r):
    """Validate an action against safety bounds. Returns (valid, reason)."""
    atype = action.get('type', '')
    confidence = float(action.get('confidence', 0))

    if confidence < MIN_CONFIDENCE_TO_APPLY:
        return True, f'logged as recommendation (confidence {confidence:.2f} < {MIN_CONFIDENCE_TO_APPLY})'

    if atype == 'block_pattern':
        # Check min active patterns
        blocked_raw = r.get('brain:blocked_patterns') or '[]'
        blocked = json.loads(blocked_raw)
        all_patterns = ['BOLLINGER_SQUEEZE', 'RSI_OVERSOLD', 'MACD_BULLISH_CROSS',
                        'EMA_BULLISH_CROSS', 'DIP_BUY', 'VOLUME_SPIKE_UP', 'DEEP_VALUE_CRASH',
                        'MOMENTUM_GAINER']
        active = [p for p in all_patterns if p not in blocked]
        if len(active) <= MIN_ACTIVE_PATTERNS:
            return False, f'cannot block: only {len(active)} active patterns (min {MIN_ACTIVE_PATTERNS})'
        return True, 'ok'

    if atype == 'unblock_pattern':
        return True, 'ok'

    if atype == 'flag_stale_position':
        return True, 'ok'

    if atype in SAFETY_BOUNDS:
        bounds = SAFETY_BOUNDS[atype]
        new_val = float(action.get('new_value', 0))
        old_val = float(action.get('old_value', 0))

        if new_val < bounds['min'] or new_val > bounds['max']:
            return False, f'out of range [{bounds["min"]}, {bounds["max"]}]: {new_val}'

        if abs(new_val - old_val) > bounds['max_delta']:
            return False, f'delta {abs(new_val - old_val):.2f} exceeds max {bounds["max_delta"]}'

        return True, 'ok'

    return False, f'unknown action type: {atype}'


def apply_action(action, cfg, cfg_raw, r, pg, run_id):
    """Apply a validated action. Returns (success, new_cfg_raw)."""
    atype = action.get('type', '')
    confidence = float(action.get('confidence', 0))
    applied = confidence >= MIN_CONFIDENCE_TO_APPLY

    # Log to autopilot_actions regardless
    cur = pg.cursor()
    cur.execute("""
        INSERT INTO autopilot_actions (run_id, action_type, target, old_value, new_value, reasoning, confidence, applied)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
    """, [run_id, atype, action.get('target', ''),
          str(action.get('old_value', '')), str(action.get('new_value', '')),
          action.get('reasoning', ''), confidence, applied])
    pg.commit()
    cur.close()

    if not applied:
        return True, cfg_raw  # Logged as recommendation only

    if atype == 'block_pattern':
        pattern = action.get('target', '')
        blocked_raw = r.get('brain:blocked_patterns') or '[]'
        blocked = json.loads(blocked_raw)
        if pattern not in blocked:
            blocked.append(pattern)
        r.set('brain:blocked_patterns', json.dumps(blocked), ex=86400 * 7)
        return True, cfg_raw

    if atype == 'unblock_pattern':
        pattern = action.get('target', '')
        blocked_raw = r.get('brain:blocked_patterns') or '[]'
        blocked = json.loads(blocked_raw)
        blocked = [p for p in blocked if p != pattern]
        r.set('brain:blocked_patterns', json.dumps(blocked), ex=86400 * 7)
        return True, cfg_raw

    if atype == 'flag_stale_position':
        # Just log — the Telegram report will show it
        return True, cfg_raw

    if atype in SAFETY_BOUNDS:
        bounds = SAFETY_BOUNDS[atype]
        new_val = float(action.get('new_value', 0))
        section = bounds['section']
        key = bounds['key']

        # Update TOML
        cfg[section][key] = new_val
        new_raw = toml.dumps(cfg)
        with open(TOML_PATH, 'w') as f:
            f.write(new_raw)

        # Log to config_changes
        new_version = config_version(new_raw)
        cur = pg.cursor()
        cur.execute("""
            INSERT INTO config_changes (change_type, source, config_version, parameters, reasoning)
            VALUES ('ai_brain', %s, %s, %s, %s)
        """, [f'brain:{run_id}', new_version,
              json.dumps([{'param': key, 'section': section,
                           'old': str(action.get('old_value', '')),
                           'new': str(new_val)}]),
              action.get('reasoning', '')])
        pg.commit()
        cur.close()

        return True, new_raw

    return False, cfg_raw


# === Grok Analysis ===

SYSTEM_PROMPT = """You are Cryonix AI Brain — an autonomous trading system analyst.

Analyze the data and return a JSON response with:
1. "diagnosis": Array of problems found (each with severity: critical/warning/info, and description)
2. "actions": Array of actions to take (each with type, target, old_value, new_value, reasoning, confidence 0-1)
3. "directives": Array of evolution directives for code-level changes (each with type: code_change|investigation, target, description, priority: high|medium|low)
4. "report": Compact Telegram-formatted text summary (HTML tags allowed: <b>, <i>, <code>)

Available action types and their constraints:
- block_pattern: Block a pattern. target=pattern name. Min 3 patterns must stay active.
- unblock_pattern: Reactivate a blocked pattern. Requires positive EV trend.
- adjust_min_confidence: Change threshold. ±0.10 per run, range 0.50-0.85.
- adjust_stop_loss: Change SL ATR multiplier. ±0.5 per run, range 1.5-5.0.
- adjust_take_profit: Change TP ATR multiplier. ±0.5 per run, range 2.0-8.0.
- adjust_trailing_stop: Change trailing %. ±1% per run, range 1.0-8.0.
- adjust_position_size: Change min order value. ±$2 per run, range $5-$15.
- adjust_max_positions: Change max concurrent positions. ±2 per run, range 3-10.
- pipeline_tuning: Adjust single_pattern_penalty. ±0.05 per run, range 0.30-1.0.
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
- If you identify code-level issues (not just parameter tuning), add them to directives
- Return ONLY valid JSON, no markdown fences"""


def call_grok(context, is_acute=False):
    """Call Grok API with trading context. Returns parsed JSON response."""
    api_key = os.environ.get('XAI_API_KEY', '')
    if not api_key:
        raise RuntimeError('XAI_API_KEY not set')

    user_msg = json.dumps(context, indent=2, default=str)
    if is_acute:
        user_msg = "⚠️ ACUTE TRIGGER: 3+ consecutive losses detected. Losses are accelerating — assess immediately and prioritize defensive actions.\n\n" + user_msg

    resp = httpx.post(
        GROK_API_URL,
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        json={
            'model': 'grok-3-mini-fast',
            'messages': [
                {'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user', 'content': user_msg},
            ],
            'temperature': 0.1,
            'max_tokens': 2000,
        },
        timeout=60,
    )
    resp.raise_for_status()

    content = resp.json()['choices'][0]['message']['content']
    # Strip markdown fences if present
    if content.startswith('```'):
        content = content.split('\n', 1)[1]
        if content.endswith('```'):
            content = content[:-3]

    return json.loads(content)


# === Main ===

def main():
    parser = argparse.ArgumentParser(description='AI Brain — Autonomous Self-Improvement')
    parser.add_argument('--acute', action='store_true', help='Acute trigger mode (3+ losses)')
    parser.add_argument('--dry-run', action='store_true', help='Collect data + call Grok but do not apply actions')
    args = parser.parse_args()

    run_id = f'brain_{datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")}'
    print(f'[AI BRAIN] Starting run {run_id} (acute={args.acute}, dry_run={args.dry_run})')

    pg = get_pg()
    r = get_redis()

    try:
        # Step 1: Collect data
        period = 6 if not args.acute else 24  # Acute looks at wider window
        context = collect_data(pg, r, period_hours=period, is_acute=args.acute)

        trade_count = len(context['trades_closed'])
        print(f'[AI BRAIN] Collected: {trade_count} closed trades, '
              f'{len(context["open_positions"])} open positions, '
              f'{len(context["calibration"])} calibrated patterns')

        if trade_count == 0 and not args.acute:
            print('[AI BRAIN] No trades in period, skipping analysis')
            telegram_send(f'🧠 <b>AI Brain</b> ({run_id})\n\nNo trades in last {period}h. Skipping.')
            return

        # Step 2: Call Grok
        print('[AI BRAIN] Calling Grok for analysis...')
        result = call_grok(context, is_acute=args.acute)

        diagnosis = result.get('diagnosis', [])
        actions = result.get('actions', [])[:MAX_ACTIONS_PER_RUN]
        directives = result.get('directives', [])
        report = result.get('report', 'No report generated')

        print(f'[AI BRAIN] Grok returned: {len(diagnosis)} diagnoses, '
              f'{len(actions)} actions, {len(directives)} directives')

        # Step 3: Validate and apply actions
        cfg, cfg_raw = load_toml_config()
        old_version = config_version(cfg_raw)
        applied_count = 0
        recommendation_count = 0
        failed_count = 0

        for action in actions:
            valid, reason = validate_action(action, cfg, r)
            atype = action.get('type', '')
            conf = float(action.get('confidence', 0))

            if not valid:
                print(f'[AI BRAIN] REJECTED {atype}: {reason}')
                failed_count += 1
                continue

            if args.dry_run:
                print(f'[AI BRAIN] DRY RUN {atype}: {action.get("old_value")} -> {action.get("new_value")} '
                      f'(conf={conf:.2f})')
                continue

            success, cfg_raw = apply_action(action, cfg, cfg_raw, r, pg, run_id)
            if success:
                if conf >= MIN_CONFIDENCE_TO_APPLY:
                    applied_count += 1
                    print(f'[AI BRAIN] APPLIED {atype}: {action.get("old_value")} -> {action.get("new_value")}')
                else:
                    recommendation_count += 1
                    print(f'[AI BRAIN] RECOMMENDATION {atype} (conf={conf:.2f})')

        # Step 4: Write evolution directives
        if directives and not args.dry_run:
            for d in directives:
                d['created_at'] = datetime.now(timezone.utc).isoformat()
                d['brain_run_id'] = run_id

            # Merge with existing directives
            existing_raw = r.get('evolution:directives')
            existing = json.loads(existing_raw) if existing_raw else []
            existing.extend(directives)
            r.set('evolution:directives', json.dumps(existing), ex=86400)
            print(f'[AI BRAIN] Wrote {len(directives)} evolution directives')

        # Step 5: Send Telegram report
        new_version = config_version(cfg_raw)
        header = '🧠 <b>AI Brain Report</b>'
        if args.acute:
            header = '🚨 <b>AI Brain ACUTE Report</b>'

        tg_msg = f'{header} ({run_id})\n\n'
        tg_msg += report + '\n\n'

        if applied_count > 0:
            tg_msg += f'📈 Config: <code>{old_version}</code> → <code>{new_version}</code>\n'
        tg_msg += f'✅ Applied: {applied_count} | 💡 Recommendations: {recommendation_count}'
        if failed_count > 0:
            tg_msg += f' | ❌ Rejected: {failed_count}'
        if directives:
            tg_msg += f'\n🔗 Evolution directives: {len(directives)}'

        telegram_send(tg_msg)

        # Clear acute trigger if this was an acute run
        if args.acute:
            r.delete('brain:acute_trigger')
            print('[AI BRAIN] Cleared acute trigger')

        print(f'[AI BRAIN] Run complete. Applied={applied_count}, Rec={recommendation_count}, '
              f'Failed={failed_count}, Directives={len(directives)}')

    except Exception as e:
        print(f'[AI BRAIN] ERROR: {e}')
        telegram_send(f'🧠❌ <b>AI Brain Error</b>\n\n<code>{str(e)[:500]}</code>')
        raise
    finally:
        pg.close()
        r.close()


if __name__ == '__main__':
    main()
```

**Step 2: Verify the script loads without errors**

Run:
```bash
cd /home/azureuser/cryonix && python3 -c "import scripts.strategy_lab.ai_brain" 2>&1 || python3 scripts/strategy-lab/ai_brain.py --dry-run 2>&1 | head -5
```

Expected: Script starts, collects data (or shows connection info). May error on Grok call in dry-run if no trades, that's fine.

**Step 3: Commit**

```bash
git add scripts/strategy-lab/ai_brain.py
git commit -m "feat(brain): add AI Brain autonomous analysis script

Data collection, Grok analysis, safety-bounded action application,
evolution directives, and Telegram reporting."
```

---

### Task 3: Add acute trigger in auto-trade/route.ts

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:1825-1830` (after monitorPositions)

**Step 1: Add loss streak tracking and acute trigger**

After line 1826 (`const sells = monitorResults.filter(...)`) in the POST handler, add:

```typescript
    // ACUTE TRIGGER: Track consecutive SL losses for AI Brain
    const slSells = sells.filter(s => s.action === 'SOLD_SL');
    if (slSells.length > 0) {
      try {
        const streakRaw = await redis.get('brain:loss_streak');
        const currentStreak = streakRaw ? parseInt(streakRaw) : 0;
        const newStreak = currentStreak + slSells.length;
        await redis.set('brain:loss_streak', String(newStreak), 'EX', 86400);

        if (newStreak >= 3) {
          await redis.set('brain:acute_trigger', JSON.stringify({
            streak: newStreak,
            last_losses: slSells.map(s => ({ symbol: s.symbol, pnl: s.pnl })),
            triggered_at: new Date().toISOString(),
          }), 'EX', 3600);
          console.log(`[BRAIN] Acute trigger set: ${newStreak} consecutive losses`);
        }
      } catch (e) {
        console.error('[BRAIN] Loss streak tracking error:', e);
      }
    }

    // Reset streak on any win
    const wins = sells.filter(s => s.action === 'SOLD_TP' || s.action === 'SOLD_TRAILING');
    if (wins.length > 0) {
      await redis.del('brain:loss_streak').catch(() => {});
    }
```

**Step 2: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(auto-trade): add loss streak tracking for AI Brain acute trigger

Tracks consecutive SL losses in Redis. Sets brain:acute_trigger
when 3+ losses occur, enabling AI Brain acute analysis."
```

---

### Task 4: Add evolution directive reading in copilot-evolution.mjs

**Files:**
- Modify: `scripts/evolution/copilot-evolution.mjs:439-601` (buildEvolutionPrompt method)

**Step 1: Read directives from Redis and include in prompt**

In the `buildEvolutionPrompt` method, after the `sentimentSection` block (around line 527), add a new section:

```javascript
    // Fetch AI Brain directives
    let directivesSection = '';
    try {
      const directivesRaw = await this.redis.get('evolution:directives');
      if (directivesRaw) {
        const directives = JSON.parse(directivesRaw);
        if (directives.length > 0) {
          directivesSection = `
## 🧠 AI Brain Directives (from last 24h)
${directives.map(d => `- [${d.priority?.toUpperCase() || 'MEDIUM'}] ${d.target}: ${d.description}`).join('\n')}

Consider these directives when planning mutations. HIGH priority directives should be addressed first.
These come from the AI Brain's analysis of trading performance data.`;
        }
      }
    } catch {}
```

Then add `${directivesSection}` to the prompt template string (after `${issuesSection}`, around line 574).

**Step 2: Clear consumed directives after processing**

In the `runClaudeEvolution` method, after a successful mutation (around line 421, after `console.log('\n✅ Claude Code evolution completed')`), add:

```javascript
      // Clear consumed AI Brain directives
      try {
        await this.redis.del('evolution:directives');
        console.log('🧹 Cleared consumed AI Brain directives');
      } catch {}
```

**Step 3: Commit**

```bash
git add scripts/evolution/copilot-evolution.mjs
git commit -m "feat(evolution): read AI Brain directives from Redis

Evolution engine now reads evolution:directives and includes them
in the Claude mutation prompt. Clears directives after processing."
```

---

### Task 5: Add cron job for AI Brain

**Step 1: Add cron entry**

Run:
```bash
(crontab -l; echo '# AI Brain — autonomous analysis every 6h (offset from calibration by 3h)'; echo '0 0,6,12,18 * * * cd /home/azureuser/cryonix && python3 scripts/strategy-lab/ai_brain.py >> /tmp/ai-brain-cron.log 2>&1') | crontab -
```

**Step 2: Add acute trigger cron (check every 15 min)**

Run:
```bash
(crontab -l; echo '# AI Brain acute trigger check (runs only if brain:acute_trigger exists in Redis)'; echo '*/15 * * * * cd /home/azureuser/cryonix && redis-cli -u $KV_URL EXISTS brain:acute_trigger | grep -q 1 && python3 scripts/strategy-lab/ai_brain.py --acute >> /tmp/ai-brain-acute.log 2>&1') | crontab -
```

**Step 3: Verify crontab**

Run:
```bash
crontab -l | grep brain
```

Expected: Two lines with `ai_brain.py` entries.

---

### Task 6: Dry-run test on production data

**Step 1: Run with --dry-run**

Run:
```bash
cd /home/azureuser/cryonix && python3 scripts/strategy-lab/ai_brain.py --dry-run 2>&1
```

Expected: Script collects data, calls Grok, prints diagnosis and actions but doesn't apply. Check:
- Data collection succeeds (trade count, position count printed)
- Grok returns valid JSON with diagnosis/actions/report
- No crashes

**Step 2: If Grok call fails, check API key**

Run:
```bash
echo $XAI_API_KEY | head -c 10
```

If empty, load from .env:
```bash
source /home/azureuser/cryonix/.env && python3 scripts/strategy-lab/ai_brain.py --dry-run 2>&1
```

---

### Task 7: Live test (single run, no --dry-run)

**Step 1: Run AI Brain for real**

Run:
```bash
cd /home/azureuser/cryonix && source .env && python3 scripts/strategy-lab/ai_brain.py 2>&1
```

Expected:
- Data collected
- Grok analysis returned
- Actions validated and applied (or recommended)
- Telegram report sent
- Config changes logged to `config_changes` table
- Actions logged to `autopilot_actions` table

**Step 2: Verify database writes**

Run:
```bash
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "SELECT * FROM autopilot_actions ORDER BY created_at DESC LIMIT 5;"
```

Expected: Recent AI Brain actions visible.

**Step 3: Verify Redis state**

Run:
```bash
docker exec cryonix-redis-1 redis-cli GET evolution:directives
docker exec cryonix-redis-1 redis-cli GET brain:blocked_patterns
```

Expected: Directives written if Grok suggested code changes. Blocked patterns updated if Grok blocked any.

---

### Task 8: Update CLAUDE.md with AI Brain documentation

**Files:**
- Modify: `CLAUDE.md` (root)

**Step 1: Add AI Brain to Background Workers section**

After the `scripts/evolution/copilot-evolution.mjs` entry:
```
- `scripts/strategy-lab/ai_brain.py` - AI Brain autonomous analysis (every 6h + acute trigger)
```

**Step 2: Add AI Brain to Data Flow section**

After the Evolution System block:
```
AI Brain (Python, every 6h + acute on 3+ losses)
  -> Collect: closed trades, open positions, calibration, pipeline stats, capital
  -> Collect: config_changes (48h), evolution_runs (48h), previous brain actions
  -> Call Grok API for analysis + action recommendations
  -> Validate actions against safety bounds (range, delta, min patterns)
  -> Apply: update cryonix.toml + Redis + config_changes + autopilot_actions
  -> Write evolution:directives to Redis (24h TTL) for code-level insights
  -> Send Telegram report
```

**Step 3: Add to Redis key patterns**

Add to the Redis key patterns list:
```
`brain:acute_trigger`, `brain:loss_streak`, `brain:blocked_patterns`, `evolution:directives`
```

**Step 4: Add autopilot_actions to Database Schema list**

Add `autopilot_actions` to the table list.

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add AI Brain to CLAUDE.md"
```

---

### Task 9: Update AGENTS.md with AI Brain entry

**Files:**
- Modify: `AGENTS.md`

**Step 1: Add AI Brain agent entry**

Add a new section for AI Brain between the Evolution Engine and Calibration entries:

```markdown
### 7. AI Brain (`scripts/strategy-lab/ai_brain.py`)
- **Schedule:** Every 6h via cron + acute trigger on 3+ consecutive losses
- **AI:** Grok 3 Mini Fast (analysis + action decisions)
- **Input:** Closed trades, open positions, calibration data, pipeline stats, capital, config changes, evolution runs
- **Output:** Parameter tuning (cryonix.toml), pattern blocking (Redis), evolution directives (Redis), Telegram report
- **Safety:** Bounded ranges per action type, max 4 actions/run, confidence >= 0.7 to auto-apply
- **Communication:** Writes `evolution:directives` to Redis for Evolution Engine
```

**Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: add AI Brain to AGENTS.md"
```

---

### Task 10: Deploy and verify end-to-end

**Step 1: Rebuild and restart affected containers**

The auto-trade route change needs a web container rebuild:
```bash
cd /home/azureuser/cryonix && docker compose -f docker-compose.prod.yml build web && docker compose -f docker-compose.prod.yml up -d web
```

**Step 2: Verify containers running**

Run:
```bash
docker compose -f docker-compose.prod.yml ps --format "table {{.Name}}\t{{.Status}}"
```

Expected: All containers running/healthy.

**Step 3: Test auto-trade route still works**

Run:
```bash
curl -s http://localhost:80/api/auto-trade | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('success') else 'FAIL')"
```

Expected: `OK`

**Step 4: Verify cron is set**

Run:
```bash
crontab -l | grep -c brain
```

Expected: `2` (regular + acute)

**Step 5: Push all commits**

```bash
git push
```

**Step 6: Final commit summary**

Run:
```bash
git log --oneline -10
```
