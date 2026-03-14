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
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? path.resolve(__dirname, '../..');
const REDIS_URL    = process.env.KV_URL ?? 'redis://localhost:6379';
const PG_URL       = process.env.POSTGRES_URL ?? '';
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID      = process.env.TELEGRAM_CHAT_ID ?? '';
const CLAUDE_MODEL  = 'claude-opus-4-6';
const COOLDOWN_MS   = 60 * 60 * 1000; // 1 hour
const CHECK_INTERVAL_MS = 60_000;     // check every 60s

let isRunning = false;
let redis: Redis;

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('[aktienix-brain] Starting AktienixBrain...');

    // Init git repo + seed baseline for aktienix.toml so Brain can track changes
    try {
        execSync(
            'git init && git config user.email "brain@aktienix" && git config user.name "AktienixBrain" && ' +
            'git add aktienix.toml && git commit -m "baseline" || true',
            { cwd: PROJECT_ROOT, encoding: 'utf-8' }
        );
        console.log('[aktienix-brain] Git baseline created for aktienix.toml');
    } catch { /* non-fatal */ }

    redis = new Redis(REDIS_URL);
    redis.on('error', err => console.error('[aktienix-brain] Redis error:', err.message));

    setInterval(checkAndRun, CHECK_INTERVAL_MS);
    checkAndRun(); // Also check immediately on startup
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
        // Always write cooldown timestamp — even on failure — to prevent retry spam.
        // runBrain() writes a richer last_run on success; this is the fallback for failures.
        await redis.set('aktienix:brain:cooldown', '1', 'EX', 3600).catch(() => {});
    }
}

async function shouldRun(): Promise<string | null> {
    // Cooldown check — separate key with 1h TTL (survives CLI failures)
    const cooldown = await redis.get('aktienix:brain:cooldown').catch(() => null);
    if (cooldown) return null;

    // Scheduled trigger: 09:00 ET or 16:30 ET
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = nowET.getHours();
    const m = nowET.getMinutes();
    const isScheduled = (h === 9 && m >= 0 && m < 5) || (h === 16 && m >= 30 && m < 35);
    if (isScheduled) return 'scheduled';

    // Acute trigger: consecutive losses or daily loss > 3%
    const riskRaw = await redis.get('aktienix:risk');
    const acctRaw = await redis.get('aktienix:account');
    if (riskRaw && acctRaw) {
        let risk: any, acct: any;
        try { risk = JSON.parse(riskRaw); acct = JSON.parse(acctRaw); } catch { return null; }
        const pv   = acct.portfolioValue ?? 0;
        if (risk.consecutiveLosses >= 2) return 'acute: 2+ consecutive losses';
        if (pv > 0 && risk.dailyPnlDollar < -(pv * 0.03)) return 'acute: daily P&L < -3%';
    }

    return null;
}

interface BrainData {
    account: Record<string, any> | null;
    positions: any[] | null;
    risk: Record<string, any> | null;
    previousRun: string | null;
    tradeStats: {
        overall: { totalTrades: number; winRate: number; totalPnl: number };
        bySymbol: Array<{ symbol: string; trades: number; winRate: number; avgPnl: number }>;
    } | null;
    recentTrades: Array<Record<string, any>> | null;
    currentConfig: Record<string, any> | null;
    marketStatus: string;
}

async function collectData(): Promise<BrainData> {
    // Verify Redis is reachable — spec requires aborting if Redis is down
    await redis.ping(); // throws if Redis unreachable → runBrain() catches and aborts

    // Redis (may be null if agent is idle — 5-min TTL)
    const accountRaw   = await redis.get('aktienix:account').catch(() => null);
    const positionsRaw = await redis.get('aktienix:positions').catch(() => null);
    const riskRaw      = await redis.get('aktienix:risk').catch(() => null);
    const prevRunRaw   = await redis.get('aktienix:brain:last_run').catch(() => null);

    function safeParse(raw: string | null): any {
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
    }
    let account   = safeParse(accountRaw);
    let positions = safeParse(positionsRaw);
    const risk      = safeParse(riskRaw);

    // Format previous run for prompt
    let previousRun: string | null = null;
    if (prevRunRaw) {
        try {
            const prev = JSON.parse(prevRunRaw);
            previousRun = `[${prev.timestamp}] ${prev.analysis} Actions: ${(prev.actions ?? []).join(', ')}`;
        } catch { /* ignore */ }
    }

    // Fallback: query Alpaca directly if Redis is stale (market closed / agent idle)
    if (!account || !positions) {
        try {
            const isPaper = !process.env.ALPACA_API_KEY;
            const key = isPaper ? process.env.ALPACA_PAPER_API_KEY : process.env.ALPACA_API_KEY;
            const secret = isPaper ? process.env.ALPACA_PAPER_API_SECRET : process.env.ALPACA_API_SECRET;
            const baseUrl = isPaper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';

            if (key && secret) {
                const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };

                if (!account) {
                    const res = await fetch(`${baseUrl}/v2/account`, { headers });
                    if (res.ok) {
                        const a = await res.json() as any;
                        account = {
                            portfolioValue: parseFloat(a.portfolio_value),
                            cash: parseFloat(a.cash),
                            buyingPower: parseFloat(a.buying_power),
                            settledCash: parseFloat(a.cash), // approximate
                            isPatternDayTrader: a.pattern_day_trader,
                        };
                    }
                }
                if (!positions) {
                    const res = await fetch(`${baseUrl}/v2/positions`, { headers });
                    if (res.ok) {
                        const posArr = await res.json() as any[];
                        positions = posArr.map(p => ({
                            symbol: p.symbol,
                            qty: parseFloat(p.qty),
                            avgEntryPrice: parseFloat(p.avg_entry_price),
                            marketValue: parseFloat(p.market_value),
                            unrealizedPl: parseFloat(p.unrealized_pl),
                            unrealizedPlpc: parseFloat(p.unrealized_plpc),
                            currentPrice: parseFloat(p.current_price),
                        }));
                    }
                }
                console.log('[aktienix-brain] Used Alpaca API fallback for account/positions.');
            }
        } catch (e: any) {
            console.warn('[aktienix-brain] Alpaca fallback failed:', e.message);
        }
    }

    // Market status (ET)
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = nowET.getHours();
    const m = nowET.getMinutes();
    const dayOfWeek = nowET.getDay(); // 0=Sun, 6=Sat
    let marketStatus: string;
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        marketStatus = 'CLOSED (weekend)';
    } else if (h < 9 || (h === 9 && m < 30)) {
        marketStatus = `PRE-MARKET (opens ${9}:30 ET, currently ${h}:${String(m).padStart(2, '0')} ET)`;
    } else if (h >= 16) {
        marketStatus = `AFTER-HOURS (closed at 16:00 ET, currently ${h}:${String(m).padStart(2, '0')} ET)`;
    } else {
        marketStatus = `OPEN (${h}:${String(m).padStart(2, '0')} ET)`;
    }

    // Read current config values from aktienix.toml
    let currentConfig: Record<string, any> | null = null;
    try {
        const tomlPath = path.join(PROJECT_ROOT, 'aktienix.toml');
        const tomlText = readFileSync(tomlPath, 'utf-8');

        // Extract key values with regex (avoids needing TOML parser in brain)
        const extract = (pattern: RegExp): string | null => {
            const match = tomlText.match(pattern);
            return match ? match[1].trim() : null;
        };
        currentConfig = {
            min_confidence: extract(/min_confidence\s*=\s*([\d.]+)/),
            max_open_positions: extract(/max_open_positions\s*=\s*(\d+)/),
            max_capital_per_trade_pct: extract(/max_capital_per_trade_pct\s*=\s*([\d.]+)/),
            stop_loss_pct: extract(/stop_loss_pct\s*=\s*([\d.]+)/),
            take_profit_pct: extract(/take_profit_pct\s*=\s*([\d.]+)/),
            max_trades_per_day: extract(/^max_trades_per_day\s*=\s*(\d+)/m),
            max_daily_loss_pct: extract(/max_daily_loss_pct\s*=\s*([\d.]+)/),
            trailing_stop_pct: extract(/trailing_stop_pct\s*=\s*([\d.]+)/),
            paper_trading: extract(/paper_trading\s*=\s*(true|false)/),
        };
    } catch { /* non-fatal */ }

    // Postgres: 7-day trade stats + recent individual trades
    let tradeStats = null;
    let recentTrades: Array<Record<string, any>> | null = null;
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

            // Recent individual trades (last 20) — gives Brain detail on what happened
            const recent = await db.query(`
                SELECT symbol, side, qty, fill_price, dollar_amount, realized_pnl,
                       confidence, exit_reason, timestamp
                FROM aktienix_trades
                WHERE timestamp > NOW() - INTERVAL '7 days'
                ORDER BY timestamp DESC
                LIMIT 20
            `);

            const r = overall.rows[0];
            tradeStats = {
                overall: {
                    totalTrades: parseInt(r.total_trades ?? '0', 10),
                    winRate: parseFloat(r.win_rate ?? '0'),
                    totalPnl: parseFloat(r.total_pnl ?? '0'),
                },
                bySymbol: bySymbol.rows.map(row => ({
                    symbol: row.symbol,
                    trades: parseInt(row.trades, 10),
                    winRate: parseFloat(row.win_rate ?? '0'),
                    avgPnl: parseFloat(row.avg_pnl ?? '0'),
                })),
            };
            recentTrades = recent.rows.length > 0 ? recent.rows : null;
        } catch (err: any) {
            console.warn('[aktienix-brain] Postgres unavailable:', err.message);
        } finally {
            await db.end().catch(() => {});
        }
    }

    return { account, positions, risk, previousRun, tradeStats, recentTrades, currentConfig, marketStatus };
}

function buildPrompt(data: BrainData, triggerReason: string, runId: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const accountSection = data.account
        ? JSON.stringify(data.account, null, 2)
        : '[not available — agent idle or market closed]';
    const positionsSection = data.positions && data.positions.length > 0
        ? JSON.stringify(data.positions, null, 2)
        : '[] (no open positions)';
    const riskSection = data.risk
        ? JSON.stringify(data.risk, null, 2)
        : '[not available — agent idle or market closed]';
    const tradeSection = data.tradeStats && data.tradeStats.overall.totalTrades > 0
        ? JSON.stringify(data.tradeStats, null, 2)
        : '[no closed trades in the last 7 days]';
    const recentTradesSection = data.recentTrades
        ? JSON.stringify(data.recentTrades, null, 2)
        : '[no recent trades]';
    const configSection = data.currentConfig
        ? JSON.stringify(data.currentConfig, null, 2)
        : '[could not read config]';
    const prevSection = data.previousRun ?? 'First run — no prior Brain analysis exists.';

    return `# AktienixBrain — Portfolio Analysis Run

You are AktienixBrain, an autonomous portfolio analyst for Aktienix (US stock swing trading on Alpaca).
Today is ${date}. Run ID: ${runId}. Trigger: ${triggerReason}.

**Market status: ${data.marketStatus}**

## Current State

### Account (from Alpaca API)
\`\`\`json
${accountSection}
\`\`\`

### Open Positions
\`\`\`json
${positionsSection}
\`\`\`

### Risk State (from runner's Redis state — may be stale if runner is idle)
\`\`\`json
${riskSection}
\`\`\`

### Current Config Values (aktienix.toml — the values you may change)
\`\`\`json
${configSection}
\`\`\`

### Trade Performance (7-day summary, closed trades only)
\`\`\`json
${tradeSection}
\`\`\`

### Recent Individual Trades (last 20, newest first)
\`\`\`json
${recentTradesSection}
\`\`\`

### Previous Brain Run
${prevSection}

## Your Job

Analyse trading performance and decide whether config adjustments are needed. Be conservative — only change parameters when the data clearly justifies it.

### Decision Framework
1. **Read the data above carefully.** If there are no trades yet or insufficient data, say so and make no changes.
2. **Identify root causes**, not just symptoms. "3 losses" could mean bad signals, bad sizing, bad timing, or just bad luck on 3 trades.
3. **Make small, targeted changes.** Change 1-2 parameters at most per run. Large multi-parameter changes make it impossible to know what helped.
4. **Consider reverting previous Brain changes** if they didn't help or made things worse.

### Config File
Edit \`aktienix.toml\` at the project root directly if changes are needed. You do NOT need to commit or restart — that is handled automatically after your run.

### What You CAN Change in aktienix.toml:

| Parameter | Current | Allowed range | Safety floor |
|-----------|---------|---------------|-------------|
| \`risk.min_confidence\` | ${data.currentConfig?.min_confidence ?? '?'} | 0.30 – 0.75 | ≥ 0.40 |
| \`limits.max_open_positions\` | ${data.currentConfig?.max_open_positions ?? '?'} | 3 – 10 | ≥ 4 |
| \`limits.max_trades_per_day\` | ${data.currentConfig?.max_trades_per_day ?? '?'} | 5 – 30 | ≥ 10 |
| \`capital.max_capital_per_trade_pct\` | ${data.currentConfig?.max_capital_per_trade_pct ?? '?'} | 0.10 – 0.30 | ≥ 0.10 |
| \`exits.stop_loss_pct\` | ${data.currentConfig?.stop_loss_pct ?? '?'} | 1.5 – 5.0 | ≥ 2.0 |
| \`exits.take_profit_pct\` | ${data.currentConfig?.take_profit_pct ?? '?'} | 3.0 – 10.0 | ≥ 3.0 |
| symbols in \`[watchlist]\` section | — | add up to 10, remove if no open position | — |

**Safety floors** prevent death spirals. Never go below them even on repeated acute triggers.

### What You CAN Also Do:
- Use Bash to run \`npx tsx scripts/aktienix/close-position.ts SYMBOL\` to close a losing position
  - Only close if: unrealizedPl% < –5% OR position held > 5 trading days with < 0.5% gain

### What You CANNOT Do:
- Open new positions or place buy orders
- Change \`intelligence.*\`, \`broker.*\`, \`market_hours.*\`, or \`timing.*\` settings
- Exceed the parameter bounds or go below safety floors
- Make changes without clear data-backed reasoning

### What Is Handled Automatically (do NOT do these):
- Git commit of aktienix.toml (automatic after your run)
- Docker restart of the aktienix runner (automatic after your run)
- Telegram report (automatic after your run)

## Output

After completing your analysis and any actions, print this exact block:

\`\`\`
BRAIN_SUMMARY_START
Trigger: ${triggerReason}
Actions: [comma-separated list of what you changed, or "none"]
Analysis: [2-3 sentences: what you observed, your diagnosis, and what you did/didn't change and why]
BRAIN_SUMMARY_END
\`\`\`
`;
}

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
            `cat "${promptPath}" | claude -p ` +
            `--model ${CLAUDE_MODEL} ` +
            `--allowedTools 'Edit,Read,Glob,Grep,Bash' ` +
            `--max-budget-usd 3`,
            { timeout: 300_000, cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
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

    // 5. Check if aktienix.toml was modified, commit + restart if so
    let filesChanged = '';
    try {
        filesChanged = execSync('git diff --stat HEAD -- aktienix.toml', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    } catch { /* non-fatal */ }
    const tomlChanged = filesChanged.includes('aktienix.toml');

    if (tomlChanged) {
        // Auto-commit and restart since Claude can't reliably use Bash in pipe mode
        try {
            execSync(
                `git add aktienix.toml && git commit -m "brain(${runId}): ${actions.join(', ')}"`,
                { cwd: PROJECT_ROOT, encoding: 'utf-8' }
            );
            console.log('[aktienix-brain] Committed aktienix.toml changes.');
        } catch (e: any) { console.error('[aktienix-brain] git commit failed:', e.message); }

        try {
            execSync('docker restart aktienix', { timeout: 30_000, encoding: 'utf-8' });
            console.log('[aktienix-brain] Restarted aktienix runner.');
        } catch (e: any) { console.error('[aktienix-brain] docker restart failed:', e.message); }
    }
    const filesLine = tomlChanged ? 'aktienix.toml (committed + runner restarted)' : 'none';

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
            body: JSON.stringify({ chat_id: CHAT_ID, text }),
        });
    } catch (err: any) {
        console.error('[aktienix-brain] Telegram failed:', err.message);
    }
}

main().catch(err => {
    console.error('[aktienix-brain] Fatal:', err.message);
    process.exit(1);
});
