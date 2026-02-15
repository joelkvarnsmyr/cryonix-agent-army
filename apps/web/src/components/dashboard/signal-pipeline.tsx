"use client";

import { Card, CardContent, Badge } from '@cryonix/ui';
import { Radio, ArrowRight, Brain, Shield } from 'lucide-react';
import { useTankState } from '@/hooks/useTankState';
import { useAutoTrade } from '@/hooks/useAutoTrade';

export function SignalPipeline() {
  const { pendingTrades, scout } = useTankState();
  const { data: autoTrade } = useAutoTrade(10000);

  const pending = autoTrade?.queues?.pending || 0;
  const approved = autoTrade?.queues?.approved || 0;
  const engineStatus = scout.state?.status || 'offline';
  const isScanning = engineStatus === 'active' || engineStatus === 'scanning';
  const signals = Array.isArray(pendingTrades.data) ? pendingTrades.data : [];

  return (
    <Card className="glass-card">
      <CardContent className="p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Signal Pipeline</span>
          </div>
          <div className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${isScanning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-zinc-500'}`} />
            <span className="text-[10px] font-mono text-muted-foreground">
              {isScanning ? 'SCANNING' : 'IDLE'}
            </span>
          </div>
        </div>

        {/* Pipeline Flow */}
        <div className="flex items-center gap-2 mb-4">
          <div className="flex-1 rounded-lg bg-muted/20 border border-border/30 p-2.5 text-center">
            <div className="text-[10px] text-muted-foreground font-mono mb-1">DETECTED</div>
            <div className="text-lg font-mono font-bold text-primary">{pending}</div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground/30 flex-shrink-0" />
          <div className="flex-1 rounded-lg bg-muted/20 border border-border/30 p-2.5 text-center">
            <div className="text-[10px] text-muted-foreground font-mono mb-1 flex items-center justify-center gap-1">
              <Brain className="h-2.5 w-2.5" />AI VALID
            </div>
            <div className="text-lg font-mono font-bold text-amber-400">{approved}</div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground/30 flex-shrink-0" />
          <div className="flex-1 rounded-lg bg-muted/20 border border-border/30 p-2.5 text-center">
            <div className="text-[10px] text-muted-foreground font-mono mb-1 flex items-center justify-center gap-1">
              <Shield className="h-2.5 w-2.5" />EXECUTED
            </div>
            <div className="text-lg font-mono font-bold text-emerald-400">
              {autoTrade?.dailyState?.tradesExecuted || 0}
            </div>
          </div>
        </div>

        {/* Pending Signals */}
        {signals.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-[10px] text-muted-foreground font-mono uppercase mb-2">Awaiting Execution</p>
            {signals.slice(0, 4).map((signal: any, idx: number) => (
              <div key={idx} className="flex items-center justify-between py-1.5 px-2.5 rounded-md bg-muted/10 border border-border/20">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={`text-[9px] h-4 px-1.5 ${
                      signal.action === 'BUY' ? 'text-emerald-400 border-emerald-400/30' : 'text-red-400 border-red-400/30'
                    }`}
                  >
                    {signal.action}
                  </Badge>
                  <span className="font-mono text-xs">{signal.symbol}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {((signal.confidence || 0) * 100).toFixed(0)}%
                  </span>
                  <span className="text-[9px] font-mono text-muted-foreground/50">
                    {signal.patterns?.slice(0, 2).join(', ') || ''}
                  </span>
                </div>
              </div>
            ))}
            {signals.length > 4 && (
              <p className="text-[10px] text-muted-foreground/50 font-mono text-center">
                +{signals.length - 4} more
              </p>
            )}
          </div>
        ) : (
          <div className="text-center py-3">
            <p className="text-[10px] text-muted-foreground/60 font-mono">Pipeline clear. Scanning for opportunities...</p>
          </div>
        )}

        {/* Daily Stats */}
        <div className="mt-3 pt-3 border-t border-border/20 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground font-mono">
            {autoTrade?.dailyState?.tradesExecuted || 0}/{autoTrade?.config?.MAX_TRADES_PER_DAY || 5} trades today
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">
            Min conf: {((autoTrade?.config?.MIN_CONFIDENCE || 0.65) * 100).toFixed(0)}%
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
