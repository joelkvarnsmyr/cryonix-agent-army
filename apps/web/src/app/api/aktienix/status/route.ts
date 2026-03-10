import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

type MarketPhase = 'pre' | 'regular' | 'after' | 'closed';

function getMarketHours(): { phase: MarketPhase; isOpen: boolean; localTime: string } {
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const isDST = now.getTimezoneOffset() < Math.max(jan, jul);
  const etOffset = isDST ? -4 : -5;
  const etMs = now.getTime() + (now.getTimezoneOffset() + etOffset * 60) * 60_000;
  const et = new Date(etMs);
  const day = et.getDay();
  const h = et.getHours();
  const m = et.getMinutes();
  const mins = h * 60 + m;
  const localTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ET`;

  if (day === 0 || day === 6) return { phase: 'closed', isOpen: false, localTime };
  if (mins < 240) return { phase: 'closed', isOpen: false, localTime };
  if (mins < 570) return { phase: 'pre', isOpen: false, localTime };
  if (mins < 960) return { phase: 'regular', isOpen: true, localTime };
  if (mins < 1200) return { phase: 'after', isOpen: false, localTime };
  return { phase: 'closed', isOpen: false, localTime };
}

export async function GET() {
  const marketHours = getMarketHours();

  let agentStatus: Record<string, unknown> | null = null;
  try {
    const raw = await redis.get('aktienix:agent:status');
    if (raw) agentStatus = JSON.parse(raw as string);
  } catch { /* redis unavailable */ }

  return NextResponse.json({
    market: marketHours,
    agent: agentStatus ?? { running: false, broker: 'unknown', lastPoll: null },
    timestamp: new Date().toISOString(),
  });
}
