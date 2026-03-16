'use client';

import {
  useCopynixStatus,
  useCopynixPositions,
  useCopynixWallets,
  useCopynixTrades,
} from '@/hooks/useCopynix';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

function timeAgo(ts: string | number) {
  const diff = Date.now() - (typeof ts === 'string' ? new Date(ts).getTime() : ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function truncateAddress(addr: string) {
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

const CONSENSUS_COLOR: Record<string, string> = {
  strong: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/5',
  medium: 'text-amber-400 border-amber-400/30 bg-amber-400/5',
  single: 'text-muted-foreground/60 border-white/10 bg-white/[0.02]',
};

// copynix.toml defaults
const TP_PCT = 25;
const SL_PCT = 15;

export default function CopynixPage() {
  const { data: status }    = useCopynixStatus(10_000);
  const { positions }       = useCopynixPositions(10_000);
  const { wallets }         = useCopynixWallets(60_000);
  const { trades, summary, equityCurve } = useCopynixTrades(50, 30_000);

  const isLoading      = status === null;
  const agentRunning   = status?.status === 'running';
  const paperTrading   = status?.paperTrading ?? true;
  const portfolioValue = status?.account?.portfolioValue  ?? 0;
  const usdcBalance    = status?.account?.usdcBalance     ?? 0;
  const dailyPnl       = status?.risk?.dailyPnlDollar     ?? 0;
  const tradesToday    = status?.risk?.tradesToday         ?? 0;
  const openPositions  = positions.length;
  const maxPositions   = status?.risk?.maxPositions        ?? 5;
  const trackedWallets = status?.trackedWallets            ?? wallets.length;

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-4">

        {/* Status bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-mono font-semibold text-cyan-400">SOLANA</span>
            {paperTrading && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/5 text-amber-400">
                PAPER
              </span>
            )}
            <span className="text-[10px] font-mono text-muted-foreground/50">
              {trackedWallets} wallet{trackedWallets !== 1 ? 's' : ''} tracked
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${isLoading ? 'bg-zinc-500' : agentRunning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
              <span className="font-mono">
                {isLoading ? 'CONNECTING' : agentRunning ? 'RUNNING' : 'STOPPED'}
              </span>
            </span>
          </div>
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
              <div className="font-mono text-foreground">${usdcBalance.toFixed(2)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">POSITIONS</div>
              <div className="font-mono text-foreground">{openPositions} / {maxPositions}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">TRADES TODAY</div>
              <div className="font-mono text-foreground">{tradesToday}</div>
            </div>
          </div>
        </div>

        {/* Tracked wallets */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2.5">
            TRACKED WALLETS {wallets.length > 0 && `(${wallets.length})`}
          </div>
          {wallets.length === 0 ? (
            <div className="text-sm text-muted-foreground/40">No wallet data available</div>
          ) : (
            <div className="space-y-1.5">
              {wallets.map((w) => (
                <div key={w.address} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-foreground/80">{truncateAddress(w.address)}</span>
                    {w.label && (
                      <span className="text-[10px] font-mono text-cyan-400/70">{w.label}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {w.winRate != null && (
                      <span className={`text-xs font-mono ${w.winRate >= 60 ? 'text-emerald-400' : 'text-muted-foreground/60'}`}>
                        {w.winRate.toFixed(1)}% WR
                      </span>
                    )}
                    {w.lastActive && (
                      <span className="text-[10px] font-mono text-muted-foreground/40 w-14 text-right">
                        {timeAgo(w.lastActive)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
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
                const plColor = pos.unrealizedPl >= 0 ? 'text-emerald-400' : 'text-red-400';
                return (
                  <div key={pos.mint} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">

                    {/* Symbol + consensus + P&L */}
                    <div className="flex items-start justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-foreground">{pos.symbol}</span>
                        <span className={`text-[9px] font-mono px-1 py-0.5 rounded border ${CONSENSUS_COLOR[pos.consensusLevel] ?? CONSENSUS_COLOR.single}`}>
                          {pos.consensusLevel.toUpperCase()}
                        </span>
                      </div>
                      <span className={`text-base font-bold ${plColor}`}>
                        {pos.unrealizedPlPct >= 0 ? '+' : ''}{pos.unrealizedPlPct.toFixed(2)}%
                      </span>
                    </div>

                    {/* Prices */}
                    <div className="text-xs font-mono text-muted-foreground space-y-0.5">
                      <div>
                        <span className="text-muted-foreground/50">Entry </span>
                        ${pos.avgEntryPrice < 1 ? pos.avgEntryPrice.toFixed(6) : pos.avgEntryPrice.toFixed(2)}
                        <span className="text-muted-foreground/30 mx-1">-&gt;</span>
                        <span className={plColor}>
                          ${pos.currentPrice < 1 ? pos.currentPrice.toFixed(6) : pos.currentPrice.toFixed(2)}
                        </span>
                      </div>
                      <div className={plColor}>
                        {pos.unrealizedPl >= 0 ? '+' : ''}${pos.unrealizedPl.toFixed(2)} unrealized
                      </div>
                      <div className="text-muted-foreground/50">
                        {pos.qty.toFixed(2)} tokens · {timeAgo(pos.entryTime)}
                      </div>
                    </div>

                    {/* Simple TP/SL bar */}
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-[9px] font-mono text-muted-foreground/40 mb-0.5">
                        <span>SL -{SL_PCT}%</span>
                        <span>TP +{TP_PCT}%</span>
                      </div>
                      <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                        {(() => {
                          const pct = pos.unrealizedPlPct;
                          const normalized = ((pct + SL_PCT) / (SL_PCT + TP_PCT)) * 100;
                          const clamped = Math.max(0, Math.min(100, normalized));
                          const barColor = pct >= 0 ? 'bg-emerald-400' : 'bg-red-400';
                          return <div className={`h-full rounded-full ${barColor}`} style={{ width: `${clamped}%` }} />;
                        })()}
                      </div>
                    </div>

                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Equity curve */}
        {equityCurve.length > 1 && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2.5">CUMULATIVE P&L</div>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={equityCurve}>
                <defs>
                  <linearGradient id="copynixPnlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={equityCurve[equityCurve.length - 1]?.cumulativePnl >= 0 ? '#34d399' : '#f87171'} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={equityCurve[equityCurve.length - 1]?.cumulativePnl >= 0 ? '#34d399' : '#f87171'} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="timestamp" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                  contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11 }}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, 'P&L']}
                  labelFormatter={(l: string) => new Date(l).toLocaleDateString()}
                />
                <Area
                  type="monotone"
                  dataKey="cumulativePnl"
                  stroke={equityCurve[equityCurve.length - 1]?.cumulativePnl >= 0 ? '#34d399' : '#f87171'}
                  fill="url(#copynixPnlGrad)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Recent trades */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest">RECENT TRADES</div>
            {summary.totalTrades > 0 && (
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>WR <span className={summary.winRate >= 0.5 ? 'text-emerald-400' : 'text-amber-400'}>
                  {(summary.winRate * 100).toFixed(0)}%
                </span></span>
                <span className={summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toFixed(2)}
                </span>
              </div>
            )}
          </div>
          {trades.length === 0 ? (
            <div className="text-sm text-muted-foreground/40">No trades yet — waiting for consensus signals</div>
          ) : (
            <div className="space-y-1.5">
              {trades.slice(0, 10).map((t) => (
                <div key={`${t.id}-${t.timestamp}`} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-xs w-8 ${t.side === 'BUY' ? 'text-emerald-400' : 'text-violet-400'}`}>
                      {t.side}
                    </span>
                    <span className="font-mono text-xs text-foreground/80 w-16 truncate">{t.symbol}</span>
                    {t.consensusLevel && (
                      <span className={`text-[9px] font-mono px-1 py-0.5 rounded border ${CONSENSUS_COLOR[t.consensusLevel] ?? CONSENSUS_COLOR.single}`}>
                        {t.consensusLevel.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {t.side === 'SELL' && t.realizedPnl != null && (
                      <span className={`text-xs font-mono ${t.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)}
                      </span>
                    )}
                    {t.side === 'BUY' && t.dollarAmount != null && (
                      <span className="text-xs font-mono text-muted-foreground/50">
                        ${t.dollarAmount.toFixed(0)}
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

      </div>
    </DashboardLayout>
  );
}
