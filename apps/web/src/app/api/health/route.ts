import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const startedAt = Date.now();

interface CheckResult {
  status: 'ok' | 'error';
  latency_ms: number;
  error?: string;
}

async function checkRedis(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await redis.ping();
    return { status: 'ok', latency_ms: Date.now() - start };
  } catch (e) {
    return { status: 'error', latency_ms: Date.now() - start, error: String(e) };
  }
}

async function checkPostgres(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { status: 'ok', latency_ms: Date.now() - start };
  } catch (e) {
    return { status: 'error', latency_ms: Date.now() - start, error: String(e) };
  }
}

async function checkBinance(): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Lightweight public endpoint — no auth needed
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDC', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    return { status: 'ok', latency_ms: Date.now() - start };
  } catch (e) {
    return { status: 'error', latency_ms: Date.now() - start, error: String(e) };
  }
}

async function checkEngine(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const engineUrl = process.env.ENGINE_URL || 'http://localhost:8000';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${engineUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: 'ok', latency_ms: Date.now() - start };
  } catch (e) {
    return { status: 'error', latency_ms: Date.now() - start, error: String(e) };
  }
}

async function getTradingData() {
  try {
    const [dailyRaw, positionsRaw, regimeRaw] = await Promise.all([
      redis.get('daily:state'),
      redis.get('positions:open'),
      redis.get('market:regime'),
    ]);

    const daily = dailyRaw ? JSON.parse(dailyRaw as string) : null;
    const positions = positionsRaw ? JSON.parse(positionsRaw as string) : [];
    const today = new Date().toDateString();

    return {
      open_positions: Array.isArray(positions) ? positions.length : 0,
      daily_trades: daily?.date === today ? (daily.tradesExecuted ?? 0) : 0,
      daily_pnl: daily?.date === today ? (daily.dailyPnl ?? 0) : 0,
      capital: 0, // populated below if possible
      regime: (regimeRaw as string) || 'unknown',
    };
  } catch {
    return { open_positions: 0, daily_trades: 0, daily_pnl: 0, capital: 0, regime: 'unknown' };
  }
}

export async function GET() {
  const [redisCheck, postgresCheck, binanceCheck, engineCheck, trading] = await Promise.all([
    checkRedis(),
    checkPostgres(),
    checkBinance(),
    checkEngine(),
    getTradingData(),
  ]);

  // healthy = all pass; degraded = core (redis+pg) ok but engine/binance down; unhealthy = redis or pg down
  const coreOk = redisCheck.status === 'ok' && postgresCheck.status === 'ok';
  const allOk = coreOk && binanceCheck.status === 'ok' && engineCheck.status === 'ok';

  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (!coreOk) {
    status = 'unhealthy';
  } else if (allOk) {
    status = 'healthy';
  } else {
    status = 'degraded';
  }

  const body = {
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    checks: {
      redis: redisCheck,
      postgres: postgresCheck,
      binance: binanceCheck,
      engine: engineCheck,
    },
    trading,
  };

  return NextResponse.json(body, { status: status === 'unhealthy' ? 503 : 200 });
}
