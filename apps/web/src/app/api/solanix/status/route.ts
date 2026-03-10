import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [statusRaw, accountRaw, riskRaw] = await Promise.all([
      redis.get('solanix:status'),
      redis.get('solanix:account'),
      redis.get('solanix:risk'),
    ]);

    const status = statusRaw ?? null;
    const account = accountRaw ? JSON.parse(accountRaw as string) : null;
    const risk = riskRaw ? JSON.parse(riskRaw as string) : null;

    return NextResponse.json({ status, account, risk, timestamp: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
