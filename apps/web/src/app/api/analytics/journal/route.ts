import { NextResponse } from 'next/server';
import { db } from '@cryonix/database';
import { positionHistory, trades, configChanges } from '@cryonix/database';
import { desc, gte, eq, and } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const days = Math.min(parseInt(url.searchParams.get('days') || '7'), 90);
    const patternFilter = url.searchParams.get('pattern');
    const configFilter = url.searchParams.get('config_version');
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Fetch config version timeline from config_changes
    const configTimeline = await db.select({
      version: configChanges.configVersion,
      changeType: configChanges.changeType,
      source: configChanges.source,
      reasoning: configChanges.reasoning,
      deployedAt: configChanges.createdAt,
    }).from(configChanges)
      .orderBy(desc(configChanges.createdAt))
      .limit(50);

    // Primary: trades table (reliable source with status tracking)
    const tradeConditions: any[] = [
      gte(trades.timestamp, cutoff),
      eq(trades.status, 'CLOSED'),
    ];
    if (patternFilter) tradeConditions.push(eq(trades.pattern, patternFilter));

    const tradeRows = await db.select().from(trades)
      .where(and(...tradeConditions))
      .orderBy(desc(trades.timestamp))
      .limit(200);

    // Try to enrich from position_history (has holdingPeriod, closeReason, fees)
    const phConditions: any[] = [gte(positionHistory.closedAt, cutoff)];
    if (patternFilter) phConditions.push(eq(positionHistory.pattern, patternFilter));

    const phRows = await db.select().from(positionHistory)
      .where(and(...phConditions))
      .orderBy(desc(positionHistory.closedAt))
      .limit(200);

    // Build a lookup map from position_history by symbol+approximate time
    const phMap = new Map<string, typeof phRows[number]>();
    for (const r of phRows) {
      // Key by symbol — if multiple, latest wins (already sorted desc)
      if (!phMap.has(r.symbol)) phMap.set(r.symbol, r);
    }

    if (tradeRows.length > 0) {
      const journalTrades = tradeRows.map(t => {
        // Try to find matching position_history entry for richer data
        const ph = phMap.get(t.symbol);
        const phMeta = (ph?.metadata && typeof ph.metadata === 'object') ? ph.metadata as Record<string, any> : {};

        return {
          symbol: t.symbol,
          pattern: t.pattern,
          confidence: parseFloat(t.confidence || '0'),
          entry_price: parseFloat(t.entryPrice || '0'),
          exit_price: parseFloat(t.exitPrice || ph?.exitPrice || '0'),
          pnl: parseFloat(t.pnl || '0'),
          pnl_percent: ph ? parseFloat(ph.pnlPercent || '0') : 0,
          exit_reason: ph?.closeReason || t.status,
          holding_period_h: ph?.holdingPeriod ? Math.round((ph.holdingPeriod) / 360) / 10 : 0,
          config_version: t.configVersion || phMeta.configVersion || 'pre-tracking',
          reasoning: t.reasoning || phMeta.exitReason || '',
          opened_at: ph?.openedAt || t.timestamp,
          closed_at: ph?.closedAt || t.timestamp,
        };
      });

      const filtered = configFilter
        ? journalTrades.filter(t => t.config_version === configFilter)
        : journalTrades;

      return NextResponse.json({
        trades: filtered,
        summary: computeSummary(filtered),
        config_comparison: computeConfigComparison(filtered),
        config_timeline: configTimeline,
        source: 'trades',
        days,
      });
    }

    // Fallback: position_history only (if trades table has no CLOSED entries)
    if (phRows.length > 0) {
      const journalTrades = phRows.map(r => {
        const meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata as Record<string, any> : {};
        return {
          symbol: r.symbol,
          pattern: r.pattern,
          confidence: meta.confidence || 0,
          entry_price: parseFloat(r.entryPrice || '0'),
          exit_price: parseFloat(r.exitPrice || '0'),
          pnl: parseFloat(r.pnl || '0'),
          pnl_percent: parseFloat(r.pnlPercent || '0'),
          exit_reason: r.closeReason,
          holding_period_h: Math.round((r.holdingPeriod || 0) / 360) / 10,
          config_version: meta.configVersion || 'pre-tracking',
          reasoning: meta.exitReason || '',
          opened_at: r.openedAt,
          closed_at: r.closedAt,
        };
      });

      const filtered = configFilter
        ? journalTrades.filter(t => t.config_version === configFilter)
        : journalTrades;

      return NextResponse.json({
        trades: filtered,
        summary: computeSummary(filtered),
        config_comparison: computeConfigComparison(filtered),
        config_timeline: configTimeline,
        source: 'position_history',
        days,
      });
    }

    // No data in either table
    return NextResponse.json({
      trades: [],
      summary: computeSummary([]),
      config_comparison: [],
      config_timeline: configTimeline,
      source: 'none',
      days,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

interface JournalTrade {
  symbol: string;
  pattern: string | null;
  pnl: number;
  pnl_percent: number;
  exit_reason: string | null;
  holding_period_h: number;
  config_version: string;
  [key: string]: any;
}

function computeSummary(trades: JournalTrade[]) {
  if (trades.length === 0) return { total_trades: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgHolding = trades.reduce((s, t) => s + t.holding_period_h, 0) / trades.length;

  const patternPnl: Record<string, number> = {};
  trades.forEach(t => {
    if (t.pattern) patternPnl[t.pattern] = (patternPnl[t.pattern] || 0) + t.pnl;
  });
  const sorted = Object.entries(patternPnl).sort((a, b) => b[1] - a[1]);

  return {
    total_trades: trades.length,
    win_rate: parseFloat((wins.length / trades.length * 100).toFixed(1)),
    total_pnl: parseFloat(totalPnl.toFixed(2)),
    avg_holding_h: parseFloat(avgHolding.toFixed(1)),
    best_pattern: sorted[0]?.[0] || null,
    worst_pattern: sorted[sorted.length - 1]?.[0] || null,
    config_versions_used: [...new Set(trades.map(t => t.config_version))],
  };
}

function computeConfigComparison(trades: JournalTrade[]) {
  const byVersion: Record<string, JournalTrade[]> = {};
  trades.forEach(t => {
    if (!byVersion[t.config_version]) byVersion[t.config_version] = [];
    byVersion[t.config_version].push(t);
  });
  return Object.entries(byVersion).map(([version, vTrades]) => ({
    version,
    trades: vTrades.length,
    pnl: parseFloat(vTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)),
    win_rate: parseFloat((vTrades.filter(t => t.pnl > 0).length / vTrades.length * 100).toFixed(1)),
  }));
}
