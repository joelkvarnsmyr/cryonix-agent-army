'use client';

import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  useAktienixStatus,
  useAktienixPortfolio,
  useAktienixPositions,
  useAktienixTrades,
} from '@/hooks/useAktienix';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { PositionTpSlBar } from '@/components/dashboard/position-tp-sl-bar';

function timeAgo(iso: string) {
  // Handle Postgres timestamps like "2026-03-19 13:45:49" (space instead of T)
  const parsed = new Date(iso?.includes('T') ? iso : iso?.replace(' ', 'T') + 'Z');
  const diff = Date.now() - parsed.getTime();
  if (isNaN(diff) || diff < 0) return 'now';
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

  const [etTime, setEtTime] = useState('');
  useEffect(() => {
    const tick = () => {
      setEtTime(
        new Date().toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
        }) + ' ET',
      );
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  // Cumulative equity curve from closed trades
  const equityData = (() => {
    if (trades.length === 0) return [];
    let cum = 0;
    return [...trades].filter(t => t.side === 'SELL').reverse().map(t => {
      cum += t.realizedPnl ?? 0;
      return { time: t.timestamp, cumulative: cum };
    });
  })();

  const phase        = status?.market?.phase    ?? 'closed';
  const isOpen       = status?.market?.isOpen   ?? false;
  const brokerLabel  = status?.agent?.broker    ?? '—';
  const agentRunning = status?.agent?.running   ?? false;
  const paperTrading = brokerLabel === 'paper' || brokerLabel === 'alpaca-paper';

  const portfolioValue = portfolio?.portfolioValue ?? 0;
  const buyingPower    = portfolio?.buyingPower    ?? 0;
  const settledCash    = portfolio?.settledCash    ?? 0;
  const dailyPnl       = portfolio?.dailyPnl      ?? 0;
  const dailyPnlPct    = portfolio?.dailyPnlPct   ?? 0;

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-4">

        {/* Status bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className={`text-xs font-mono font-semibold ${PHASE_COLOR[phase]}`}>
              {PHASE_LABEL[phase]}
            </span>
            {paperTrading && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/5 text-amber-400">
                PAPER
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${agentRunning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
              <span className="font-mono">{brokerLabel}</span>
            </span>
            <span className="font-mono text-muted-foreground/60">{etTime}</span>
          </div>
        </div>

        {/* Portfolio value card */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-1">PORTFOLIO VALUE</div>
          <div className="text-3xl font-bold tracking-tight text-emerald-400">
            ${portfolioValue.toFixed(2)}
          </div>
          <div className="mt-1 flex items-center justify-center gap-3 text-sm">
            <span className={dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {dailyPnl >= 0 ? '+' : ''}{dailyPnl.toFixed(2)} today
              <span className="text-xs ml-1 opacity-70">({dailyPnlPct >= 0 ? '+' : ''}{dailyPnlPct.toFixed(2)}%)</span>
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">BUYING POWER</div>
              <div className="font-mono text-foreground">${buyingPower.toFixed(2)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">SETTLED CASH</div>
              <div className="font-mono text-foreground">${settledCash.toFixed(2)}</div>
            </div>
          </div>
        </div>

        {/* Equity curve */}
        {equityData.length > 1 && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2">CUMULATIVE P&L</div>
            <ResponsiveContainer width="100%" height={130}>
              <AreaChart data={equityData}>
                <defs>
                  <linearGradient id="aktGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(142,76%,55%)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(142,76%,55%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" hide />
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip
                  contentStyle={{ background: 'hsl(220,55%,7%)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11 }}
                  labelFormatter={(v) => new Date(v as string).toLocaleDateString()}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cumulative P&L']}
                />
                <Area type="monotone" dataKey="cumulative" stroke="hsl(142,76%,55%)" strokeWidth={1.5} fill="url(#aktGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Open positions */}
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
                const plColor = (pos.unrealizedPl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400';
                return (
                  <div key={pos.symbol} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">

                    {/* Symbol + P&L */}
                    <div className="flex items-start justify-between mb-1">
                      <span className="font-mono text-sm font-semibold text-foreground">{pos.symbol}</span>
                      <span className={`text-base font-bold ${plColor}`}>
                        {(pos.unrealizedPlPct ?? 0) >= 0 ? '+' : ''}{(pos.unrealizedPlPct ?? 0).toFixed(2)}%
                      </span>
                    </div>

                    {/* Prices */}
                    <div className="text-xs font-mono text-muted-foreground space-y-0.5">
                      <div>
                        <span className="text-muted-foreground/50">Entry </span>${pos.avgEntryPrice.toFixed(2)}
                        <span className="text-muted-foreground/30 mx-1">→</span>
                        <span className={plColor}>${pos.currentPrice.toFixed(2)}</span>
                      </div>
                      <div className={plColor}>
                        {(pos.unrealizedPl ?? 0) >= 0 ? '+' : ''}${(pos.unrealizedPl ?? 0).toFixed(2)} unrealized
                      </div>
                      <div className="text-muted-foreground/50">
                        {pos.qty} shares · {timeAgo(pos.openedAt)}
                      </div>
                    </div>

                    {/* TP/SL progress bar */}
                    <PositionTpSlBar
                      entry={pos.avgEntryPrice}
                      current={pos.currentPrice}
                      slPrice={pos.stopLoss}
                      tpPrice={pos.takeProfit}
                      slPct={4}
                      tpPct={8}
                    />

                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent trades */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest">RECENT TRADES</div>
            {summary.total > 0 && (
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>
                  WR <span className={summary.winRate >= 0.5 ? 'text-emerald-400' : 'text-amber-400'}>
                    {(summary.winRate * 100).toFixed(0)}%
                  </span>
                </span>
                <span className={summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toFixed(2)}
                </span>
              </div>
            )}
          </div>
          {trades.length === 0 ? (
            <div className="text-sm text-muted-foreground/40">No trades yet</div>
          ) : (
            <div className="space-y-1.5">
              {trades.slice(0, 8).map((t) => (
                <div key={`${t.symbol}-${t.timestamp}`} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-xs w-8 ${t.side === 'BUY' ? 'text-emerald-400' : 'text-violet-400'}`}>
                      {t.side}
                    </span>
                    <span className="font-mono text-xs text-foreground/80 w-12">{t.symbol}</span>
                    {t.exitReason && (
                      <span className="text-[10px] text-muted-foreground/40 font-mono">{t.exitReason}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {t.side === 'SELL' && t.realizedPnl != null && (
                      <span className={`text-xs font-mono ${t.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)}
                      </span>
                    )}
                    <span className="text-[10px] font-mono text-muted-foreground/40 w-14 text-right">
                      {timeAgo(t.timestamp)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* How It Works */}
        <details className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
          <summary className="p-4 cursor-pointer select-none flex items-center justify-between">
            <span className="text-[10px] font-mono text-muted-foreground/60 tracking-widest">HOW AKTIENIX WORKS</span>
            <span className="text-[10px] font-mono text-muted-foreground/30">[click to expand]</span>
          </summary>
          <div className="px-4 pb-4 space-y-3 text-xs text-muted-foreground leading-relaxed">

            {/* Signal Pipeline */}
            <div>
              <div className="text-[10px] font-mono text-cyan-400/70 tracking-wider mb-1">SIGNAL PIPELINE</div>
              <p>Every 15 min, the agent scans {positions.length > 0 ? '21' : '21'} stocks using 5 technical factors weighted for equities:</p>
              <div className="grid grid-cols-5 gap-1 mt-1.5 text-center">
                {[
                  { label: 'RSI', w: '25%', color: 'text-violet-400' },
                  { label: 'MACD', w: '25%', color: 'text-blue-400' },
                  { label: 'Bollinger', w: '20%', color: 'text-amber-400' },
                  { label: 'Trend', w: '20%', color: 'text-emerald-400' },
                  { label: 'Volume', w: '10%', color: 'text-orange-400' },
                ].map(f => (
                  <div key={f.label} className="rounded bg-white/[0.03] py-1">
                    <div className={`text-[10px] font-mono ${f.color}`}>{f.label}</div>
                    <div className="text-[9px] text-muted-foreground/40">{f.w}</div>
                  </div>
                ))}
              </div>
              <p className="mt-1.5">Signals must score above <span className="font-mono text-foreground/80">45%</span> confidence to pass. Counter-trend signals are penalized 50%.</p>
            </div>

            {/* Intelligence Layer */}
            <div>
              <div className="text-[10px] font-mono text-cyan-400/70 tracking-wider mb-1">INTELLIGENCE LAYER</div>
              <div className="space-y-1">
                <div className="flex items-start gap-2">
                  <span className="text-[10px] font-mono text-amber-400 w-20 shrink-0">Grok AI</span>
                  <span>Scans X/Twitter every 15min for breaking macro events (oil shocks, conflicts, Fed decisions). Bullish alignment: +15% confidence. Bearish: block sector.</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-[10px] font-mono text-violet-400 w-20 shrink-0">Polymarket</span>
                  <span>Prediction market sentiment overlays. Crypto-correlated stocks (MSTR, COIN) get +/-8% based on crypto sentiment. Oil tickers react to geopolitical events.</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-[10px] font-mono text-emerald-400 w-20 shrink-0">Bayesian</span>
                  <span>Self-learning system. Every closed trade updates win probability per pattern, symbol, and time-of-day. After 10 trades, confidence auto-adjusts +/-15%.</span>
                </div>
              </div>
            </div>

            {/* Risk Management */}
            <div>
              <div className="text-[10px] font-mono text-cyan-400/70 tracking-wider mb-1">RISK MANAGEMENT</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {[
                  ['Max position', '$5,000 (5%)'],
                  ['Max positions', '8 simultaneous'],
                  ['Daily loss limit', '-2% portfolio'],
                  ['Weekly loss limit', '-5% portfolio'],
                  ['Max trades/day', '8'],
                  ['PDT guard', '≤5 day-trades/5d'],
                  ['Account type', 'Cash (T+1)'],
                  ['Stop-loss', '-3% fixed'],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-muted-foreground/50">{label}</span>
                    <span className="font-mono text-foreground/70">{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Exit Strategy */}
            <div>
              <div className="text-[10px] font-mono text-cyan-400/70 tracking-wider mb-1">EXIT STRATEGY (5-STAGE)</div>
              <div className="space-y-0.5">
                {[
                  { stage: 'SL', desc: 'Stop-loss at -3%', color: 'text-red-400' },
                  { stage: 'TP', desc: 'Take-profit at +8% (R:R = 2.67)', color: 'text-emerald-400' },
                  { stage: 'TRAIL', desc: 'Trailing stop -2% from HWM (activates at +3%)', color: 'text-blue-400' },
                  { stage: 'STALE', desc: 'Stagnation exit after 10 trading days if < 0.5% movement', color: 'text-amber-400' },
                  { stage: 'EOD', desc: 'Optional end-of-day close (currently disabled for swing trading)', color: 'text-muted-foreground/60' },
                ].map(s => (
                  <div key={s.stage} className="flex items-start gap-2">
                    <span className={`text-[10px] font-mono w-12 shrink-0 ${s.color}`}>{s.stage}</span>
                    <span>{s.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Data Flow */}
            <div>
              <div className="text-[10px] font-mono text-cyan-400/70 tracking-wider mb-1">DATA FLOW</div>
              <div className="font-mono text-[10px] text-muted-foreground/60 leading-5">
                <span className="text-foreground/50">Alpaca 1D bars</span> → TA signals → Grok + Polymarket overlay → Bayesian adjustment → Risk checks → <span className="text-emerald-400">BUY</span> on Alpaca<br/>
                <span className="text-foreground/50">Exit monitor (60s)</span> → SL/TP/trailing/stagnation check → <span className="text-violet-400">SELL</span> → Bayesian posterior update → Postgres log
              </div>
            </div>

            {/* Watchlist */}
            <div>
              <div className="text-[10px] font-mono text-cyan-400/70 tracking-wider mb-1">WATCHLIST (21 SYMBOLS)</div>
              <div className="flex flex-wrap gap-1">
                {['AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','SPY','QQQ','JPM','JNJ','MSTR','COIN','XOM','CVX','XLE','USO','UAL','DAL','FDX','UPS'].map(s => (
                  <span key={s} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.03] text-foreground/60">{s}</span>
                ))}
              </div>
            </div>

          </div>
        </details>

        {/* Market sessions footer */}
        <div className="flex items-center justify-center gap-5 py-1 text-[10px] font-mono text-muted-foreground/40">
          {[
            { label: 'Pre-market', key: 'pre',     hours: '04:00–09:30' },
            { label: 'Regular',    key: 'regular',  hours: '09:30–16:00' },
            { label: 'After-hours',key: 'after',    hours: '16:00–20:00' },
          ].map(s => (
            <span key={s.label} className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${phase === s.key && isOpen ? 'bg-emerald-400' : 'bg-white/10'}`} />
              {s.label} {s.hours} ET
            </span>
          ))}
        </div>

      </div>
    </DashboardLayout>
  );
}
