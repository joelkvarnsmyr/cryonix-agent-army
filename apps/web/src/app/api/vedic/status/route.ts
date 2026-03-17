import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  let vedicScore: any = null;
  let moon: any = null;
  let planets: any = null;
  let aspects: any = null;
  let traderStats: any = null;
  let btdStats: any = null;
  let btdState: any = null;
  let bayesData: any = null;
  let futuresStats: any = null;

  try {
    const [scoreRaw, moonRaw, planetsRaw, aspectsRaw, traderRaw, btdStatsRaw, btdStateRaw, bayesRaw, futuresRaw] =
      await Promise.all([
        redis.get('vedic:score'),
        redis.get('vedic:moon'),
        redis.get('vedic:planets'),
        redis.get('vedic:aspects'),
        redis.get('vedic_trader:stats'),
        redis.get('vedic_btd:stats'),
        redis.get('vedic_btd:state'),
        redis.get('vedic:bayes'),
        redis.get('vedic_futures:stats'),
      ]);

    if (scoreRaw) try { vedicScore = JSON.parse(scoreRaw as string); } catch {}
    if (moonRaw) try { moon = JSON.parse(moonRaw as string); } catch {}
    if (planetsRaw) try { planets = JSON.parse(planetsRaw as string); } catch {}
    if (aspectsRaw) try { aspects = JSON.parse(aspectsRaw as string); } catch {}
    if (traderRaw) try { traderStats = JSON.parse(traderRaw as string); } catch {}
    if (btdStatsRaw) try { btdStats = JSON.parse(btdStatsRaw as string); } catch {}
    if (btdStateRaw) try { btdState = JSON.parse(btdStateRaw as string); } catch {}
    if (bayesRaw) try { bayesData = JSON.parse(bayesRaw as string); } catch {}
    if (futuresRaw) try { futuresStats = JSON.parse(futuresRaw as string); } catch {}
  } catch (error) {
    console.error('[vedic/status] Redis error:', error);
  }

  const scoutRunning = vedicScore !== null;
  const traderRunning = traderStats !== null;
  const btdRunning = btdStats !== null;

  return NextResponse.json({
    scout: {
      running: scoutRunning,
      score: vedicScore?.score ?? 0,
      label: vedicScore?.label ?? 'unknown',
      venusRx: vedicScore?.venus_rx ?? false,
      mercuryRx: vedicScore?.mercury_rx ?? false,
      nRetrogrades: vedicScore?.n_retrogrades ?? 0,
      muhurtaLabel: vedicScore?.muhurta_label ?? '',
    },
    moon: moon ? {
      nakshatra: moon.nakshatra,
      nakshatraBias: moon.nakshatra_bias,
      tithi: moon.tithi,
      tithiNumber: moon.tithi_number,
      moonPhasePct: moon.moon_phase_pct,
      paksha: moon.lunar_paksha,
      horaLord: moon.hora_lord,
      vara: moon.vara,
    } : null,
    planets: planets?.planets ?? null,
    aspects: aspects ? {
      active: aspects.aspects?.length ?? 0,
      nature: aspects.dominant_nature ?? 'neutral',
      score: aspects.aspect_score ?? 0,
    } : null,
    trader: traderStats ? {
      running: true,
      balance: traderStats.balance ?? 0,
      totalPnl: traderStats.total_pnl ?? 0,
      totalReturnPct: traderStats.total_return_pct ?? 0,
      trades: traderStats.total_trades ?? 0,
      wins: traderStats.wins ?? 0,
      losses: traderStats.losses ?? 0,
      winRate: traderStats.win_rate ?? 0,
      openPositions: traderStats.open_positions ?? 0,
      positions: traderStats.positions ?? [],
    } : { running: false },
    btd: btdStats ? {
      running: true,
      phase: btdStats.btd_phase ?? btdState?.phase ?? 'WAITING',
      daysSinceDirect: btdStats.days_since_direct ?? 0,
      balance: btdStats.balance ?? 0,
      totalPnl: btdStats.total_pnl ?? 0,
      totalReturnPct: btdStats.total_return_pct ?? 0,
      trades: btdStats.total_trades ?? 0,
      wins: btdStats.wins ?? 0,
      winRate: btdStats.win_rate ?? 0,
      openPositions: btdStats.open_positions ?? 0,
      entriesThisCycle: btdStats.entries_this_cycle ?? 0,
    } : { running: false, phase: 'OFFLINE' },
    futures: futuresStats ? {
      running: true,
      balance: futuresStats.balance ?? 0,
      totalPnl: futuresStats.total_pnl ?? 0,
      returnPct: futuresStats.return_pct ?? 0,
      trades: futuresStats.total_trades ?? 0,
      wins: futuresStats.wins ?? 0,
      winRate: futuresStats.win_rate ?? 0,
      longTrades: futuresStats.long_trades ?? 0,
      longWr: futuresStats.long_wr ?? 0,
      shortTrades: futuresStats.short_trades ?? 0,
      shortWr: futuresStats.short_wr ?? 0,
      openPositions: futuresStats.open_positions ?? 0,
    } : { running: false },
    bayes: bayesData ? {
      probability: bayesData.probability ?? 0.5,
      score: bayesData.score ?? 0,
      label: bayesData.label ?? 'neutral',
      baseRate: bayesData.base_rate ?? 0.55,
      totalTrades: bayesData.total_trades ?? 0,
      signals: bayesData.signals ?? {},
    } : null,
    timestamp: new Date().toISOString(),
  });
}
