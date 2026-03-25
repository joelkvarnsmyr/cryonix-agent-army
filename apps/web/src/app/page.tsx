"use client";

import { usePortfolio } from '@/hooks/useMarketData';
import { useAutoTrade } from '@/hooks/useAutoTrade';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { PositionTpSlBar } from '@/components/dashboard/position-tp-sl-bar';

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function HomePage() {
  const { portfolio, loading: portfolioLoading } = usePortfolio(15_000);
  const { data: autoTrade } = useAutoTrade(10_000);
  const { health } = useSystemHealth(30_000);

  const [equity, setEquity] = useState<{ time: string; cumulative: number }[]>([]);
  useEffect(() => {
    const load = () =>
      fetch('/api/chart-data?action=pnl')
        .then(r => r.json())
        .then(d => setEquity(d.equity || []))
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const [trades, setTrades] = useState<Array<{
    symbol: string; pnl: number; pnl_percent: number; closed_at: string; pattern: string | null;
  }>>([]);
  const [weekPnl, setWeekPnl] = useState(0);
  useEffect(() => {
    const load = () =>
      fetch('/api/analytics/journal?days=7')
        .then(r => r.json())
        .then(d => {
          setTrades((d.trades || []).slice(0, 5));
          setWeekPnl(d.summary?.total_pnl || 0);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const positions   = autoTrade?.positions    || [];
  const dailyPnl    = autoTrade?.dailyState?.dailyPnl || 0;
  const totalValue  = portfolio?.totalValue   || 0;
  const dailyPnlPct = totalValue > 0 ? (dailyPnl / totalValue) * 100 : 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frozen      = (autoTrade?.toml as any)?.baseline?.frozen === true;
  const healthyCount  = health?.summary?.healthy || 0;
  const totalServices = health?.summary?.total   || 4;

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-4">

        {/* Baseline frozen banner */}
        {frozen && (
          <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-4 py-2 flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse-dot" />
            <span className="text-cyan-400 text-[10px] font-mono font-bold tracking-widest">BASELINE FROZEN</span>
            <span className="text-xs text-muted-foreground/60">AI Brain and Evolution are paused</span>
          </div>
        )}

        {/* Portfolio value */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-1">PORTFOLIO VALUE</div>
          <div className="text-3xl font-bold tracking-tight text-glow-cyan">
            {portfolioLoading && !portfolio ? '...' : `$${totalValue.toFixed(2)}`}
          </div>
          <div className="mt-1 flex items-center justify-center gap-3 text-sm">
            <span className={dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {dailyPnl >= 0 ? '+' : ''}{dailyPnl.toFixed(4)} today
              <span className="text-xs ml-1 opacity-60">({dailyPnlPct >= 0 ? '+' : ''}{dailyPnlPct.toFixed(1)}%)</span>
            </span>
            <span className="text-muted-foreground/30">|</span>
            <span className={weekPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {weekPnl >= 0 ? '+' : ''}{weekPnl.toFixed(4)} / 7d
            </span>
          </div>
          <div className="mt-3 flex items-center justify-center gap-4 text-[10px] font-mono text-muted-foreground/50">
            <span>{positions.length} open position{positions.length !== 1 ? 's' : ''}</span>
            <span className="text-muted-foreground/25">·</span>
            <span>{healthyCount}/{totalServices} services healthy</span>
          </div>
        </div>

        {/* Equity curve */}
        {equity.length > 1 && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2">EQUITY CURVE (30d)</div>
            <ResponsiveContainer width="100%" height={130}>
              <AreaChart data={equity}>
                <defs>
                  <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(191,100%,50%)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(191,100%,50%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" hide />
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip
                  contentStyle={{ background: 'hsl(220,55%,7%)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11 }}
                  labelFormatter={(v) => new Date(v as string).toLocaleDateString()}
                  formatter={(v: number) => [`$${v.toFixed(4)}`, 'P&L']}
                />
                <Area type="monotone" dataKey="cumulative" stroke="hsl(191,100%,50%)" strokeWidth={1.5} fill="url(#eqGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Live positions — dynamic, all symbols */}
        <div>
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2">
            OPEN POSITIONS {positions.length > 0 && `(${positions.length})`}
          </div>
          {positions.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
              <div className="text-sm text-muted-foreground/40">No open positions</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {positions.map(pos => {
                const plColor = pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400';
                return (
                  <div key={pos.symbol} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">

                    {/* Symbol row */}
                    <div className="flex items-start justify-between mb-1">
                      <div>
                        <span className="font-mono text-sm font-semibold text-foreground">
                          {pos.symbol.replace('/USDC', '')}
                        </span>
                        {pos.pattern && (
                          <span className="ml-2 text-[9px] font-mono text-primary/50 border border-primary/15 px-1 py-0.5 rounded">
                            {pos.pattern.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>
                      <span className={`text-base font-bold ${plColor}`}>
                        {pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct.toFixed(2)}%
                      </span>
                    </div>

                    {/* Price info */}
                    <div className="text-xs font-mono text-muted-foreground space-y-0.5">
                      <div>
                        <span className="text-muted-foreground/50">Entry </span>
                        ${pos.entryPrice.toFixed(4)}
                        <span className="text-muted-foreground/30 mx-1">→</span>
                        <span className={plColor}>${pos.currentPrice.toFixed(4)}</span>
                      </div>
                      <div className={plColor}>
                        {pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(4)} unrealized
                      </div>
                      <div className="text-muted-foreground/50">
                        {pos.quantity} · conf {(pos.confidence * 100).toFixed(0)}% · {timeAgo(pos.openedAt)}
                      </div>
                    </div>

                    {/* TP/SL progress bar */}
                    <PositionTpSlBar
                      entry={pos.entryPrice}
                      current={pos.currentPrice}
                      slPrice={pos.stopLoss}
                      tpPrice={pos.takeProfit}
                    />

                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent trades */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2.5">RECENT TRADES (7d)</div>
          {trades.length === 0 ? (
            <div className="text-sm text-muted-foreground/40">No trades in last 7 days</div>
          ) : (
            <div className="space-y-1.5">
              {trades.map((t, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-foreground/80 w-14">
                      {t.symbol.replace('/USDC', '')}
                    </span>
                    {t.pattern && (
                      <span className="text-[10px] font-mono text-muted-foreground/40">
                        {t.pattern.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-mono ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/40 w-14 text-right">
                      {timeAgo(t.closed_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Service health */}
        <div className="flex items-center justify-center gap-5 py-1 text-[10px] font-mono text-muted-foreground/40">
          {(health?.services || []).map((s: { name: string; status: string; latency?: number }) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${
                s.status === 'healthy' ? 'bg-emerald-400' : s.status === 'degraded' ? 'bg-amber-400' : 'bg-red-400'
              }`} />
              {s.name}
              {s.latency !== undefined && <span className="opacity-50">{s.latency}ms</span>}
            </span>
          ))}
        </div>

      </div>
    </DashboardLayout>
  );
}
