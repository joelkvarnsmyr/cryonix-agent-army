'use client';

import { useState } from 'react';
import {
  usePolynixStatus,
  usePolynixPositions,
  usePolynixTrades,
} from '@/hooks/usePolynix';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';

// -- Helpers ------------------------------------------------------------------

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function expiryLabel(expiresAt: number) {
  const remaining = Math.max(0, expiresAt - Date.now());
  if (remaining <= 0) return 'EXPIRED';
  const secs = Math.floor(remaining / 1000);
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const hrs = Math.floor(secs / 3600);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const TYPE_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  arb: { label: 'ARB', color: 'text-emerald-400', bg: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/5' },
  directional: { label: 'DIR', color: 'text-blue-400', bg: 'text-blue-400 border-blue-400/30 bg-blue-400/5' },
};

const SIDE_COLOR: Record<string, string> = {
  YES: 'text-emerald-400',
  NO: 'text-red-400',
  BOTH: 'text-amber-400',
};

// -- Page ---------------------------------------------------------------------

export default function PolynixPage() {
  const { data: status } = usePolynixStatus(10_000);
  const { positions } = usePolynixPositions(10_000);
  const { trades, summary } = usePolynixTrades(15_000);

  const [expandedBet, setExpandedBet] = useState<string | null>(null);
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);

  const agentRunning = status?.agent?.running ?? false;
  const paperTrading = status?.agent?.paperTrading ?? true;
  const account = status?.account;
  const risk = status?.risk;
  const lastSignal = status?.lastSignal;

  const balance = account?.balance ?? 0;
  const totalPnl = account?.totalPnl ?? 0;
  const tradesTotal = account?.tradesTotal ?? 0;
  const wins = account?.wins ?? 0;
  const losses = account?.losses ?? 0;
  const winRate = account?.winRate ?? 0;
  const startingBalance = 500;
  const deployed = startingBalance - balance + totalPnl;

  // Unrealized P&L from live prices
  const totalUnrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const arbPositions = positions.filter(p => p.type === 'arb');
  const dirPositions = positions.filter(p => p.type === 'directional');
  const arbUrPnl = arbPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const dirUrPnl = dirPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-4">

        {/* Status bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-mono font-semibold text-orange-400">POLYNIX</span>
            {paperTrading && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/5 text-amber-400">
                PAPER
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${agentRunning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
              <span className="font-mono">{agentRunning ? 'running' : 'stopped'}</span>
            </span>
            {risk?.circuitBreakerActive && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-red-400/30 bg-red-400/5 text-red-400">
                BREAKER
              </span>
            )}
          </div>
        </div>

        {/* Portfolio card */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-1">VIRTUAL BALANCE</div>
          <div className="text-3xl font-bold tracking-tight text-orange-400">
            ${balance.toFixed(2)}
          </div>
          <div className="mt-1 flex items-center justify-center gap-4 text-sm">
            <span className={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} realized
            </span>
            {totalUnrealizedPnl !== 0 && (
              <span className={totalUnrealizedPnl >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}>
                {totalUnrealizedPnl >= 0 ? '+' : ''}${totalUnrealizedPnl.toFixed(2)} unrealized
              </span>
            )}
            <span className="text-muted-foreground/60">
              ${deployed.toFixed(2)} deployed
            </span>
          </div>
          {(arbPositions.length > 0 || dirPositions.length > 0) && (
            <div className="mt-2 flex items-center justify-center gap-4 text-[10px] font-mono text-muted-foreground/50">
              {arbPositions.length > 0 && (
                <span>ARB: {arbPositions.length} bets, <span className="text-emerald-400/60">+${arbUrPnl.toFixed(2)}</span> locked</span>
              )}
              {dirPositions.length > 0 && (
                <span>DIR: {dirPositions.length} bets, <span className={dirUrPnl >= 0 ? 'text-emerald-400/60' : 'text-red-400/60'}>{dirUrPnl >= 0 ? '+' : ''}${dirUrPnl.toFixed(2)}</span></span>
              )}
            </div>
          )}
          <div className="mt-3 grid grid-cols-5 gap-2 text-xs text-muted-foreground">
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">OPEN</div>
              <div className="font-mono text-foreground">{positions.length}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">SETTLED</div>
              <div className="font-mono text-foreground">{tradesTotal}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">WIN RATE</div>
              <div className={`font-mono ${winRate >= 50 ? 'text-emerald-400' : winRate > 0 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                {tradesTotal > 0 ? `${winRate.toFixed(0)}%` : '-'}
              </div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">W / L</div>
              <div className="font-mono text-foreground">{wins}/{losses}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">DAILY</div>
              <div className={`font-mono ${(risk?.dailyPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {(risk?.dailyPnl ?? 0) >= 0 ? '+' : ''}${(risk?.dailyPnl ?? 0).toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        {/* Last signal */}
        {lastSignal && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground/50">LAST</span>
                <span className={`px-1 rounded border text-[10px] ${TYPE_BADGE[lastSignal.type]?.bg ?? ''}`}>
                  {lastSignal.type?.toUpperCase()}
                </span>
                <span className={SIDE_COLOR[lastSignal.direction] ?? 'text-foreground'}>
                  {lastSignal.direction}
                </span>
                <span className="text-muted-foreground/50">edge {lastSignal.edge}%</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground/50">
                <span className={lastSignal.executed ? 'text-emerald-400' : 'text-muted-foreground/40'}>
                  {lastSignal.executed ? 'filled' : 'skipped'}
                </span>
                <span>{lastSignal.timestamp ? timeAgo(lastSignal.timestamp) : ''}</span>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground/40 mt-0.5 truncate">{lastSignal.market}</div>
          </div>
        )}

        {/* Open bets */}
        <div>
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2">
            OPEN BETS {positions.length > 0 && `(${positions.length})`}
          </div>
          {positions.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
              <div className="text-sm text-muted-foreground/40">No open bets</div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {positions.map(pos => {
                const badge = TYPE_BADGE[pos.type] ?? TYPE_BADGE.directional;
                const sideColor = SIDE_COLOR[pos.side] ?? 'text-foreground';
                const isExpanded = expandedBet === pos.id;

                return (
                  <div
                    key={pos.id}
                    className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm cursor-pointer transition-colors hover:border-white/[0.12]"
                    onClick={() => setExpandedBet(isExpanded ? null : pos.id)}
                  >
                    {/* Compact row */}
                    <div className="flex items-center justify-between px-4 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${badge.bg}`}>
                          {badge.label}
                        </span>
                        <span className={`font-mono text-sm font-semibold shrink-0 ${sideColor}`}>
                          {pos.side}
                        </span>
                        {pos.currentPrice != null && (
                          <span className="font-mono text-xs text-foreground/70 shrink-0">
                            {(pos.currentPrice * 100).toFixed(0)}¢
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground/50 truncate">
                          {pos.market?.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {pos.unrealizedPnl != null && (
                          <span className={`font-mono text-xs font-semibold ${pos.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}
                          </span>
                        )}
                        <span className="font-mono text-xs text-muted-foreground/40">
                          ${pos.costBasis.toFixed(2)}
                        </span>
                        <span className="font-mono text-xs text-amber-400 w-10 text-right">
                          {expiryLabel(pos.expiresAt)}
                        </span>
                      </div>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="border-t border-white/[0.04] px-4 py-3 space-y-2">
                        <div className="text-xs text-muted-foreground/70 break-words">{pos.market?.title}</div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs font-mono">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Type</span>
                            <span className={badge.color}>{pos.type}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Side</span>
                            <span className={sideColor}>{pos.side}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Asset</span>
                            <span className="text-foreground">{pos.market?.asset ?? '-'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Entry price</span>
                            <span className="text-foreground">${pos.entryPrice.toFixed(4)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Contracts</span>
                            <span className="text-foreground">{pos.size.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Cost basis</span>
                            <span className="text-foreground">${pos.costBasis.toFixed(2)}</span>
                          </div>
                          {pos.currentPrice != null && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground/50">Current odds</span>
                              <span className="text-foreground">{(pos.currentPrice * 100).toFixed(1)}%</span>
                            </div>
                          )}
                          {pos.unrealizedPnl != null && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground/50">Unrealized P&L</span>
                              <span className={pos.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                {pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}
                              </span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Max payout</span>
                            <span className="text-emerald-400">${pos.size.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Max profit</span>
                            <span className="text-emerald-400">
                              +${(pos.size - pos.costBasis).toFixed(2)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Entered</span>
                            <span className="text-foreground">{formatDate(pos.enteredAt)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Expires</span>
                            <span className="text-amber-400">{formatDate(pos.expiresAt)}</span>
                          </div>
                        </div>
                        {pos.type === 'arb' && (
                          <div className="text-[10px] text-emerald-400/60 pt-1">
                            Arb: guaranteed payout regardless of outcome (YES+NO both purchased)
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Settled bets */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest">SETTLED BETS</div>
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
            <div className="text-sm text-muted-foreground/40">No settled bets yet</div>
          ) : (
            <div className="space-y-1">
              {trades.slice(0, 15).map((t) => {
                const badge = TYPE_BADGE[t.type] ?? TYPE_BADGE.directional;
                const won = t.pnl >= 0;
                const isExpanded = expandedTrade === t.id;

                return (
                  <div key={t.id}>
                    <div
                      className="flex items-center justify-between py-1 cursor-pointer hover:bg-white/[0.02] rounded px-1 -mx-1"
                      onClick={() => setExpandedTrade(isExpanded ? null : t.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-mono px-1 rounded border ${badge.bg}`}>
                          {badge.label}
                        </span>
                        <span className={`font-mono text-xs ${SIDE_COLOR[t.side] ?? 'text-foreground'}`}>
                          {t.side}
                        </span>
                        <span className="font-mono text-xs text-foreground/50 truncate max-w-[180px]">
                          {t.asset || t.marketTitle?.slice(0, 25)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-mono font-semibold ${won ? 'text-emerald-400' : 'text-red-400'}`}>
                          {won ? '+' : ''}${t.pnl.toFixed(2)}
                        </span>
                        <span className="text-[10px] font-mono text-muted-foreground/40 w-12 text-right">
                          {timeAgo(t.settledAt)}
                        </span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="bg-white/[0.02] rounded-lg px-3 py-2 mb-1 text-xs font-mono">
                        <div className="text-muted-foreground/60 mb-1.5 break-words">{t.marketTitle}</div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Entry</span>
                            <span>${t.entryPrice.toFixed(4)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Cost</span>
                            <span>${t.costBasis.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Size</span>
                            <span>{t.size.toFixed(2)} contracts</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Result</span>
                            <span className={won ? 'text-emerald-400' : 'text-red-400'}>
                              {t.status.toUpperCase()}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">P&L</span>
                            <span className={won ? 'text-emerald-400' : 'text-red-400'}>
                              {won ? '+' : ''}${t.pnl.toFixed(2)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Settled</span>
                            <span>{formatDate(t.settledAt)}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Risk footer */}
        {risk && (
          <div className="flex items-center justify-center gap-5 py-1 text-[10px] font-mono text-muted-foreground/40">
            <span>Loss streak: {risk.consecutiveLosses}</span>
            <span>Daily P&L: {risk.dailyPnl >= 0 ? '+' : ''}${risk.dailyPnl.toFixed(2)}</span>
            <span>Reset: {risk.lastResetDate}</span>
          </div>
        )}

      </div>
    </DashboardLayout>
  );
}
