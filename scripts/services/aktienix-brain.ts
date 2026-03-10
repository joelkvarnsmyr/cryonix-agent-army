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
        // Write cooldown timestamp so shouldRun() won't fire again within 1h
        // (runBrain in Task 5 will write the full last_run JSON with actions/analysis)
        const existing = await redis.get('aktienix:brain:last_run').catch(() => null);
        if (!existing) {
            await redis.set('aktienix:brain:last_run',
                JSON.stringify({ timestamp: new Date().toISOString() }),
                'EX', 172800
            ).catch(() => {});
        }
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
    const isScheduled = (h === 9 && m >= 0 && m < 5) || (h === 16 && m >= 30 && m < 35);
    if (isScheduled) return 'scheduled';

    // Acute trigger: consecutive losses or daily loss > 3%
    const riskRaw = await redis.get('aktienix:risk');
    const acctRaw = await redis.get('aktienix:account');
    if (riskRaw && acctRaw) {
        const risk = JSON.parse(riskRaw);
        const acct = JSON.parse(acctRaw);
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
}

async function collectData(): Promise<BrainData> {
    // Redis (may be null if agent is idle — 5-min TTL)
    const accountRaw   = await redis.get('aktienix:account').catch(() => null);
    const positionsRaw = await redis.get('aktienix:positions').catch(() => null);
    const riskRaw      = await redis.get('aktienix:risk').catch(() => null);
    const prevRunRaw   = await redis.get('aktienix:brain:last_run').catch(() => null);

    function safeParse(raw: string | null): any {
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
    }
    const account   = safeParse(accountRaw);
    const positions = safeParse(positionsRaw);
    const risk      = safeParse(riskRaw);

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
        } catch (err: any) {
            console.warn('[aktienix-brain] Postgres unavailable:', err.message);
        } finally {
            await db.end().catch(() => {});
        }
    }

    return { account, positions, risk, previousRun, tradeStats };
}

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

main().catch(err => {
    console.error('[aktienix-brain] Fatal:', err.message);
    process.exit(1);
});
