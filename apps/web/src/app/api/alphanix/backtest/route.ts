import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { Backtester } = await import('../../../../../../../../packages/agents/src/alphanix/backtest/backtester');

    // For now, return a placeholder — backtester requires candle data
    return NextResponse.json({
      message: 'Backtest API ready. Send candle data to run.',
      params: body,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
