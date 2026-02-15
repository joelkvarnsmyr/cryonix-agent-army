"use client";

import { Card, CardContent, CardHeader, CardTitle, Badge } from '@cryonix/ui';
import { TrendingUp, TrendingDown } from 'lucide-react';

export function ActivePositions() {
  // Mock data
  const positions = [
    {
      id: '1',
      symbol: 'BTC/USDT',
      quantity: 0.5,
      entryPrice: 95000,
      currentPrice: 96500,
      pnl: 750,
      pnlPercent: 1.58,
    },
    {
      id: '2',
      symbol: 'ETH/USDT',
      quantity: 5,
      entryPrice: 3400,
      currentPrice: 3420,
      pnl: 100,
      pnlPercent: 0.59,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Active Positions</span>
          <Badge variant="outline">{positions.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {positions.map((position) => {
          const isProfit = position.pnl >= 0;

          return (
            <div
              key={position.id}
              className="rounded-lg border border-border bg-card p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-sm">{position.symbol}</span>
                <div className="flex items-center gap-1">
                  {isProfit ? (
                    <TrendingUp className="h-3 w-3 text-green-500" />
                  ) : (
                    <TrendingDown className="h-3 w-3 text-red-500" />
                  )}
                  <span className={`text-xs font-semibold ${isProfit ? 'text-green-500' : 'text-red-500'}`}>
                    {isProfit ? '+' : ''}{position.pnlPercent.toFixed(2)}%
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground">Qty:</span>
                  <span className="ml-1 font-medium">{position.quantity}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Entry:</span>
                  <span className="ml-1 font-medium">${position.entryPrice.toLocaleString()}</span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-border">
                <span className="text-xs text-muted-foreground">P&L</span>
                <span className={`text-sm font-bold ${isProfit ? 'text-green-500' : 'text-red-500'}`}>
                  {isProfit ? '+' : ''}${position.pnl.toLocaleString()}
                </span>
              </div>
            </div>
          );
        })}

        {positions.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-sm">
            No active positions
          </div>
        )}
      </CardContent>
    </Card>
  );
}
