import { NextResponse } from 'next/server';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

// Per 1M tokens: [input, output]
const MODEL_PRICING: Record<string, [number, number]> = {
  'grok-4-1-fast-reasoning': [0.20, 0.50],
  'grok-4-1-fast-non-reasoning': [0.20, 0.50],
  'grok-4-fast-reasoning': [1.00, 4.00],
  'grok-4-fast-non-reasoning': [1.00, 4.00],
  'grok-4-0709': [3.00, 15.00],
  'grok-4.20-0309-reasoning': [2.00, 6.00],
};

function calcCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['grok-4-1-fast-non-reasoning'];
  return (promptTokens / 1_000_000) * pricing[0] + (completionTokens / 1_000_000) * pricing[1];
}

export async function GET() {
  try {
    const rows = await db.execute(sql`
      SELECT
        usage->>'model' as model,
        COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '24 hours') as calls_24h,
        SUM((usage->>'prompt_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '24 hours') as prompt_24h,
        SUM((usage->>'completion_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '24 hours') as comp_24h,
        COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '7 days') as calls_7d,
        SUM((usage->>'prompt_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '7 days') as prompt_7d,
        SUM((usage->>'completion_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '7 days') as comp_7d,
        COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '30 days') as calls_30d,
        SUM((usage->>'prompt_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '30 days') as prompt_30d,
        SUM((usage->>'completion_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '30 days') as comp_30d,
        COUNT(*) as calls_all,
        SUM((usage->>'prompt_tokens')::int) as prompt_all,
        SUM((usage->>'completion_tokens')::int) as comp_all,
        MIN(timestamp) as first_call,
        MAX(timestamp) as last_call
      FROM validation_history
      WHERE usage IS NOT NULL AND usage->>'model' IS NOT NULL
      GROUP BY usage->>'model'
      ORDER BY calls_all DESC
    `);

    if (!rows.length) {
      return NextResponse.json({
        success: true,
        data: { models: [], totals: null, estimate: null },
      });
    }

    let totals = {
      calls_24h: 0, cost_24h: 0,
      calls_7d: 0, cost_7d: 0,
      calls_30d: 0, cost_30d: 0,
      calls_all: 0, cost_all: 0,
    };

    const models = rows.map((r: Record<string, unknown>) => {
      const model = r.model as string;
      const calls24h = Number(r.calls_24h) || 0;
      const calls7d = Number(r.calls_7d) || 0;
      const calls30d = Number(r.calls_30d) || 0;
      const callsAll = Number(r.calls_all) || 0;

      const cost24h = calcCost(model, Number(r.prompt_24h) || 0, Number(r.comp_24h) || 0);
      const cost7d = calcCost(model, Number(r.prompt_7d) || 0, Number(r.comp_7d) || 0);
      const cost30d = calcCost(model, Number(r.prompt_30d) || 0, Number(r.comp_30d) || 0);
      const costAll = calcCost(model, Number(r.prompt_all) || 0, Number(r.comp_all) || 0);

      totals.calls_24h += calls24h;
      totals.cost_24h += cost24h;
      totals.calls_7d += calls7d;
      totals.cost_7d += cost7d;
      totals.calls_30d += calls30d;
      totals.cost_30d += cost30d;
      totals.calls_all += callsAll;
      totals.cost_all += costAll;

      return {
        model,
        calls: { h24: calls24h, d7: calls7d, d30: calls30d, all: callsAll },
        cost: { h24: round(cost24h), d7: round(cost7d), d30: round(cost30d), all: round(costAll) },
        tokens: {
          prompt_all: Number(r.prompt_all) || 0,
          completion_all: Number(r.comp_all) || 0,
        },
        first_call: r.first_call,
        last_call: r.last_call,
      };
    });

    // Monthly estimate based on daily average over tracked period
    const firstCall = rows.reduce((earliest: string, r: Record<string, unknown>) => {
      const fc = r.first_call as string;
      return !earliest || fc < earliest ? fc : earliest;
    }, '') as string;
    const daysTracked = Math.max(1, (Date.now() - new Date(firstCall).getTime()) / (1000 * 60 * 60 * 24));
    const dailyAvg = totals.cost_all / daysTracked;
    const monthlyEstimate = dailyAvg * 30;

    return NextResponse.json({
      success: true,
      data: {
        models,
        totals: {
          calls: { h24: totals.calls_24h, d7: totals.calls_7d, d30: totals.calls_30d, all: totals.calls_all },
          cost: { h24: round(totals.cost_24h), d7: round(totals.cost_7d), d30: round(totals.cost_30d), all: round(totals.cost_all) },
        },
        estimate: {
          daily_avg: round(dailyAvg),
          monthly: round(monthlyEstimate),
          days_tracked: round(daysTracked),
        },
      },
    });
  } catch (error) {
    console.error('[API /costs] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch cost data' },
      { status: 500 },
    );
  }
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
