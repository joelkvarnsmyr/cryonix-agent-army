'use client';

import { useSolanixStatus, useSolanixPositions, useSolanixSignals } from '@/hooks/useSolanix';
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

  const agentRunning    = status?.status === 'running';
  const portfolioValue  = status?.account?.portfolioValue ?? 0;
  const buyingPower     = status?.account?.usdcBalance    ?? 0;
  const dailyPnl        = status?.risk?.dailyPnl          ?? 0;
  const tradesToday     = status?.risk?.openPositions     ?? 0;
  const positionsUsed   = positions.length;
  const maxPositions    = 5;

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
            <span className={`w-1.5 h-1.5 rounded-full ${agentRunning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
            <span className={agentRunning ? 'text-emerald-400' : 'text-red-400'}>
              {agentRunning ? 'RUNNING' : 'STOPPED'}
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
              <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">PAPER MODE</div>
              <div className={`font-mono text-xs ${status?.risk?.paperTrading ? 'text-amber-400' : 'text-foreground'}`}>
                {status?.risk?.paperTrading ? 'YES' : 'LIVE'}
              </div>
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

      </div>
    </DashboardLayout>
  );
}
