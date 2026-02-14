"use client";

import { Card, CardContent } from '@cryonix/ui';
import { TrendingUp, TrendingDown, Wallet, RefreshCw, Loader2 } from 'lucide-react';
import { usePortfolio } from '@/hooks/useMarketData';
import { useAutoTrade } from '@/hooks/useAutoTrade';

export function PortfolioCard() {
  const { portfolio, loading, refresh } = usePortfolio(15000);
  const { data: autoTrade } = useAutoTrade(15000);

  const totalValue = portfolio?.totalValue || 0;
  const holdings = portfolio?.holdings || [];
  const dailyPnl = autoTrade?.dailyState?.dailyPnl || 0;
  const dailyPnlPct = totalValue > 0 ? (dailyPnl / totalValue) * 100 : 0;
  const isProfitable = dailyPnl >= 0;

  // Separate stables from crypto
  const stablecoins = ['USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD'];
  const cryptoHoldings = holdings.filter(h => !stablecoins.includes(h.currency) && h.usdValue >= 0.01);
  const cashBalance = holdings
    .filter(h => stablecoins.includes(h.currency))
    .reduce((sum, h) => sum + h.usdValue, 0);
  const positionsValue = cryptoHoldings.reduce((sum, h) => sum + h.usdValue, 0);

  if (loading && !portfolio) {
    return (
      <Card className="glass-card glow-border-cyan">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-primary/50" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass-card glow-border-cyan overflow-hidden">
      <CardContent className="p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Portfolio</span>
          </div>
          <button onClick={refresh} className="text-muted-foreground hover:text-foreground transition-colors">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Total Value */}
        <div className="mb-4">
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-bold font-mono text-glow-cyan tracking-tight">
              ${totalValue.toFixed(2)}
            </span>
            <div className={`flex items-center gap-1 text-sm font-mono ${isProfitable ? 'text-emerald-400' : 'text-red-400'}`}>
              {isProfitable ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
              <span>{isProfitable ? '+' : ''}{dailyPnl.toFixed(4)}</span>
              <span className="text-xs opacity-70">({dailyPnlPct.toFixed(2)}%)</span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono mt-1">TODAY&apos;S P&amp;L</p>
        </div>

        {/* Allocation Bar */}
        <div className="mb-4">
          <div className="flex h-2 rounded-full overflow-hidden bg-muted/30">
            {positionsValue > 0 && (
              <div
                className="bg-primary/60 transition-all duration-500"
                style={{ width: `${(positionsValue / totalValue) * 100}%` }}
              />
            )}
            {cashBalance > 0 && (
              <div
                className="bg-emerald-500/40 transition-all duration-500"
                style={{ width: `${(cashBalance / totalValue) * 100}%` }}
              />
            )}
          </div>
          <div className="flex justify-between mt-1.5 text-[10px] font-mono text-muted-foreground">
            <span>Positions ${positionsValue.toFixed(2)}</span>
            <span>Cash ${cashBalance.toFixed(2)}</span>
          </div>
        </div>

        {/* Holdings */}
        {cryptoHoldings.length > 0 && (
          <div className="space-y-2">
            {cryptoHoldings.map((h) => {
              const pct = totalValue > 0 ? (h.usdValue / totalValue) * 100 : 0;
              return (
                <div key={h.currency} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-md bg-muted/50 flex items-center justify-center">
                      <span className="text-[10px] font-mono font-bold text-primary/80">
                        {h.currency.slice(0, 2)}
                      </span>
                    </div>
                    <div>
                      <span className="font-medium text-xs">{h.currency}</span>
                      <span className="text-[10px] text-muted-foreground ml-2 font-mono">
                        {h.amount.toFixed(6)}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="font-mono text-xs font-medium">${h.usdValue.toFixed(2)}</span>
                    <span className="text-[10px] text-muted-foreground ml-1.5 font-mono">
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Updated */}
        {portfolio?.updated && (
          <p className="text-[10px] text-muted-foreground/50 font-mono mt-3 text-right">
            {new Date(portfolio.updated).toLocaleTimeString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
