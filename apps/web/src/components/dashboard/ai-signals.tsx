"use client";

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Badge, Progress, Button } from '@cryonix/ui';
import { TrendingUp, TrendingDown, Minus, RefreshCw, Loader2, Zap } from 'lucide-react';
import { useAnalysis, useMultipleTickers } from '@/hooks/useMarketData';
import { useWebSocket } from '@/hooks/use-websocket';
import { SignalCard } from '@/components/signals/SignalCard';
import type { FullValidationResponse } from '@/components/signals/types';
import type { TradingSignal } from '@cryonix/types';


interface Signal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  entry: number;
  target: number;
  stopLoss: number;
  reasoning: string[];
  summary: string;
  price?: number;
  change24h?: number;
}

export function AISignals() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [validating, setValidating] = useState<string | null>(null);
  const [validationResults, setValidationResults] = useState<Record<string, FullValidationResponse>>({});
  const [filterAction, setFilterAction] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<string>('NEWEST');

  const { tickers } = useMultipleTickers(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  const { lastMessage } = useWebSocket();

  // Listen for real-time signals
  useEffect(() => {
    if (lastMessage?.type === 'BROADCAST' && lastMessage.data?.type === 'NEW_SIGNAL') {
      const signalData = lastMessage.data.data;
      const newSignal: Signal = {
        symbol: signalData.symbol,
        action: signalData.side,
        confidence: signalData.confidence,
        entry: 0,
        target: 0,
        stopLoss: 0,
        reasoning: [signalData.reasoning],
        summary: 'New signal detected by Orchestrator',
      };

      setSignals(prev => {
        const filtered = prev.filter(s => s.symbol !== newSignal.symbol);
        return [newSignal, ...filtered];
      });
    }
  }, [lastMessage]);

  const analyzeSymbol = async (symbol: string) => {
    setAnalyzing(symbol);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      const data = await res.json();

      if (data.success && data.data.analysis) {
        const newSignal: Signal = {
          symbol,
          action: data.data.analysis.signal || 'HOLD',
          confidence: (data.data.analysis.confidence || 50) / 100,
          entry: data.data.analysis.entry || data.data.marketData.price,
          target: data.data.analysis.target || 0,
          stopLoss: data.data.analysis.stopLoss || 0,
          reasoning: data.data.analysis.reasoning || [],
          summary: data.data.analysis.summary || '',
          price: data.data.marketData.price,
          change24h: data.data.marketData.change24h,
        };

        setSignals(prev => {
          const filtered = prev.filter(s => s.symbol !== symbol);
          return [newSignal, ...filtered];
        });

        // Clear previous validation if any
        setValidationResults(prev => {
          const next = { ...prev };
          delete next[symbol];
          return next;
        });
      }
    } catch (error) {
      console.error('Analysis error:', error);
    } finally {
      setAnalyzing(null);
    }
  };

  const handleValidate = async (signal: TradingSignal) => {
    setValidating(signal.symbol);
    try {
      const res = await fetch('/api/validate-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signal: {
            ...signal,
            entryPrice: signal.entry_price,
            targetPrice: signal.target_price,
            stopLoss: signal.stop_loss
          }
        }),
      });
      const data = await res.json();

      if (data.success) {
        setValidationResults(prev => ({
          ...prev,
          [signal.symbol]: data as FullValidationResponse
        }));
      }
    } catch (error) {
      console.error('Validation error:', error);
    } finally {
      setValidating(null);
    }
  };

  const analyzeAll = async () => {
    const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    for (const symbol of symbols) {
      await analyzeSymbol(symbol);
    }
  };

  // Filter and sort signals
  const filteredSignals = signals
    .filter(s => filterAction === 'ALL' || s.action === filterAction)
    .sort((a, b) => {
      if (sortBy === 'CONFIDENCE') {
        return b.confidence - a.confidence;
      }
      return 0; // Default (Newest) logic handled by insertion order
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-yellow-500" />
            AI Signals (GROK)
          </span>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono">{filteredSignals.length}</Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={analyzeAll}
              disabled={analyzing !== null}
            >
              {analyzing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              <span className="ml-1">Analyze All</span>
            </Button>
          </div>
        </CardTitle>

        {/* Filters and Sort */}
        <div className="flex gap-2 mt-4">
          <div className="flex bg-muted rounded-lg p-1">
            {['ALL', 'BUY', 'SELL', 'WAIT'].map(action => (
              <button
                key={action}
                onClick={() => setFilterAction(action)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${filterAction === action
                    ? 'bg-background shadow-sm font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                  }`}
              >
                {action}
              </button>
            ))}
          </div>

          <select
            className="bg-muted text-xs rounded-md px-2 border-none focus:ring-1 focus:ring-primary"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="NEWEST">Newest</option>
            <option value="CONFIDENCE">Confidence</option>
          </select>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">

        {/* Quick analyze buttons */}
        {signals.length === 0 && (
          <div className="text-center py-4">
            <p className="text-sm text-muted-foreground mb-3">
              Click to get AI analysis from GROK
            </p>
            <div className="flex gap-2 justify-center flex-wrap">
              {['BTC/USDT', 'ETH/USDT', 'SOL/USDT'].map((symbol) => (
                <Button
                  key={symbol}
                  size="sm"
                  variant="outline"
                  onClick={() => analyzeSymbol(symbol)}
                  disabled={analyzing !== null}
                >
                  {analyzing === symbol ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : null}
                  {symbol.split('/')[0]}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Signals list */}
        {filteredSignals.map((signal) => {
          // Adapt to TradingSignal type for SignalCard
          const tradingSignal: TradingSignal = {
            id: crypto.randomUUID(),
            timestamp: new Date(),
            symbol: signal.symbol,
            action: signal.action === 'HOLD' ? 'WAIT' : signal.action,
            confidence: signal.confidence,
            pattern: 'ai_analysis',
            reasoning: signal.reasoning,
            entry_price: signal.entry,
            target_price: signal.target,
            stop_loss: signal.stopLoss,
            agent_id: 'grok_assistant'
          };

          return (
            <div key={signal.symbol} className="space-y-2">
              <SignalCard
                signal={tradingSignal}
                validationData={validationResults[signal.symbol]}
                onValidate={handleValidate}
                validating={validating === signal.symbol}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
