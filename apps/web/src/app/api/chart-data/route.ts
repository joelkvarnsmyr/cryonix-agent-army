import { NextRequest, NextResponse } from 'next/server';
import ccxt from 'ccxt';
import {
  getTradeHistory,
  getPositionHistory,
  getValidationHistory,
  getSignals,
} from '@cryonix/database';

export const dynamic = 'force-dynamic';

const exchange = new ccxt.binance({ enableRateLimit: true });

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'candles';

  try {
    switch (action) {
      // OHLCV candles + trade markers for a symbol
      case 'candles': {
        const symbol = searchParams.get('symbol') || 'BTC/USDC';
        const timeframe = searchParams.get('timeframe') || '15m';
        const limit = parseInt(searchParams.get('limit') || '200');

        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        const candles = ohlcv.map(([time, open, high, low, close, volume]) => ({
          time: Math.floor((time as number) / 1000),
          open, high, low, close, volume,
        }));

        // Fetch trades for this symbol in the candle range
        const sinceDate = new Date((candles[0]?.time || 0) * 1000);
        const symbolTrades = await getTradeHistory({
          symbol,
          since: sinceDate,
          limit: 50,
        });

        const markers = symbolTrades.map(t => ({
          time: Math.floor(new Date(t.timestamp).getTime() / 1000),
          position: t.side === 'BUY' ? 'belowBar' as const : 'aboveBar' as const,
          color: t.side === 'BUY' ? '#10b981' : '#ef4444',
          shape: t.side === 'BUY' ? 'arrowUp' as const : 'arrowDown' as const,
          text: `${t.side} $${Number(t.entryPrice).toFixed(2)}`,
          size: 1,
        }));

        return NextResponse.json({ success: true, candles, markers });
      }

      // Trade P&L history for bar chart
      case 'pnl': {
        const since = searchParams.get('since')
          ? new Date(searchParams.get('since')!)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const tradeHistory = await getTradeHistory({ since, limit: 100 });

        const pnlData = tradeHistory
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
          .map(t => ({
            id: t.id,
            time: t.timestamp.toISOString(),
            symbol: t.symbol,
            side: t.side,
            pnl: Number(t.pnl) || 0,
            entry: Number(t.entryPrice),
            exit: Number(t.exitPrice) || 0,
            confidence: Number(t.confidence),
            pattern: t.pattern,
            status: t.status,
          }));

        // Cumulative equity curve
        let cumPnl = 0;
        const equity = pnlData
          .filter(t => t.pnl !== 0)
          .map(t => {
            cumPnl += t.pnl;
            return { time: t.time, pnl: t.pnl, cumulative: cumPnl, symbol: t.symbol };
          });

        return NextResponse.json({ success: true, trades: pnlData, equity });
      }

      // Pattern performance stats
      case 'patterns': {
        const since = searchParams.get('since')
          ? new Date(searchParams.get('since')!)
          : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        const closedPositions = await getPositionHistory({ since, limit: 200 });

        // Group by pattern
        const patternMap: Record<string, { wins: number; losses: number; totalPnl: number; count: number; avgHold: number }> = {};
        for (const pos of closedPositions) {
          const p = pos.pattern || 'unknown';
          if (!patternMap[p]) patternMap[p] = { wins: 0, losses: 0, totalPnl: 0, count: 0, avgHold: 0 };
          const pnl = Number(pos.pnl) || 0;
          patternMap[p].count++;
          patternMap[p].totalPnl += pnl;
          patternMap[p].avgHold += (pos.holdingPeriod || 0);
          if (pnl > 0) patternMap[p].wins++;
          else patternMap[p].losses++;
        }

        const patterns = Object.entries(patternMap).map(([name, data]) => ({
          name: name.replace(/_/g, ' '),
          winRate: data.count > 0 ? (data.wins / data.count) * 100 : 0,
          totalPnl: data.totalPnl,
          count: data.count,
          wins: data.wins,
          losses: data.losses,
          avgHoldMins: data.count > 0 ? Math.round(data.avgHold / data.count / 60) : 0,
        }));

        return NextResponse.json({ success: true, patterns });
      }

      // AI validation impact
      case 'validation': {
        const since = searchParams.get('since')
          ? new Date(searchParams.get('since')!)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const validations = await getValidationHistory({ since, limit: 100 });

        const data = validations.map(v => ({
          time: v.timestamp.toISOString(),
          symbol: v.symbol,
          original: Number(v.originalConfidence) * 100,
          adjusted: Number(v.adjustedConfidence) * 100,
          delta: (Number(v.adjustedConfidence) - Number(v.originalConfidence)) * 100,
          approved: v.approved,
          consensus: v.consensusLevel,
          risk: v.riskLevel,
        }));

        // Stats
        const total = data.length;
        const approved = data.filter(d => d.approved).length;
        const avgDelta = total > 0 ? data.reduce((s, d) => s + d.delta, 0) / total : 0;

        return NextResponse.json({
          success: true,
          validations: data,
          stats: { total, approved, rejected: total - approved, approvalRate: total > 0 ? (approved / total) * 100 : 0, avgDelta },
        });
      }

      // Signal frequency timeline
      case 'signals': {
        const since = searchParams.get('since')
          ? new Date(searchParams.get('since')!)
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const recentSignals = await getSignals({ since, limit: 500 });

        const data = recentSignals.map(s => ({
          time: s.timestamp?.toISOString(),
          symbol: s.symbol,
          action: s.action,
          confidence: Number(s.confidence) * 100,
          pattern: s.pattern,
          executed: s.executed,
        }));

        return NextResponse.json({ success: true, signals: data });
      }

      default:
        return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('Chart Data API Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
