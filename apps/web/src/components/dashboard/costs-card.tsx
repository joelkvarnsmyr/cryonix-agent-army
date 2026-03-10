"use client";

import { useState } from 'react';
import { Card, CardContent } from '@cryonix/ui';
import { DollarSign, RefreshCw, Loader2, Cpu, TrendingUp, Clock } from 'lucide-react';
import { useCosts, type CostsData } from '@/hooks/useCosts';

type TimeWindow = 'h24' | 'd7' | 'd30' | 'all';
const WINDOWS: { key: TimeWindow; label: string }[] = [
  { key: 'h24', label: '24h' },
  { key: 'd7', label: '7d' },
  { key: 'd30', label: '30d' },
  { key: 'all', label: 'All' },
];

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return '$0.00';
}

function shortModel(model: string): string {
  return model
    .replace('grok-4-1-fast-reasoning', 'Grok 4.1 Fast')
    .replace('grok-4-1-fast-non-reasoning', 'Grok 4.1 NR')
    .replace('grok-4-fast-reasoning', 'Grok 4 Fast')
    .replace('grok-3-mini', 'Grok 3 Mini')
    .replace('grok-3', 'Grok 3');
}

export function CostsCard() {
  const { data, loading, refresh } = useCosts(60000);
  const [window, setWindow] = useState<TimeWindow>('d7');

  if (loading && !data) {
    return (
      <Card className="glass-card glow-border-violet">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-violet-400/50" />
        </CardContent>
      </Card>
    );
  }

  const totals = data?.totals;
  const estimate = data?.estimate;
  const models = data?.models || [];

  return (
    <Card className="glass-card glow-border-violet overflow-hidden">
      <CardContent className="p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-violet-400/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">AI Costs</span>
          </div>
          <button onClick={refresh} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Refresh costs">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Time window selector */}
        <div className="flex gap-1 mb-4">
          {WINDOWS.map(w => (
            <button
              key={w.key}
              onClick={() => setWindow(w.key)}
              className={`px-2.5 py-1 text-[10px] font-mono rounded-md transition-colors ${
                window === w.key
                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/10'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* Total cost for selected window */}
        <div className="mb-4">
          <span className="text-2xl font-bold font-mono text-glow-violet tracking-tight">
            {formatCost(totals?.cost[window] ?? 0)}
          </span>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-[10px] text-muted-foreground font-mono">
              {totals?.calls[window] ?? 0} calls
            </span>
            {estimate && (
              <span className="text-[10px] text-violet-400/70 font-mono flex items-center gap-1">
                <TrendingUp className="h-2.5 w-2.5" />
                ~{formatCost(estimate.monthly)}/mo est.
              </span>
            )}
          </div>
        </div>

        {/* Per-model breakdown */}
        {models.length > 0 && (
          <div className="space-y-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">By Model</span>
            {models.map(m => {
              const pct = totals && totals.cost[window] > 0
                ? (m.cost[window] / totals.cost[window]) * 100
                : 0;
              return (
                <div key={m.model} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <Cpu className="h-3 w-3 text-violet-400/50 shrink-0" />
                    <span className="text-xs font-mono text-foreground/80 truncate">{shortModel(m.model)}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-muted-foreground font-mono">{m.calls[window]}</span>
                    <span className="text-xs font-mono font-medium text-violet-300">{formatCost(m.cost[window])}</span>
                    {pct > 0 && (
                      <span className="text-[10px] text-muted-foreground/60 font-mono w-8 text-right">{pct.toFixed(0)}%</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer: tracking since */}
        {estimate && estimate.days_tracked > 0 && (
          <div className="mt-4 pt-3 border-t border-border/10 flex items-center gap-1.5">
            <Clock className="h-3 w-3 text-muted-foreground/40" />
            <span className="text-[10px] text-muted-foreground/60 font-mono">
              Tracking {Math.floor(estimate.days_tracked)}d &middot; avg {formatCost(estimate.daily_avg)}/day
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
