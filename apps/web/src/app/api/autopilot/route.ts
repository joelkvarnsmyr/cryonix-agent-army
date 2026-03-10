import { NextResponse } from 'next/server';
import { db, autopilotActions } from '@cryonix/database';
import { desc } from 'drizzle-orm';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [actions, blockedRaw, directivesRaw, acuteRaw] = await Promise.all([
      db
        .select()
        .from(autopilotActions)
        .orderBy(desc(autopilotActions.createdAt))
        .limit(20),
      redis.get('brain:blocked_patterns'),
      redis.get('evolution:directives'),
      redis.get('brain:acute_trigger'),
    ]);

    const blocked = blockedRaw ? JSON.parse(blockedRaw as string) : [];
    const directives = directivesRaw ? JSON.parse(directivesRaw as string) : null;
    const acuteTrigger = acuteRaw ? JSON.parse(acuteRaw as string) : null;

    return NextResponse.json({
      actions,
      blocked,
      directives,
      acuteTrigger,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
