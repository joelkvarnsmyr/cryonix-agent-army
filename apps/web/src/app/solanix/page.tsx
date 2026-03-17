'use client';

import { useSolanixStatus, useSolanixPositions, useSolanixSignals, type ShadowStats } from '@/hooks/useSolanix';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { PositionTpSlBar } from '@/components/dashboard/position-tp-sl-bar';

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const ACTION_COLOR: Record<string, string> = {
  BUY:  'text-emerald-400',
  SELL: 'text-red-400',
  WAIT: 'text-muted-foreground/50',
};

const SOURCE_LABEL: Record<string, string> = {
  ta:          'TA',
  dexscreener: 'DEX',
};

// solanix.toml defaults
const TP_PCT = 8;
const SL_PCT = 4;

export default function SolanixPage() {
  const { data: status }    = useSolanixStatus(10_000);
  const { positions }       = useSolanixPositions(15_000);
  const { signals }         = useSolanixSignals(30_000);

  const isLoading       = status === null;
  const agentRunning    = status?.status === 'running';
  const portfolioValue  = status?.account?.portfolioValue  ?? 0;
  const buyingPower     = status?.account?.buyingPower     ?? 0;
  const dailyPnl        = status?.risk?.dailyPnlDollar     ?? 0;
  const tradesToday     = status?.risk?.tradesToday        ?? 0;
  const positionsUsed   = positions.length;
  const maxPositions    = 5;
  const shadows: ShadowStats[] = status?.shadows ?? [];

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-4">

        {/* Paper trading banner */}
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-[10px] font-mono font-bold tracking-widest">PAPER TRADING</span>
            <span className="text-xs text-muted-foreground/60">Simulated execution — no real funds at risk</span>
          </div>
          <span className="flex items-center gap-1.5 text-xs font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${isLoading ? 'bg-zinc-500' : agentRunning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
            <span className={isLoading ? 'text-muted-foreground/50' : agentRunning ? 'text-emerald-400' : 'text-red-400'}>
              {isLoading ? 'CONNECTING…' : agentRunning ? 'RUNNING' : 'STOPPED'}
            </span>
          </span>
        </div>

        {/* Portfolio card */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-1">PORTFOLIO VALUE</div>
          <div className="text-3xl font-bold tracking-tight text-emerald-400">
            ${portfolioValue.toFixed(2)}
          </div>
          <div className="mt-1 flex items-center justify-center gap-3 text-sm">
            <span className={dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)} today
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-xs text-muted-foreground">
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">USDC BALANCE</div>
              <div className="font-mono text-foreground">${buyingPower.toFixed(2)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">POSITIONS</div>
              <div className="font-mono text-foreground">{positionsUsed} / {maxPositions}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">TRADES TODAY</div>
              <div className="font-mono text-foreground">{tradesToday}</div>
            </div>
          </div>
        </div>

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
                const plPct = pos.avgEntryPrice > 0
                  ? ((pos.currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100
                  : 0;
                const plColor = pos.unrealizedPl >= 0 ? 'text-emerald-400' : 'text-red-400';
                return (
                  <div key={pos.symbol} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">

                    {/* Symbol + P&L */}
                    <div className="flex items-start justify-between mb-1">
                      <div>
                        <span className="font-mono text-sm font-semibold text-foreground">{pos.symbol}</span>
                        {pos.trailingStopActive && (
                          <span className="ml-2 text-[9px] font-mono text-amber-400/70 border border-amber-400/20 px-1 py-0.5 rounded">
                            TRAILING
                          </span>
                        )}
                      </div>
                      <span className={`text-base font-bold ${plColor}`}>
                        {plPct >= 0 ? '+' : ''}{plPct.toFixed(2)}%
                      </span>
                    </div>

                    {/* Prices */}
                    <div className="text-xs font-mono text-muted-foreground space-y-0.5">
                      <div>
                        <span className="text-muted-foreground/50">Entry </span>
                        ${pos.avgEntryPrice < 1 ? pos.avgEntryPrice.toFixed(4) : pos.avgEntryPrice.toFixed(2)}
                        <span className="text-muted-foreground/30 mx-1">→</span>
                        <span className={plColor}>
                          ${pos.currentPrice < 1 ? pos.currentPrice.toFixed(4) : pos.currentPrice.toFixed(2)}
                        </span>
                      </div>
                      <div className={plColor}>
                        {pos.unrealizedPl >= 0 ? '+' : ''}${pos.unrealizedPl.toFixed(2)} unrealized
                      </div>
                      <div className="text-muted-foreground/50">
                        {pos.qty.toFixed(2)} tokens · {timeAgo(pos.entryTime)}
                      </div>
                    </div>

                    {/* TP/SL progress bar — calculated from config defaults */}
                    <PositionTpSlBar
                      entry={pos.avgEntryPrice}
                      current={pos.currentPrice}
                      slPct={SL_PCT}
                      tpPct={TP_PCT}
                    />

                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* A/B Test — Shadow strategies comparison */}
        {shadows.length > 0 && (
          <div>
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2">
              A/B TEST — EXIT STRATEGY COMPARISON
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Primary strategy card */}
              <div className="rounded-xl border border-emerald-400/20 bg-card/60 backdrop-blur-sm p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-[10px] font-mono text-emerald-400/80 tracking-widest">PRIMARY</span>
                </div>
                <div className="text-lg font-bold text-foreground">${portfolioValue.toFixed(2)}</div>
                <div className="text-xs font-mono text-muted-foreground/50 mt-1 space-y-0.5">
                  <div>TP 8% / SL 4% / Trail 5%</div>
                  <div>{positionsUsed} positions · {tradesToday} trades today</div>
                </div>
              </div>

              {/* Shadow strategy cards */}
              {shadows.map((s) => {
                const pnlColor = s.portfolioValue >= 250 ? 'text-emerald-400' : 'text-red-400';
                const isLeading = s.portfolioValue > portfolioValue && s.portfolioValue > Math.max(...shadows.filter(x => x.name !== s.name).map(x => x.portfolioValue), 0);
                return (
                  <div key={s.name} className={`rounded-xl border ${isLeading ? 'border-amber-400/30' : 'border-white/[0.06]'} bg-card/60 backdrop-blur-sm p-4`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-2 h-2 rounded-full ${s.name === 'wide-trail' ? 'bg-blue-400' : 'bg-purple-400'}`} />
                      <span className="text-[10px] font-mono text-muted-foreground/60 tracking-widest">{s.name.toUpperCase()}</span>
                      {isLeading && <span className="text-[9px] font-mono text-amber-400/70 border border-amber-400/20 px-1 rounded">LEADING</span>}
                    </div>
                    <div className={`text-lg font-bold ${pnlColor}`}>${s.portfolioValue.toFixed(2)}</div>
                    <div className="text-xs font-mono text-muted-foreground/50 mt-1 space-y-0.5">
                      <div>
                        {s.name === 'wide-trail' ? 'TP 12% / SL 2.5% / Trail 8%' : 'TP 4% / SL 2% / Trail 3%'}
                      </div>
                      <div>{s.positions} pos · {s.trades} exits · WR {s.winRate.toFixed(0)}%</div>
                      {s.realizedPnl !== 0 && (
                        <div className={s.realizedPnl >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}>
                          Realized: {s.realizedPnl >= 0 ? '+' : ''}${s.realizedPnl.toFixed(2)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent signals */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest">RECENT SIGNALS</div>
            {signals.length > 0 && (
              <span className="text-[10px] font-mono text-muted-foreground/40">{signals.length} total</span>
            )}
          </div>
          {signals.length === 0 ? (
            <div className="text-sm text-muted-foreground/40">No signals yet</div>
          ) : (
            <div className="space-y-1.5">
              {signals.slice(0, 10).map((sig, i) => (
                <div key={`${sig.symbol}-${sig.timestamp}-${i}`} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-foreground/80 w-12">{sig.symbol}</span>
                    <span className={`text-xs font-mono font-semibold ${ACTION_COLOR[sig.action] ?? 'text-muted-foreground'}`}>
                      {sig.action}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/40">
                      {SOURCE_LABEL[sig.source] ?? sig.source}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-muted-foreground/60">
                      {(sig.confidence * 100).toFixed(0)}%
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/40 w-14 text-right">
                      {timeAgo(sig.timestamp)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* How it works */}
        <details className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
          <summary className="px-4 py-3 cursor-pointer select-none flex items-center justify-between">
            <span className="text-[10px] font-mono text-muted-foreground/60 tracking-widest">HOW SOLANIX TRADES</span>
            <span className="text-[10px] text-muted-foreground/30">click to expand</span>
          </summary>
          <div className="px-4 pb-4 space-y-4 text-xs text-muted-foreground leading-relaxed">

            {/* Pipeline */}
            <div>
              <div className="text-[10px] font-mono text-amber-400/70 tracking-widest mb-1.5">SIGNAL PIPELINE</div>
              <div className="font-mono text-[11px] space-y-1 text-muted-foreground/70">
                <div className="flex gap-2"><span className="text-muted-foreground/40 w-4">1.</span><span>DexScreener scans 25 tokens every 15 min (h1/h6/h24 momentum, volume, buy pressure)</span></div>
                <div className="flex gap-2"><span className="text-muted-foreground/40 w-4">2.</span><span>Macro filter adjusts confidence (Fear &amp; Greed, BTC dominance, X sentiment)</span></div>
                <div className="flex gap-2"><span className="text-muted-foreground/40 w-4">3.</span><span>Stablecoin depeg check + token unlock penalty</span></div>
                <div className="flex gap-2"><span className="text-muted-foreground/40 w-4">4.</span><span>Bayesian self-learning adjusts based on historical trade P&amp;L</span></div>
                <div className="flex gap-2"><span className="text-muted-foreground/40 w-4">5.</span><span>Final confidence &gt; 25% threshold &rarr; BUY via Jupiter quote</span></div>
              </div>
            </div>

            {/* Bayesian learning */}
            <div>
              <div className="text-[10px] font-mono text-amber-400/70 tracking-widest mb-1.5">BAYESIAN SELF-LEARNING</div>
              <p className="text-muted-foreground/70">
                Uses Beta-Binomial conjugate priors to learn from closed trades.
                Each signal&apos;s confidence is adjusted by four learned posteriors:
              </p>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-white/[0.02] p-2">
                  <div className="text-[9px] font-mono text-muted-foreground/40 mb-0.5">PER SYMBOL</div>
                  <div className="text-muted-foreground/60">Avg P&amp;L per token &mdash; boost winners, penalize losers</div>
                </div>
                <div className="rounded-lg bg-white/[0.02] p-2">
                  <div className="text-[9px] font-mono text-muted-foreground/40 mb-0.5">CONFIDENCE BAND</div>
                  <div className="text-muted-foreground/60">Calibrates: are 40% signals really winning 40%?</div>
                </div>
                <div className="rounded-lg bg-white/[0.02] p-2">
                  <div className="text-[9px] font-mono text-muted-foreground/40 mb-0.5">HOUR OF DAY</div>
                  <div className="text-muted-foreground/60">Learns best trading hours (UTC)</div>
                </div>
                <div className="rounded-lg bg-white/[0.02] p-2">
                  <div className="text-[9px] font-mono text-muted-foreground/40 mb-0.5">SIGNAL SOURCE</div>
                  <div className="text-muted-foreground/60">TA vs DexScreener breakout win rate</div>
                </div>
              </div>
              <p className="mt-1.5 text-muted-foreground/50 text-[10px]">
                Prior: Beta(2,2) &mdash; weak 50% belief. Credibility grows with sample size: n/(n+10). Max &plusmn;20% adjustment cap.
                Rotations excluded from learning (they reflect opportunity, not signal quality).
              </p>
            </div>

            {/* Risk management */}
            <div>
              <div className="text-[10px] font-mono text-amber-400/70 tracking-widest mb-1.5">RISK MANAGEMENT</div>
              <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                <div className="rounded-lg bg-white/[0.02] p-2 text-center">
                  <div className="text-emerald-400/70">TP +8%</div>
                  <div className="text-[9px] text-muted-foreground/40">take profit</div>
                </div>
                <div className="rounded-lg bg-white/[0.02] p-2 text-center">
                  <div className="text-red-400/70">SL -4%</div>
                  <div className="text-[9px] text-muted-foreground/40">stop loss</div>
                </div>
                <div className="rounded-lg bg-white/[0.02] p-2 text-center">
                  <div className="text-amber-400/70">Trail 5%</div>
                  <div className="text-[9px] text-muted-foreground/40">after +3% gain</div>
                </div>
              </div>
              <div className="mt-2 space-y-0.5 text-muted-foreground/50 text-[10px]">
                <div>Max 5 positions &middot; $50/trade &middot; 20 trades/day &middot; 5% daily loss limit</div>
                <div>Smart rotation: swaps weakest position if new signal scores 15+ pts higher</div>
                <div>Stagnation exit: closes flat positions after 3 days (&lt;0.5% move)</div>
              </div>
            </div>

            {/* Data flow */}
            <div>
              <div className="text-[10px] font-mono text-amber-400/70 tracking-widest mb-1.5">ARCHITECTURE</div>
              <div className="font-mono text-[10px] text-muted-foreground/50 leading-5">
                <span className="text-muted-foreground/70">DexScreener API</span> &rarr; Signal scoring &rarr; Macro filter &rarr; Bayes &rarr; <span className="text-muted-foreground/70">Jupiter quote</span> &rarr; Paper fill<br/>
                <span className="text-muted-foreground/70">Postgres</span> &larr; Position persist &middot; Trade journal &middot; Bayesian training data<br/>
                <span className="text-muted-foreground/70">Redis</span> &larr; Live state (dashboard) &middot; Macro data (from Cryonix engine)
              </div>
            </div>

          </div>
        </details>

      </div>
    </DashboardLayout>
  );
}
