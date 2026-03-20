'use client';

import { useApexStatus } from '@/hooks/useApex';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const MODE_COLOR: Record<string, string> = {
  venus_rx: 'text-violet-400 bg-violet-400/10 border-violet-400/20',
  dip_sniper: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  confluence: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
};

const DIR_COLOR: Record<string, string> = {
  bullish: 'text-emerald-400',
  bearish: 'text-red-400',
};

export default function ApexPage() {
  const { data, error } = useApexStatus(15_000);

  const isLoading = data === null;
  const agentRunning = data?.status === 'running';
  const capital = data?.capital;
  const perf = data?.performance ?? { totalPnl: 0, winRate: 0, trades: 0, maxDrawdown: 0 };
  const positions = data?.positions ?? [];
  const board = data?.confluenceBoard ?? [];
  const cb = data?.circuitBreaker;

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-4">

        {/* Paper trading banner */}
        <div className="rounded-lg border border-rose-400/30 bg-rose-400/5 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-rose-400 text-[10px] font-mono font-bold tracking-widest">APEX — META-INTELLIGENCE</span>
            <span className="text-xs text-muted-foreground/60">Confluence trader — paper mode</span>
          </div>
          <span className="flex items-center gap-1.5 text-xs font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${isLoading ? 'bg-zinc-500' : agentRunning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
            <span className={isLoading ? 'text-muted-foreground/50' : agentRunning ? 'text-emerald-400' : 'text-red-400'}>
              {isLoading ? 'CONNECTING...' : agentRunning ? 'RUNNING' : 'OFFLINE'}
            </span>
          </span>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3">
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">CAPITAL</div>
            <div className="text-xl font-bold text-foreground">${capital?.total?.toFixed(2) ?? '—'}</div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">DEPLOYED</div>
            <div className="text-xl font-bold text-amber-400">${capital?.deployed?.toFixed(2) ?? '0.00'}</div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">TOTAL P&L</div>
            <div className={`text-xl font-bold ${perf.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {perf.totalPnl >= 0 ? '+' : ''}${perf.totalPnl.toFixed(2)}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">WIN RATE</div>
            <div className="text-xl font-bold text-foreground">{perf.winRate}%</div>
            <div className="text-[10px] text-muted-foreground/40">{perf.trades} trades</div>
          </div>
        </div>

        {/* Confluence Board */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
          <div className="px-4 py-3 border-b border-white/[0.04]">
            <h3 className="text-sm font-mono font-bold tracking-wider text-rose-400">CONFLUENCE BOARD</h3>
          </div>
          {board.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground/50">
              No confluence signals detected
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {board.map((item, i) => (
                <div key={i} className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-bold text-sm">{item.symbol}</span>
                    <span className={`text-xs font-mono ${DIR_COLOR[item.direction] ?? 'text-muted-foreground'}`}>
                      {item.direction.toUpperCase()}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${MODE_COLOR[item.mode] ?? ''}`}>
                      {item.mode}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex gap-1">
                      {item.signals.map((s, j) => (
                        <span key={j} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-muted-foreground/70 font-mono">
                          {s}
                        </span>
                      ))}
                    </div>
                    <div className="w-16 text-right">
                      <span className="text-sm font-mono font-bold text-foreground">{item.score}</span>
                      <div className="h-1 mt-1 rounded-full bg-white/[0.06] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-rose-400"
                          style={{ width: `${Math.min(100, item.score)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Open Positions */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
          <div className="px-4 py-3 border-b border-white/[0.04]">
            <h3 className="text-sm font-mono font-bold tracking-wider text-foreground">
              POSITIONS <span className="text-muted-foreground/50">({positions.length})</span>
            </h3>
          </div>
          {positions.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground/50">
              No open positions
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {positions.map((pos) => {
                const pnlPct = pos.direction === 'long'
                  ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
                  : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;
                return (
                  <div key={pos.id} className="px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="font-mono font-bold text-sm">{pos.symbol}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${MODE_COLOR[pos.mode] ?? ''}`}>
                        {pos.mode}
                      </span>
                      <span className={`text-xs font-mono ${pos.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
                        {pos.direction.toUpperCase()}
                      </span>
                      {pos.trailingActive && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-amber-400/10 text-amber-400 border border-amber-400/20 font-mono">
                          TRAIL
                        </span>
                      )}
                    </div>
                    <div className="text-right">
                      <span className={`text-sm font-mono font-bold ${pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                      </span>
                      <div className="text-[10px] text-muted-foreground/40 font-mono">
                        {timeAgo(pos.entryTime)} | score {pos.confluenceScore}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Circuit Breaker */}
        {cb && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
            <h3 className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground/50 mb-3">CIRCUIT BREAKERS</h3>
            <div className="grid grid-cols-3 gap-3 text-center text-xs font-mono">
              <div>
                <div className="text-muted-foreground/40 mb-1">Consecutive Losses</div>
                <div className={`text-lg font-bold ${(cb.consecutiveLosses ?? 0) >= 2 ? 'text-red-400' : 'text-foreground'}`}>
                  {cb.consecutiveLosses ?? 0}/3
                </div>
              </div>
              <div>
                <div className="text-muted-foreground/40 mb-1">Daily Loss</div>
                <div className="text-lg font-bold text-foreground">
                  {typeof cb.dailyLoss === 'number' ? cb.dailyLoss.toFixed(1) : '0.0'}%
                </div>
              </div>
              <div>
                <div className="text-muted-foreground/40 mb-1">Drawdown</div>
                <div className="text-lg font-bold text-foreground">
                  {typeof cb.drawdown === 'number' ? cb.drawdown.toFixed(1) : '0.0'}%
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-3 text-xs text-red-400 font-mono">
            {error}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
