import { NextRequest, NextResponse } from 'next/server';
import { db, signals, getSignals, getSignalStats, getUnexecutedSignals, createSignal } from '@cryonix/database';
import { desc } from 'drizzle-orm';

/**
 * GET /api/signals
 * Query params:
 * - action: 'list' | 'unexecuted' | 'stats' (default: 'list')
 * - symbol, pattern, executed, limit, since (for filtering)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'list';
    const symbol = searchParams.get('symbol') || undefined;
    const pattern = searchParams.get('pattern') || undefined;
    const executedParam = searchParams.get('executed');
    const executed = executedParam ? executedParam === 'true' : undefined;
    const limit = parseInt(searchParams.get('limit') || '50');
    const sinceParam = searchParams.get('since');
    const since = sinceParam ? new Date(sinceParam) : undefined;

    switch (action) {
      case 'list': {
        const signalsList = await getSignals({ symbol, pattern, executed, limit, since });
        return NextResponse.json({ success: true, count: signalsList.length, data: signalsList });
      }

      case 'unexecuted': {
        const unexecutedList = await getUnexecutedSignals(limit);
        return NextResponse.json({ success: true, count: unexecutedList.length, data: unexecutedList });
      }

      case 'stats': {
        const stats = await getSignalStats({ since, pattern });
        return NextResponse.json({ success: true, data: stats });
      }

      default: {
        // Legacy support: simple list
        const recentSignals = await db
          .select()
          .from(signals)
          .orderBy(desc(signals.timestamp))
          .limit(limit);

        return NextResponse.json({ success: true, signals: recentSignals });
      }
    }
  } catch (error) {
    console.error('Error fetching signals:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch signals' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/signals
 * Create a new signal manually (primarily for testing)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const newSignal = await createSignal(body);

    return NextResponse.json({
      success: true,
      signal: newSignal,
    });
  } catch (error) {
    console.error('Error creating signal:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create signal' },
      { status: 500 }
    );
  }
}
