"use client";

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Button, Slider } from '@cryonix/ui';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useMarketData, usePortfolio } from '@/hooks/useMarketData';

export function QuickTrade() {
  const [selectedSymbol, setSelectedSymbol] = useState('BTC/USDT');
  const [riskPercent, setRiskPercent] = useState(2);
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [isExecuting, setIsExecuting] = useState(false);
  const [tradeResult, setTradeResult] = useState<{ success: boolean; message: string } | null>(null);

  const { ticker, loading: tickerLoading } = useMarketData(selectedSymbol, 5000);
  const { portfolio } = usePortfolio();

  // Calculate position size based on risk
  const currentPrice = ticker?.price || 0;
  const portfolioValue = portfolio?.totalValue || 0;
  const riskAmount = portfolioValue * (riskPercent / 100);

  // Assuming 2% stop loss for position sizing
  const stopLossPercent = 2;
  const positionValue = riskAmount / (stopLossPercent / 100);
  const positionSize = currentPrice > 0 ? positionValue / currentPrice : 0;

  // Calculate targets
  const stopLoss = currentPrice * (1 - stopLossPercent / 100);
  const target = currentPrice * 1.03; // 3% target
  const potentialLoss = riskAmount;
  const potentialProfit = positionValue * 0.03;
  const rrRatio = potentialProfit / potentialLoss;

  const executeTrade = async (side: 'buy' | 'sell') => {
    if (positionSize <= 0) {
      setTradeResult({ success: false, message: 'Invalid position size' });
      return;
    }

    setIsExecuting(true);
    setTradeResult(null);

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbol,
          side,
          type: orderType,
          amount: positionSize,
          stopLoss: side === 'buy' ? stopLoss : undefined,
          takeProfit: side === 'buy' ? target : undefined,
        }),
      });

      const data = await res.json();

      if (data.success) {
        setTradeResult({
          success: true,
          message: `${side.toUpperCase()} order executed! ID: ${data.data.order.id}`,
        });
      } else {
        setTradeResult({ success: false, message: data.error });
      }
    } catch (error: any) {
      setTradeResult({ success: false, message: error.message });
    } finally {
      setIsExecuting(false);
    }
  };

  // Clear trade result after 5 seconds
  useEffect(() => {
    if (tradeResult) {
      const timer = setTimeout(() => setTradeResult(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [tradeResult]);

  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>⚡ Quick Trade</span>
          <span className="text-xs font-normal text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">
            LIVE
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Symbol selector */}
        <div>
          <label className="text-sm font-medium mb-2 block">Asset</label>
          <div className="flex gap-2 flex-wrap">
            {symbols.map((sym) => (
              <button
                key={sym}
                onClick={() => setSelectedSymbol(sym)}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  selectedSymbol === sym
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80'
                }`}
              >
                {sym.split('/')[0]}
              </button>
            ))}
          </div>
        </div>

        {/* Current price */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Current Price</span>
          <div className="text-right">
            {tickerLoading && !ticker ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <span className="text-2xl font-bold">
                  ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
                {ticker?.change24h !== undefined && (
                  <span className={`text-sm ml-2 ${ticker.change24h >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {ticker.change24h >= 0 ? '+' : ''}{ticker.change24h.toFixed(2)}%
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Price levels */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="bg-muted rounded p-2">
            <div className="text-muted-foreground">Entry</div>
            <div className="font-semibold mt-1">${currentPrice.toLocaleString()}</div>
          </div>
          <div className="bg-muted rounded p-2">
            <div className="text-muted-foreground">Target (+3%)</div>
            <div className="font-semibold mt-1 text-green-500">${target.toLocaleString()}</div>
          </div>
          <div className="bg-muted rounded p-2">
            <div className="text-muted-foreground">Stop (-2%)</div>
            <div className="font-semibold mt-1 text-red-500">${stopLoss.toLocaleString()}</div>
          </div>
        </div>

        {/* Risk slider */}
        <div>
          <label className="text-sm font-medium mb-2 block">
            Position Risk: {riskPercent}% of portfolio
          </label>
          <Slider
            value={[riskPercent]}
            onValueChange={(val) => setRiskPercent(val[0])}
            max={5}
            min={0.5}
            step={0.5}
            className="mb-2"
          />
          <div className="text-xs text-muted-foreground">
            Position Size: {positionSize.toFixed(6)} {selectedSymbol.split('/')[0]}
            <span className="ml-2">(~${positionValue.toFixed(2)})</span>
          </div>
        </div>

        {/* Risk/Reward summary */}
        <div className="bg-muted rounded-lg p-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Max Loss:</span>
            <span className="text-red-500 font-semibold">-${potentialLoss.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Potential Profit:</span>
            <span className="text-green-500 font-semibold">+${potentialProfit.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">R:R Ratio:</span>
            <span className="font-semibold">1:{rrRatio.toFixed(2)}</span>
          </div>
        </div>

        {/* Trade result message */}
        {tradeResult && (
          <div className={`rounded-lg p-3 flex items-center gap-2 ${
            tradeResult.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
          }`}>
            {tradeResult.success ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
            <span className="text-sm">{tradeResult.message}</span>
          </div>
        )}

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            className="bg-green-600 hover:bg-green-700 w-full"
            onClick={() => executeTrade('buy')}
            disabled={isExecuting || positionSize <= 0}
          >
            {isExecuting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            BUY LONG
          </Button>
          <Button
            className="bg-red-600 hover:bg-red-700 w-full"
            onClick={() => executeTrade('sell')}
            disabled={isExecuting || positionSize <= 0}
          >
            {isExecuting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            SELL SHORT
          </Button>
        </div>

        {/* Warning */}
        <p className="text-xs text-yellow-500 text-center">
          Warning: This executes real trades on Binance!
        </p>
      </CardContent>
    </Card>
  );
}
