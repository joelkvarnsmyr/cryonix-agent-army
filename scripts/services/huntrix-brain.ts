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
import { PARAM_BOUNDS } from '../../packages/agents/src/huntrix/brain-actions';

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
    pumpStats: any | null;
}

async function collectData(): Promise<BrainData> {
    await redis.ping(); // throws if Redis unreachable

    const stateRaw   = await redis.get('huntrix:state').catch(() => null);
    const riskRaw    = await redis.get('huntrix:risk').catch(() => null);
    const prevRunRaw    = await redis.get('huntrix:brain:last_run').catch(() => null);
    const pumpStatsRaw  = await redis.get('huntrix:pump_stats').catch(() => null);

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
        pumpStats: safeParse(pumpStatsRaw),
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

    const pumpStatsSection = data.pumpStats
        ? JSON.stringify(data.pumpStats, null, 2)
        : '[no pump data yet — profiler needs more detected pumps]';

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

## Pump Duration Statistics (per exchange)
\`\`\`json
${pumpStatsSection}
\`\`\`

Use these stats to inform \`exits.max_hold_minutes\` adjustments. If median peak is 8min on MEXC but max_hold is 30, consider lowering it. If no data exists yet, skip this analysis.

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
