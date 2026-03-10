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

async function runBrain(_triggerReason: string) {
    // TODO in Task 5 — placeholder so the file compiles
    console.log('[aktienix-brain] runBrain() not yet implemented.');
}

main().catch(err => {
    console.error('[aktienix-brain] Fatal:', err.message);
    process.exit(1);
});
