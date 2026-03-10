# AktienixBrain Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build AktienixBrain — an autonomous portfolio analysis service that uses Claude Code CLI to analyse trading performance and adjust Aktienix strategy parameters, watchlist, and positions daily.

**Architecture:** A standalone Node/TypeScript service (`scripts/services/aktienix-brain.ts`) that collects state from Redis + Postgres, builds a prompt, and pipes it to `claude -p` as a subprocess (same pattern as `copilot-evolution.mjs`). Claude reads `aktienix.toml` directly, edits it, closes positions via a helper script, and commits changes. Brain itself has no AI logic — it is a data collector and subprocess runner.

**Tech Stack:** TypeScript/tsx, ioredis, pg (node-postgres), @alpacahq/alpaca-trade-api (in close-position.ts), child_process (exec), Claude Code CLI (`claude` binary on VM PATH).

**Spec:** `docs/superpowers/specs/2026-03-10-aktienix-brain-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| CREATE | `scripts/aktienix/close-position.ts` | CLI helper: close one Alpaca position + log to Postgres |
| CREATE | `scripts/services/aktienix-brain.ts` | Main Brain service: collect data, trigger logic, run Claude CLI, report |
| CREATE | `scripts/aktienix/__tests__/close-position.test.ts` | Unit tests for close-position argument parsing and flow |
| MODIFY | `docker-compose.prod.yml` | Add `container_name: aktienix` to aktienix service + add aktienix-brain service |

---

## Chunk 1: close-position.ts helper

### Task 1: Scaffold close-position.ts + argument parsing

**Files:**
- Create: `scripts/aktienix/close-position.ts`

Context: This script is invoked by Claude Code CLI as a Bash tool: `npx tsx scripts/aktienix/close-position.ts AAPL`. It closes the full position for the given symbol and exits 0/1. It reads Alpaca credentials from environment, connects to Alpaca, fetches the current position qty, submits a SELL MARKET order, polls until filled, logs to Postgres, and exits.

Reference the existing pattern in `scripts/aktienix/test-watchlist-curator.ts` for dotenv loading.

- [ ] **Step 1: Write the scaffold with argument parsing and all imports**

```typescript
// scripts/aktienix/close-position.ts
// Usage: npx tsx scripts/aktienix/close-position.ts <SYMBOL>
// Exits 0 on success, 1 on failure.
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client } from 'pg';
import Alpaca from '@alpacahq/alpaca-trade-api';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });

const symbol = process.argv[2]?.toUpperCase();
if (!symbol) {
    console.error('Usage: close-position.ts <SYMBOL>');
    process.exit(1);
}

async function main() {
    console.log(`[close-position] Closing position for ${symbol}...`);
    process.exit(0);
}

main().catch(err => {
    console.error('[close-position] Fatal:', err.message);
    process.exit(1);
});
```

- [ ] **Step 2: Verify the script runs without errors**

```bash
npx tsx scripts/aktienix/close-position.ts AAPL
```
Expected: prints `[close-position] Closing position for AAPL...` and exits 0.

```bash
npx tsx scripts/aktienix/close-position.ts
```
Expected: prints usage error and exits 1.

- [ ] **Step 3: Commit**

```bash
git add scripts/aktienix/close-position.ts
git commit -m "feat(brain): scaffold close-position.ts helper"
```

---

### Task 2: Implement Alpaca connection + position fetch + SELL order

**Files:**
- Modify: `scripts/aktienix/close-position.ts`

- [ ] **Step 1: Implement Alpaca connect + getPosition + createOrder**

Replace the `main()` body with (imports are already at the top from Task 1):

```typescript
async function main() {
    const isPaper = !!process.env.ALPACA_PAPER_API_KEY;
    const apiKey    = isPaper ? process.env.ALPACA_PAPER_API_KEY    : process.env.ALPACA_API_KEY;
    const apiSecret = isPaper ? process.env.ALPACA_PAPER_API_SECRET : process.env.ALPACA_API_SECRET;

    if (!apiKey || !apiSecret) {
        console.error('[close-position] Missing Alpaca credentials in environment.');
        process.exit(1);
    }

    const alpaca = new (Alpaca as any)({
        keyId: apiKey,
        secretKey: apiSecret,
        paper: isPaper, // Paper if ALPACA_PAPER_API_KEY is set, live otherwise
    });

    // 1. Fetch position
    let position: any;
    try {
        position = await alpaca.getPosition(symbol);
    } catch (err: any) {
        console.error(`[close-position] No position found for ${symbol}: ${err.message}`);
        process.exit(1);
    }

    const qty = Math.abs(parseFloat(position.qty));
    const avgEntry = parseFloat(position.avg_entry_price);
    console.log(`[close-position] Found position: ${qty} shares @ $${avgEntry.toFixed(2)}`);

    // 2. Submit SELL MARKET order
    let order: any;
    try {
        order = await alpaca.createOrder({
            symbol,
            qty,
            side: 'sell',
            type: 'market',
            time_in_force: 'day',
        });
    } catch (err: any) {
        console.error(`[close-position] Order submission failed: ${err.message}`);
        process.exit(1);
    }
    console.log(`[close-position] Order submitted: ${order.id} (status: ${order.status})`);

    // 3. Poll until filled (max 30s)
    let filled = order.status === 'filled';
    const deadline = Date.now() + 30_000;
    while (!filled && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        try {
            const updated = await alpaca.getOrder(order.id);
            filled = updated.status === 'filled';
            if (filled) {
                order = updated;
                console.log(`[close-position] Order filled at $${parseFloat(updated.filled_avg_price).toFixed(2)}`);
            }
        } catch { /* ignore polling errors */ }
    }

    if (!filled) {
        console.warn('[close-position] Order not confirmed filled within 30s — proceeding with submission price');
    }

    const fillPrice = filled
        ? parseFloat(order.filled_avg_price ?? avgEntry)
        : avgEntry;

    const realizedPnl = (fillPrice - avgEntry) * qty;
    console.log(`[close-position] Realized P&L: $${realizedPnl.toFixed(2)}`);

    // 4. Log to Postgres
    await logTrade({ symbol, qty, fillPrice, avgEntry, realizedPnl, orderId: order.id, isPaper });

    console.log('[close-position] Done.');
    process.exit(0);
}
```

- [ ] **Step 2: Implement logTrade() with Postgres**

Add before `main()` (imports are already at the top from Task 1):

```typescript
async function logTrade(opts: {
    symbol: string;
    qty: number;
    fillPrice: number;
    avgEntry: number;
    realizedPnl: number;
    orderId: string;
    isPaper: boolean;
}) {
    const pgUrl = process.env.POSTGRES_URL;
    if (!pgUrl) {
        console.warn('[close-position] POSTGRES_URL not set — skipping DB log');
        return;
    }
    const db = new Client({ connectionString: pgUrl });
    try {
        await db.connect();
        await db.query(
            `INSERT INTO aktienix_trades
             (symbol, qty, fill_price, realized_pnl, side, reasoning, timestamp, exit_reason, broker, paper_trading, order_id)
             VALUES ($1, $2, $3, $4, 'SELL', 'Brain intervention', NOW(), 'brain_intervention', 'alpaca', $5, $6)`,
            [opts.symbol, opts.qty, opts.fillPrice, opts.realizedPnl, opts.isPaper, opts.orderId]
        );
        console.log('[close-position] Trade logged to Postgres.');
    } catch (err: any) {
        console.error('[close-position] DB log failed:', err.message);
        // Do not exit 1 — the trade was placed, logging failure is not fatal
    } finally {
        await db.end();
    }
}
```

- [ ] **Step 3: Smoke test against paper account**

```bash
npx tsx scripts/aktienix/close-position.ts SPY
```
Expected: either `[close-position] No position found for SPY: ...` (exits 1 — expected on a fresh paper account with no open position, this is NOT a bug) OR closes the position and logs to Postgres.

This is a live API test — run it manually to verify. No automated test for the full flow (requires real Alpaca account).

- [ ] **Step 4: Commit**

```bash
git add scripts/aktienix/close-position.ts
git commit -m "feat(brain): implement close-position.ts — Alpaca SELL + Postgres logging"
```

---

## Chunk 2: aktienix-brain.ts — data collection + trigger logic

### Task 3: Scaffold aktienix-brain.ts + trigger loop

**Files:**
- Create: `scripts/services/aktienix-brain.ts`

Context: This is a long-running service (like `aktienix-runner.ts`). It checks every 60s whether to run Brain. It uses `ioredis` for Redis (already in the codebase, see `copilot-evolution.mjs`) and `pg` for Postgres. The project root when running in Docker is `/app`.

- [ ] **Step 1: Scaffold with dotenv loading and trigger loop**

```typescript
// scripts/services/aktienix-brain.ts
// AktienixBrain — autonomous portfolio analyst using Claude Code CLI
// Run: npx tsx scripts/services/aktienix-brain.ts

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });

import Redis from 'ioredis';
import { Client as PgClient } from 'pg';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? path.resolve(__dirname, '../..');
const REDIS_URL   = process.env.KV_URL ?? 'redis://localhost:6379';
const PG_URL      = process.env.POSTGRES_URL ?? '';
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID ?? '';
const CLAUDE_MODEL = 'claude-opus-4-6';
const COOLDOWN_MS  = 60 * 60 * 1000; // 1 hour
const CHECK_INTERVAL_MS = 60_000;    // check every 60s

// ET market schedule: 09:00 and 16:30 (hours in ET, 24h)
const SCHEDULED_HOURS_ET = [9, 16]; // 09:00 and 16:30 ET
const SCHEDULED_MINUTE_16 = 30;     // 16:30 specifically

let isRunning = false;
let redis: Redis;

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('[aktienix-brain] Starting AktienixBrain...');
    redis = new Redis(REDIS_URL);

    setInterval(checkAndRun, CHECK_INTERVAL_MS);
    console.log('[aktienix-brain] Trigger loop started. Checking every 60s.');
}

async function checkAndRun() {
    if (isRunning) return;

    const triggerReason = await shouldRun();
    if (!triggerReason) return;

    isRunning = true;
    try {
        await runBrain(triggerReason);
    } finally {
        isRunning = false;
    }
}

async function shouldRun(): Promise<string | null> {
    // Cooldown check
    const lastRun = await redis.get('aktienix:brain:last_run');
    if (lastRun) {
        const lastRunData = JSON.parse(lastRun);
        const lastTs = new Date(lastRunData.timestamp).getTime();
        if (Date.now() - lastTs < COOLDOWN_MS) return null;
    }

    // Scheduled trigger: 09:00 ET or 16:30 ET
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = nowET.getHours();
    const m = nowET.getMinutes();
    const isScheduled = (h === 9 && m === 0) || (h === 16 && m >= 30 && m < 35);
    if (isScheduled) return 'scheduled';

    // Acute trigger: consecutive losses or daily loss > 3%
    const riskRaw  = await redis.get('aktienix:risk');
    const acctRaw  = await redis.get('aktienix:account');
    if (riskRaw && acctRaw) {
        const risk = JSON.parse(riskRaw);
        const acct = JSON.parse(acctRaw);
        const pv   = acct.portfolioValue ?? 0;
        if (risk.consecutiveLosses >= 2) return 'acute: 2+ consecutive losses';
        if (pv > 0 && risk.dailyPnlDollar < -(pv * 0.03)) return 'acute: daily P&L < -3%';
    }

    return null;
}

main().catch(err => {
    console.error('[aktienix-brain] Fatal:', err.message);
    process.exit(1);
});
```

- [ ] **Step 2: Verify the script starts without errors**

```bash
npx tsx scripts/services/aktienix-brain.ts
```
Expected: prints "Starting AktienixBrain..." and "Trigger loop started. Checking every 60s." — stays running. Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add scripts/services/aktienix-brain.ts
git commit -m "feat(brain): scaffold aktienix-brain.ts with trigger loop"
```

---

### Task 4: Implement data collection (Redis + Postgres)

**Files:**
- Modify: `scripts/services/aktienix-brain.ts`

- [ ] **Step 1: Add collectData() function**

Add after the `shouldRun()` function:

```typescript
interface BrainData {
    account: Record<string, any> | null;
    positions: any[] | null;
    risk: Record<string, any> | null;
    previousRun: string | null;
    tradeStats: {
        overall: { totalTrades: number; winRate: number; totalPnl: number };
        bySymbol: Array<{ symbol: string; trades: number; winRate: number; avgPnl: number }>;
    } | null;
}

async function collectData(): Promise<BrainData> {
    // Redis (may be null if agent is idle — 5-min TTL)
    const accountRaw   = await redis.get('aktienix:account').catch(() => null);
    const positionsRaw = await redis.get('aktienix:positions').catch(() => null);
    const riskRaw      = await redis.get('aktienix:risk').catch(() => null);
    const prevRunRaw   = await redis.get('aktienix:brain:last_run').catch(() => null);

    const account   = accountRaw   ? JSON.parse(accountRaw)   : null;
    const positions = positionsRaw ? JSON.parse(positionsRaw) : null;
    const risk      = riskRaw      ? JSON.parse(riskRaw)      : null;

    // Format previous run for prompt
    let previousRun: string | null = null;
    if (prevRunRaw) {
        try {
            const prev = JSON.parse(prevRunRaw);
            previousRun = `[${prev.timestamp}] ${prev.analysis} Actions: ${(prev.actions ?? []).join(', ')}`;
        } catch { /* ignore */ }
    }

    // Postgres: 7-day closed trade stats
    let tradeStats = null;
    if (PG_URL) {
        const db = new PgClient({ connectionString: PG_URL });
        try {
            await db.connect();

            const overall = await db.query(`
                SELECT
                    COUNT(*) AS total_trades,
                    SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS win_rate,
                    COALESCE(SUM(realized_pnl), 0) AS total_pnl
                FROM aktienix_trades
                WHERE side = 'SELL' AND realized_pnl IS NOT NULL
                  AND timestamp > NOW() - INTERVAL '7 days'
            `);

            const bySymbol = await db.query(`
                SELECT
                    symbol,
                    COUNT(*) AS trades,
                    SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS win_rate,
                    AVG(realized_pnl) AS avg_pnl
                FROM aktienix_trades
                WHERE side = 'SELL' AND realized_pnl IS NOT NULL
                  AND timestamp > NOW() - INTERVAL '7 days'
                GROUP BY symbol
                ORDER BY SUM(realized_pnl) ASC
            `);

            const r = overall.rows[0];
            tradeStats = {
                overall: {
                    totalTrades: parseInt(r.total_trades ?? '0'),
                    winRate: parseFloat(r.win_rate ?? '0'),
                    totalPnl: parseFloat(r.total_pnl ?? '0'),
                },
                bySymbol: bySymbol.rows.map(row => ({
                    symbol: row.symbol,
                    trades: parseInt(row.trades),
                    winRate: parseFloat(row.win_rate ?? '0'),
                    avgPnl: parseFloat(row.avg_pnl ?? '0'),
                })),
            };
        } catch (err: any) {
            console.warn('[aktienix-brain] Postgres unavailable:', err.message);
        } finally {
            await db.end().catch(() => {});
        }
    }

    return { account, positions, risk, previousRun, tradeStats };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/services/aktienix-brain.ts
git commit -m "feat(brain): implement collectData() — Redis + Postgres 7-day trade stats"
```

---

### Task 5: Build prompt + invoke Claude Code CLI + parse output

**Files:**
- Modify: `scripts/services/aktienix-brain.ts`

- [ ] **Step 1: Implement buildPrompt() function**

Add after `collectData()`:

```typescript
function buildPrompt(data: BrainData, triggerReason: string, runId: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const accountSection = data.account
        ? JSON.stringify(data.account, null, 2)
        : '[not available — agent idle]';
    const positionsSection = data.positions
        ? JSON.stringify(data.positions, null, 2)
        : '[not available — agent idle]';
    const riskSection = data.risk
        ? JSON.stringify(data.risk, null, 2)
        : '[not available — agent idle]';
    const tradeSection = data.tradeStats
        ? JSON.stringify(data.tradeStats, null, 2)
        : '[no trade data available]';
    const prevSection = data.previousRun ?? 'First run';

    return `# AktienixBrain — Portfolio Analysis Run

You are AktienixBrain, an autonomous portfolio analyst for Aktienix (US stock swing trading).
Today is ${date}. Run ID: ${runId}. Trigger: ${triggerReason}.

## Current State

### Account
\`\`\`json
${accountSection}
\`\`\`

### Open Positions
\`\`\`json
${positionsSection}
\`\`\`

### Risk State
\`\`\`json
${riskSection}
\`\`\`

### Trade Performance (7 days, closed trades only)
\`\`\`json
${tradeSection}
\`\`\`

### Previous Brain Run
${prevSection}

## Your Job

Analyse trading performance and take autonomous corrective actions.

### Config File
Read \`aktienix.toml\` at the project root — that is the live config. Edit it directly if changes are needed.

### What You CAN Change in aktienix.toml:

| Parameter | Allowed range |
|-----------|--------------|
| \`risk.min_confidence\` | 0.30 – 0.75 |
| \`limits.max_open_positions\` | 1 – 8 |
| \`capital.max_capital_per_trade_pct\` | 0.05 – 0.25 |
| \`exits.stop_loss_pct\` | current value ±20% |
| \`exits.take_profit_pct\` | current value ±20% |
| symbols in \`[watchlist]\` section | add up to 10, remove if no open position |

### What You CAN Do:
- Edit \`aktienix.toml\` to adjust the parameters above
- Run \`npx tsx scripts/aktienix/close-position.ts SYMBOL\` to close a position
  - Only close if: unrealizedPl% < –5% OR position age > 5 days
- Run \`docker restart aktienix\` AFTER editing aktienix.toml (so trading agent reloads config)
- Run \`git add aktienix.toml && git commit -m "brain(${runId}): <description>"\` to commit

### What You CANNOT Do:
- Open new positions
- Change \`intelligence.*\` or \`broker.*\` settings
- Exceed the parameter bounds above
- Use git add -A or stage files other than aktienix.toml

## Output

After completing your analysis and actions, print this summary block:

\`\`\`
BRAIN_SUMMARY_START
Trigger: ${triggerReason}
Actions: [comma-separated list of actions taken, or "none"]
Analysis: [2-3 sentences summarising what you found and did]
BRAIN_SUMMARY_END
\`\`\`
`;
}
```

- [ ] **Step 2: Implement runBrain() — invokes Claude CLI and parses output**

Add after `buildPrompt()`:

```typescript
async function runBrain(triggerReason: string) {
    const runId = `brain_${Date.now()}`;
    console.log(`\n[aktienix-brain] === Run ${runId} (${triggerReason}) ===`);

    // 1. Collect data
    let data: BrainData;
    try {
        data = await collectData();
    } catch (err: any) {
        console.error('[aktienix-brain] Data collection failed:', err.message);
        await sendTelegram(`🧠 AktienixBrain\n\n⚠️ Run aborted — data collection failed: ${err.message}`);
        return;
    }

    // 2. Build prompt + write to temp file
    const prompt = buildPrompt(data, triggerReason, runId);
    const promptPath = path.join(tmpdir(), `aktienix-brain-${runId}.md`);
    writeFileSync(promptPath, prompt);

    // 3. Run Claude Code CLI
    console.log('[aktienix-brain] Invoking Claude Code CLI...');
    let claudeOutput = '';
    try {
        claudeOutput = execSync(
            `cat "${promptPath}" | CLAUDECODE= claude -p ` +
            `--model ${CLAUDE_MODEL} ` +
            `--allowedTools 'Edit,Read,Glob,Grep,` +
            `Bash(npx tsx scripts/aktienix/close-position.ts),` +
            `Bash(docker restart aktienix),` +
            `Bash(git add aktienix.toml),Bash(git commit)' ` +
            `--max-budget-usd 3`,
            { timeout: 300_000, cwd: PROJECT_ROOT, encoding: 'utf-8' }
        );
        console.log('[aktienix-brain] Claude finished.');
    } catch (err: any) {
        console.error('[aktienix-brain] Claude CLI failed:', err.message);
        await sendTelegram(`🧠 AktienixBrain\n\n❌ Claude CLI failed (${triggerReason}):\n${err.message.slice(0, 200)}`);
        return;
    } finally {
        try { unlinkSync(promptPath); } catch { /* ignore */ }
    }

    // 4. Parse summary block
    const summaryMatch = claudeOutput.match(/BRAIN_SUMMARY_START\n([\s\S]*?)BRAIN_SUMMARY_END/);
    if (!summaryMatch) {
        console.warn('[aktienix-brain] WARNING: No BRAIN_SUMMARY block found in Claude output — Claude may have crashed or skipped the summary.');
    }
    const summaryRaw = summaryMatch?.[1] ?? '';
    const actionLine  = summaryRaw.match(/^Actions: (.+)$/m)?.[1] ?? 'none';
    const analysisLine = summaryRaw.match(/^Analysis: (.+)$/m)?.[1] ?? '(no analysis)';
    const actions = actionLine === 'none' ? [] : actionLine.split(',').map(s => s.trim());

    // 5. Check which files were changed
    let filesChanged = '';
    try {
        filesChanged = execSync('git diff --stat HEAD~1 HEAD -- aktienix.toml', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    } catch { /* git diff can fail if no commits yet; non-fatal */ }
    const filesLine = filesChanged.includes('aktienix.toml') ? 'aktienix.toml' : 'none';

    // 6. Store last_run in Redis (48h TTL)
    const lastRunData = {
        runId,
        trigger: triggerReason,
        timestamp: new Date().toISOString(),
        analysis: analysisLine,
        actions,
    };
    await redis.set('aktienix:brain:last_run', JSON.stringify(lastRunData), 'EX', 172800);

    // 7. Telegram report
    const actionsText = actions.length > 0
        ? actions.map(a => `✅ ${a}`).join('\n')
        : '— No changes made';

    const portfolioValue = data.account?.portfolioValue;
    const portfolioLine = typeof portfolioValue === 'number'
        ? `📊 Portfolio: $${portfolioValue.toFixed(2)}`
        : '📊 Portfolio: [data unavailable]';

    // Compute next scheduled run time (next 09:00 or 16:30 ET)
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = nowET.getHours();
    let nextScheduled: string;
    if (h < 9) {
        nextScheduled = `Today ${nowET.toLocaleDateString('en-US')} 09:00 ET`;
    } else if (h < 16 || (h === 16 && nowET.getMinutes() < 30)) {
        nextScheduled = `Today ${nowET.toLocaleDateString('en-US')} 16:30 ET`;
    } else {
        const tomorrow = new Date(nowET);
        tomorrow.setDate(tomorrow.getDate() + 1);
        nextScheduled = `Tomorrow ${tomorrow.toLocaleDateString('en-US')} 09:00 ET`;
    }

    const report = [
        `🧠 AktienixBrain — ${triggerReason.startsWith('acute') ? 'Acute' : 'Scheduled'} Report`,
        '',
        portfolioLine,
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
    console.log('[aktienix-brain] Run complete.');
}

async function sendTelegram(text: string) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.log('[aktienix-brain] Telegram not configured — skipping.');
        return;
    }
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
        });
    } catch (err: any) {
        console.error('[aktienix-brain] Telegram failed:', err.message);
    }
}
```

- [ ] **Step 3: Verify the script compiles (type-check)**

```bash
pnpm --filter @cryonix/agents exec tsc --noEmit 2>/dev/null; npx tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Or simply test it starts without crashing:
```bash
npx tsx scripts/services/aktienix-brain.ts &
sleep 3
kill %1
```
Expected: starts and prints "Trigger loop started" with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/services/aktienix-brain.ts
git commit -m "feat(brain): implement buildPrompt(), runBrain(), sendTelegram() in aktienix-brain.ts"
```

---

## Chunk 3: Docker deployment

### Task 6: Add container_name + aktienix-brain service to docker-compose.prod.yml

**Files:**
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Add `container_name: aktienix` to the existing aktienix service**

Find the existing `aktienix:` service block in `docker-compose.prod.yml`. Add `container_name: aktienix` as the first line under the service key:

```yaml
aktienix:
  container_name: aktienix   # required — brain uses `docker restart aktienix`
  build:
    context: .
    dockerfile: Dockerfile.scripts
  restart: unless-stopped
  # ... rest unchanged
```

- [ ] **Step 2: Add the new aktienix-brain service at the end of the services block**

After the `aktienix:` service and before the `caddy:` service, add:

```yaml
  # ============================================================
  # AktienixBrain — Claude Code CLI autonomous portfolio analyst
  # ============================================================

  aktienix-brain:
    container_name: aktienix-brain
    build:
      context: .
      dockerfile: Dockerfile.scripts
    restart: unless-stopped
    command: ["npx", "tsx", "scripts/services/aktienix-brain.ts"]
    volumes:
      - ./aktienix.toml:/app/aktienix.toml  # read-write (Brain edits config)
      - /var/run/docker.sock:/var/run/docker.sock  # for docker restart aktienix
    environment:
      - NODE_ENV=production
      - KV_URL=redis://redis:6379
      - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD:-password}@postgres:5432/cryonix
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_INTERACTIVE_BOT_TOKEN}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
      - ALPACA_PAPER_API_KEY=${ALPACA_PAPER_API_KEY}
      - ALPACA_PAPER_API_SECRET=${ALPACA_PAPER_API_SECRET}
      - ALPACA_API_KEY=${ALPACA_API_KEY:-}
      - ALPACA_API_SECRET=${ALPACA_API_SECRET:-}
      - PROJECT_ROOT=/app
    networks:
      - cryonix-net
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy
```

- [ ] **Step 3: Validate docker-compose syntax**

```bash
docker compose -f docker-compose.prod.yml config > /dev/null && echo "VALID" || echo "INVALID"
```
Expected: prints `VALID`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat(brain): add aktienix-brain Docker service + container_name to aktienix"
```

---

## Chunk 4: End-to-end smoke test

### Task 7: Manual trigger smoke test

**Files:**
- Read: `scripts/services/aktienix-brain.ts` (to understand what to check)

This task verifies the full pipeline without waiting for a scheduled trigger. Run Brain manually by temporarily lowering the cooldown or injecting a trigger condition.

- [ ] **Step 1: Force a Brain run by clearing the cooldown key**

Note: The Redis helpers below use `docker exec` to avoid CJS/ESM import issues in the workspace.

```bash
# In a separate terminal, start Brain
npx tsx scripts/services/aktienix-brain.ts &

# Clear any existing cooldown (runs inside Redis container)
docker exec cryonix-redis-1 redis-cli DEL aktienix:brain:last_run

# Inject acute trigger condition
docker exec cryonix-redis-1 redis-cli SET aktienix:risk '{"consecutiveLosses":3,"dailyPnlDollar":-500,"weeklyPnlDollar":-800,"tradesToday":5,"dayTradesThisWeek":2}' EX 300
docker exec cryonix-redis-1 redis-cli SET aktienix:account '{"portfolioValue":10000,"buyingPower":5000,"settledCash":5000}' EX 300
echo "Risk state injected"
```

- [ ] **Step 2: Observe Brain output**

Wait up to 90 seconds. Expected terminal output:
```
[aktienix-brain] === Run brain_XXXXX (acute: 2+ consecutive losses) ===
[aktienix-brain] Invoking Claude Code CLI...
[aktienix-brain] Claude finished.
[aktienix-brain] Run complete.
```

And a Telegram message should arrive (if bot token + chat ID configured).

- [ ] **Step 3: Verify Redis last_run was stored with correct TTL**

```bash
# Check value
docker exec cryonix-redis-1 redis-cli GET aktienix:brain:last_run

# Check TTL — must be close to 172800 (48h)
docker exec cryonix-redis-1 redis-cli TTL aktienix:brain:last_run
```
Expected: JSON object with `runId`, `trigger`, `timestamp`, `analysis`, `actions`. TTL should be between 172000 and 172800.

- [ ] **Step 4: Stop the test process**

```bash
kill %1
```

- [ ] **Step 5: Commit if any fixes were needed during smoke test**

```bash
git add scripts/services/aktienix-brain.ts scripts/aktienix/close-position.ts
git commit -m "fix(brain): smoke test fixes"
```

---

## Done

When all tasks complete:
- `close-position.ts` closes Alpaca positions and logs to `aktienix_trades` with `exit_reason = 'brain_intervention'`
- `aktienix-brain.ts` runs on schedule (09:00 ET + 16:30 ET) and on acute triggers (2+ losses or -3% daily)
- Claude Code CLI autonomously reads `aktienix.toml`, makes justified parameter adjustments, and optionally closes bad positions
- Changes committed to git via `git add aktienix.toml && git commit`
- Trading agent restarted via `docker restart aktienix` to pick up config changes
- Telegram report sent after every run

## Notes for Implementer

- `ioredis` is available as a dev dependency via the workspace. If `require('ioredis')` fails, add it: `pnpm add ioredis --filter <scripts-pkg>` or use the raw TCP client pattern from `state-publisher.ts`.
- The `claude` binary must be on PATH inside the Docker container. Verify: `which claude` in the container before deploying.
- Paper trading vs live: `close-position.ts` currently hardcodes `paper: true` in the Alpaca constructor for safety, same as `alpaca-client.ts`. This is intentional.
- If `PROJECT_ROOT` env var is not set (local dev), the script defaults to two directories up from `scripts/services/`, which resolves to the repo root.
