"use client";

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, Badge } from '@cryonix/ui';
import { ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, ZAxis } from 'recharts';
import { Brain } from 'lucide-react';

interface ValidationPoint {
  time: string;
  symbol: string;
  original: number;
  adjusted: number;
  delta: number;
  approved: boolean;
  consensus: string;
  risk: string;
}

interface Stats {
  total: number;
  approved: number;
  rejected: number;
  approvalRate: number;
  avgDelta: number;
}

export function AiImpactChart() {
  const [data, setData] = useState<ValidationPoint[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/chart-data?action=validation');
      const json = await res.json();
      if (json.success) {
        setData(json.validations || []);
        setStats(json.stats || null);
      }
    } catch (err) {
      console.error('Failed to fetch validation data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 120000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const chartData = data.map(d => ({
    original: Number(d.original.toFixed(1)),
    adjusted: Number(d.adjusted.toFixed(1)),
    approved: d.approved,
    symbol: d.symbol?.replace('/USDC', '').replace('/USDT', ''),
    consensus: d.consensus,
    z: 60,
  }));

  return (
    <Card className="glass-card">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-violet-400" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">AI Validation Impact</span>
          </div>
          {stats && (
            <div className="flex items-center gap-2 text-[10px] font-mono">
              <Badge variant="outline" className="text-[8px] h-4 px-1.5 text-emerald-400 border-emerald-400/20">
                {stats.approvalRate.toFixed(0)}% approved
              </Badge>
              <span className={`${stats.avgDelta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                avg {stats.avgDelta >= 0 ? '+' : ''}{stats.avgDelta.toFixed(1)}%
              </span>
              <span className="text-muted-foreground/50">{stats.total} checks</span>
            </div>
          )}
        </div>

        <div className="h-[160px]">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 5, right: 5, left: -10, bottom: 5 }}>
                <XAxis
                  dataKey="original"
                  type="number"
                  domain={[0, 100]}
                  tick={{ fontSize: 9, fill: 'hsl(215, 16%, 35%)' }}
                  axisLine={{ stroke: 'rgba(30, 42, 68, 0.3)' }}
                  tickLine={false}
                  label={{ value: 'Original %', position: 'insideBottom', offset: -2, fontSize: 8, fill: 'hsl(215, 16%, 30%)' }}
                />
                <YAxis
                  dataKey="adjusted"
                  type="number"
                  domain={[0, 100]}
                  tick={{ fontSize: 9, fill: 'hsl(215, 16%, 35%)' }}
                  axisLine={false}
                  tickLine={false}
                  label={{ value: 'Adjusted %', angle: -90, position: 'insideLeft', offset: 15, fontSize: 8, fill: 'hsl(215, 16%, 30%)' }}
                />
                <ZAxis dataKey="z" range={[30, 80]} />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(220, 55%, 7%)',
                    border: '1px solid hsl(218, 35%, 16%)',
                    borderRadius: '8px',
                    fontSize: '10px',
                    fontFamily: 'var(--font-mono)',
                  }}
                  formatter={(_value: number, _name: string, props: any) => {
                    const d = props.payload;
                    return [`${d.symbol}: ${d.original}% → ${d.adjusted}% (${d.consensus})`, d.approved ? 'Approved' : 'Rejected'];
                  }}
                />
                {/* Diagonal reference line (no change) */}
                <ReferenceLine
                  segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]}
                  stroke="hsl(218, 35%, 16%)"
                  strokeDasharray="4 4"
                />
                {/* Approved scatter */}
                <Scatter
                  data={chartData.filter(d => d.approved)}
                  fill="#10b981"
                  fillOpacity={0.6}
                  animationDuration={500}
                />
                {/* Rejected scatter */}
                <Scatter
                  data={chartData.filter(d => !d.approved)}
                  fill="#ef4444"
                  fillOpacity={0.6}
                  animationDuration={500}
                />
              </ScatterChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-[10px] font-mono text-muted-foreground/40">
              {loading ? 'Loading validation data...' : 'No AI validations yet'}
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-2 text-[9px] font-mono text-muted-foreground/50">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> Approved
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-red-500" /> Rejected
          </span>
          <span className="ml-auto">above line = AI boosted confidence</span>
        </div>
      </CardContent>
    </Card>
  );
}
