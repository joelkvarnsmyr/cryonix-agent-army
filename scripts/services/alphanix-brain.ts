// scripts/services/alphanix-brain.ts
// AlphanixBrain — autonomous multi-asset analyst using Claude Code CLI
// Run: npx tsx scripts/services/alphanix-brain.ts

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

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
const CLAUDE_MODEL = 'claude-opus-4-6';
const COOLDOWN_MS  = 60 * 60 * 1000; // 1 hour
const CHECK_INTERVAL_MS = 60_000;    // check every 60s

let isRunning = false;
let redis: Redis;

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('[alphanix-brain] Starting AlphanixBrain...');

    // Init git repo + seed baseline for alphanix.toml so Brain can track changes
    try {
        execSync(
            'git init && git config user.email "brain@alphanix" && git config user.name "AlphanixBrain" && ' +
            'git add alphanix.toml && git commit -m "baseline" || true',
            { cwd: PROJECT_ROOT, encoding: 'utf-8' }
        );
        console.log('[alphanix-brain] Git baseline created for alphanix.toml');
    } catch { /* non-fatal */ }

    redis = new Redis(REDIS_URL);
    redis.on('error', err => console.error('[alphanix-brain] Redis error:', err.message));

    setInterval(checkAndRun, CHECK_INTERVAL_MS);
    checkAndRun(); // Also check immediately on startup
    console.log('[alphanix-brain] Trigger loop started. Checking every 60s.');
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
        await redis.set('alphanix:brain:cooldown', '1', 'EX', 3600).catch(() => {});
    }
}

async function shouldRun(): Promise<string | null> {
    // Cooldown check
    const cooldown = await redis.get('alphanix:brain:cooldown').catch(() => null);
    if (cooldown) return null;

    // Scheduled trigger: every 6 hours (00:00, 06:00, 12:00, 18:00 UTC)
    const nowUTC = new Date();
    const h = nowUTC.getUTCHours();
    const m = nowUTC.getUTCMinutes();
    const isScheduled = (h % 6 === 0) && m >= 0 && m < 5;
    if (isScheduled) return 'scheduled';

    // Acute trigger: high global drawdown or multiple pod failures
    const orchRaw = await redis.get('alphanix:orchestrator:state').catch(() => null);
    if (orchRaw) {
        try {
            const orch = JSON.parse(orchRaw);
            const pods = orch.pods || {};
            const failedPods = Object.values(pods).filter((p: any) => p.status === 'error' || p.status === 'stopped');
            if (failedPods.length >= 2) return `acute: ${failedPods.length} pods in error/stopped state`;

            // Check global drawdown from orchestrator state
            if (orch.globalDrawdownPct && orch.globalDrawdownPct > 4.0) {
                return `acute: global drawdown ${orch.globalDrawdownPct.toFixed(1)}% exceeds 4%`;
            }
        } catch { /* ignore parse errors */ }
    }

    return null;
}

interface BrainData {
    orchestratorState: Record<string, any> | null;
    podStates: Record<string, any>;
    currentConfig: Record<string, any> | null;
    previousRun: string | null;
    recentTrades: Array<Record<string, any>> | null;
    timestamp: string;
}

async function collectData(): Promise<BrainData> {
    // Verify Redis is reachable
    await redis.ping();

    // Orchestrator state
    const orchRaw = await redis.get('alphanix:orchestrator:state').catch(() => null);
    const orchestratorState = orchRaw ? JSON.parse(orchRaw) : null;

    // Pod states
    const podStates: Record<string, any> = {};
    if (orchestratorState) {
        for (const podId of Object.keys(orchestratorState.pods || {})) {
            const [state, risk, perf] = await Promise.all([
                redis.get(`alphanix:pod:${podId}:state`).catch(() => null),
                redis.get(`alphanix:pod:${podId}:risk`).catch(() => null),
                redis.get(`alphanix:pod:${podId}:performance`).catch(() => null),
            ]);
            podStates[podId] = {
                state: state ? JSON.parse(state) : null,
                risk: risk ? JSON.parse(risk) : null,
                performance: perf ? JSON.parse(perf) : null,
            };
        }
    }

    // Previous brain run
    const prevRunRaw = await redis.get('alphanix:brain:last_run').catch(() => null);
    let previousRun: string | null = null;
    if (prevRunRaw) {
        try {
            const prev = JSON.parse(prevRunRaw);
            previousRun = `[${prev.timestamp}] ${prev.analysis} Actions: ${(prev.actions ?? []).join(', ')}`;
        } catch { /* ignore */ }
    }

    // Current config from TOML
    let currentConfig: Record<string, any> | null = null;
    try {
        const tomlPath = path.join(PROJECT_ROOT, 'alphanix.toml');
        const tomlText = readFileSync(tomlPath, 'utf-8');
        const extract = (pattern: RegExp): string | null => {
            const match = tomlText.match(pattern);
            return match ? match[1].trim() : null;
        };
        currentConfig = {
            capital_total_usd: extract(/capital_total_usd\s*=\s*([\d.]+)/),
            max_pods: extract(/max_pods\s*=\s*(\d+)/),
            global_max_drawdown_pct: extract(/global_max_drawdown_pct\s*=\s*([\d.]+)/),
            rebalance_interval_hours: extract(/rebalance_interval_hours\s*=\s*(\d+)/),
        };
    } catch { /* non-fatal */ }

    // Postgres: recent trades (if alphanix_trades table exists)
    let recentTrades: Array<Record<string, any>> | null = null;
    if (PG_URL) {
        const db = new PgClient({ connectionString: PG_URL });
        try {
            await db.connect();
            const recent = await db.query(`
                SELECT symbol, side, qty, fill_price, realized_pnl, pod_id, timestamp
                FROM alphanix_trades
                WHERE timestamp > NOW() - INTERVAL '7 days'
                ORDER BY timestamp DESC
                LIMIT 30
            `);
            recentTrades = recent.rows.length > 0 ? recent.rows : null;
        } catch (err: any) {
            // Table may not exist yet — non-fatal
            console.warn('[alphanix-brain] Postgres query failed:', err.message);
        } finally {
            await db.end().catch(() => {});
        }
    }

    return {
        orchestratorState,
        podStates,
        currentConfig,
        previousRun,
        recentTrades,
        timestamp: new Date().toISOString(),
    };
}

function buildPrompt(data: BrainData, triggerReason: string, runId: string): string {
    const date = new Date().toISOString().slice(0, 10);

    const orchSection = data.orchestratorState
        ? JSON.stringify(data.orchestratorState, null, 2)
        : '[not available — orchestrator may not be running]';
    const podSection = Object.keys(data.podStates).length > 0
        ? JSON.stringify(data.podStates, null, 2)
        : '[no pod data available]';
    const configSection = data.currentConfig
        ? JSON.stringify(data.currentConfig, null, 2)
        : '[could not read config]';
    const tradesSection = data.recentTrades
        ? JSON.stringify(data.recentTrades, null, 2)
        : '[no recent trades]';
    const prevSection = data.previousRun ?? 'First run — no prior Brain analysis exists.';

    return `# AlphanixBrain — Multi-Asset Portfolio Analysis Run

You are AlphanixBrain, an autonomous analyst for Alphanix — a multi-asset AI trading army with pod-based architecture.
Today is ${date}. Run ID: ${runId}. Trigger: ${triggerReason}.

## Current State

### Orchestrator State
\`\`\`json
${orchSection}
\`\`\`

### Pod States (per-pod: state, risk, performance)
\`\`\`json
${podSection}
\`\`\`

### Current Config Values (alphanix.toml)
\`\`\`json
${configSection}
\`\`\`

### Recent Trades (last 7 days, newest first)
\`\`\`json
${tradesSection}
\`\`\`

### Previous Brain Run
${prevSection}

## Your Job

Analyse the multi-asset portfolio and decide whether config adjustments are needed. Be conservative — only change parameters when the data clearly justifies it.

### Decision Framework
1. **Read the data above carefully.** If there are no trades yet or insufficient data, say so and make no changes.
2. **Identify root causes**, not just symptoms. Multiple pod failures could be systemic or isolated.
3. **Make small, targeted changes.** Change 1-2 parameters at most per run.
4. **Consider reverting previous Brain changes** if they didn't help.

### Config File
Edit \`alphanix.toml\` at the project root directly if changes are needed. You do NOT need to commit or restart — that is handled automatically after your run.

### What You CAN Change in alphanix.toml:

| Parameter | Allowed range | Notes |
|-----------|---------------|-------|
| \`orchestrator.capital_total_usd\` | 1000 – 100000 | Total capital budget |
| \`orchestrator.global_max_drawdown_pct\` | 2.0 – 10.0 | Global drawdown limit |
| \`orchestrator.rebalance_interval_hours\` | 1 – 24 | Rebalance frequency |
| \`pods.{pod}.enabled\` | true/false | Enable/disable a pod |
| \`pods.{pod}.capital_pct\` | 0 – 100 | Capital allocation (sum must be ≤ 100) |
| \`pods.{pod}.risk_max_drawdown_pct\` | 1.0 – 10.0 | Per-pod drawdown limit |
| \`pods.{pod}.risk_max_positions\` | 1 – 20 | Max concurrent positions |
| \`pods.{pod}.symbols\` | — | Add/remove symbols |

### What You CANNOT Do:
- Open or close individual positions
- Change adapter types, strategy names, or timing parameters
- Exceed the parameter bounds above
- Make changes without clear data-backed reasoning

### What Is Handled Automatically (do NOT do these):
- Git commit of alphanix.toml (automatic after your run)
- Docker restart of the alphanix runner (automatic after your run)
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
    console.log(`\n[alphanix-brain] === Run ${runId} (${triggerReason}) ===`);

    // 1. Collect data
    let data: BrainData;
    try {
        data = await collectData();
    } catch (err: any) {
        console.error('[alphanix-brain] Data collection failed:', err.message);
        await sendTelegram(`🧠 AlphanixBrain\n\n⚠️ Run aborted — data collection failed: ${err.message}`);
        return;
    }

    // 2. Build prompt + write to temp file
    const prompt = buildPrompt(data, triggerReason, runId);
    const promptPath = path.join(tmpdir(), `alphanix-brain-${runId}.md`);
    writeFileSync(promptPath, prompt);

    // 3. Run Claude Code CLI
    console.log('[alphanix-brain] Invoking Claude Code CLI...');
    let claudeOutput = '';
    try {
        claudeOutput = execSync(
            `cat "${promptPath}" | claude -p ` +
            `--model ${CLAUDE_MODEL} ` +
            `--allowedTools 'Edit,Read,Glob,Grep,Bash'`,
            { timeout: 300_000, cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        );
        console.log('[alphanix-brain] Claude finished.');
    } catch (err: any) {
        console.error('[alphanix-brain] Claude CLI failed:', err.message);
        await sendTelegram(`🧠 AlphanixBrain\n\n❌ Claude CLI failed (${triggerReason}):\n${err.message.slice(0, 200)}`);
        return;
    } finally {
        try { unlinkSync(promptPath); } catch { /* ignore */ }
    }

    // 4. Parse summary block
    const summaryMatch = claudeOutput.match(/BRAIN_SUMMARY_START\n([\s\S]*?)BRAIN_SUMMARY_END/);
    if (!summaryMatch) {
        console.warn('[alphanix-brain] WARNING: No BRAIN_SUMMARY block found in Claude output.');
    }
    const summaryRaw = summaryMatch?.[1] ?? '';
    const actionLine  = summaryRaw.match(/^Actions: (.+)$/m)?.[1] ?? 'none';
    const analysisLine = summaryRaw.match(/^Analysis: (.+)$/m)?.[1] ?? '(no analysis)';
    const actions = actionLine === 'none' ? [] : actionLine.split(',').map(s => s.trim());

    // 5. Check if alphanix.toml was modified, commit + restart if so
    let filesChanged = '';
    try {
        filesChanged = execSync('git diff --stat HEAD -- alphanix.toml', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    } catch { /* non-fatal */ }
    const tomlChanged = filesChanged.includes('alphanix.toml');

    if (tomlChanged) {
        try {
            execSync(
                `git add alphanix.toml && git commit -m "brain(${runId}): ${actions.join(', ')}"`,
                { cwd: PROJECT_ROOT, encoding: 'utf-8' }
            );
            console.log('[alphanix-brain] Committed alphanix.toml changes.');
        } catch (e: any) { console.error('[alphanix-brain] git commit failed:', e.message); }

        try {
            execSync('docker restart alphanix', { timeout: 30_000, encoding: 'utf-8' });
            console.log('[alphanix-brain] Restarted alphanix runner.');
        } catch (e: any) { console.error('[alphanix-brain] docker restart failed:', e.message); }
    }
    const filesLine = tomlChanged ? 'alphanix.toml (committed + runner restarted)' : 'none';

    // 6. Store last_run in Redis (48h TTL)
    const lastRunData = {
        runId,
        trigger: triggerReason,
        timestamp: new Date().toISOString(),
        analysis: analysisLine,
        actions,
    };
    await redis.set('alphanix:brain:last_run', JSON.stringify(lastRunData), 'EX', 172800);

    // 7. Telegram report
    const actionsText = actions.length > 0
        ? actions.map(a => `✅ ${a}`).join('\n')
        : '— No changes made';

    const podCount = Object.keys(data.podStates).length;
    const capitalLine = data.currentConfig?.capital_total_usd
        ? `💰 Capital: $${data.currentConfig.capital_total_usd}`
        : '💰 Capital: [data unavailable]';

    const report = [
        `🧠 AlphanixBrain — ${triggerReason.startsWith('acute') ? 'Acute' : 'Scheduled'} Report`,
        '',
        capitalLine,
        `🔧 Active pods: ${podCount}`,
        `⚠️  Trigger: ${triggerReason}`,
        '',
        analysisLine,
        '',
        actionsText,
        '',
        `Files changed: ${filesLine}`,
    ].join('\n');

    await sendTelegram(report);
    console.log('[alphanix-brain] Run complete.');
}

async function sendTelegram(text: string) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.log('[alphanix-brain] Telegram not configured — skipping.');
        return;
    }
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHAT_ID, text }),
        });
    } catch (err: any) {
        console.error('[alphanix-brain] Telegram failed:', err.message);
    }
}

main().catch(err => {
    console.error('[alphanix-brain] Fatal:', err.message);
    process.exit(1);
});
