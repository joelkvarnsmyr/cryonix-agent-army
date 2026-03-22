# Huntrix Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an autonomous Brain agent to Huntrix that analyzes trade performance and adjusts `huntrix.toml` parameters, force-exits positions, and restarts the runner — following the established Aktienix Brain pattern.

**Architecture:** Brain runs in its own Docker container (`huntrix-brain`), using Claude Code CLI (`claude -p`) as the reasoning engine. A trigger loop checks every 60s for scheduled (6h intervals) or acute (2+ losses, 10%+ daily loss) conditions. Data is collected from Redis, piped to Claude via stdin, and actions are validated against safety bounds before applying.

**Tech Stack:** TypeScript, ioredis, Claude Code CLI, Docker, `@iarna/toml`

**Spec:** `docs/superpowers/specs/2026-03-22-huntrix-brain-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/agents/src/huntrix/brain-actions.ts` | Validate + apply brain actions (bounds check, TOML read/write, force-exit signal) |
| `packages/agents/src/huntrix/__tests__/brain-actions.test.ts` | Tests for bounds validation and TOML writing |
| `scripts/services/huntrix-brain.ts` | Brain entrypoint — trigger loop, data collection, prompt builder, Claude invocation, action execution |
| `packages/agents/src/huntrix/types.ts` | Add `BrainAction` type |
| `packages/agents/src/huntrix/config.ts` | Add `brain` config section defaults |
| `huntrix.toml` | Add `[brain]` section |
| `Dockerfile.huntrix` | Add git + docker-cli + claude-code CLI |
| `docker-compose.prod.yml` | Add `huntrix-brain` service |
| `packages/agents/src/huntrix/huntrix-agent.ts` | Read `huntrix:brain:force_exit` in tick loop |

---

## Tasks

### Task 1: Types + config for Brain

**Files:**
- Modify: `packages/agents/src/huntrix/types.ts`
- Modify: `packages/agents/src/huntrix/config.ts`
- Modify: `huntrix.toml`

- [ ] **Step 1: Add BrainAction type to types.ts**

Add at the end of `packages/agents/src/huntrix/types.ts`:

```typescript
// ── Brain ──────────────────────────────────────────────────────

export interface BrainAction {
  type: 'adjust_param' | 'force_exit' | 'restart_runner';
  param?: string;       // dot-path e.g. 'exits.stop_loss_pct'
  old_value?: number;
  new_value?: number;
  symbol?: string;      // for force_exit
  reasoning: string;
}

export interface HuntrixBrainConfig {
  enabled: boolean;
  cooldown_minutes: number;
  scheduled_hours: number[];
  acute_consecutive_losses: number;
  acute_daily_loss_pct: number;
}
```

- [ ] **Step 2: Add `brain` to HuntrixConfig interface**

In `packages/agents/src/huntrix/types.ts`, add `brain: HuntrixBrainConfig;` as the last field of the `HuntrixConfig` interface (after the `telegram` field at line ~238).

- [ ] **Step 3: Add brain defaults to config.ts**

In `packages/agents/src/huntrix/config.ts`, add to `HUNTRIX_DEFAULTS` (after the `telegram` block):

```typescript
  brain: {
    enabled: true,
    cooldown_minutes: 60,
    scheduled_hours: [0, 6, 12, 18],
    acute_consecutive_losses: 2,
    acute_daily_loss_pct: 10.0,
  },
```

Also add the deep-merge line in `loadHuntrixConfig()` (after `telegram` merge):

```typescript
      brain: { ...HUNTRIX_DEFAULTS.brain, ...parsed.brain },
```

- [ ] **Step 4: Add [brain] section to huntrix.toml**

Append to `huntrix.toml`:

```toml
[brain]
enabled = true
cooldown_minutes = 60
scheduled_hours = [0, 6, 12, 18]
acute_consecutive_losses = 2
acute_daily_loss_pct = 10.0
```

- [ ] **Step 5: Type check**

Run: `cd packages/agents && npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/huntrix/types.ts packages/agents/src/huntrix/config.ts huntrix.toml
git commit -m "feat(huntrix): add Brain types, config defaults, and TOML section"
```

---

### Task 2: Brain actions — bounds validation + TOML write + tests (6 tests)

**Files:**
- Create: `packages/agents/src/huntrix/brain-actions.ts`
- Create: `packages/agents/src/huntrix/__tests__/brain-actions.test.ts`

- [ ] **Step 1: Write brain-actions.ts**

```typescript
// packages/agents/src/huntrix/brain-actions.ts
// Validates and applies Brain actions against safety bounds

import { readFileSync, writeFileSync } from 'fs';
import { parse, stringify } from '@iarna/toml';
import type { BrainAction } from './types';

// ── Safety Bounds ────────────────────────────────────────────────────────
export const PARAM_BOUNDS: Record<string, { min: number; max: number }> = {
  'exits.stop_loss_pct':                  { min: 1.0, max: 8.0 },
  'exits.take_profit_pct':                { min: 5.0, max: 30.0 },
  'exits.trailing_stop_pct':              { min: 2.0, max: 10.0 },
  'exits.trailing_activation_pct':        { min: 1.0, max: 5.0 },
  'exits.max_hold_minutes':               { min: 10,  max: 60 },
  'exits.dump_velocity_exit_pct_per_min': { min: 1.0, max: 5.0 },
  'exits.volume_reversal_checks':         { min: 2,   max: 5 },
  'exits.shill_drop_tighten_pct':         { min: 30.0, max: 70.0 },
  'exits.shill_tightened_trailing_pct':   { min: 1.0, max: 4.0 },
  'detection.min_volume_spike_multiplier':   { min: 2.0, max: 10.0 },
  'detection.max_entry_velocity_pct_per_min': { min: 5.0, max: 20.0 },
  'detection.min_entry_velocity_pct_per_min': { min: 0.5, max: 3.0 },
  'detection.max_already_pumped_pct':        { min: 10.0, max: 40.0 },
  'detection.max_spread_pct':                { min: 0.3, max: 1.0 },
  'scanner.min_shill_accounts':      { min: 3,   max: 10 },
  'scanner.min_coordination_score':  { min: 40,  max: 80 },
  'capital.max_position_size_usd':   { min: 10,  max: 50 },
  'limits.max_trades_per_day':       { min: 2,   max: 10 },
  'risk.max_daily_loss_pct':         { min: 5.0, max: 25.0 },
};

const FROZEN_PREFIXES = ['general.', 'timing.', 'telegram.', 'scanner.sources.', 'brain.'];
const FROZEN_KEYS = ['detection.phase_window_minutes'];

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateAction(action: BrainAction): ValidationResult {
  if (action.type === 'force_exit') {
    if (!action.symbol) return { valid: false, reason: 'force_exit requires symbol' };
    return { valid: true };
  }
  if (action.type === 'restart_runner') {
    return { valid: true };
  }
  if (action.type === 'adjust_param') {
    const param = action.param;
    if (!param) return { valid: false, reason: 'adjust_param requires param path' };
    if (action.new_value === undefined) return { valid: false, reason: 'adjust_param requires new_value' };

    // Frozen check
    if (FROZEN_PREFIXES.some(p => param.startsWith(p))) {
      return { valid: false, reason: `${param} is frozen — brain cannot modify it` };
    }
    if (FROZEN_KEYS.includes(param)) {
      return { valid: false, reason: `${param} is frozen — brain cannot modify it` };
    }

    // Bounds check
    const bounds = PARAM_BOUNDS[param];
    if (!bounds) return { valid: false, reason: `${param} is not in the adjustable parameters list` };
    if (action.new_value < bounds.min || action.new_value > bounds.max) {
      return { valid: false, reason: `${param} value ${action.new_value} outside bounds [${bounds.min}, ${bounds.max}]` };
    }
    return { valid: true };
  }
  return { valid: false, reason: `Unknown action type: ${action.type}` };
}

/**
 * Apply a validated adjust_param action to huntrix.toml.
 * Returns true if the file was modified.
 */
export function applyParamChange(tomlPath: string, param: string, newValue: number): boolean {
  const raw = readFileSync(tomlPath, 'utf-8');
  const doc = parse(raw) as any;

  const [section, key] = param.split('.');
  if (!doc[section] || doc[section][key] === undefined) {
    console.warn(`[brain-actions] Parameter ${param} not found in TOML`);
    return false;
  }
  if (doc[section][key] === newValue) return false; // no change needed

  doc[section][key] = newValue;
  writeFileSync(tomlPath, stringify(doc));
  return true;
}
```

- [ ] **Step 2: Write tests**

```typescript
// packages/agents/src/huntrix/__tests__/brain-actions.test.ts
import { describe, it, expect } from 'vitest';
import { validateAction, PARAM_BOUNDS } from '../brain-actions';
import type { BrainAction } from '../types';

describe('brain-actions', () => {
  describe('validateAction', () => {
    it('accepts valid adjust_param within bounds', () => {
      const action: BrainAction = {
        type: 'adjust_param',
        param: 'exits.stop_loss_pct',
        old_value: 3.0,
        new_value: 4.0,
        reasoning: 'too many tight SL exits',
      };
      expect(validateAction(action)).toEqual({ valid: true });
    });

    it('rejects adjust_param outside bounds', () => {
      const action: BrainAction = {
        type: 'adjust_param',
        param: 'exits.stop_loss_pct',
        old_value: 3.0,
        new_value: 15.0, // max is 8.0
        reasoning: 'test',
      };
      const result = validateAction(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('outside bounds');
    });

    it('rejects frozen parameter (general.*)', () => {
      const action: BrainAction = {
        type: 'adjust_param',
        param: 'general.capital',
        new_value: 500,
        reasoning: 'more capital',
      };
      const result = validateAction(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('frozen');
    });

    it('rejects frozen parameter (timing.*)', () => {
      const action: BrainAction = {
        type: 'adjust_param',
        param: 'timing.scan_interval_ms',
        new_value: 60000,
        reasoning: 'faster scans',
      };
      const result = validateAction(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('frozen');
    });

    it('accepts valid force_exit with symbol', () => {
      const action: BrainAction = {
        type: 'force_exit',
        symbol: 'PEPE/USDC',
        reasoning: 'position losing heavily',
      };
      expect(validateAction(action)).toEqual({ valid: true });
    });

    it('rejects force_exit without symbol', () => {
      const action: BrainAction = {
        type: 'force_exit',
        reasoning: 'close something',
      };
      const result = validateAction(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('symbol');
    });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/brain-actions.test.ts`
Expected: 6 tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/huntrix/brain-actions.ts packages/agents/src/huntrix/__tests__/brain-actions.test.ts
git commit -m "feat(huntrix): add brain-actions with bounds validation + tests"
```

---

### Task 3: Force-exit in tick loop

**Files:**
- Modify: `packages/agents/src/huntrix/huntrix-agent.ts`

- [ ] **Step 1: Add force-exit check at the top of tick()**

In `packages/agents/src/huntrix/huntrix-agent.ts`, inside the `tick()` method, add this block right after `this.checkDailyReset();` (line 103) and before the position monitoring block (line 105):

```typescript
        // 0. Check brain force-exit signal
        try {
            const forceExitRaw = await this.redis.get('huntrix:brain:force_exit');
            if (forceExitRaw) {
                const { symbol, reason } = JSON.parse(forceExitRaw);
                const pos = this.positions.find(p => p.symbol === symbol);
                if (pos) {
                    console.log(`[HUNTRIX] Brain force-exit: ${symbol} — ${reason}`);
                    await this.closePosition(pos, 'manual');
                    if (this.config.telegram.alert_on_exit) {
                        await this.sendTelegramAlert(
                            `<b>🧠 HUNTRIX BRAIN EXIT</b>\n${symbol}: ${reason}\nP&L: ${pos.unrealized_pnl_pct.toFixed(2)}%`,
                        );
                    }
                }
                await this.redis.del('huntrix:brain:force_exit');
            }
        } catch { /* best effort */ }
```

- [ ] **Step 2: Type check**

Run: `cd packages/agents && npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/huntrix/huntrix-agent.ts
git commit -m "feat(huntrix): add brain force-exit signal handling in tick loop"
```

---

### Task 4: Brain entrypoint script

**Files:**
- Create: `scripts/services/huntrix-brain.ts`

- [ ] **Step 1: Write huntrix-brain.ts**

This is the main brain script. Follow the Aktienix Brain pattern (at `scripts/services/aktienix-brain.ts`).

```typescript
// scripts/services/huntrix-brain.ts
// HuntrixBrain — autonomous parameter optimizer using Claude Code CLI
// Run: npx tsx scripts/services/huntrix-brain.ts

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import Redis from 'ioredis';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { validateAction, applyParamChange, PARAM_BOUNDS } from '../../packages/agents/src/huntrix/brain-actions';
import type { BrainAction } from '../../packages/agents/src/huntrix/types';

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? path.resolve(__dirname, '../..');
const REDIS_URL    = process.env.KV_URL ?? 'redis://localhost:6379';
const BOT_TOKEN    = process.env.TELEGRAM_INTERACTIVE_BOT_TOKEN ?? '';
const CHAT_ID      = process.env.TELEGRAM_CHAT_ID ?? '';
const CLAUDE_MODEL = 'claude-opus-4-6';
const COOLDOWN_MS  = 60 * 60 * 1000;  // 1 hour
const CHECK_INTERVAL_MS = 60_000;     // check every 60s
const TOML_PATH    = path.join(PROJECT_ROOT, 'huntrix.toml');

let isRunning = false;
let redis: Redis;

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('[huntrix-brain] Starting HuntrixBrain...');

    // Init git baseline for huntrix.toml
    try {
        execSync(
            'git init && git config user.email "brain@huntrix" && git config user.name "HuntrixBrain" && ' +
            'git add huntrix.toml && git commit -m "baseline" || true',
            { cwd: PROJECT_ROOT, encoding: 'utf-8' }
        );
        console.log('[huntrix-brain] Git baseline created for huntrix.toml');
    } catch { /* non-fatal */ }

    redis = new Redis(REDIS_URL);
    redis.on('error', err => console.error('[huntrix-brain] Redis error:', err.message));

    // Load brain config from TOML
    let brainConfig = { scheduled_hours: [0, 6, 12, 18], acute_consecutive_losses: 2, acute_daily_loss_pct: 10.0 };
    try {
        const { parse } = await import('@iarna/toml');
        const toml = parse(readFileSync(TOML_PATH, 'utf-8')) as any;
        if (toml.brain) {
            brainConfig = {
                scheduled_hours: toml.brain.scheduled_hours ?? brainConfig.scheduled_hours,
                acute_consecutive_losses: toml.brain.acute_consecutive_losses ?? brainConfig.acute_consecutive_losses,
                acute_daily_loss_pct: toml.brain.acute_daily_loss_pct ?? brainConfig.acute_daily_loss_pct,
            };
        }
    } catch { /* use defaults */ }

    setInterval(() => checkAndRun(brainConfig), CHECK_INTERVAL_MS);
    checkAndRun(brainConfig);
    console.log('[huntrix-brain] Trigger loop started. Checking every 60s.');
}

async function checkAndRun(brainConfig: any) {
    if (isRunning) return;

    const triggerReason = await shouldRun(brainConfig);
    if (!triggerReason) return;

    isRunning = true;
    try {
        await runBrain(triggerReason);
    } finally {
        isRunning = false;
        await redis.set('huntrix:brain:cooldown', '1', 'EX', 3600).catch(() => {});
    }
}

async function shouldRun(brainConfig: any): Promise<string | null> {
    // Cooldown check
    const cooldown = await redis.get('huntrix:brain:cooldown').catch(() => null);
    if (cooldown) return null;

    // Scheduled trigger: check if current UTC hour matches any scheduled hour
    const now = new Date();
    const h = now.getUTCHours();
    const m = now.getUTCMinutes();
    const isScheduled = brainConfig.scheduled_hours.includes(h) && m >= 0 && m < 5;
    if (isScheduled) return 'scheduled';

    // Acute trigger: consecutive losses or daily loss
    const stateRaw = await redis.get('huntrix:state').catch(() => null);
    if (stateRaw) {
        try {
            const state = JSON.parse(stateRaw);
            if ((state.consecutive_losses ?? 0) >= brainConfig.acute_consecutive_losses) {
                return `acute: ${state.consecutive_losses}+ consecutive losses`;
            }
            const balance = state.virtual_balance ?? 100;
            const dailyLoss = Math.abs(state.daily_pnl ?? 0);
            const lossPct = (dailyLoss / balance) * 100;
            if ((state.daily_pnl ?? 0) < 0 && lossPct >= brainConfig.acute_daily_loss_pct) {
                return `acute: daily loss ${lossPct.toFixed(1)}% exceeds ${brainConfig.acute_daily_loss_pct}%`;
            }
        } catch { /* ignore parse errors */ }
    }

    return null;
}

// ── Data Collection ──────────────────────────────────────────────────────────

interface BrainData {
    state: any | null;
    risk: any | null;
    previousRun: string | null;
    currentConfig: string | null;
}

async function collectData(): Promise<BrainData> {
    await redis.ping(); // throws if Redis unreachable

    const stateRaw   = await redis.get('huntrix:state').catch(() => null);
    const riskRaw    = await redis.get('huntrix:risk').catch(() => null);
    const prevRunRaw = await redis.get('huntrix:brain:last_run').catch(() => null);

    function safeParse(raw: string | null): any {
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
    }

    let previousRun: string | null = null;
    if (prevRunRaw) {
        try {
            const prev = JSON.parse(prevRunRaw);
            previousRun = `[${prev.timestamp}] ${prev.analysis} Actions: ${(prev.actions ?? []).join(', ')}`;
        } catch { /* ignore */ }
    }

    let currentConfig: string | null = null;
    try {
        currentConfig = readFileSync(TOML_PATH, 'utf-8');
    } catch { /* non-fatal */ }

    return {
        state: safeParse(stateRaw),
        risk: safeParse(riskRaw),
        previousRun,
        currentConfig,
    };
}

// ── Prompt Builder ───────────────────────────────────────────────────────────

function buildPrompt(data: BrainData, triggerReason: string, runId: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const state = data.state;

    const stateSection = state
        ? JSON.stringify({
            status: state.status,
            virtual_balance: state.virtual_balance,
            daily_pnl: state.daily_pnl,
            trades_today: state.trades_today,
            win_rate: state.win_rate,
            consecutive_losses: state.consecutive_losses,
            positions: (state.positions ?? []).map((p: any) => ({
                symbol: p.symbol,
                entry_price: p.entry_price,
                current_price: p.current_price,
                size_usd: p.size_usd,
                unrealized_pnl_pct: p.unrealized_pnl_pct,
                exit_reason: p.exit_reason,
                signal_type: p.signal?.type,
                signal_source: p.signal?.source,
                entered_at: p.entered_at,
            })),
        }, null, 2)
        : '[agent offline — no state available]';

    const tradesSection = state?.recent_trades && state.recent_trades.length > 0
        ? JSON.stringify(state.recent_trades.slice(0, 50).map((t: any) => ({
            symbol: t.symbol,
            entry_price: t.entry_price,
            exit_price: t.exit_price,
            unrealized_pnl_pct: t.unrealized_pnl_pct,
            exit_reason: t.exit_reason,
            signal_type: t.signal?.type,
            signal_source: t.signal?.source,
            entered_at: t.entered_at,
            exited_at: t.exited_at,
        })), null, 2)
        : '[no closed trades yet]';

    const riskSection = data.risk
        ? JSON.stringify(data.risk, null, 2)
        : '[not available]';

    const configSection = data.currentConfig ?? '[could not read huntrix.toml]';
    const prevSection = data.previousRun ?? 'First run — no prior Brain analysis exists.';

    // Build bounds table for prompt
    const boundsTable = Object.entries(PARAM_BOUNDS)
        .map(([param, b]) => `| \`${param}\` | ${b.min} | ${b.max} |`)
        .join('\n');

    return `# HuntrixBrain — Performance Analysis Run

You are HuntrixBrain, an autonomous parameter optimizer for Huntrix (crypto manipulation detection & ride trader).
Today is ${date}. Run ID: ${runId}. Trigger: ${triggerReason}.

Huntrix detects pump & dump schemes, coordinated shill campaigns, and other manipulation, then rides the early pump phase for profit. It runs 24/7 in paper trading mode.

## Current State
\`\`\`json
${stateSection}
\`\`\`

## Closed Trades (most recent 50)
\`\`\`json
${tradesSection}
\`\`\`

## Risk State
\`\`\`json
${riskSection}
\`\`\`

## Current Config (huntrix.toml)
\`\`\`toml
${configSection}
\`\`\`

## Previous Brain Run
${prevSection}

## Your Job

Analyse Huntrix trading performance and decide whether config adjustments are needed. Be conservative — only change parameters when the data clearly justifies it.

### Analysis Framework
1. **Win rate per exit type** — Which exits trigger most? SL too tight → raise SL. TP too tight → raise TP. Max hold hit often → consider raising it.
2. **Win rate per signal source** — Does Grok X-scan perform better than Telegram clusters? Adjust min_shill_accounts or min_coordination_score.
3. **Hold time distribution** — Trades hitting max_hold_minutes? Raise it. Quick exits? Lower it.
4. **Velocity & volume thresholds** — Filtering too many good signals? Loosen. Letting in noise? Tighten.
5. **Consider reverting previous Brain changes** if they didn't help or made things worse.

### Parameter Bounds (hard limits — rejection if outside)
| Parameter | Min | Max |
|-----------|-----|-----|
${boundsTable}

### Frozen Parameters (DO NOT touch)
- \`general.*\`, \`timing.*\`, \`telegram.*\`, \`scanner.sources.*\`, \`brain.*\`
- \`detection.phase_window_minutes\`

### What You CAN Do
- Edit \`huntrix.toml\` parameters within bounds (1-2 changes per run max)
- Force-exit a position by writing to Redis: \`redis-cli SET huntrix:brain:force_exit '{"symbol":"SYMBOL/USDC","reason":"your reason"}' EX 300\`
  - Only force-exit if: unrealized_pnl_pct < -5% OR position held > 25min with negative P&L

### What You CANNOT Do
- Open new positions or place buy orders
- Change frozen parameters
- Exceed parameter bounds
- Make changes without clear data-backed reasoning

### What Is Handled Automatically (do NOT do these)
- Git commit of huntrix.toml (automatic after your run)
- Docker restart of the huntrix runner (automatic after your run)
- Telegram report (automatic after your run)

## Output

After your analysis, print this exact block:

\`\`\`
BRAIN_SUMMARY_START
Trigger: ${triggerReason}
Actions: [comma-separated list of what you changed, or "none"]
Analysis: [2-3 sentences: what you observed, your diagnosis, and what you did/didn't change and why]
BRAIN_SUMMARY_END
\`\`\`
`;
}

// ── Run Brain ────────────────────────────────────────────────────────────────

async function runBrain(triggerReason: string) {
    const runId = `brain_${Date.now()}`;
    console.log(`\n[huntrix-brain] === Run ${runId} (${triggerReason}) ===`);

    // 1. Collect data
    let data: BrainData;
    try {
        data = await collectData();
    } catch (err: any) {
        console.error('[huntrix-brain] Data collection failed:', err.message);
        await sendTelegram(`🧠 HuntrixBrain\n\n⚠️ Run aborted — data collection failed: ${err.message}`);
        return;
    }

    // 2. Build prompt + write to temp file
    const prompt = buildPrompt(data, triggerReason, runId);
    const promptPath = path.join(tmpdir(), `huntrix-brain-${runId}.md`);
    writeFileSync(promptPath, prompt);

    // 3. Run Claude Code CLI
    console.log('[huntrix-brain] Invoking Claude Code CLI...');
    let claudeOutput = '';
    try {
        claudeOutput = execSync(
            `cat "${promptPath}" | claude -p ` +
            `--model ${CLAUDE_MODEL} ` +
            `--allowedTools 'Edit,Read,Glob,Grep,Bash'`,
            { timeout: 300_000, cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        );
        console.log('[huntrix-brain] Claude finished.');
    } catch (err: any) {
        console.error('[huntrix-brain] Claude CLI failed:', err.message);
        await sendTelegram(`🧠 HuntrixBrain\n\n❌ Claude CLI failed (${triggerReason}):\n${err.message.slice(0, 200)}`);
        return;
    } finally {
        try { unlinkSync(promptPath); } catch { /* ignore */ }
    }

    // 4. Parse summary block
    const summaryMatch = claudeOutput.match(/BRAIN_SUMMARY_START\n([\s\S]*?)BRAIN_SUMMARY_END/);
    if (!summaryMatch) {
        console.warn('[huntrix-brain] WARNING: No BRAIN_SUMMARY block found in Claude output.');
    }
    const summaryRaw = summaryMatch?.[1] ?? '';
    const actionLine  = summaryRaw.match(/^Actions: (.+)$/m)?.[1] ?? 'none';
    const analysisLine = summaryRaw.match(/^Analysis: (.+)$/m)?.[1] ?? '(no analysis)';
    const actions = actionLine === 'none' ? [] : actionLine.split(',').map(s => s.trim());

    // 5. Check if huntrix.toml was modified, commit + restart if so
    let filesChanged = '';
    try {
        filesChanged = execSync('git diff --stat HEAD -- huntrix.toml', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    } catch { /* non-fatal */ }
    const tomlChanged = filesChanged.includes('huntrix.toml');

    if (tomlChanged) {
        try {
            execSync(
                `git add huntrix.toml && git commit -m "brain(${runId}): ${actions.join(', ')}"`,
                { cwd: PROJECT_ROOT, encoding: 'utf-8' }
            );
            console.log('[huntrix-brain] Committed huntrix.toml changes.');
        } catch (e: any) { console.error('[huntrix-brain] git commit failed:', e.message); }

        try {
            execSync('docker restart huntrix', { timeout: 30_000, encoding: 'utf-8' });
            console.log('[huntrix-brain] Restarted huntrix runner.');
        } catch (e: any) { console.error('[huntrix-brain] docker restart failed:', e.message); }
    }
    const filesLine = tomlChanged ? 'huntrix.toml (committed + runner restarted)' : 'none';

    // 6. Store last_run in Redis (48h TTL)
    const lastRunData = {
        runId,
        trigger: triggerReason,
        timestamp: new Date().toISOString(),
        analysis: analysisLine,
        actions,
    };
    await redis.set('huntrix:brain:last_run', JSON.stringify(lastRunData), 'EX', 172800);

    // 7. Telegram report
    const state = data.state;
    const balance = state?.virtual_balance ?? 0;
    const winRate = state?.win_rate ?? 0;
    const totalTrades = data.risk?.totalTrades ?? 0;

    const actionsText = actions.length > 0
        ? actions.map(a => `✅ ${a}`).join('\n')
        : '— No changes made';

    // Next scheduled run
    const now = new Date();
    const nextHour = [0, 6, 12, 18].find(h => h > now.getUTCHours()) ?? 0;
    const nextScheduled = nextHour > now.getUTCHours()
        ? `Today ${now.toISOString().slice(0, 10)} ${String(nextHour).padStart(2, '0')}:00 UTC`
        : `Tomorrow ${String(nextHour).padStart(2, '0')}:00 UTC`;

    const report = [
        `🧠 HuntrixBrain — ${triggerReason.startsWith('acute') ? 'Acute' : 'Scheduled'} Report`,
        '',
        `📊 Balance: $${balance.toFixed(2)} | WR: ${winRate.toFixed(0)}% (${totalTrades} trades)`,
        `⚠️  Trigger: ${triggerReason}`,
        '',
        analysisLine,
        '',
        actionsText,
        '',
        `Files changed: ${filesLine}`,
        `Next scheduled: ${nextScheduled}`,
    ].join('\n');

    await sendTelegram(report);
    console.log('[huntrix-brain] Run complete.');
}

// ── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text: string) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.log('[huntrix-brain] Telegram not configured — skipping.');
        return;
    }
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHAT_ID, text }),
        });
    } catch (err: any) {
        console.error('[huntrix-brain] Telegram failed:', err.message);
    }
}

// ── Entry ────────────────────────────────────────────────────────────────────
main().catch(err => {
    console.error('[huntrix-brain] Fatal:', err.message);
    process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/services/huntrix-brain.ts
git commit -m "feat(huntrix): add brain entrypoint script"
```

---

### Task 5: Docker setup

**Files:**
- Modify: `Dockerfile.huntrix`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Update Dockerfile.huntrix**

Replace the entire `Dockerfile.huntrix` with:

```dockerfile
# Dockerfile.huntrix — Huntrix — Manipulation Detection & Ride Trader
FROM node:20-alpine

WORKDIR /app

# System packages for brain (git for commits, docker-cli for restart)
RUN apk add --no-cache git docker-cli

# Install runtime dependencies
RUN npm install --no-save \
    @iarna/toml@2 \
    dotenv@16 \
    ioredis@5 \
    openai@4 \
    ccxt@4 \
    tsx@4 \
    typescript@5

# Install Claude Code CLI (for brain)
RUN npm install -g @anthropic-ai/claude-code

# Stub for @cryonix/types — all imports are `import type` (erased by tsx at runtime)
RUN mkdir -p node_modules/@cryonix/types && \
    echo '{"name":"@cryonix/types","version":"1.0.0","main":"index.js"}' > node_modules/@cryonix/types/package.json && \
    echo 'module.exports = {};' > node_modules/@cryonix/types/index.js

# Copy agent source
COPY packages/agents/src/ ./packages/agents/src/

# Copy runner + brain scripts
COPY scripts/services/huntrix-runner.ts ./scripts/services/
COPY scripts/services/huntrix-brain.ts ./scripts/services/

# Copy config
COPY huntrix.toml ./

CMD ["npx", "tsx", "scripts/services/huntrix-runner.ts"]
```

- [ ] **Step 2: Add huntrix-brain service to docker-compose.prod.yml**

Find the `huntrix:` service block in `docker-compose.prod.yml`. After it, add:

```yaml
  huntrix-brain:
    build:
      context: .
      dockerfile: Dockerfile.huntrix
    container_name: huntrix-brain
    command: ["npx", "tsx", "scripts/services/huntrix-brain.ts"]
    restart: unless-stopped
    volumes:
      - ~/.claude:/root/.claude:ro
      - /var/run/docker.sock:/var/run/docker.sock
      - ./huntrix.toml:/app/huntrix.toml
    environment:
      - NODE_ENV=production
      - KV_URL=redis://redis:6379
      - TELEGRAM_INTERACTIVE_BOT_TOKEN=${TELEGRAM_INTERACTIVE_BOT_TOKEN:-}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
      - PROJECT_ROOT=/app
    depends_on:
      - redis
    networks:
      - cryonix-net
```

Note: Remove the `USER node` line from Dockerfile since brain needs root for Docker socket access.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.huntrix docker-compose.prod.yml
git commit -m "feat(huntrix): add brain Docker setup — Dockerfile + compose service"
```

---

### Task 6: Type check + test run

**Files:** None new — verification only.

- [ ] **Step 1: Run all huntrix tests**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/`
Expected: All tests pass (brain-actions + goplus + defi-llama + rss + orderbook).

- [ ] **Step 2: Full type check**

Run: `npx tsc --noEmit -p packages/agents/tsconfig.json`
Expected: No new errors from our changes.

- [ ] **Step 3: Commit any remaining changes**

If any fixes were needed, commit them.

---

### Task 7: Deploy to VM

- [ ] **Step 1: Merge to main**

```bash
cd /path/to/main/repo
git merge worktree-huntrix-phase1-signals --no-ff -m "merge: huntrix brain implementation"
```

- [ ] **Step 2: Deploy code**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
```

- [ ] **Step 3: Build and start brain container**

```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build huntrix huntrix-brain"
```

- [ ] **Step 4: Verify logs**

```bash
ssh azureuser@openclaw-vm "docker logs huntrix-brain --tail 20"
```

Expected: `[huntrix-brain] Starting HuntrixBrain...` + `Trigger loop started. Checking every 60s.`

- [ ] **Step 5: Verify Redis keys**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli KEYS 'huntrix:brain:*'"
```

Expected: Keys will appear after first brain run (at next scheduled hour or acute trigger).
