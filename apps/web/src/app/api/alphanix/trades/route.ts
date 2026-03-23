import { NextResponse } from 'next/server';
import { Client } from 'pg';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const podId = searchParams.get('pod') || 'crypto';
  const limit = parseInt(searchParams.get('limit') || '50');

  try {
    const pg = new Client({ connectionString: process.env.POSTGRES_URL });
    await pg.connect();
    const res = await pg.query(
      'SELECT * FROM alphanix_trades WHERE pod_id = $1 ORDER BY timestamp DESC LIMIT $2',
      [podId, limit]
    );
    await pg.end();
    return NextResponse.json({ trades: res.rows, timestamp: new Date().toISOString() });
  } catch (error) {
    // Table may not exist yet
    return NextResponse.json({ trades: [], timestamp: new Date().toISOString() });
  }
}
