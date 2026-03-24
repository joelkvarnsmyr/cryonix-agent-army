import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stateRaw = await redis.get('huntrix:state');
    if (!stateRaw) {
      return NextResponse.json({ status: 'offline' });
    }

    const state = JSON.parse(stateRaw);

    // Read supplementary keys individually — don't let one failure break the whole response
    let risk: Record<string, unknown> | null = null;
    let detections: Record<string, unknown> | null = null;
    try {
      const riskRaw = await redis.get('huntrix:risk');
      if (riskRaw) risk = JSON.parse(riskRaw);
    } catch { /* ignore */ }
    try {
      const detectionsRaw = await redis.get('huntrix:detections');
      if (detectionsRaw) detections = JSON.parse(detectionsRaw);
    } catch { /* ignore */ }

    return NextResponse.json({
      status: state.status ?? 'offline',
      paperMode: state.paper_mode ?? true,
      virtualBalance: state.virtual_balance ?? 0,
      positions: state.positions ?? [],
      recentTrades: state.recent_trades ?? [],
      activeSignals: state.active_signals ?? [],
      detections: (detections as { signals?: unknown[] })?.signals ?? [],
      performance: {
        dailyPnl: state.daily_pnl ?? 0,
        tradesToday: state.trades_today ?? 0,
        winRate: state.win_rate ?? 0,
        totalTrades: (risk as { totalTrades?: number })?.totalTrades ?? 0,
        totalWins: (risk as { totalWins?: number })?.totalWins ?? 0,
      },
      circuitBreaker: {
        consecutiveLosses: state.consecutive_losses ?? (risk as { consecutiveLosses?: number })?.consecutiveLosses ?? 0,
        dailyLoss: Math.abs(state.daily_pnl ?? 0),
        cooldownUntil: (risk as { cooldownUntil?: number })?.cooldownUntil ?? 0,
        isPaused: ((risk as { cooldownUntil?: number })?.cooldownUntil ?? 0) > Date.now(),
      },
      lastScanAt: state.last_scan_at ?? null,
      timestamp: state.updated_at ?? new Date().toISOString(),
    });
  } catch (e) {
    console.error('[HUNTRIX API] Status error:', e);
    return NextResponse.json({ status: 'offline', error: String(e) });
  }
}
