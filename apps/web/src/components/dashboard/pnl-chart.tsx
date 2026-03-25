"use client";

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@cryonix/ui';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { DollarSign } from 'lucide-react';

interface TradeData {
  id: number;
  time: string;
  symbol: string;
  side: string;
  pnl: number;
  confidence: number;
  pattern: string;
}

export function PnlChart() {
  const [trades, setTrades] = useState<TradeData[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/chart-data?action=pnl');
      const json = await res.json();
      if (json.success) {
        setTrades(json.trades?.filter((t: TradeData) => t.pnl !== 0) || []);
      }
    } catch (err) {
      console.error('Failed to fetch P&L data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const chartData = trades.map((t, i) => ({
    index: i + 1,
    pnl: Number(t.pnl.toFixed(4)),
    symbol: t.symbol?.replace('/USDC', '').replace('/USDT', '') || '?',
    pattern: t.pattern?.replace(/_/g, ' ') || '?',
    time: new Date(t.time).toLocaleDateString('sv-SE'),
  }));

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const best = trades.reduce((b, t) => t.pnl > b ? t.pnl : b, -Infinity);
  const worst = trades.reduce((w, t) => t.pnl < w ? t.pnl : w, Infinity);

  return (
    <Card className="glass-card w-full overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">P&L Per Trade</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(4)}
            </span>
            {trades.length > 0 && (
              <>
                <span className="text-emerald-400/60">best +{best.toFixed(4)}</span>
                <span className="text-red-400/60">worst {worst.toFixed(4)}</span>
              </>
            )}
          </div>
        </div>

        <div className="h-[160px]">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <XAxis
                  dataKey="index"
                  minTickGap={20}
                  tick={{ fontSize: 8, fill: 'hsl(215, 16%, 35%)' }}
                  axisLine={{ stroke: 'rgba(30, 42, 68, 0.3)' }}
                  tickLine={false}
                  label={{ value: 'Trade #', position: 'insideBottom', fontSize: 8, fill: 'hsl(215, 16%, 30%)' }}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: 'hsl(215, 16%, 35%)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(220, 55%, 7%)',
                    border: '1px solid hsl(218, 35%, 16%)',
                    borderRadius: '8px',
                    fontSize: '10px',
                    fontFamily: 'var(--font-mono)',
                  }}
                  formatter={(value: number, _name: string, props: any) => [
                    `$${value.toFixed(4)}`,
                    `${props.payload.symbol} (${props.payload.pattern})`,
                  ]}
                  labelFormatter={(label) => `Trade #${label}`}
                />
                <ReferenceLine y={0} stroke="hsl(218, 35%, 16%)" strokeDasharray="3 3" />
                <Bar dataKey="pnl" radius={[2, 2, 0, 0]} animationDuration={600}>
                  {chartData.map((entry, i) => (
                    <Cell key={i} fill={entry.pnl >= 0 ? '#10b981' : '#ef4444'} fillOpacity={0.7} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-[10px] font-mono text-muted-foreground/40">
              {loading ? 'Loading trade data...' : 'No completed trades yet'}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
