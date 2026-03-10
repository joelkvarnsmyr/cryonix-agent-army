"use client";

import Link from 'next/link';
import { TrendingUp, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@cryonix/ui';
import { useAktienixStatus, useAktienixPortfolio, useAktienixPositions } from '@/hooks/useAktienix';

const PHASE_LABEL: Record<string, string> = {
  pre:     'PRE-MARKET',
  regular: 'MARKET OPEN',
  after:   'AFTER-HOURS',
  closed:  'CLOSED',
};

const PHASE_COLOR: Record<string, string> = {
  pre:     'text-amber-400 bg-amber-400/10 border-amber-400/20',
  regular: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  after:   'text-amber-400 bg-amber-400/10 border-amber-400/20',
  closed:  'text-muted-foreground bg-white/[0.03] border-white/[0.06]',
};

export function AktienixStatusCard() {
  const { data: status }    = useAktienixStatus(30_000);
  const { data: portfolio } = useAktienixPortfolio(30_000);
  const { positions }       = useAktienixPositions(30_000);

  const phase        = status?.market.phase    ?? 'closed';
  const etTime       = status?.market.localTime ?? '--:-- ET';
  const agentRunning = status?.agent.running   ?? false;
  const broker       = status?.agent.broker    ?? '—';
  const portfolioVal = portfolio?.portfolioValue ?? 0;
  const buyingPower  = portfolio?.buyingPower    ?? 0;
  const posCount     = positions.length;

  return (
    <Card className="glass-card glow-border-violet overflow-hidden">
      <CardContent className="p-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-violet-400/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Aktienix</span>
          </div>
          <Link href="/aktienix" className="text-muted-foreground/40 hover:text-violet-400 transition-colors">
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>

        {/* Market phase badge + agent status */}
        <div className="flex items-center gap-2 mb-4">
          <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${PHASE_COLOR[phase]}`}>
            {PHASE_LABEL[phase]}
          </span>
          <span className="flex items-center gap-1 ml-auto">
            <span className={`h-1.5 w-1.5 rounded-full ${agentRunning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
            <span className="text-[10px] font-mono text-muted-foreground/60">
              {agentRunning ? broker : 'stopped'}
            </span>
          </span>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-white/[0.03] p-2.5">
            <div className="text-[9px] font-mono text-muted-foreground/50 mb-0.5 uppercase tracking-wider">Portfolio</div>
            <div className="font-mono text-sm text-foreground">${portfolioVal.toFixed(0)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.03] p-2.5">
            <div className="text-[9px] font-mono text-muted-foreground/50 mb-0.5 uppercase tracking-wider">Cash</div>
            <div className="font-mono text-sm text-foreground">${buyingPower.toFixed(0)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.03] p-2.5">
            <div className="text-[9px] font-mono text-muted-foreground/50 mb-0.5 uppercase tracking-wider">Positions</div>
            <div className="font-mono text-sm text-foreground">{posCount}</div>
          </div>
        </div>

        {/* ET clock */}
        <div className="mt-3 text-[9px] font-mono text-muted-foreground/35 text-right">{etTime}</div>

      </CardContent>
    </Card>
  );
}
