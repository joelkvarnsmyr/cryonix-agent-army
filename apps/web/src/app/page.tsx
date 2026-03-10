"use client";

import Link from 'next/link';
import { usePortfolio } from '@/hooks/useMarketData';
import { useAutoTrade } from '@/hooks/useAutoTrade';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function HomePage() {
  const { portfolio } = usePortfolio(15000);
  const { data: autoTrade } = useAutoTrade(10000);
  const { health } = useSystemHealth(30000);

  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 16));
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, []);

  const [equity, setEquity] = useState<{ time: string; cumulative: number }[]>([]);
  useEffect(() => {
    const load = () => fetch('/api/chart-data?action=pnl')
      .then(r => r.json())
      .then(d => setEquity(d.equity || []))
      .catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  const [trades, setTrades] = useState<Array<{
    symbol: string; pnl: number; pnl_percent: number; closed_at: string; pattern: string | null;
  }>>([]);
  const [weekPnl, setWeekPnl] = useState(0);
  useEffect(() => {
    const load = () => fetch('/api/analytics/journal?days=7')
      .then(r => r.json())
      .then(d => {
        setTrades((d.trades || []).slice(0, 5));
        setWeekPnl(d.summary?.total_pnl || 0);
      })
      .catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const positions = autoTrade?.positions || [];
  const dailyPnl = autoTrade?.dailyState?.dailyPnl || 0;
  const totalValue = portfolio?.totalValue || 0;
  const dailyPnlPct = totalValue > 0 ? (dailyPnl / totalValue) * 100 : 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frozen = (autoTrade?.toml as any)?.baseline?.frozen === true;
  const healthyCount = health?.summary?.healthy || 0;
  const totalServices = health?.summary?.total || 4;
  const allHealthy = health?.status === 'healthy';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto p-4 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm font-bold tracking-wider text-muted-foreground">CRYONIX</span>
            <Link href="/aktienix" className="font-mono text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">Stocks →</Link>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${allHealthy ? 'bg-emerald-400 animate-pulse' : health?.status === 'degraded' ? 'bg-amber-400' : 'bg-red-400'}`} />
              {healthyCount}/{totalServices}
            </span>
            <span className="font-mono">{clock} UTC</span>
          </div>
        </div>

        {/* Balance */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
          <div className="text-3xl font-bold tracking-tight text-glow-cyan">
            ${totalValue.toFixed(2)}
          </div>
          <div className="mt-1 flex items-center justify-center gap-3 text-sm">
            <span className={dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {dailyPnl >= 0 ? '+' : ''}{dailyPnl.toFixed(2)} today ({dailyPnlPct >= 0 ? '+' : ''}{dailyPnlPct.toFixed(1)}%)
            </span>
            <span className="text-muted-foreground">|</span>
            <span className={weekPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {weekPnl >= 0 ? '+' : ''}{weekPnl.toFixed(2)} / 7d
            </span>
          </div>
          {frozen && (
            <div className="mt-2 inline-block rounded-full bg-cyan-500/10 border border-cyan-500/20 px-3 py-0.5 text-xs text-cyan-400">
              FROZEN
            </div>
          )}
        </div>

        {/* Equity Curve */}
        {equity.length > 1 && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
            <div className="text-xs text-muted-foreground mb-2">Equity (30d)</div>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={equity}>
                <defs>
                  <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(191, 100%, 50%)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(191, 100%, 50%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" hide />
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip
                  contentStyle={{ background: 'hsl(220, 55%, 7%)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(v) => new Date(v as string).toLocaleDateString()}
                  formatter={(v: number) => [`$${v.toFixed(4)}`, 'P&L']}
                />
                <Area
                  type="monotone"
                  dataKey="cumulative"
                  stroke="hsl(191, 100%, 50%)"
                  strokeWidth={2}
                  fill="url(#eqGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Positions */}
        <div className="grid grid-cols-2 gap-3">
          {['INJ', 'ATOM'].map(symbol => {
            const pos = positions.find((p: { symbol: string }) => p.symbol.startsWith(symbol));
            return (
              <div key={symbol} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                <div className="text-xs text-muted-foreground mb-1">{symbol}/USDC</div>
                {pos ? (
                  <>
                    <div className={`text-lg font-semibold ${pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {pos.pnl >= 0 ? '+' : ''}{pos.pnlPct.toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      <div>${pos.entryPrice.toFixed(4)} &rarr; ${pos.currentPrice.toFixed(4)}</div>
                      <div>SL ${pos.stopLoss.toFixed(4)}</div>
                      <div className={pos.pnl >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}>
                        {pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(4)}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground/50 mt-1">No position</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Recent Trades */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="text-xs text-muted-foreground mb-2">Recent trades</div>
          {trades.length === 0 ? (
            <div className="text-sm text-muted-foreground/50">No trades in last 7 days</div>
          ) : (
            <div className="space-y-1.5">
              {trades.map((t, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground w-16">{t.symbol.replace('/USDC', '')}</span>
                    {t.pattern && <span className="text-xs text-muted-foreground/60">{t.pattern}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)}
                    </span>
                    <span className="text-xs text-muted-foreground w-14 text-right">{timeAgo(t.closed_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Health */}
        <div className="flex items-center justify-center gap-4 py-2 text-xs text-muted-foreground">
          {(health?.services || []).map((s: { name: string; status: string; latency?: number }) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${
                s.status === 'healthy' ? 'bg-emerald-400' : s.status === 'degraded' ? 'bg-amber-400' : 'bg-red-400'
              }`} />
              {s.name}
            </span>
          ))}
        </div>

      </div>
    </div>
  );
}
