"use client";

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@cryonix/ui';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface EquityPoint {
  time: string;
  pnl: number;
  cumulative: number;
  symbol: string;
}

export function EquityCurve() {
  const [data, setData] = useState<EquityPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/chart-data?action=pnl');
      const json = await res.json();
      if (json.success) {
        setData(json.equity || []);
      }
    } catch (err) {
      console.error('Failed to fetch equity data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const totalPnl = data.length > 0 ? data[data.length - 1].cumulative : 0;
  const isPositive = totalPnl >= 0;
  const wins = data.filter(d => d.pnl > 0).length;
  const total = data.length;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(0) : '—';

  const chartData = data.map(d => ({
    time: new Date(d.time).toLocaleDateString('sv-SE', { month: 'short', day: 'numeric' }),
    value: Number(d.cumulative.toFixed(4)),
    pnl: Number(d.pnl.toFixed(4)),
  }));

  return (
    <Card className="glass-card">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {isPositive ? (
              <TrendingUp className="h-4 w-4 text-emerald-400" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-400" />
            )}
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Equity Curve</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className={isPositive ? 'text-emerald-400' : 'text-red-400'}>
              {isPositive ? '+' : ''}{totalPnl.toFixed(4)} USDC
            </span>
            <span className="text-muted-foreground">{total} trades</span>
            <span className="text-muted-foreground">{winRate}% WR</span>
          </div>
        </div>

        <div className="h-[160px]">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 9, fill: 'hsl(215, 16%, 35%)' }}
                  axisLine={{ stroke: 'rgba(30, 42, 68, 0.3)' }}
                  tickLine={false}
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
                  formatter={(value: number) => [`$${value.toFixed(4)}`, 'Cumulative P&L']}
                />
                <ReferenceLine y={0} stroke="hsl(218, 35%, 16%)" strokeDasharray="3 3" />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={isPositive ? '#10b981' : '#ef4444'}
                  strokeWidth={1.5}
                  fill="url(#equityGradient)"
                  dot={false}
                  animationDuration={800}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-[10px] font-mono text-muted-foreground/40">
              {loading ? 'Loading equity data...' : 'No closed trades yet'}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
