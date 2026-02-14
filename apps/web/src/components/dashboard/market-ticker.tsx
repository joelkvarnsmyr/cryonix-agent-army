"use client";

import { Card, CardContent } from '@cryonix/ui';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { useMultipleTickers } from '@/hooks/useMarketData';

export function MarketTicker() {
  const { tickers, loading } = useMultipleTickers();

  // Filter to our key trading pairs
  const watchlist = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'DOT/USDT', 'AVAX/USDT', 'ADA/USDT', 'LINK/USDT'];
  const filteredTickers = tickers
    .filter(t => watchlist.includes(t.symbol))
    .sort((a, b) => watchlist.indexOf(a.symbol) - watchlist.indexOf(b.symbol));

  if (loading && filteredTickers.length === 0) {
    return (
      <Card className="glass-card">
        <CardContent className="p-3">
          <div className="flex items-center gap-4 overflow-x-auto">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-8 w-32 rounded bg-muted/20 animate-shimmer flex-shrink-0" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass-card">
      <CardContent className="p-2 px-3">
        <div className="flex items-center gap-1 overflow-x-auto">
          <span className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider mr-2 flex-shrink-0">LIVE</span>
          {filteredTickers.map((ticker) => {
            const isUp = ticker.change24h >= 0;
            const symbol = ticker.symbol.replace('/USDT', '');
            return (
              <div
                key={ticker.symbol}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-muted/20 transition-colors flex-shrink-0"
              >
                <span className="font-mono text-xs font-semibold text-foreground/80">{symbol}</span>
                <span className="font-mono text-xs text-foreground/90">
                  ${ticker.price >= 1000
                    ? ticker.price.toLocaleString(undefined, { maximumFractionDigits: 0 })
                    : ticker.price >= 1
                      ? ticker.price.toFixed(2)
                      : ticker.price.toFixed(4)
                  }
                </span>
                <span className={`flex items-center gap-0.5 font-mono text-[10px] font-medium ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                  {isUp ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                  {isUp ? '+' : ''}{ticker.change24h.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
