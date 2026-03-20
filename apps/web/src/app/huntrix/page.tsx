'use client';

import { useHuntrixStatus } from '@/hooks/useHuntrix';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const TYPE_COLOR: Record<string, string> = {
  pump_and_dump: 'text-red-400 bg-red-400/10 border-red-400/20',
  coordinated_shill: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  whale_accumulation: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  fake_news_pump: 'text-violet-400 bg-violet-400/10 border-violet-400/20',
  wash_trading_pump: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
  influencer_pump: 'text-pink-400 bg-pink-400/10 border-pink-400/20',
};

const PHASE_COLOR: Record<string, string> = {
  early_pump: 'text-emerald-400',
  mid_pump: 'text-amber-400',
  peak: 'text-red-400',
  dump: 'text-red-500',
};

export default function HuntrixPage() {
  const { data, error } = useHuntrixStatus(10_000);

  const isLoading = data === null;
  const isOnline = data?.status !== 'offline' && data?.status !== undefined && data?.status !== null;
  const positions = data?.positions ?? [];
  const signals = data?.activeSignals ?? [];
  const perf = data?.performance ?? { dailyPnl: 0, tradesToday: 0, winRate: 0, totalTrades: 0, totalWins: 0 };
  const cb = data?.circuitBreaker;
  const recentTrades = data?.recentTrades ?? [];

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-4">

        {/* Banner */}
        <div className="rounded-lg border border-orange-400/30 bg-orange-400/5 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-orange-400 text-[10px] font-mono font-bold tracking-widest">HUNTRIX</span>
            <span className="text-xs text-muted-foreground/60">Manipulation detection & ride — paper mode</span>
          </div>
          <span className="flex items-center gap-1.5 text-xs font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${isLoading ? 'bg-zinc-500' : isOnline ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
            <span className={isLoading ? 'text-muted-foreground/50' : isOnline ? 'text-emerald-400' : 'text-red-400'}>
              {isLoading ? 'CONNECTING...' : isOnline ? (data?.status ?? '').toUpperCase() : 'OFFLINE'}
            </span>
          </span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3">
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">BALANCE</div>
            <div className="text-xl font-bold text-foreground">${data?.virtualBalance?.toFixed(2) ?? '—'}</div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">DAILY P&L</div>
            <div className={`text-xl font-bold ${perf.dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {perf.dailyPnl >= 0 ? '+' : ''}${perf.dailyPnl.toFixed(2)}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">WIN RATE</div>
            <div className="text-xl font-bold text-foreground">{perf.winRate.toFixed(0)}%</div>
            <div className="text-[10px] text-muted-foreground/40">{perf.totalTrades} trades</div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">LAST SCAN</div>
            <div className="text-sm font-mono text-foreground">{data?.lastScanAt ? timeAgo(data.lastScanAt) : '—'}</div>
          </div>
        </div>

        {/* Detection Feed */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
          <div className="px-4 py-3 border-b border-white/[0.04]">
            <h3 className="text-sm font-mono font-bold tracking-wider text-orange-400">DETECTION FEED</h3>
          </div>
          {signals.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground/50">
              No active manipulation signals
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {signals.map((sig, i) => (
                <div key={i} className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-bold text-sm">{sig.symbol}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${TYPE_COLOR[sig.type] ?? ''}`}>
                      {sig.type.replace(/_/g, ' ')}
                    </span>
                    <span className={`text-xs font-mono ${PHASE_COLOR[sig.phase] ?? 'text-muted-foreground'}`}>
                      {sig.phase.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono">
                    <span className="text-muted-foreground/50">{sig.total_shill_accounts} shills</span>
                    <span className="font-bold text-foreground">{sig.confidence}%</span>
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
              POSITIONS <span className="text-muted-foreground/50">({positions.length}/2)</span>
            </h3>
          </div>
          {positions.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground/50">
              No open positions
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {positions.map((pos) => (
                <div key={pos.id} className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-bold text-sm">{pos.symbol}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${TYPE_COLOR[pos.signal?.type] ?? ''}`}>
                      {pos.signal?.type?.replace(/_/g, ' ') ?? '?'}
                    </span>
                    {pos.trailing_active && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-amber-400/10 text-amber-400 border border-amber-400/20 font-mono">
                        TRAIL
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className={`text-sm font-mono font-bold ${pos.unrealized_pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {pos.unrealized_pnl_pct >= 0 ? '+' : ''}{pos.unrealized_pnl_pct.toFixed(2)}%
                    </span>
                    <div className="text-[10px] text-muted-foreground/40 font-mono">
                      ${pos.size_usd.toFixed(2)} | {timeAgo(pos.entered_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Trades */}
        {recentTrades.length > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
            <div className="px-4 py-3 border-b border-white/[0.04]">
              <h3 className="text-sm font-mono font-bold tracking-wider text-foreground">RECENT TRADES</h3>
            </div>
            <div className="divide-y divide-white/[0.04]">
              {recentTrades.slice(0, 5).map((t) => (
                <div key={t.id} className="px-4 py-2 flex items-center justify-between text-xs font-mono">
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{t.symbol}</span>
                    <span className="text-muted-foreground/50">{t.exit_reason}</span>
                  </div>
                  <span className={t.unrealized_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {t.unrealized_pnl >= 0 ? '+' : ''}${t.unrealized_pnl.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Circuit Breaker */}
        {cb && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
            <h3 className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground/50 mb-3">CIRCUIT BREAKERS</h3>
            <div className="grid grid-cols-3 gap-3 text-center text-xs font-mono">
              <div>
                <div className="text-muted-foreground/40 mb-1">Consecutive Losses</div>
                <div className={`text-lg font-bold ${cb.consecutiveLosses >= 2 ? 'text-red-400' : 'text-foreground'}`}>
                  {cb.consecutiveLosses}/3
                </div>
              </div>
              <div>
                <div className="text-muted-foreground/40 mb-1">Daily Loss</div>
                <div className="text-lg font-bold text-foreground">${cb.dailyLoss.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-muted-foreground/40 mb-1">Cooldown</div>
                <div className={`text-lg font-bold ${cb.isPaused ? 'text-red-400' : 'text-foreground'}`}>
                  {cb.isPaused ? 'ACTIVE' : 'OK'}
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
