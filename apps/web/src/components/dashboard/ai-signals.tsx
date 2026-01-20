"use client";

import { Card, CardContent, CardHeader, CardTitle, Badge, Progress } from '@cryonix/ui';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export function AISignals() {
  // Mock data - will be replaced with real WebSocket data
  const signals = [
    {
      id: '1',
      symbol: 'BTC/USDT',
      action: 'BUY' as const,
      confidence: 0.87,
      pattern: 'Bollinger Squeeze',
      reasoning: [
        'Bollinger Bands squeeze detected',
        'Volume spike above average',
        'RSI neutral at 52',
      ],
      targetPrice: 98500,
      stopLoss: 92000,
    },
    {
      id: '2',
      symbol: 'ETH/USDT',
      action: 'BUY' as const,
      confidence: 0.75,
      pattern: 'Triangle Breakout',
      reasoning: [
        'Ascending triangle formation',
        'Higher lows on 4H chart',
        'Resistance at $3,450',
      ],
      targetPrice: 3650,
      stopLoss: 3200,
    },
    {
      id: '3',
      symbol: 'SOL/USDT',
      action: 'WAIT' as const,
      confidence: 0.45,
      pattern: 'Consolidation',
      reasoning: [
        'Price consolidating',
        'Low volume',
        'Waiting for clear direction',
      ],
      targetPrice: 185,
      stopLoss: 165,
    },
  ];

  const getActionColor = (action: string) => {
    switch (action) {
      case 'BUY':
        return 'bg-green-500';
      case 'SELL':
        return 'bg-red-500';
      default:
        return 'bg-yellow-500';
    }
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case 'BUY':
        return <TrendingUp className="h-3 w-3" />;
      case 'SELL':
        return <TrendingDown className="h-3 w-3" />;
      default:
        return <Minus className="h-3 w-3" />;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>🤖 AI Signals</span>
          <Badge variant="outline" className="font-mono">{signals.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {signals.map((signal) => (
          <div
            key={signal.id}
            className="rounded-lg border border-border bg-card p-3 hover:bg-accent/50 transition-colors cursor-pointer"
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-sm">{signal.symbol}</span>
              <div className={`${getActionColor(signal.action)} px-2 py-1 rounded-full flex items-center gap-1 text-white text-xs font-semibold`}>
                {getActionIcon(signal.action)}
                {signal.action}
              </div>
            </div>

            {/* Pattern */}
            <p className="text-xs text-muted-foreground mb-2">{signal.pattern}</p>

            {/* Confidence */}
            <div className="mb-2">
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Confidence</span>
                <span className="font-semibold">{(signal.confidence * 100).toFixed(0)}%</span>
              </div>
              <Progress value={signal.confidence * 100} className="h-1.5" />
            </div>

            {/* Reasoning */}
            <div className="text-xs text-muted-foreground space-y-1 mb-2">
              {signal.reasoning.map((reason, idx) => (
                <div key={idx}>• {reason}</div>
              ))}
            </div>

            {/* Prices */}
            <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-border">
              <div>
                <span className="text-muted-foreground">Target:</span>
                <span className="text-green-500 ml-1 font-semibold">${signal.targetPrice.toLocaleString()}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Stop:</span>
                <span className="text-red-500 ml-1 font-semibold">${signal.stopLoss.toLocaleString()}</span>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
