'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSolanixStatus, useSolanixPositions, useSolanixSignals } from '@/hooks/useSolanix';

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const ACTION_COLOR: Record<string, string> = {
  BUY: 'text-emerald-400',
  SELL: 'text-red-400',
  WAIT: 'text-muted-foreground',
};

const SOURCE_LABEL: Record<string, string> = {
  ta: 'TA',
  dexscreener: 'DEX',
};

export default function SolanixPage() {
  const { data: status } = useSolanixStatus(10_000);
  const { positions } = useSolanixPositions(15_000);
  const { signals } = useSolanixSignals(30_000);

  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 16));
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);

  const agentRunning = status?.status === 'running';
  const portfolioValue = status?.account?.portfolioValue ?? 0;
  const usdcBalance = status?.account?.usdcBalance ?? 0;
  const solBalance = status?.account?.solBalance ?? 0;
  const dailyPnl = status?.risk?.dailyPnl ?? 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto p-4 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/" className="font-mono text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">← Crypto</Link>
            <Link href="/aktienix" className="font-mono text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">Stocks</Link>
            <span className="font-mono text-sm font-bold tracking-wider text-muted-foreground">SOLANIX</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${agentRunning ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              {agentRunning ? 'running' : 'stopped'}
            </span>
            <span className="font-mono">{clock} UTC</span>
          </div>
        </div>

        {/* Paper Trading Banner */}
        {status !== null && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-2 flex items-center gap-2">
            <span className="text-amber-400 text-xs font-mono font-bold">PAPER TRADING MODE</span>
            <span className="text-xs text-muted-foreground">No real funds at risk — simulated execution only</span>
          </div>
        )}

        {/* Portfolio Value */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
          <div className="text-xs text-muted-foreground mb-1 font-mono">PORTFOLIO VALUE</div>
          <div className="text-3xl font-bold tracking-tight text-emerald-400">
            ${portfolioValue.toFixed(2)}
          </div>
          <div className="mt-1 flex items-center justify-center gap-3 text-sm">
            <span className={dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {dailyPnl >= 0 ? '+' : ''}{dailyPnl.toFixed(2)} today
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/60 mb-0.5">USDC Balance</div>
              <div className="font-mono text-foreground">${usdcBalance.toFixed(2)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/60 mb-0.5">SOL Balance</div>
              <div className="font-mono text-foreground">{solBalance.toFixed(4)} SOL</div>
            </div>
          </div>
        </div>

        {/* Open Positions */}
        {positions.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-2">Open positions ({positions.length})</div>
            <div className="grid grid-cols-2 gap-3">
              {positions.map(pos => {
                const plPct = pos.avgEntryPrice > 0
                  ? ((pos.currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100
                  : 0;
                const plColor = pos.unrealizedPl >= 0 ? 'text-emerald-400' : 'text-red-400';
                return (
                  <div key={pos.symbol} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                    <div className="text-xs text-muted-foreground mb-1">{pos.symbol}</div>
                    <div className={`text-lg font-semibold ${plColor}`}>
                      {plPct >= 0 ? '+' : ''}{plPct.toFixed(2)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      <div>${pos.avgEntryPrice.toFixed(4)} &rarr; ${pos.currentPrice.toFixed(4)}</div>
                      <div className={plColor}>
                        {pos.unrealizedPl >= 0 ? '+' : ''}${pos.unrealizedPl.toFixed(2)}
                      </div>
                      <div className="text-muted-foreground/50">{pos.qty} tokens · {timeAgo(pos.entryTime)}</div>
                      {pos.trailingStopActive && (
                        <div className="text-amber-400/70">trailing stop active</div>
                      )}
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

        {/* Recent Signals */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-muted-foreground">Recent signals</div>
            {signals.length > 0 && (
              <div className="text-xs text-muted-foreground/60">{signals.length} total</div>
            )}
          </div>
          {signals.length === 0 ? (
            <div className="text-sm text-muted-foreground/50">No signals yet</div>
          ) : (
            <div className="space-y-1.5">
              {signals.slice(0, 10).map((sig, i) => (
                <div key={`${sig.symbol}-${sig.timestamp}-${i}`} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground w-16">{sig.symbol}</span>
                    <span className={`text-xs font-mono font-semibold ${ACTION_COLOR[sig.action] ?? 'text-muted-foreground'}`}>
                      {sig.action}
                    </span>
                    <span className="text-xs text-muted-foreground/50">{SOURCE_LABEL[sig.source] ?? sig.source}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground/70">
                      {(sig.confidence * 100).toFixed(0)}%
                    </span>
                    <span className="text-xs text-muted-foreground/50 w-14 text-right">{timeAgo(sig.timestamp)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
