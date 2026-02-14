"use client";

import { Card, CardContent, Badge } from '@cryonix/ui';
import { Clock, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { useAutoTrade } from '@/hooks/useAutoTrade';
import { useWebSocket } from '@/hooks/use-websocket';

export function TradeActivity() {
  const { data: autoTrade } = useAutoTrade(15000);
  const { trades } = useWebSocket();

  const dailyState = autoTrade?.dailyState;
  const recentTrades = trades.slice(0, 8);

  return (
    <Card className="glass-card">
      <CardContent className="p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Activity</span>
          </div>
          {dailyState && (
            <div className="flex items-center gap-2">
              <span className={`font-mono text-xs font-semibold ${dailyState.dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {dailyState.dailyPnl >= 0 ? '+' : ''}{dailyState.dailyPnl.toFixed(4)}
              </span>
              <span className="text-[9px] text-muted-foreground font-mono">TODAY</span>
            </div>
          )}
        </div>

        {/* Recent trades from WebSocket */}
        {recentTrades.length > 0 ? (
          <div className="space-y-1.5">
            {recentTrades.map((trade, i) => {
              const isBuy = trade.side === 'BUY';
              return (
                <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-md bg-muted/10">
                  <div className="flex items-center gap-2">
                    {isBuy ? (
                      <ArrowUpRight className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <ArrowDownRight className="h-3 w-3 text-red-400" />
                    )}
                    <span className="font-mono text-[11px] font-medium">{trade.symbol}</span>
                    <Badge variant="outline" className={`text-[8px] h-3.5 px-1 ${isBuy ? 'text-emerald-400 border-emerald-400/30' : 'text-red-400 border-red-400/30'}`}>
                      {trade.side?.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="text-right">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      ${trade.price?.toLocaleString() || '—'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-6">
            <Clock className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
            <p className="text-[11px] text-muted-foreground/60 font-mono">No recent trades</p>
            <p className="text-[9px] text-muted-foreground/40 font-mono mt-1">
              {dailyState?.tradesExecuted || 0} executed today
            </p>
          </div>
        )}

        {/* Grid Status */}
        {autoTrade?.grids && autoTrade.grids.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/20">
            <span className="text-[9px] font-mono text-muted-foreground/50 uppercase">Active Grids</span>
            <div className="flex gap-1.5 mt-1">
              {autoTrade.grids.map((grid: any, i: number) => (
                <Badge key={i} variant="outline" className="text-[9px] h-4 px-1.5 border-violet-500/30 text-violet-400">
                  {grid.symbol?.replace('/USDC', '')}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
