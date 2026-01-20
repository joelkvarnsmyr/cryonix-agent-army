import { NextRequest, NextResponse } from 'next/server';
import { db, signals } from '@cryonix/database';
import { desc } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '10');

    const recentSignals = await db
      .select()
      .from(signals)
      .orderBy(desc(signals.timestamp))
      .limit(limit);

    return NextResponse.json({
      success: true,
      signals: recentSignals,
    });
  } catch (error) {
    console.error('Error fetching signals:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch signals' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const newSignal = await db
      .insert(signals)
      .values(body)
      .returning();

    return NextResponse.json({
      success: true,
      signal: newSignal[0],
    });
  } catch (error) {
    console.error('Error creating signal:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create signal' },
      { status: 500 }
    );
  }
}
