import { NextResponse } from 'next/server';
import { db, signals, validationHistory, trades } from '@cryonix/database';
import { desc, gte } from 'drizzle-orm';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface ProcessEvent {
  id: string;
  timestamp: string;
  type: 'signal_detected' | 'ai_validation' | 'risk_check' | 'trade_executed' | 'position_monitor' | 'queue_event' | 'system';
  symbol?: string;
  action?: string;
  status: 'approved' | 'rejected' | 'executed' | 'pending' | 'info' | 'warning' | 'error';
  title: string;
  description: string;
  details?: Record<string, unknown>;
  agent?: string;
  confidence?: number;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '60');
  const since = searchParams.get('since');

  const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24h default

  const events: ProcessEvent[] = [];

  try {
    // 1. Fetch recent signals
    const recentSignals = await db
      .select()
      .from(signals)
      .where(gte(signals.timestamp, sinceDate))
      .orderBy(desc(signals.timestamp))
      .limit(limit);

    for (const sig of recentSignals) {
      events.push({
        id: `sig-${sig.id}`,
        timestamp: sig.timestamp?.toISOString() || new Date().toISOString(),
        type: 'signal_detected',
        symbol: sig.symbol,
        action: sig.action,
        status: sig.executed ? 'executed' : 'pending',
        title: `${sig.pattern || 'Pattern'} detected on ${sig.symbol}`,
        description: `${sig.action} signal at ${Number(sig.confidence) * 100}% confidence. Entry: $${Number(sig.entryPrice)?.toLocaleString()}`,
        details: {
          pattern: sig.pattern,
          confidence: Number(sig.confidence),
          entryPrice: Number(sig.entryPrice),
          targetPrice: Number(sig.targetPrice),
          stopLoss: Number(sig.stopLoss),
          reasoning: sig.reasoning,
          metadata: sig.metadata,
          timeframe: sig.timeframe,
          executed: sig.executed,
        },
        agent: sig.agentId || 'QuantGuild',
        confidence: Number(sig.confidence),
      });
    }

    // 2. Fetch AI validations
    const recentValidations = await db
      .select()
      .from(validationHistory)
      .where(gte(validationHistory.timestamp, sinceDate))
      .orderBy(desc(validationHistory.timestamp))
      .limit(limit);

    for (const val of recentValidations) {
      const confChange = Number(val.adjustedConfidence) - Number(val.originalConfidence);
      const confChangeStr = confChange >= 0 ? `+${(confChange * 100).toFixed(1)}%` : `${(confChange * 100).toFixed(1)}%`;

      events.push({
        id: `val-${val.id}`,
        timestamp: val.timestamp.toISOString(),
        type: 'ai_validation',
        symbol: val.symbol,
        action: val.action,
        status: val.approved ? 'approved' : 'rejected',
        title: `GROK AI ${val.approved ? 'approved' : 'rejected'} ${val.symbol} ${val.action}`,
        description: `${val.consensusLevel} consensus. Confidence ${confChangeStr} (${(Number(val.originalConfidence) * 100).toFixed(0)}% → ${(Number(val.adjustedConfidence) * 100).toFixed(0)}%). Risk: ${val.riskLevel}`,
        details: {
          originalConfidence: Number(val.originalConfidence),
          adjustedConfidence: Number(val.adjustedConfidence),
          consensusLevel: val.consensusLevel,
          entryTiming: val.entryTiming,
          riskLevel: val.riskLevel,
          reasoning: val.reasoning,
          sourceVotes: val.sourceVotes,
          technicalIndicators: val.technicalIndicators,
          priceTargets: val.priceTargets,
          usage: val.usage,
        },
        agent: val.agentId || 'GROK',
        confidence: Number(val.adjustedConfidence),
      });
    }

    // 3. Fetch recent trades
    const recentTrades = await db
      .select()
      .from(trades)
      .where(gte(trades.timestamp, sinceDate))
      .orderBy(desc(trades.timestamp))
      .limit(limit);

    for (const trade of recentTrades) {
      const pnl = Number(trade.pnl);
      events.push({
        id: `trade-${trade.id}`,
        timestamp: trade.timestamp.toISOString(),
        type: 'trade_executed',
        symbol: trade.symbol,
        action: trade.side,
        status: trade.status === 'FILLED' || trade.status === 'CLOSED' ? 'executed' : 'pending',
        title: `${trade.side} ${trade.symbol} ${trade.status === 'CLOSED' ? '(closed)' : 'executed'}`,
        description: `Qty: ${Number(trade.quantity).toFixed(6)} @ $${Number(trade.entryPrice)?.toLocaleString()}${pnl ? ` P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}` : ''}`,
        details: {
          quantity: Number(trade.quantity),
          entryPrice: Number(trade.entryPrice),
          exitPrice: Number(trade.exitPrice),
          pnl: pnl,
          confidence: Number(trade.confidence),
          pattern: trade.pattern,
          reasoning: trade.reasoning,
          status: trade.status,
        },
        agent: trade.agentId || 'AutoTrader',
        confidence: Number(trade.confidence),
      });
    }

    // 4. Add current queue state as system events
    const pendingCount = await redis.llen('trades:pending');
    const approvedCount = await redis.llen('trades:approved');

    if (pendingCount > 0 || approvedCount > 0) {
      events.push({
        id: `queue-${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'queue_event',
        status: 'info',
        title: `Queue status: ${pendingCount} pending, ${approvedCount} approved`,
        description: `${pendingCount} signals awaiting AI validation, ${approvedCount} approved for execution`,
        details: { pending: pendingCount, approved: approvedCount },
        agent: 'Redis',
      });
    }

    // 5. Add Redis position monitoring state
    const positionsRaw = await redis.get('positions:open');
    if (positionsRaw) {
      const openPositions = JSON.parse(positionsRaw as string);
      if (Array.isArray(openPositions) && openPositions.length > 0) {
        for (const pos of openPositions) {
          events.push({
            id: `monitor-${pos.symbol}-${pos.openedAt}`,
            timestamp: pos.openedAt || new Date().toISOString(),
            type: 'position_monitor',
            symbol: pos.symbol,
            action: pos.side,
            status: 'info',
            title: `Monitoring ${pos.side} ${pos.symbol}`,
            description: `Entry: $${pos.entryPrice} | SL: $${pos.stopLoss?.toFixed(2)} | Trail: $${pos.trailingStop?.toFixed(2)} | HWM: $${pos.highWaterMark?.toFixed(2)}`,
            details: {
              entryPrice: pos.entryPrice,
              quantity: pos.quantity,
              stopLoss: pos.stopLoss,
              takeProfit: pos.takeProfit,
              trailingStop: pos.trailingStop,
              highWaterMark: pos.highWaterMark,
              confidence: pos.confidence,
              pattern: pos.pattern,
            },
            agent: 'AutoTrader',
            confidence: pos.confidence,
          });
        }
      }
    }

    // Sort all events by timestamp (newest first)
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return NextResponse.json({
      success: true,
      events: events.slice(0, limit),
      total: events.length,
      since: sinceDate.toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      events: [],
      error: error.message,
    });
  }
}
