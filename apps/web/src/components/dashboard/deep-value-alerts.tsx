"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@cryonix/ui';
import { AlertTriangle, TrendingDown, Activity, Zap } from 'lucide-react';

interface DeepValueSignal {
  symbol: string;
  confidence: number;
  reason: string;
  drawdown_pct: number;
  drop_velocity: number;
  volume_ratio: number;
  rsi_15m: number;
  rsi_1h: number | null;
  rsi_4h: number | null;
  recent_high: number;
  entry_price: number;
  timestamp?: string;
}

export function DeepValueAlerts() {
  const [alerts, setAlerts] = useState<DeepValueSignal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAlerts() {
      try {
        const res = await fetch('/api/signals?pattern=DEEP_VALUE_CRASH&limit=10');
        if (res.ok) {
          const data = await res.json();
          setAlerts(data.signals || []);
        }
      } catch (e) {
        console.error('Failed to fetch deep value alerts:', e);
      } finally {
        setLoading(false);
      }
    }

    fetchAlerts();
    const interval = setInterval(fetchAlerts, 30_000);
    return () => clearInterval(interval);
  }, []);

  function getRsiColor(rsi: number | null): string {
    if (rsi === null) return 'text-muted-foreground';
    if (rsi < 25) return 'text-red-500';
    if (rsi < 35) return 'text-orange-500';
    if (rsi < 50) return 'text-yellow-500';
    return 'text-muted-foreground';
  }

  function getSeverity(drawdown: number): string {
    if (drawdown >= 18) return 'EXTREME';
    if (drawdown >= 12) return 'SEVERE';
    return 'MODERATE';
  }

  function getSeverityColor(drawdown: number): string {
    if (drawdown >= 18) return 'bg-red-500/20 text-red-400 border-red-500/30';
    if (drawdown >= 12) return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-yellow-500" />
            Deep Value Alerts
          </span>
          <Badge variant="outline">{alerts.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}

        {!loading && alerts.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-4">
            <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No deep value crashes detected</p>
            <p className="text-xs mt-1">Monitoring for 8%+ drawdowns across 15 pairs</p>
          </div>
        )}

        {alerts.map((alert, i) => (
          <div
            key={`${alert.symbol}-${i}`}
            className="rounded-lg border border-border bg-card p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm">{alert.symbol}</span>
              <Badge className={getSeverityColor(alert.drawdown_pct)}>
                {getSeverity(alert.drawdown_pct)} -{alert.drawdown_pct.toFixed(1)}%
              </Badge>
            </div>

            {/* Crash metrics */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="flex items-center gap-1">
                <TrendingDown className="h-3 w-3 text-red-500" />
                <span className="text-muted-foreground">Velocity:</span>
                <span className="font-mono">{alert.drop_velocity.toFixed(1)}%/h</span>
              </div>
              <div className="flex items-center gap-1">
                <Activity className="h-3 w-3 text-blue-500" />
                <span className="text-muted-foreground">Volume:</span>
                <span className="font-mono">{alert.volume_ratio.toFixed(1)}x</span>
              </div>
              <div>
                <span className="text-muted-foreground">Conf:</span>
                <span className="font-mono ml-1">{(alert.confidence * 100).toFixed(0)}%</span>
              </div>
            </div>

            {/* Multi-TF RSI */}
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">RSI:</span>
              <span className={getRsiColor(alert.rsi_15m)}>
                15m: {alert.rsi_15m.toFixed(0)}
              </span>
              <span className={getRsiColor(alert.rsi_1h)}>
                1h: {alert.rsi_1h?.toFixed(0) ?? '-'}
              </span>
              <span className={getRsiColor(alert.rsi_4h)}>
                4h: {alert.rsi_4h?.toFixed(0) ?? '-'}
              </span>
            </div>

            {/* Price info */}
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>High: ${alert.recent_high.toLocaleString()}</span>
              <span>Entry: ${alert.entry_price.toLocaleString()}</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
