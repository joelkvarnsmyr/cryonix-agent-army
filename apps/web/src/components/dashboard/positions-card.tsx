"use client";

import { Card, CardContent, Badge } from '@cryonix/ui';
import { TrendingUp, TrendingDown, Crosshair } from 'lucide-react';
import { useAutoTrade } from '@/hooks/useAutoTrade';

export function PositionsCard() {
  const { data, loading } = useAutoTrade(10000);
  const positions = data?.positions || [];

  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);

  return (
    <Card className="glass-card">
      <CardContent className="p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Crosshair className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Positions</span>
          </div>
          <Badge variant="outline" className="font-mono text-[10px] h-5 border-border/50">
            {positions.length}/{data?.config?.MAX_OPEN_POSITIONS || 3}
          </Badge>
        </div>

        {positions.length === 0 ? (
          <div className="text-center py-6">
            <div className="h-10 w-10 rounded-full bg-muted/30 flex items-center justify-center mx-auto mb-2">
              <Crosshair className="h-5 w-5 text-muted-foreground/40" />
            </div>
            <p className="text-xs text-muted-foreground">No open positions</p>
            <p className="text-[10px] text-muted-foreground/50 mt-1">Waiting for signals...</p>
          </div>
        ) : (
          <>
            {/* Positions List */}
            <div className="space-y-2.5">
              {positions.map((pos) => {
                const isProfit = pos.pnl >= 0;
                return (
                  <div
                    key={pos.symbol}
                    className="rounded-lg bg-muted/20 border border-border/30 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{pos.symbol.replace('/USDC', '')}</span>
                        <Badge
                          variant="outline"
                          className={`text-[9px] h-4 px-1.5 ${
                            pos.side === 'BUY' ? 'text-emerald-400 border-emerald-400/30' : 'text-red-400 border-red-400/30'
                          }`}
                        >
                          {pos.side}
                        </Badge>
                        <span className="text-[9px] font-mono text-muted-foreground/60">{pos.pattern}</span>
                      </div>
                      <div className={`flex items-center gap-1 font-mono text-sm font-semibold ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
                        {isProfit ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {isProfit ? '+' : ''}{pos.pnlPct.toFixed(2)}%
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-2 text-[10px] font-mono">
                      <div>
                        <span className="text-muted-foreground/60 block">Entry</span>
                        <span>${pos.entryPrice.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground/60 block">Now</span>
                        <span>${pos.currentPrice.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground/60 block">SL</span>
                        <span className="text-red-400/70">${pos.stopLoss.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground/60 block">P&L</span>
                        <span className={isProfit ? 'text-emerald-400' : 'text-red-400'}>
                          {isProfit ? '+' : ''}${pos.pnl.toFixed(4)}
                        </span>
                      </div>
                    </div>

                    {/* Trailing Stop Indicator */}
                    {pos.trailingStop > 0 && (
                      <div className="flex items-center gap-2 text-[9px] font-mono text-muted-foreground/50">
                        <span>Trail: ${pos.trailingStop.toFixed(2)}</span>
                        <span>HWM: ${pos.highWaterMark.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Total P&L */}
            <div className="mt-3 pt-3 border-t border-border/30 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground font-mono uppercase">Total Unrealized</span>
              <span className={`font-mono text-sm font-bold ${totalPnl >= 0 ? 'text-emerald-400 text-glow-green' : 'text-red-400 text-glow-red'}`}>
                {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
