'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Badge,
  Progress,
} from '@cryonix/ui';
import { CorrelationMatrix } from './risk/CorrelationMatrix';

interface RiskStatus {
  // ... existing fields ...
  portfolio: {
    total_capital: number;
    available_capital: number;
    open_positions: number;
  };
  daily: {
    pnl: number;
    limit: number;
    remaining: number;
    trades: number;
    max_trades: number;
  };
  weekly: {
    pnl: number;
    limit: number;
    remaining: number;
  };
  circuit_breaker: {
    active: boolean;
    reason: string;
    until: string | null;
  };
  consecutive_losses: number;
  limits: {
    max_daily_loss_pct: number;
    max_weekly_loss_pct: number;
    max_position_size_pct: number;
    min_confidence: number;
  };
  correlations?: Record<string, Record<string, number>>;
}

export function RiskDashboard() {
  const [status, setStatus] = useState<RiskStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/risk');
      const data = await res.json();
      if (data.status === 'ok') {
        setStatus(data.risk);
        setError(null);
      } else {
        setError(data.error || 'Failed to fetch risk status');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  const resetCircuitBreaker = async () => {
    try {
      await fetch('/api/risk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset-circuit-breaker' }),
      });
      fetchStatus();
    } catch (err) {
      console.error('Failed to reset circuit breaker:', err);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Risk Manager</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Risk Manager</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-red-500">{error}</div>
          <Button onClick={fetchStatus} variant="outline" className="mt-2">Retry</Button>
        </CardContent>
      </Card>
    );
  }

  if (!status) return null;

  const dailyUsedPct = Math.abs(status.daily.pnl / status.daily.limit) * 100;
  const weeklyUsedPct = Math.abs(status.weekly.pnl / status.weekly.limit) * 100;
  const tradeUsedPct = (status.daily.trades / status.daily.max_trades) * 100;

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              Risk Manager
              {status.circuit_breaker.active && (
                <Badge variant="destructive">CIRCUIT BREAKER ACTIVE</Badge>
              )}
            </CardTitle>
            <CardDescription>Portfolio protection and risk limits</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={fetchStatus}>
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Circuit Breaker Alert */}
        {status.circuit_breaker.active && (
          <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <div className="flex justify-between items-center">
              <div>
                <div className="font-semibold text-red-500">Trading Paused</div>
                <div className="text-sm text-muted-foreground">{status.circuit_breaker.reason}</div>
                {status.circuit_breaker.until && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Until: {new Date(status.circuit_breaker.until).toLocaleString()}
                  </div>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={resetCircuitBreaker}>
                Reset (Admin)
              </Button>
            </div>
          </div>
        )}

        {/* Portfolio Summary */}
        <div className="grid grid-cols-3 gap-4">
          <div className="p-3 bg-muted rounded-lg">
            <div className="text-sm text-muted-foreground">Total Capital</div>
            <div className="text-xl font-bold">${status.portfolio.total_capital.toLocaleString()}</div>
          </div>
          <div className="p-3 bg-muted rounded-lg">
            <div className="text-sm text-muted-foreground">Available</div>
            <div className="text-xl font-bold">${status.portfolio.available_capital.toLocaleString()}</div>
          </div>
          <div className="p-3 bg-muted rounded-lg">
            <div className="text-sm text-muted-foreground">Open Positions</div>
            <div className="text-xl font-bold">{status.portfolio.open_positions}</div>
          </div>
        </div>

        {/* Daily Limits */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Daily Loss Limit ({(status.limits.max_daily_loss_pct * 100).toFixed(0)}%)</span>
            <span className={status.daily.pnl < 0 ? 'text-red-500' : 'text-green-500'}>
              ${status.daily.pnl.toFixed(2)} / ${Math.abs(status.daily.limit).toFixed(2)}
            </span>
          </div>
          <Progress value={Math.min(dailyUsedPct, 100)} className="h-2" />
          {dailyUsedPct > 80 && (
            <div className="text-xs text-yellow-500">Warning: Approaching daily limit</div>
          )}
        </div>

        {/* Weekly Limits */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Weekly Loss Limit ({(status.limits.max_weekly_loss_pct * 100).toFixed(0)}%)</span>
            <span className={status.weekly.pnl < 0 ? 'text-red-500' : 'text-green-500'}>
              ${status.weekly.pnl.toFixed(2)} / ${Math.abs(status.weekly.limit).toFixed(2)}
            </span>
          </div>
          <Progress value={Math.min(weeklyUsedPct, 100)} className="h-2" />
        </div>

        {/* Trade Count */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Daily Trades</span>
            <span>{status.daily.trades} / {status.daily.max_trades}</span>
          </div>
          <Progress value={tradeUsedPct} className="h-2" />
        </div>

        {/* Consecutive Losses */}
        <div className="flex justify-between items-center p-3 bg-muted rounded-lg">
          <span className="text-sm">Consecutive Losses</span>
          <div className="flex items-center gap-2">
            <span className={`text-xl font-bold ${status.consecutive_losses >= 2 ? 'text-yellow-500' : ''}`}>
              {status.consecutive_losses}
            </span>
            <span className="text-sm text-muted-foreground">/ 3 max</span>
          </div>
        </div>

        {/* Correlation Matrix */}
        {status.correlations && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Portfolio Correlation</h3>
            <CorrelationMatrix correlations={status.correlations} />
          </div>
        )}

        {/* Limits Summary */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="p-2 bg-muted/50 rounded">
            <div className="text-muted-foreground">Max Position Size</div>
            <div className="font-semibold">{(status.limits.max_position_size_pct * 100).toFixed(0)}%</div>
          </div>
          <div className="p-2 bg-muted/50 rounded">
            <div className="text-muted-foreground">Min Confidence</div>
            <div className="font-semibold">{(status.limits.min_confidence * 100).toFixed(0)}%</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
