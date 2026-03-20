import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [stateRaw, riskRaw, detectionsRaw] = await Promise.all([
      redis.get('huntrix:state'),
      redis.get('huntrix:risk'),
      redis.get('huntrix:detections'),
    ]);

    const state = stateRaw ? JSON.parse(stateRaw as string) : null;
    const risk = riskRaw ? JSON.parse(riskRaw as string) : null;
    const detections = detectionsRaw ? JSON.parse(detectionsRaw as string) : null;

    return NextResponse.json({
      status: state?.status ?? 'offline',
      paperMode: state?.paper_mode ?? true,
      virtualBalance: state?.virtual_balance ?? 0,
      positions: state?.positions ?? [],
      recentTrades: state?.recent_trades ?? [],
      activeSignals: state?.active_signals ?? [],
      detections: detections?.signals ?? [],
      performance: {
        dailyPnl: state?.daily_pnl ?? 0,
        tradesToday: state?.trades_today ?? 0,
        winRate: state?.win_rate ?? 0,
        totalTrades: risk?.totalTrades ?? 0,
        totalWins: risk?.totalWins ?? 0,
      },
      circuitBreaker: {
        consecutiveLosses: state?.consecutive_losses ?? risk?.consecutiveLosses ?? 0,
        dailyLoss: Math.abs(state?.daily_pnl ?? 0),
        cooldownUntil: risk?.cooldownUntil ?? 0,
        isPaused: (risk?.cooldownUntil ?? 0) > Date.now(),
      },
      lastScanAt: state?.last_scan_at ?? null,
      timestamp: state?.updated_at ?? new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
