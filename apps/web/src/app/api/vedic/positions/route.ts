import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  let traderPositions: any[] = [];
  let btdPositions: any[] = [];

  try {
    const [traderRaw, btdRaw] = await Promise.all([
      redis.get('vedic_trader:wallet'),
      redis.get('vedic_btd:wallet'),
    ]);

    if (traderRaw) {
      const wallet = JSON.parse(traderRaw as string);
      if (wallet.positions && typeof wallet.positions === 'object') {
        traderPositions = Object.entries(wallet.positions).map(([sym, pos]: [string, any]) => ({
          symbol: sym,
          pair: pos.symbol ?? `${sym}/USDC`,
          entryPrice: pos.entry_price ?? 0,
          quantity: pos.quantity ?? 0,
          entryTime: pos.entry_time ?? 0,
          entryReason: pos.entry_reason ?? '',
          peakPrice: pos.peak_price ?? pos.entry_price ?? 0,
          trailingActive: pos.trailing_active ?? false,
          source: 'trader',
        }));
      }
    }

    if (btdRaw) {
      const wallet = JSON.parse(btdRaw as string);
      if (wallet.positions && typeof wallet.positions === 'object') {
        btdPositions = Object.entries(wallet.positions).map(([sym, pos]: [string, any]) => ({
          symbol: sym,
          pair: pos.symbol ?? `${sym}/USDC`,
          entryPrice: pos.entry_price ?? 0,
          quantity: pos.quantity ?? 0,
          entryTime: pos.entry_time ?? 0,
          entryReason: pos.entry_reason ?? '',
          peakPrice: pos.peak_price ?? pos.entry_price ?? 0,
          trailingActive: pos.trailing_active ?? false,
          btdCycle: pos.btd_cycle ?? '',
          btdDay: pos.btd_day ?? 0,
          source: 'btd',
        }));
      }
    }

    // Futures positions
    const futuresRaw = await redis.get('vedic_futures:wallet');
    if (futuresRaw) {
      const wallet = JSON.parse(futuresRaw as string);
      if (wallet.positions && typeof wallet.positions === 'object') {
        const futuresPositions = Object.entries(wallet.positions).map(([sym, pos]: [string, any]) => ({
          symbol: sym,
          pair: pos.symbol ?? `${sym}/USDC`,
          side: pos.side ?? 'LONG',
          entryPrice: pos.entry_price ?? 0,
          quantity: pos.quantity ?? 0,
          entryTime: pos.entry_time ?? 0,
          entryReason: pos.entry_reason ?? '',
          peakPrice: pos.peak_price ?? pos.entry_price ?? 0,
          trailingActive: pos.trailing_active ?? false,
          source: 'futures',
        }));
        btdPositions.push(...futuresPositions); // reuse array for simplicity
      }
    }
  } catch (error) {
    console.error('[vedic/positions] Redis error:', error);
  }

  return NextResponse.json({
    positions: [...traderPositions, ...btdPositions],
    counts: {
      trader: traderPositions.length,
      btd: btdPositions.length,
    },
  });
}
