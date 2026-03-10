'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  useAktienixStatus,
  useAktienixPortfolio,
  useAktienixPositions,
  useAktienixTrades,
} from '@/hooks/useAktienix';

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const PHASE_LABEL: Record<string, string> = {
  pre: 'PRE-MARKET',
  regular: 'MARKET OPEN',
  after: 'AFTER-HOURS',
  closed: 'MARKET CLOSED',
};

const PHASE_COLOR: Record<string, string> = {
  pre: 'text-amber-400',
  regular: 'text-emerald-400',
  after: 'text-amber-400',
  closed: 'text-muted-foreground',
};

export default function AktienixPage() {
  const { data: status } = useAktienixStatus(30_000);
  const { data: portfolio } = useAktienixPortfolio(15_000);
  const { positions } = useAktienixPositions(15_000);
  const { trades, summary } = useAktienixTrades(20, 30_000);

  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 16));
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);

  // Build a cumulative equity curve from closed trades
  const equityData = (() => {
    if (trades.length === 0) return [];
    let cum = 0;
    return [...trades].reverse().map(t => {
      cum += t.pnl ?? 0;
      return { time: t.closedAt, cumulative: cum };
    });
  })();

  const phase = status?.market.phase ?? 'closed';
  const isOpen = status?.market.isOpen ?? false;
  const etTime = status?.market.localTime ?? '--:-- ET';
  const brokerLabel = status?.agent.broker ?? 'unknown';
  const agentRunning = status?.agent.running ?? false;

  const portfolioValue = portfolio?.portfolioValue ?? 0;
  const buyingPower = portfolio?.buyingPower ?? 0;
  const settledCash = portfolio?.settledCash ?? 0;
  const dailyPnl = portfolio?.dailyPnl ?? 0;
  const dailyPnlPct = portfolio?.dailyPnlPct ?? 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto p-4 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/" className="font-mono text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">← Crypto</Link>
            <span className="font-mono text-sm font-bold tracking-wider text-muted-foreground">AKTIENIX</span>
            <span className={`text-xs font-mono ${PHASE_COLOR[phase]}`}>
              {PHASE_LABEL[phase]}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${agentRunning ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              {brokerLabel}
            </span>
            <span className="font-mono">{clock} UTC</span>
            <span className="font-mono text-muted-foreground/60">{etTime}</span>
          </div>
        </div>

        {/* Balance */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
          <div className="text-xs text-muted-foreground mb-1 font-mono">PORTFOLIO VALUE</div>
          <div className="text-3xl font-bold tracking-tight text-emerald-400">
            ${portfolioValue.toFixed(2)}
          </div>
          <div className="mt-1 flex items-center justify-center gap-3 text-sm">
            <span className={dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {dailyPnl >= 0 ? '+' : ''}{dailyPnl.toFixed(2)} today ({dailyPnlPct >= 0 ? '+' : ''}{dailyPnlPct.toFixed(2)}%)
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/60 mb-0.5">Buying Power</div>
              <div className="font-mono text-foreground">${buyingPower.toFixed(2)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/60 mb-0.5">Settled Cash</div>
              <div className="font-mono text-foreground">${settledCash.toFixed(2)}</div>
            </div>
          </div>
        </div>

        {/* Equity Curve */}
        {equityData.length > 1 && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
            <div className="text-xs text-muted-foreground mb-2">Cumulative P&L (from trades)</div>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={equityData}>
                <defs>
                  <linearGradient id="aktGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(142, 76%, 55%)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(142, 76%, 55%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" hide />
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip
                  contentStyle={{ background: 'hsl(220, 55%, 7%)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(v) => new Date(v as string).toLocaleDateString()}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cumulative P&L']}
                />
                <Area type="monotone" dataKey="cumulative" stroke="hsl(142, 76%, 55%)" strokeWidth={2} fill="url(#aktGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Open Positions */}
        {positions.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-2">Open positions ({positions.length})</div>
            <div className="grid grid-cols-2 gap-3">
              {positions.map(pos => {
                const plColor = pos.unrealizedPl >= 0 ? 'text-emerald-400' : 'text-red-400';
                return (
                  <div key={pos.symbol} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                    <div className="text-xs text-muted-foreground mb-1">{pos.symbol}</div>
                    <div className={`text-lg font-semibold ${plColor}`}>
                      {pos.unrealizedPl >= 0 ? '+' : ''}{pos.unrealizedPlPct.toFixed(2)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      <div>${pos.avgEntryPrice.toFixed(2)} &rarr; ${pos.currentPrice.toFixed(2)}</div>
                      <div>SL ${pos.stopLoss?.toFixed(2) ?? '—'} · TP ${pos.takeProfit?.toFixed(2) ?? '—'}</div>
                      <div className={plColor}>
                        {pos.unrealizedPl >= 0 ? '+' : ''}${pos.unrealizedPl.toFixed(2)}
                      </div>
                      <div className="text-muted-foreground/50">{pos.qty} shares · {timeAgo(pos.openedAt)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {positions.length === 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-sm text-muted-foreground/50">No open positions</div>
          </div>
        )}

        {/* Recent Trades */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-muted-foreground">Recent trades</div>
            {summary.total > 0 && (
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>WR: <span className={summary.winRate >= 0.5 ? 'text-emerald-400' : 'text-amber-400'}>{(summary.winRate * 100).toFixed(0)}%</span></span>
                <span className={summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toFixed(2)} total
                </span>
              </div>
            )}
          </div>
          {trades.length === 0 ? (
            <div className="text-sm text-muted-foreground/50">No trades yet</div>
          ) : (
            <div className="space-y-1.5">
              {trades.slice(0, 8).map((t) => (
                <div key={`${t.symbol}-${t.closedAt}`} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground w-12">{t.symbol}</span>
                    {t.signal && <span className="text-xs text-muted-foreground/60">{t.signal}</span>}
                    {t.exitReason && <span className="text-xs text-muted-foreground/40">{t.exitReason}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={(t.pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {(t.pnl ?? 0) >= 0 ? '+' : ''}${(t.pnl ?? 0).toFixed(2)}
                    </span>
                    <span className="text-xs text-muted-foreground w-14 text-right">{timeAgo(t.closedAt ?? '')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Market Hours Footer */}
        <div className="flex items-center justify-center gap-4 py-2 text-xs text-muted-foreground">
          {[
            { label: 'Pre-market', phaseKey: 'pre', hours: '04:00–09:30 ET' },
            { label: 'Regular', phaseKey: 'regular', hours: '09:30–16:00 ET' },
            { label: 'After-hours', phaseKey: 'after', hours: '16:00–20:00 ET' },
          ].map(s => (
            <span key={s.label} className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${phase === s.phaseKey && isOpen ? 'bg-emerald-400' : 'bg-white/10'}`} />
              {s.label}
            </span>
          ))}
        </div>

      </div>
    </div>
  );
}
