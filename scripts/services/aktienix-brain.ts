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

async function runBrain(_triggerReason: string) {
    // TODO in Task 5 — placeholder so the file compiles
    console.log('[aktienix-brain] runBrain() not yet implemented.');
}

main().catch(err => {
    console.error('[aktienix-brain] Fatal:', err.message);
    process.exit(1);
});
