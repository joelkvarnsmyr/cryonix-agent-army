'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  Progress,
} from '@cryonix/ui';
import {
  Shield,
  ShieldAlert,
  ShieldOff,
  AlertTriangle,
  AlertOctagon,
  TrendingDown,
  Activity,
  RefreshCw,
  Pause,
  Play,
  Zap,
} from 'lucide-react';

interface RiskLimits {
  max_daily_loss_pct: number;
  max_weekly_loss_pct: number;
  max_position_size_pct: number;
  max_open_positions: number;
  min_confidence: number;
  max_correlation: number;
}

interface RiskMetrics {
  daily_pnl: number;
  daily_limit: number;
  daily_used_pct: number;
  weekly_pnl: number;
  weekly_limit: number;
  weekly_used_pct: number;
  open_positions: number;
  max_positions: number;
  total_exposure: number;
  max_exposure: number;
  consecutive_losses: number;
  max_consecutive_losses: number;
}

interface CircuitBreaker {
  active: boolean;
  reason: string;
  triggered_at?: string;
  auto_reset_at?: string;
  severity: 'warning' | 'critical' | 'emergency';
}

interface RiskMonitorProps {
  metrics?: RiskMetrics;
  limits?: RiskLimits;
  circuitBreaker?: CircuitBreaker;
  onRefresh?: () => void;
  onResetCircuitBreaker?: () => Promise<void>;
  onPauseTrading?: () => Promise<void>;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

export function RiskMonitor({
  metrics: externalMetrics,
  limits: externalLimits,
  circuitBreaker: externalCircuitBreaker,
  onRefresh,
  onResetCircuitBreaker,
  onPauseTrading,
  autoRefresh = true,
  refreshInterval = 10000,
}: RiskMonitorProps) {
  const [metrics, setMetrics] = useState<RiskMetrics | null>(externalMetrics || null);
  const [limits, setLimits] = useState<RiskLimits | null>(externalLimits || null);
  const [circuitBreaker, setCircuitBreaker] = useState<CircuitBreaker | null>(
    externalCircuitBreaker || null
  );
  const [loading, setLoading] = useState(!externalMetrics);
  const [resetting, setResetting] = useState(false);

  // Fetch risk data if not provided externally
  useEffect(() => {
    if (!externalMetrics) {
      fetchRiskData();
    }

    // Auto refresh
    if (autoRefresh && !externalMetrics) {
      const interval = setInterval(fetchRiskData, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [externalMetrics, autoRefresh, refreshInterval]);

  // Update internal state when external data changes
  useEffect(() => {
    if (externalMetrics) setMetrics(externalMetrics);
    if (externalLimits) setLimits(externalLimits);
    if (externalCircuitBreaker) setCircuitBreaker(externalCircuitBreaker);
  }, [externalMetrics, externalLimits, externalCircuitBreaker]);

  const fetchRiskData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/risk');
      const data = await res.json();
      if (data.status === 'ok') {
        setMetrics({
          daily_pnl: data.risk.daily.pnl,
          daily_limit: data.risk.daily.limit,
          daily_used_pct: Math.abs(data.risk.daily.pnl / data.risk.daily.limit) * 100,
          weekly_pnl: data.risk.weekly.pnl,
          weekly_limit: data.risk.weekly.limit,
          weekly_used_pct: Math.abs(data.risk.weekly.pnl / data.risk.weekly.limit) * 100,
          open_positions: data.risk.portfolio.open_positions,
          max_positions: data.risk.daily.max_trades,
          total_exposure: data.risk.portfolio.total_capital - data.risk.portfolio.available_capital,
          max_exposure: data.risk.portfolio.total_capital,
          consecutive_losses: data.risk.consecutive_losses,
          max_consecutive_losses: 3,
        });
        setLimits(data.risk.limits);
        setCircuitBreaker(data.risk.circuit_breaker);
      }
    } catch (error) {
      console.error('Failed to fetch risk data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => {
    if (onRefresh) {
      onRefresh();
    } else {
      fetchRiskData();
    }
  };

  const handleResetCircuitBreaker = async () => {
    setResetting(true);
    try {
      if (onResetCircuitBreaker) {
        await onResetCircuitBreaker();
      } else {
        await fetch('/api/risk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reset-circuit-breaker' }),
        });
        fetchRiskData();
      }
    } catch (error) {
      console.error('Failed to reset circuit breaker:', error);
    } finally {
      setResetting(false);
    }
  };

  const getProgressColor = (usedPct: number) => {
    if (usedPct >= 90) return 'bg-red-500';
    if (usedPct >= 70) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  const getStatusIcon = () => {
    if (circuitBreaker?.active) {
      return circuitBreaker.severity === 'emergency' ? (
        <ShieldOff className="h-5 w-5 text-red-500" />
      ) : (
        <ShieldAlert className="h-5 w-5 text-yellow-500" />
      );
    }
    return <Shield className="h-5 w-5 text-green-500" />;
  };

  const getCircuitBreakerBadge = () => {
    if (!circuitBreaker?.active) {
      return <Badge className="bg-green-500 text-white">ACTIVE</Badge>;
    }
    switch (circuitBreaker.severity) {
      case 'emergency':
        return <Badge variant="destructive">EMERGENCY STOP</Badge>;
      case 'critical':
        return <Badge variant="destructive">HALTED</Badge>;
      case 'warning':
        return <Badge className="bg-yellow-500 text-black">PAUSED</Badge>;
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Risk Monitor
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-2">
            {getStatusIcon()}
            <div>
              <CardTitle className="flex items-center gap-2">
                Risk Monitor
                {getCircuitBreakerBadge()}
              </CardTitle>
              <CardDescription>Real-time portfolio risk tracking</CardDescription>
            </div>
          </div>
          <Button variant="outline" size="icon" onClick={handleRefresh} aria-label="Refresh risk monitor">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Circuit Breaker Alert */}
        {circuitBreaker?.active && (
          <div
            className={`p-4 rounded-lg border ${
              circuitBreaker.severity === 'emergency'
                ? 'bg-red-500/10 border-red-500/30'
                : circuitBreaker.severity === 'critical'
                ? 'bg-red-500/10 border-red-500/30'
                : 'bg-yellow-500/10 border-yellow-500/30'
            }`}
          >
            <div className="flex items-start gap-3">
              {circuitBreaker.severity === 'emergency' ? (
                <AlertOctagon className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
              )}
              <div className="flex-1">
                <div
                  className={`font-semibold ${
                    circuitBreaker.severity === 'emergency' || circuitBreaker.severity === 'critical'
                      ? 'text-red-500'
                      : 'text-yellow-500'
                  }`}
                >
                  {circuitBreaker.severity === 'emergency'
                    ? 'Emergency Stop Active'
                    : circuitBreaker.severity === 'critical'
                    ? 'Trading Halted'
                    : 'Trading Paused'}
                </div>
                <div className="text-sm text-muted-foreground mt-1">{circuitBreaker.reason}</div>
                {circuitBreaker.auto_reset_at && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Auto-reset at: {new Date(circuitBreaker.auto_reset_at).toLocaleString()}
                  </div>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetCircuitBreaker}
                disabled={resetting}
              >
                {resetting ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  'Reset'
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Daily Loss Progress */}
        {metrics && (
          <div className="space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span className="flex items-center gap-2">
                <TrendingDown className="h-4 w-4" />
                Daily Loss Limit
              </span>
              <span className={metrics.daily_pnl < 0 ? 'text-red-500' : 'text-green-500'}>
                ${metrics.daily_pnl.toFixed(2)} / ${Math.abs(metrics.daily_limit).toFixed(2)}
              </span>
            </div>
            <div className="relative">
              <Progress
                value={Math.min(metrics.daily_used_pct, 100)}
                className="h-3"
              />
              {metrics.daily_used_pct >= 80 && (
                <div className="absolute right-0 top-0 -mt-1">
                  <AlertTriangle className="h-4 w-4 text-yellow-500" />
                </div>
              )}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0%</span>
              <span className={metrics.daily_used_pct >= 80 ? 'text-yellow-500 font-medium' : ''}>
                {metrics.daily_used_pct.toFixed(1)}% used
              </span>
              <span>100%</span>
            </div>
          </div>
        )}

        {/* Weekly Loss Progress */}
        {metrics && (
          <div className="space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Weekly Loss Limit
              </span>
              <span className={metrics.weekly_pnl < 0 ? 'text-red-500' : 'text-green-500'}>
                ${metrics.weekly_pnl.toFixed(2)} / ${Math.abs(metrics.weekly_limit).toFixed(2)}
              </span>
            </div>
            <div className="relative">
              <Progress
                value={Math.min(metrics.weekly_used_pct, 100)}
                className="h-3"
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0%</span>
              <span>{metrics.weekly_used_pct.toFixed(1)}% used</span>
              <span>100%</span>
            </div>
          </div>
        )}

        {/* Status Grid */}
        {metrics && (
          <div className="grid grid-cols-2 gap-3">
            {/* Open Positions */}
            <div className="p-3 bg-muted rounded-lg">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs text-muted-foreground">Open Positions</span>
                {metrics.open_positions >= metrics.max_positions && (
                  <Badge variant="destructive" className="text-xs">MAX</Badge>
                )}
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold">{metrics.open_positions}</span>
                <span className="text-sm text-muted-foreground">/ {metrics.max_positions}</span>
              </div>
              <Progress
                value={(metrics.open_positions / metrics.max_positions) * 100}
                className="h-1 mt-2"
              />
            </div>

            {/* Consecutive Losses */}
            <div
              className={`p-3 rounded-lg ${
                metrics.consecutive_losses >= 2
                  ? 'bg-yellow-500/10 border border-yellow-500/30'
                  : 'bg-muted'
              }`}
            >
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs text-muted-foreground">Consecutive Losses</span>
                {metrics.consecutive_losses >= 2 && (
                  <AlertTriangle className="h-4 w-4 text-yellow-500" />
                )}
              </div>
              <div className="flex items-baseline gap-1">
                <span
                  className={`text-2xl font-bold ${
                    metrics.consecutive_losses >= 2 ? 'text-yellow-500' : ''
                  }`}
                >
                  {metrics.consecutive_losses}
                </span>
                <span className="text-sm text-muted-foreground">
                  / {metrics.max_consecutive_losses}
                </span>
              </div>
              <div className="flex gap-1 mt-2">
                {Array.from({ length: metrics.max_consecutive_losses }).map((_, i) => (
                  <div
                    key={i}
                    className={`flex-1 h-1 rounded ${
                      i < metrics.consecutive_losses ? 'bg-red-500' : 'bg-muted-foreground/30'
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* Total Exposure */}
            <div className="p-3 bg-muted rounded-lg">
              <div className="text-xs text-muted-foreground mb-2">Total Exposure</div>
              <div className="text-xl font-bold">${metrics.total_exposure.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {((metrics.total_exposure / metrics.max_exposure) * 100).toFixed(1)}% of capital
              </div>
            </div>

            {/* Circuit Breaker Status */}
            <div
              className={`p-3 rounded-lg ${
                circuitBreaker?.active
                  ? 'bg-red-500/10 border border-red-500/30'
                  : 'bg-green-500/10 border border-green-500/30'
              }`}
            >
              <div className="text-xs text-muted-foreground mb-2">Circuit Breaker</div>
              <div className="flex items-center gap-2">
                {circuitBreaker?.active ? (
                  <>
                    <Zap className="h-5 w-5 text-red-500" />
                    <span className="text-lg font-bold text-red-500">TRIGGERED</span>
                  </>
                ) : (
                  <>
                    <Shield className="h-5 w-5 text-green-500" />
                    <span className="text-lg font-bold text-green-500">READY</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Risk Limits Summary */}
        {limits && (
          <div className="pt-4 border-t space-y-2">
            <h4 className="text-sm font-semibold">Risk Limits</h4>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex justify-between p-2 bg-muted/50 rounded">
                <span className="text-muted-foreground">Max Daily Loss</span>
                <span className="font-medium">
                  {(limits.max_daily_loss_pct * 100).toFixed(0)}%
                </span>
              </div>
              <div className="flex justify-between p-2 bg-muted/50 rounded">
                <span className="text-muted-foreground">Max Weekly Loss</span>
                <span className="font-medium">
                  {(limits.max_weekly_loss_pct * 100).toFixed(0)}%
                </span>
              </div>
              <div className="flex justify-between p-2 bg-muted/50 rounded">
                <span className="text-muted-foreground">Max Position Size</span>
                <span className="font-medium">
                  {(limits.max_position_size_pct * 100).toFixed(0)}%
                </span>
              </div>
              <div className="flex justify-between p-2 bg-muted/50 rounded">
                <span className="text-muted-foreground">Min Confidence</span>
                <span className="font-medium">
                  {(limits.min_confidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Quick Actions */}
        {onPauseTrading && (
          <div className="flex gap-2 pt-4 border-t">
            <Button
              variant="outline"
              className="flex-1"
              onClick={onPauseTrading}
              disabled={circuitBreaker?.active}
            >
              <Pause className="h-4 w-4 mr-2" />
              Pause Trading
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
