"use client";

import Link from 'next/link';
import { CircleDollarSign, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@cryonix/ui';
import { useSolanixStatus, useSolanixPositions, useSolanixSignals } from '@/hooks/useSolanix';

const ACTION_COLOR: Record<string, string> = {
  BUY:  'text-emerald-400',
  SELL: 'text-red-400',
  WAIT: 'text-muted-foreground/50',
};

export function SolanixStatusCard() {
  const { data: status }  = useSolanixStatus(10_000);
  const { positions }     = useSolanixPositions(15_000);
  const { signals }       = useSolanixSignals(30_000);

  const agentRunning  = status?.status === 'running';
  const usdcBalance   = status?.account?.usdcBalance  ?? 0;
  const portfolioVal  = status?.account?.portfolioValue ?? 0;
  const isPaper       = status?.risk?.paperTrading    ?? true;
  const posCount      = positions.length;

  // Latest non-WAIT signal
  const latestSignal  = signals.find(s => s.action !== 'WAIT');

  return (
    <Card className="glass-card overflow-hidden" style={{ boxShadow: '0 0 0 1px rgba(251,191,36,0.12), 0 0 12px rgba(251,191,36,0.04)' }}>
      <CardContent className="p-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <CircleDollarSign className="h-4 w-4 text-amber-400/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Solanix</span>
          </div>
          <div className="flex items-center gap-2">
            {isPaper && (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-amber-400/25 bg-amber-400/5 text-amber-400/70">
                PAPER
              </span>
            )}
            <Link href="/solanix" className="text-muted-foreground/40 hover:text-amber-400 transition-colors">
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* Agent status */}
        <div className="flex items-center gap-2 mb-4">
          <span className={`h-1.5 w-1.5 rounded-full ${agentRunning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
          <span className={`text-xs font-mono ${agentRunning ? 'text-emerald-400' : 'text-red-400'}`}>
            {agentRunning ? 'RUNNING' : 'STOPPED'}
          </span>
          {latestSignal && (
            <span className="ml-auto flex items-center gap-1 text-[10px] font-mono">
              <span className="text-muted-foreground/40">{latestSignal.symbol}</span>
              <span className={ACTION_COLOR[latestSignal.action]}>{latestSignal.action}</span>
              <span className="text-muted-foreground/30">{(latestSignal.confidence * 100).toFixed(0)}%</span>
            </span>
          )}
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-white/[0.03] p-2.5">
            <div className="text-[9px] font-mono text-muted-foreground/50 mb-0.5 uppercase tracking-wider">Portfolio</div>
            <div className="font-mono text-sm text-foreground">${portfolioVal.toFixed(0)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.03] p-2.5">
            <div className="text-[9px] font-mono text-muted-foreground/50 mb-0.5 uppercase tracking-wider">USDC</div>
            <div className="font-mono text-sm text-foreground">${usdcBalance.toFixed(0)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.03] p-2.5">
            <div className="text-[9px] font-mono text-muted-foreground/50 mb-0.5 uppercase tracking-wider">Positions</div>
            <div className="font-mono text-sm text-foreground">{posCount}</div>
          </div>
        </div>

        {/* Signal count */}
        <div className="mt-3 text-[9px] font-mono text-muted-foreground/35 text-right">
          {signals.length} signal{signals.length !== 1 ? 's' : ''} in queue
        </div>

      </CardContent>
    </Card>
  );
}
