'use client';

import {
  usePolynixStatus,
  usePolynixPortfolio,
  usePolynixPositions,
  usePolynixTrades,
} from '@/hooks/usePolynix';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function expiryCountdown(expiresAt: number) {
  const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  if (remaining <= 0) return 'EXPIRED';
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  arb: { label: 'ARB', color: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/5' },
  directional: { label: 'DIR', color: 'text-blue-400 border-blue-400/30 bg-blue-400/5' },
};

const SIDE_COLOR: Record<string, string> = {
  YES: 'text-emerald-400',
  NO: 'text-red-400',
  BOTH: 'text-amber-400',
};

export default function PolynixPage() {
  const { data: status } = usePolynixStatus(15_000);
  const { data: portfolio } = usePolynixPortfolio(10_000);
  const { positions } = usePolynixPositions(10_000);
  const { trades, summary, lastSignal } = usePolynixTrades(15_000);

  const agentRunning = status?.agent?.running ?? false;
  const paperTrading = status?.agent?.paperTrading ?? true;
  const balance = portfolio?.balance ?? 0;
  const totalPnl = portfolio?.totalPnl ?? 0;
  const winRate = portfolio?.winRate ?? 0;
  const tradesTotal = portfolio?.tradesTotal ?? 0;
  const wins = portfolio?.wins ?? 0;
  const losses = portfolio?.losses ?? 0;
  const risk = status?.risk;
  const config = status?.config;

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-4">

        {/* Status bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-mono font-semibold text-orange-400">POLYMARKET</span>
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
          <div className="mt-1 flex items-center justify-center gap-3 text-sm">
            <span className={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} total P&L
            </span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-xs text-muted-foreground">
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">TRADES</div>
              <div className="font-mono text-foreground">{tradesTotal}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">WIN RATE</div>
              <div className={`font-mono ${winRate >= 50 ? 'text-emerald-400' : 'text-amber-400'}`}>{winRate.toFixed(0)}%</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">W / L</div>
              <div className="font-mono text-foreground">{wins}/{losses}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">DAILY P&L</div>
              <div className={`font-mono ${(risk?.dailyPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {(risk?.dailyPnl ?? 0) >= 0 ? '+' : ''}${(risk?.dailyPnl ?? 0).toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        {/* Config summary */}
        {config && (
          <div className="flex items-center justify-center gap-5 text-[10px] font-mono text-muted-foreground/40">
            <span>Arb &lt; {config.arbThreshold}</span>
            <span>Edge &gt; {config.minEdgePct}%</span>
            <span>Fee {(config.feeRate * 100).toFixed(2)}%</span>
            <span>Max ${config.maxBetSize}</span>
            <span>Slots {config.maxPositions}</span>
          </div>
        )}

        {/* Open positions */}
        <div>
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2">
            OPEN BETS {positions.length > 0 && `(${positions.length})`}
          </div>
          {positions.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
              <div className="text-sm text-muted-foreground/40">No open bets</div>
            </div>
          ) : (
            <div className="space-y-2">
              {positions.map(pos => {
                const badge = TYPE_BADGE[pos.type] ?? TYPE_BADGE.directional;
                const sideColor = SIDE_COLOR[pos.side] ?? 'text-foreground';
                return (
                  <div key={pos.id} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                    <div className="flex items-start justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${badge.color}`}>
                          {badge.label}
                        </span>
                        <span className={`font-mono text-sm font-semibold ${sideColor}`}>
                          {pos.side}
                        </span>
                        <span className="text-xs text-muted-foreground/60 font-mono">
                          {pos.market?.asset}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm font-bold text-amber-400">
                          {expiryCountdown(pos.expiresAt)}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground/60 mb-1.5 truncate">{pos.market?.title}</div>
                    <div className="flex items-center justify-between text-xs font-mono text-muted-foreground">
                      <span>
                        Entry ${pos.entryPrice.toFixed(4)} · {pos.size.toFixed(1)} contracts
                      </span>
                      <span className="text-muted-foreground/50">
                        Cost ${pos.costBasis.toFixed(2)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent trades */}
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
            <div className="space-y-1.5">
              {trades.slice(0, 10).map((t) => {
                const badge = TYPE_BADGE[t.type] ?? TYPE_BADGE.directional;
                const won = t.pnl >= 0;
                return (
                  <div key={t.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-mono px-1 rounded border ${badge.color}`}>
                        {badge.label}
                      </span>
                      <span className={`font-mono text-xs ${SIDE_COLOR[t.side] ?? 'text-foreground'}`}>
                        {t.side}
                      </span>
                      <span className="font-mono text-xs text-foreground/60">{t.asset}</span>
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
                );
              })}
            </div>
          )}
        </div>

        {/* Last signal */}
        {lastSignal && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-3">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-1">LAST SIGNAL</div>
            <div className="flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2">
                <span className={`px-1 rounded border ${TYPE_BADGE[lastSignal.type]?.color ?? 'text-foreground'}`}>
                  {lastSignal.type?.toUpperCase()}
                </span>
                <span className={SIDE_COLOR[lastSignal.direction] ?? 'text-foreground'}>
                  {lastSignal.direction}
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground/60">
                <span>edge {lastSignal.edge}%</span>
                <span>{lastSignal.executed ? 'executed' : 'skipped'}</span>
                <span>{lastSignal.timestamp ? timeAgo(lastSignal.timestamp) : ''}</span>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground/40 mt-0.5 truncate">{lastSignal.market}</div>
          </div>
        )}

        {/* Risk state footer */}
        {risk && (
          <div className="flex items-center justify-center gap-5 py-1 text-[10px] font-mono text-muted-foreground/40">
            <span>Losses streak: {risk.consecutiveLosses}</span>
            <span>Daily: {risk.dailyPnl >= 0 ? '+' : ''}${risk.dailyPnl.toFixed(2)}</span>
            <span>Reset: {risk.lastResetDate}</span>
          </div>
        )}

      </div>
    </DashboardLayout>
  );
}
