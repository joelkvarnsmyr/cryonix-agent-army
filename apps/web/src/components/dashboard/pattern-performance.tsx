"use client";

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@cryonix/ui';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Target } from 'lucide-react';

interface PatternData {
  name: string;
  winRate: number;
  totalPnl: number;
  count: number;
  wins: number;
  losses: number;
  avgHoldMins: number;
}

export function PatternPerformance() {
  const [patterns, setPatterns] = useState<PatternData[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'winRate' | 'pnl'>('winRate');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/chart-data?action=patterns');
      const json = await res.json();
      if (json.success) {
        setPatterns(json.patterns?.sort((a: PatternData, b: PatternData) => b.count - a.count) || []);
      }
    } catch (err) {
      console.error('Failed to fetch pattern data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 120000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const dataKey = view === 'winRate' ? 'winRate' : 'totalPnl';
  const format = view === 'winRate' ? (v: number) => `${v.toFixed(0)}%` : (v: number) => `$${v.toFixed(3)}`;

  return (
    <Card className="glass-card w-full overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-violet-400" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Pattern Performance</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setView('winRate')}
              className={`px-2 py-0.5 rounded text-[9px] font-mono transition-all ${view === 'winRate' ? 'bg-violet-500/10 text-violet-400' : 'text-muted-foreground/50 hover:text-muted-foreground'
                }`}
            >
              Win Rate
            </button>
            <button
              onClick={() => setView('pnl')}
              className={`px-2 py-0.5 rounded text-[9px] font-mono transition-all ${view === 'pnl' ? 'bg-violet-500/10 text-violet-400' : 'text-muted-foreground/50 hover:text-muted-foreground'
                }`}
            >
              P&L
            </button>
          </div>
        </div>

        <div className="h-[160px]">
          {patterns.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={patterns} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                <XAxis
                  type="number"
                  tick={{ fontSize: 9, fill: 'hsl(215, 16%, 55%)' }}
                  axisLine={{ stroke: 'rgba(30, 42, 68, 0.3)' }}
                  tickLine={false}
                  tickFormatter={format}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 8, fill: 'hsl(215, 16%, 65%)' }}
                  axisLine={false}
                  tickLine={false}
                  width={90}
                />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(220, 55%, 7%)',
                    border: '1px solid hsl(218, 35%, 16%)',
                    borderRadius: '8px',
                    fontSize: '10px',
                    fontFamily: 'var(--font-mono)',
                    color: 'hsl(214, 20%, 85%)',
                  }}
                  labelStyle={{ color: 'hsl(214, 20%, 70%)' }}
                  itemStyle={{ color: 'hsl(214, 20%, 85%)' }}
                  formatter={(value: number, _name: string, props: any) => {
                    const p = props.payload as PatternData;
                    return [
                      view === 'winRate' ? `${value.toFixed(1)}%` : `$${value.toFixed(4)}`,
                      `${p.wins}W/${p.losses}L (${p.count} total)`,
                    ];
                  }}
                />
                <Bar dataKey={dataKey} radius={[0, 4, 4, 0]} animationDuration={600} barSize={14}>
                  {patterns.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={
                        view === 'winRate'
                          ? entry.winRate >= 60 ? '#10b981' : entry.winRate >= 40 ? '#f59e0b' : '#ef4444'
                          : entry.totalPnl >= 0 ? '#10b981' : '#ef4444'
                      }
                      fillOpacity={0.6}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-[10px] font-mono text-muted-foreground/40">
              {loading ? 'Loading pattern data...' : 'No closed positions yet'}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
