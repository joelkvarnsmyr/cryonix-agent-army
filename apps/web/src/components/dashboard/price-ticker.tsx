"use client";

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, Badge } from '@cryonix/ui';
import { TrendingUp, TrendingDown, Minus, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { usePriceSubscription, useWebSocket } from '@/hooks/use-websocket';
import type { WSPriceData } from '@cryonix/types';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface PriceTickerProps {
  symbols?: string[];
  compact?: boolean;
  showChange?: boolean;
  showVolume?: boolean;
  className?: string;
}

interface TickerItemProps {
  symbol: string;
  price: WSPriceData | undefined;
  previousPrice: number | null;
  compact?: boolean;
  showChange?: boolean;
  showVolume?: boolean;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function formatPrice(price: number): string {
  if (price >= 10000) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (price >= 100) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (price >= 1) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  } else {
    return price.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  }
}

function formatVolume(volume: number): string {
  if (volume >= 1e9) {
    return `${(volume / 1e9).toFixed(2)}B`;
  } else if (volume >= 1e6) {
    return `${(volume / 1e6).toFixed(2)}M`;
  } else if (volume >= 1e3) {
    return `${(volume / 1e3).toFixed(2)}K`;
  }
  return volume.toFixed(2);
}

function formatChange(change: number): string {
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

function getSymbolIcon(symbol: string): string {
  const base = symbol.split('/')[0];
  const icons: Record<string, string> = {
    BTC: 'B',
    ETH: 'E',
    SOL: 'S',
    BNB: 'N',
    XRP: 'X',
    ADA: 'A',
    DOGE: 'D',
    DOT: 'P',
    AVAX: 'AV',
    MATIC: 'M',
  };
  return icons[base] || base.substring(0, 2);
}

function getSymbolColor(symbol: string): string {
  const base = symbol.split('/')[0];
  const colors: Record<string, string> = {
    BTC: 'bg-orange-500',
    ETH: 'bg-blue-500',
    SOL: 'bg-purple-500',
    BNB: 'bg-yellow-500',
    XRP: 'bg-gray-500',
    ADA: 'bg-blue-600',
    DOGE: 'bg-yellow-400',
    DOT: 'bg-pink-500',
    AVAX: 'bg-red-500',
    MATIC: 'bg-purple-600',
  };
  return colors[base] || 'bg-gray-500';
}

// ============================================================================
// TICKER ITEM COMPONENT
// ============================================================================

function TickerItem({
  symbol,
  price,
  previousPrice,
  compact = false,
  showChange = true,
  showVolume = false,
}: TickerItemProps) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  // Flash animation when price changes
  useEffect(() => {
    if (price?.price && previousPrice !== null) {
      if (price.price > previousPrice) {
        setFlash('up');
      } else if (price.price < previousPrice) {
        setFlash('down');
      }

      const timer = setTimeout(() => setFlash(null), 500);
      return () => clearTimeout(timer);
    }
  }, [price?.price, previousPrice]);

  const change = price?.change24h ?? 0;
  const isPositive = change >= 0;
  const baseSymbol = symbol.split('/')[0];

  if (compact) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors duration-300',
          flash === 'up' && 'bg-green-500/20',
          flash === 'down' && 'bg-red-500/20',
          !flash && 'bg-muted/50'
        )}
      >
        <span className="font-medium text-sm">{baseSymbol}</span>
        <span className="font-mono text-sm">
          ${price?.price ? formatPrice(price.price) : '--'}
        </span>
        {showChange && (
          <span
            className={cn(
              'text-xs font-medium',
              isPositive ? 'text-green-500' : 'text-red-500'
            )}
          >
            {price?.change24h !== undefined ? formatChange(change) : '--'}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 rounded-lg transition-all duration-300',
        flash === 'up' && 'bg-green-500/10 ring-1 ring-green-500/30',
        flash === 'down' && 'bg-red-500/10 ring-1 ring-red-500/30',
        !flash && 'bg-muted/30 hover:bg-muted/50'
      )}
    >
      {/* Symbol Icon */}
      <div
        className={cn(
          'w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm',
          getSymbolColor(symbol)
        )}
      >
        {getSymbolIcon(symbol)}
      </div>

      {/* Symbol & Price */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{baseSymbol}</span>
          <span className="text-xs text-muted-foreground">/USDT</span>
        </div>
        <div className="font-mono text-lg font-bold">
          ${price?.price ? formatPrice(price.price) : '--'}
        </div>
      </div>

      {/* Change & Volume */}
      <div className="text-right">
        {showChange && (
          <div className="flex items-center justify-end gap-1">
            {isPositive ? (
              <TrendingUp className="w-4 h-4 text-green-500" />
            ) : (
              <TrendingDown className="w-4 h-4 text-red-500" />
            )}
            <span
              className={cn(
                'font-medium text-sm',
                isPositive ? 'text-green-500' : 'text-red-500'
              )}
            >
              {price?.change24h !== undefined ? formatChange(change) : '--'}
            </span>
          </div>
        )}
        {showVolume && price?.volume24h && (
          <div className="text-xs text-muted-foreground mt-0.5">
            Vol: ${formatVolume(price.volume24h)}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN PRICE TICKER COMPONENT
// ============================================================================

export function PriceTicker({
  symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'],
  compact = false,
  showChange = true,
  showVolume = false,
  className,
}: PriceTickerProps) {
  const { connected, prices } = useWebSocket();
  const subscribedPrices = usePriceSubscription(symbols);

  // Track previous prices for flash animation
  const [previousPrices, setPreviousPrices] = useState<Record<string, number>>({});

  // Update previous prices when current prices change
  useEffect(() => {
    const newPrevious: Record<string, number> = {};
    for (const symbol of symbols) {
      const currentPrice = prices[symbol]?.price || subscribedPrices[symbol]?.price;
      if (currentPrice && previousPrices[symbol] !== currentPrice) {
        newPrevious[symbol] = previousPrices[symbol] || currentPrice;
      } else {
        newPrevious[symbol] = previousPrices[symbol] || 0;
      }
    }
    setPreviousPrices(newPrevious);
  }, [prices, subscribedPrices, symbols]);

  // Merge prices from both sources
  const mergedPrices = useMemo(() => {
    const result: Record<string, WSPriceData | undefined> = {};
    for (const symbol of symbols) {
      result[symbol] = prices[symbol] || subscribedPrices[symbol];
    }
    return result;
  }, [prices, subscribedPrices, symbols]);

  if (compact) {
    return (
      <div className={cn('flex items-center gap-2 flex-wrap', className)}>
        {/* Connection indicator */}
        <Badge
          variant={connected ? 'default' : 'destructive'}
          className="flex items-center gap-1 text-xs"
        >
          {connected ? (
            <Wifi className="w-3 h-3" />
          ) : (
            <WifiOff className="w-3 h-3" />
          )}
          {connected ? 'Live' : 'Offline'}
        </Badge>

        {/* Price tickers */}
        {symbols.map((symbol) => (
          <TickerItem
            key={symbol}
            symbol={symbol}
            price={mergedPrices[symbol]}
            previousPrice={previousPrices[symbol] || null}
            compact
            showChange={showChange}
          />
        ))}
      </div>
    );
  }

  return (
    <Card className={className}>
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium text-sm">Live Prices</span>
          </div>
          <Badge
            variant={connected ? 'default' : 'destructive'}
            className="flex items-center gap-1 text-xs"
          >
            {connected ? (
              <>
                <Wifi className="w-3 h-3" />
                Connected
              </>
            ) : (
              <>
                <WifiOff className="w-3 h-3" />
                Reconnecting...
              </>
            )}
          </Badge>
        </div>

        {/* Price Grid */}
        <div className="grid gap-2">
          {symbols.map((symbol) => (
            <TickerItem
              key={symbol}
              symbol={symbol}
              price={mergedPrices[symbol]}
              previousPrice={previousPrices[symbol] || null}
              showChange={showChange}
              showVolume={showVolume}
            />
          ))}
        </div>

        {/* Last update time */}
        {Object.keys(mergedPrices).length > 0 && (
          <div className="mt-3 text-xs text-muted-foreground text-center">
            Updates via WebSocket
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// MINI TICKER (for header bar)
// ============================================================================

export function MiniPriceTicker({
  symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
}: {
  symbols?: string[];
}) {
  const { prices, connected } = useWebSocket();

  return (
    <div className="flex items-center gap-4 text-sm">
      {!connected && (
        <Badge variant="outline" className="text-xs">
          <WifiOff className="w-3 h-3 mr-1" />
          Offline
        </Badge>
      )}
      {symbols.map((symbol) => {
        const price = prices[symbol];
        const baseSymbol = symbol.split('/')[0];
        const change = price?.change24h ?? 0;
        const isPositive = change >= 0;

        return (
          <div key={symbol} className="flex items-center gap-1.5">
            <span className="font-medium text-muted-foreground">{baseSymbol}</span>
            <span className="font-mono">
              ${price?.price ? formatPrice(price.price) : '--'}
            </span>
            <span
              className={cn(
                'text-xs',
                isPositive ? 'text-green-500' : 'text-red-500'
              )}
            >
              {price?.change24h !== undefined ? formatChange(change) : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default PriceTicker;
