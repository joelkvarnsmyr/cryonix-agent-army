import { NextRequest, NextResponse } from 'next/server';
import { BacktesterAgent, type BacktestResult } from '@cryonix/agents';
import { type PatternType, BacktestRequestSchema } from '@cryonix/types';
import {
  saveBacktestResult,
  getBacktestResults,
  getBacktestResultById,
  deleteBacktestResult,
  cleanupOldBacktests,
} from '@cryonix/database';

// Singleton backtester instance
let backtesterInstance: BacktesterAgent | null = null;

async function getBacktester(): Promise<BacktesterAgent> {
  if (!backtesterInstance) {
    backtesterInstance = new BacktesterAgent();
    await backtesterInstance.initialize();
    await backtesterInstance.start();
  }
  return backtesterInstance;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';
  const id = searchParams.get('id');
  const symbol = searchParams.get('symbol');
  const timeframe = searchParams.get('timeframe') || '1h';
  const days = parseInt(searchParams.get('days') || '30');

  try {
    switch (action) {
      case 'list': {
        // Return list of all backtest results from database
        const dbResults = await getBacktestResults({ limit: 50 });
        const results = dbResults.map((r) => {
          const config = r.config as any;
          const metrics = r.metrics as any;
          return {
            id: r.id,
            timestamp: r.timestamp,
            symbols: config.symbols,
            timeframe: config.timeframe,
            totalTrades: metrics.totalTrades,
            winRate: metrics.winRate,
            sharpeRatio: metrics.sharpeRatio,
            totalReturn: metrics.totalReturnPercent,
            status: r.status,
          };
        });
        return NextResponse.json({ success: true, results });
      }

      case 'status': {
        if (!id) {
          return NextResponse.json({ error: 'Missing backtest id' }, { status: 400 });
        }
        const dbResult = await getBacktestResultById(parseInt(id));
        if (!dbResult) {
          return NextResponse.json({ error: 'Backtest not found' }, { status: 404 });
        }
        return NextResponse.json({
          success: true,
          status: dbResult.status,
          id: dbResult.id,
          timestamp: dbResult.timestamp,
        });
      }

      case 'results': {
        if (!id) {
          return NextResponse.json({ error: 'Missing backtest id' }, { status: 400 });
        }
        const dbResult = await getBacktestResultById(parseInt(id));
        if (!dbResult) {
          return NextResponse.json({ error: 'Backtest not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true, result: dbResult });
      }

      case 'quick': {
        // Run a quick backtest
        if (!symbol) {
          return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });
        }

        const backtester = await getBacktester();
        const result = await backtester.runBacktest({
          symbols: [symbol],
          timeframe,
          startDate: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
          endDate: new Date(),
          initialCapital: 10000,
        });

        // Save to database
        const saved = await saveBacktestResult({
          userId: null,
          config: result.config as any,
          metrics: result.metrics as any,
          trades: result.trades as any,
          walkForwardResults: result.walkForwardResults as any,
          equity: (result as any).equity,
          monthlyReturns: result.metrics.monthlyReturns as any,
          patternPerformance: result.metrics.patternPerformance as any,
          status: 'COMPLETED',
          errorMessage: null,
        });

        return NextResponse.json({
          success: true,
          id: saved.id,
          summary: {
            totalTrades: result.metrics.totalTrades,
            winRate: result.metrics.winRate.toFixed(1) + '%',
            sharpeRatio: result.metrics.sharpeRatio.toFixed(2),
            totalReturn: result.metrics.totalReturnPercent.toFixed(2) + '%',
            maxDrawdown: result.metrics.maxDrawdownPercent.toFixed(2) + '%',
            profitFactor: result.metrics.profitFactor.toFixed(2),
          },
        });
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[API/Backtest] GET Error:', error);
    return NextResponse.json(
      { error: 'Backtest operation failed', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate request with Zod
    const validation = BacktestRequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Validation failed',
          details: validation.error.format(),
        },
        { status: 400 }
      );
    }

    const data = validation.data;
    const {
      symbols,
      timeframe,
      days,
      startDate,
      endDate,
      initialCapital,
      patterns,
      positionSizing,
      useHalfKelly,
      walkForward,
    } = data;

    const backtester = await getBacktester();

    // Calculate date range
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(end.getTime() - (days || 30) * 24 * 60 * 60 * 1000);

    const result = await backtester.runBacktest({
      symbols: symbols,
      timeframe: timeframe,
      startDate: start,
      endDate: end,
      initialCapital: initialCapital,
      patterns: patterns as PatternType[],
      positionSizing: positionSizing,
      useHalfKelly: useHalfKelly,
      walkForward: walkForward
        ? {
          enabled: walkForward.enabled,
          windows: walkForward.windows || 4,
          inSampleDays: walkForward.inSampleDays || 60,
          outOfSampleDays: walkForward.outOfSampleDays || 15,
        }
        : undefined,
    });

    // Save to database
    const saved = await saveBacktestResult({
      userId: null,
      config: result.config as any,
      metrics: result.metrics as any,
      trades: result.trades as any,
      walkForwardResults: result.walkForwardResults as any,
      equity: (result as any).equity,
      monthlyReturns: result.metrics.monthlyReturns as any,
      patternPerformance: result.metrics.patternPerformance as any,
      status: 'COMPLETED',
      errorMessage: null,
    });

    return NextResponse.json({
      success: true,
      id: saved.id,
      durationMs: result.durationMs,
      metrics: {
        totalTrades: result.metrics.totalTrades,
        winRate: result.metrics.winRate,
        winningTrades: result.metrics.winningTrades,
        losingTrades: result.metrics.losingTrades,
        sharpeRatio: result.metrics.sharpeRatio,
        sortinoRatio: result.metrics.sortinoRatio,
        calmarRatio: result.metrics.calmarRatio,
        totalReturn: result.metrics.totalReturn,
        totalReturnPercent: result.metrics.totalReturnPercent,
        annualizedReturn: result.metrics.annualizedReturn,
        maxDrawdown: result.metrics.maxDrawdown,
        maxDrawdownPercent: result.metrics.maxDrawdownPercent,
        profitFactor: result.metrics.profitFactor,
        expectancy: result.metrics.expectancy,
        averageWin: result.metrics.averageWin,
        averageLoss: result.metrics.averageLoss,
        patternPerformance: result.metrics.patternPerformance,
        monthlyReturns: result.metrics.monthlyReturns,
      },
      walkForwardResults: result.walkForwardResults,
      tradesCount: result.trades.length,
      skippedSignalsCount: result.skippedSignals.length,
    });
  } catch (error) {
    console.error('[API/Backtest] POST Error:', error);
    return NextResponse.json(
      { error: 'Failed to run backtest', details: String(error) },
      { status: 500 }
    );
  }
}

// DELETE endpoint - clean up old backtest results or specific ID
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const daysToKeep = parseInt(searchParams.get('daysToKeep') || '90');

    if (id) {
      // Delete specific backtest
      const deleted = await deleteBacktestResult(parseInt(id));
      if (!deleted) {
        return NextResponse.json({ error: 'Backtest not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, message: `Backtest ${id} deleted` });
    } else {
      // Clean up old results
      const deletedCount = await cleanupOldBacktests(daysToKeep);
      return NextResponse.json({
        success: true,
        message: `Cleaned up ${deletedCount} old backtest results`,
        deletedCount,
      });
    }
  } catch (error) {
    console.error('[API/Backtest] DELETE Error:', error);
    return NextResponse.json(
      { error: 'Delete operation failed', details: String(error) },
      { status: 500 }
    );
  }
}
