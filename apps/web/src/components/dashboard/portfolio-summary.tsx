"use client";

import { Card, CardContent, CardHeader, CardTitle } from '@cryonix/ui';
import { TrendingUp, TrendingDown, Wallet } from 'lucide-react';

export function PortfolioSummary() {
  // Mock data - will be replaced with real data from API
  const portfolioData = {
    totalValue: 25420.50,
    dailyPnL: 1250.30,
    dailyPnLPercent: 5.2,
    cashBalance: 5000,
    positionsValue: 20420.50,
  };

  const isPositive = portfolioData.dailyPnL >= 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5" />
          Portfolio
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Total Value */}
        <div>
          <p className="text-sm text-muted-foreground">Total Value</p>
          <p className="text-3xl font-bold">${portfolioData.totalValue.toLocaleString()}</p>
        </div>

        {/* Daily P&L */}
        <div className={`rounded-lg p-3 ${isPositive ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Today's P&L</span>
            <div className="flex items-center gap-1">
              {isPositive ? (
                <TrendingUp className="h-4 w-4 text-green-500" />
              ) : (
                <TrendingDown className="h-4 w-4 text-red-500" />
              )}
              <span className={`text-sm font-bold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
                {isPositive ? '+' : ''}{portfolioData.dailyPnLPercent}%
              </span>
            </div>
          </div>
          <p className={`text-2xl font-bold mt-1 ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
            {isPositive ? '+' : ''}${portfolioData.dailyPnL.toLocaleString()}
          </p>
        </div>

        {/* Breakdown */}
        <div className="grid grid-cols-2 gap-3 pt-2 border-t">
          <div>
            <p className="text-xs text-muted-foreground">Cash</p>
            <p className="text-lg font-semibold">${portfolioData.cashBalance.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Positions</p>
            <p className="text-lg font-semibold">${portfolioData.positionsValue.toLocaleString()}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
