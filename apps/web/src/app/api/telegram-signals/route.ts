import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

// ============================================================================
// GET /api/telegram-signals — Active signals + channel stats
// ============================================================================

export async function GET() {
  try {
    // Active signals from Redis
    let activeSignals: any[] = [];
    let boostEnabled = false;
    try {
      const raw = await redis.get('signals:telegram:active');
      if (raw) {
        const data = JSON.parse(raw as string);
        activeSignals = data.signals || [];
        boostEnabled = data.boost_enabled || false;
      }
    } catch {}

    // Channel quality from Redis
    const channelStats: any[] = [];
    try {
      const keys = await redis.keys('telegram:channel:*:quality');
      for (const key of keys) {
        const raw = await redis.get(key);
        if (raw) {
          const channelId = key.replace('telegram:channel:', '').replace(':quality', '');
          channelStats.push({ channelId, ...JSON.parse(raw as string) });
        }
      }
    } catch {}

    return NextResponse.json({
      success: true,
      boostEnabled,
      activeSignals: activeSignals.length,
      signals: activeSignals,
      channels: channelStats,
    });
  } catch (error) {
    console.error('[TELEGRAM-SIGNALS] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch telegram signals' },
      { status: 500 },
    );
  }
}
