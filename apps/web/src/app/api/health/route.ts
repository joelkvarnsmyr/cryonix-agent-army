import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';
import { configHash } from '@/lib/config';

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
    const [dailyRaw, positionsRaw, regimeRaw, riskStateRaw] = await Promise.all([
      redis.get('daily:state'),
      redis.get('positions:open'),
      redis.get('market:regime'),
      redis.get('risk:portfolio_state'),
    ]);

    const daily = dailyRaw ? JSON.parse(dailyRaw as string) : null;
    const positions = positionsRaw ? JSON.parse(positionsRaw as string) : [];
    const today = new Date().toDateString();

    let capital = 0;
    try {
      if (riskStateRaw) capital = JSON.parse(riskStateRaw as string).total_capital || 0;
    } catch {}

    return {
      open_positions: Array.isArray(positions) ? positions.length : 0,
      daily_trades: daily?.date === today ? (daily.tradesExecuted ?? 0) : 0,
      daily_pnl: daily?.date === today ? (daily.dailyPnl ?? 0) : 0,
      capital,
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

  // Build services array for frontend components
  const servicesMap = [
    { name: 'Redis', check: redisCheck },
    { name: 'Postgres', check: postgresCheck },
    { name: 'Python Engine', check: engineCheck },
    { name: 'Binance', check: binanceCheck },
  ];

  const services = servicesMap.map(({ name, check }) => ({
    name,
    status: check.status === 'ok' ? 'healthy' as const : 'down' as const,
    latency: check.latency_ms,
    ...(check.error ? { details: { error: check.error } } : {}),
  }));

  const healthyCount = services.filter(s => s.status === 'healthy').length;
  const downCount = services.filter(s => s.status === 'down').length;
  const totalLatency = services.reduce((sum, s) => sum + (s.latency || 0), 0);

  const body = {
    status,
    configHash: configHash(),
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    totalLatency,
    summary: {
      healthy: healthyCount,
      degraded: 0,
      down: downCount,
      total: services.length,
    },
    services,
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
