"use client";

import { Card, CardContent } from '@cryonix/ui';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Wallet } from 'lucide-react';
import { usePortfolio } from '@/hooks/useMarketData';

const COLORS = ['#f59e0b', '#627eea', '#00d4ff', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4'];

export function PortfolioDonut() {
  const { portfolio, loading } = usePortfolio(30000);

  const holdings = portfolio?.holdings
    ?.filter((h: any) => h.usdValue > 0.01)
    ?.sort((a: any, b: any) => b.usdValue - a.usdValue) || [];

  const totalValue = holdings.reduce((s: number, h: any) => s + h.usdValue, 0);

  const chartData = holdings.map((h: any, i: number) => ({
    name: h.currency,
    value: Number(h.usdValue.toFixed(2)),
    pct: totalValue > 0 ? ((h.usdValue / totalValue) * 100).toFixed(1) : '0',
    amount: h.amount,
    color: COLORS[i % COLORS.length],
  }));

  return (
    <Card className="glass-card">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Allocation</span>
          </div>
          <span className="text-sm font-mono font-bold text-foreground">
            ${totalValue.toFixed(2)}
          </span>
        </div>

        <div className="flex items-center gap-4">
          {/* Donut */}
          <div className="h-[130px] w-[130px] flex-shrink-0">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={35}
                    outerRadius={55}
                    paddingAngle={2}
                    dataKey="value"
                    animationDuration={600}
                    stroke="none"
                  >
                    {chartData.map((entry: any, i: number) => (
                      <Cell key={i} fill={entry.color} fillOpacity={0.8} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(220, 55%, 7%)',
                      border: '1px solid hsl(218, 35%, 16%)',
                      borderRadius: '8px',
                      fontSize: '10px',
                      fontFamily: 'var(--font-mono)',
                    }}
                    formatter={(value: number, _name: string, props: any) => [
                      `$${value} (${props.payload.pct}%)`,
                      props.payload.name,
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-[10px] font-mono text-muted-foreground/40">
                {loading ? '...' : 'No data'}
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="flex-1 space-y-1.5">
            {chartData.map((item: any, i: number) => (
              <div key={i} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: item.color }} />
                  <span className="text-[10px] font-mono font-semibold text-foreground/80">{item.name}</span>
                </div>
                <div className="flex items-center gap-2 text-[9px] font-mono text-muted-foreground">
                  <span>${item.value}</span>
                  <span className="text-muted-foreground/40">{item.pct}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
