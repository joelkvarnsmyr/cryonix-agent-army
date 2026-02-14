import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db, signals } from '@cryonix/database';
import { desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

interface ServiceStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  latency?: number;
  details?: Record<string, unknown>;
}

async function checkRedis(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await redis.ping();
    const pendingCount = await redis.llen('trades:pending');
    const approvedCount = await redis.llen('trades:approved');
    return {
      name: 'Redis',
      status: 'healthy',
      latency: Date.now() - start,
      details: {
        pendingApprovals: pendingCount,
        approvedTrades: approvedCount,
      },
    };
  } catch (error) {
    return { name: 'Redis', status: 'down', details: { error: String(error) } };
  }
}

async function checkPostgres(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const result = await db.select().from(signals).orderBy(desc(signals.timestamp)).limit(1);
    return {
      name: 'Postgres',
      status: 'healthy',
      latency: Date.now() - start,
      details: {
        lastSignal: result[0]?.timestamp || null,
        signalCount: result.length,
      },
    };
  } catch (error) {
    return { name: 'Postgres', status: 'down', details: { error: String(error) } };
  }
}

async function checkPythonEngine(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const engineUrl = process.env.ENGINE_URL || 'http://localhost:8000';
    const response = await fetch(`${engineUrl}/`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { name: 'Python Engine', status: 'degraded', latency: Date.now() - start };
    }

    const data = await response.json();
    return {
      name: 'Python Engine',
      status: 'healthy',
      latency: Date.now() - start,
      details: {
        mode: data.mode,
      },
    };
  } catch (error) {
    return { name: 'Python Engine', status: 'down', details: { error: String(error) } };
  }
}

async function checkMarketScout(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const status = await redis.get('agent:MarketScout:status');
    if (!status) {
      return { name: 'MarketScout Tank', status: 'down', details: { error: 'No status in Redis' } };
    }

    const parsed = JSON.parse(status);
    return {
      name: 'MarketScout Tank',
      status: parsed.status === 'active' ? 'healthy' : 'degraded',
      latency: Date.now() - start,
      details: parsed.details,
    };
  } catch (error) {
    return { name: 'MarketScout Tank', status: 'down', details: { error: String(error) } };
  }
}

export async function GET() {
  const start = Date.now();

  // Run all health checks in parallel
  const [redisStatus, postgresStatus, engineStatus, scoutStatus] = await Promise.all([
    checkRedis(),
    checkPostgres(),
    checkPythonEngine(),
    checkMarketScout(),
  ]);

  const services = [redisStatus, postgresStatus, engineStatus, scoutStatus];

  // Determine overall health
  const healthyCount = services.filter(s => s.status === 'healthy').length;
  const downCount = services.filter(s => s.status === 'down').length;

  let overallStatus: 'healthy' | 'degraded' | 'down';
  if (downCount > 0) {
    overallStatus = downCount === services.length ? 'down' : 'degraded';
  } else {
    overallStatus = 'healthy';
  }

  return NextResponse.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    totalLatency: Date.now() - start,
    summary: {
      healthy: healthyCount,
      degraded: services.filter(s => s.status === 'degraded').length,
      down: downCount,
      total: services.length,
    },
    services,
  });
}
