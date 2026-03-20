import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [stateRaw, riskRaw, positionsRaw] = await Promise.all([
      redis.get('apex:state'),
      redis.get('apex:risk'),
      redis.get('apex:positions'),
    ]);

    const state = stateRaw ? JSON.parse(stateRaw as string) : null;
    const risk = riskRaw ? JSON.parse(riskRaw as string) : null;
    const positions = positionsRaw ? JSON.parse(positionsRaw as string) : [];

    return NextResponse.json({
      status: state?.status ?? 'offline',
      activeMode: state?.mode ?? 'idle',
      capital: state?.capital ?? null,
      positions,
      confluenceBoard: state?.confluenceBoard ?? [],
      performance: state?.performance ?? { totalPnl: 0, winRate: 0, trades: 0, maxDrawdown: 0 },
      circuitBreaker: risk ? {
        drawdown: risk.peakCapital > 0
          ? ((risk.peakCapital - risk.currentCapital) / risk.peakCapital) * 100
          : 0,
        dailyLoss: risk.peakCapital > 0
          ? (Math.abs(risk.dailyPnl ?? 0) / risk.peakCapital) * 100
          : 0,
        consecutiveLosses: risk.consecutiveLosses ?? 0,
        isPaused: risk.isPaused ?? false,
      } : { drawdown: 0, dailyLoss: 0, consecutiveLosses: 0, isPaused: false },
      staleness: state?.staleness ?? {},
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
