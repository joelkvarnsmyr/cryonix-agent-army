"use client";

import { Card, CardContent, CardHeader, CardTitle } from '@cryonix/ui';
import { TrendingUp, TrendingDown, Wallet, RefreshCw, Loader2 } from 'lucide-react';
import { usePortfolio } from '@/hooks/useMarketData';
import { useWebSocket } from '@/hooks/use-websocket';
import { useEffect } from 'react';

export function PortfolioSummary() {
  const { portfolio, loading, error, refresh, setPortfolio } = usePortfolio(30000);
  const { lastMessage } = useWebSocket();

  useEffect(() => {
    if (lastMessage?.type === 'BROADCAST' && lastMessage.data?.type === 'PORTFOLIO_UPDATE') {
      setPortfolio(lastMessage.data.data);
    }
  }, [lastMessage, setPortfolio]);

  if (loading && !portfolio) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Portfolio
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Portfolio
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-red-500 text-sm">{error}</div>
          <button onClick={refresh} className="text-sm text-blue-500 mt-2">
            Retry
          </button>
        </CardContent>
      </Card>
    );
  }

  const totalValue = portfolio?.totalValue || 0;
  const holdings = portfolio?.holdings || [];

  // Calculate cash (stablecoins) vs positions (other crypto)
  const stablecoins = ['USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD'];
  const cashHoldings = holdings.filter(h => stablecoins.includes(h.currency));
  const positionHoldings = holdings.filter(h => !stablecoins.includes(h.currency));

  const cashBalance = cashHoldings.reduce((sum, h) => sum + h.usdValue, 0);
  const positionsValue = positionHoldings.reduce((sum, h) => sum + h.usdValue, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Portfolio
          </div>
          <button
            onClick={refresh}
            className="p-1 hover:bg-muted rounded"
            title="Refresh"
            aria-label="Refresh portfolio summary"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Total Value */}
        <div>
          <p className="text-sm text-muted-foreground">Total Value</p>
          <p className="text-3xl font-bold">${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>

        {/* Holdings List */}
        {holdings.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Holdings</p>
            {holdings.slice(0, 5).map((holding) => (
              <div key={holding.currency} className="flex justify-between items-center text-sm">
                <span className="font-medium">{holding.currency}</span>
                <div className="text-right">
                  <span className="text-muted-foreground">{holding.amount.toFixed(4)}</span>
                  <span className="ml-2 font-semibold">${holding.usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </div>
            ))}
            {holdings.length > 5 && (
              <p className="text-xs text-muted-foreground">+{holdings.length - 5} more...</p>
            )}
          </div>
        )}

        {/* Breakdown */}
        <div className="grid grid-cols-2 gap-3 pt-2 border-t">
          <div>
            <p className="text-xs text-muted-foreground">Cash (Stables)</p>
            <p className="text-lg font-semibold">${cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Positions</p>
            <p className="text-lg font-semibold">${positionsValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
        </div>

        {/* Last updated */}
        {portfolio?.updated && (
          <p className="text-xs text-muted-foreground text-right">
            Updated: {new Date(portfolio.updated).toLocaleTimeString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
