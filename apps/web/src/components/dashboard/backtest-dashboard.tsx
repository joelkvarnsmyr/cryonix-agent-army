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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Progress,
} from '@cryonix/ui';
import { EquityCurveChart } from './charts/EquityCurveChart';
import { MonthlyHeatmap } from './charts/MonthlyHeatmap';
import { PatternPerformanceTable } from './charts/PatternPerformanceTable';

interface BacktestResult {
  symbol: string;
  timeframe: string;
  period: string;
  total_return_pct: number;
  total_trades: number;
  win_rate: number;
  sharpe_ratio: number;
  max_drawdown_pct: number;
  profit_factor: number;
  production_ready: boolean;
  assessment?: {
    sharpe_pass: boolean;
    win_rate_pass: boolean;
    drawdown_pass: boolean;
    profit_factor_pass: boolean;
    production_ready: boolean;
  };
  equity_curve?: Array<{ timestamp: string; equity: number }>;
  trades?: Array<{
    side: string;
    entry_price: number;
    exit_price: number;
    pnl: number;
    exit_reason: string;
    pattern?: string;
  }>;
}

interface BacktestState {
  loading: boolean;
  running: boolean;
  backtestId: string | null;
  result: BacktestResult | null;
  error: string | null;
}

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const TIMEFRAMES = ['15m', '1h', '4h', '1d'];
const DAYS_OPTIONS = [7, 14, 30, 60, 90];

export function BacktestDashboard() {
  const [state, setState] = useState<BacktestState>({
    loading: false,
    running: false,
    backtestId: null,
    result: null,
    error: null,
  });

  const [config, setConfig] = useState({
    symbol: 'BTC/USDT',
    timeframe: '1h',
    days: 30,
  });

  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);
  const [selectedPattern, setSelectedPattern] = useState<string>('ALL');

  // Poll for backtest status
  useEffect(() => {
    if (state.running && state.backtestId) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/backtest?action=status&id=${state.backtestId}`);
          const data = await res.json();

          if (data.status === 'completed') {
            // Fetch full results
            const resultsRes = await fetch(`/api/backtest?action=results&id=${state.backtestId}`);
            const resultsData = await resultsRes.json();

            setState(prev => ({
              ...prev,
              running: false,
              result: resultsData.results,
            }));
            clearInterval(interval);
          } else if (data.status?.startsWith('error')) {
            setState(prev => ({
              ...prev,
              running: false,
              error: data.status,
            }));
            clearInterval(interval);
          }
        } catch {
          // Keep polling
        }
      }, 2000);

      setPollInterval(interval);
      return () => clearInterval(interval);
    }
  }, [state.running, state.backtestId]);

  const runBacktest = async () => {
    setState(prev => ({ ...prev, loading: true, error: null, result: null }));

    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      const data = await res.json();

      if (data.backtest_id) {
        setState(prev => ({
          ...prev,
          loading: false,
          running: true,
          backtestId: data.backtest_id,
        }));
      } else {
        setState(prev => ({
          ...prev,
          loading: false,
          error: data.error || 'Failed to start backtest',
        }));
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: String(error),
      }));
    }
  };

  const runQuickBacktest = async () => {
    setState(prev => ({ ...prev, loading: true, error: null, result: null }));

    try {
      const res = await fetch(
        `/api/backtest?action=quick&symbol=${encodeURIComponent(config.symbol)}&timeframe=${config.timeframe}&days=${config.days}`
      );
      const data = await res.json();

      if (data.error) {
        setState(prev => ({ ...prev, loading: false, error: data.error }));
      } else {
        setState(prev => ({ ...prev, loading: false, result: data }));
      }
    } catch (error) {
      setState(prev => ({ ...prev, loading: false, error: String(error) }));
    }
  };

  const getStatusColor = (pass: boolean) => pass ? 'bg-green-500' : 'bg-red-500';

  // Filter trades and re-calculate relevant data if needed
  const filteredTrades = state.result?.trades?.filter(t =>
    selectedPattern === 'ALL' || t.pattern === selectedPattern
  ) || [];

  // Get unique patterns
  const patterns = Array.from(new Set(state.result?.trades?.map(t => t.pattern || 'Unknown') || [])).sort();

  const downloadCSV = () => {
    if (!state.result || !state.result.trades) return;

    const headers = ['Entry Time', 'Symbol', 'Side', 'Pattern', 'Entry Price', 'Exit Price', 'PnL', 'Exit Reason'];
    const rows = state.result.trades.map(t => [
      new Date().toISOString(), // Mock time
      state.result!.symbol,
      t.side,
      t.pattern || 'Unknown',
      t.entry_price,
      t.exit_price,
      t.pnl,
      t.exit_reason
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(r => r.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `backtest_results_${state.result.symbol}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Card className="col-span-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Strategy Backtester
          {state.running && <Badge variant="outline">Running...</Badge>}
        </CardTitle>
        <CardDescription>
          Test the QuantGuild strategy against historical data
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Configuration */}
        <div className="flex flex-wrap gap-4">
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Symbol</label>
            <Select
              value={config.symbol}
              onValueChange={(v) => setConfig(prev => ({ ...prev, symbol: v }))}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SYMBOLS.map(s => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Timeframe</label>
            <Select
              value={config.timeframe}
              onValueChange={(v) => setConfig(prev => ({ ...prev, timeframe: v }))}
            >
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEFRAMES.map(t => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Days</label>
            <Select
              value={String(config.days)}
              onValueChange={(v) => setConfig(prev => ({ ...prev, days: parseInt(v) }))}
            >
              <SelectTrigger className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS_OPTIONS.map(d => (
                  <SelectItem key={d} value={String(d)}>{d}d</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-end gap-2">
            <Button
              onClick={runQuickBacktest}
              disabled={state.loading || state.running}
              variant="outline"
            >
              Quick Test
            </Button>
            <Button
              onClick={runBacktest}
              disabled={state.loading || state.running}
            >
              {state.loading ? 'Starting...' : state.running ? 'Running...' : 'Run Full Backtest'}
            </Button>
          </div>
        </div>

        {/* Error Display */}
        {state.error && (
          <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500">
            {state.error}
          </div>
        )}

        {/* Running State */}
        {state.running && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Running backtest...</span>
              <span className="text-muted-foreground">ID: {state.backtestId}</span>
            </div>
            <Progress value={undefined} className="h-2" />
          </div>
        )}

        {/* Results Section */}
        {state.result && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">

            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold tracking-tight">Results</h2>
              <div className="flex gap-2">
                {/* Pattern Filter */}
                {patterns.length > 0 && (
                  <Select value={selectedPattern} onValueChange={setSelectedPattern}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="All Patterns" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">All Patterns</SelectItem>
                      {patterns.map(p => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                <Button variant="outline" onClick={downloadCSV}>
                  Download CSV
                </Button>
              </div>
            </div>

            <Card className="bg-gradient-to-br from-card to-muted/50">
              <CardContent className="p-6 space-y-8">
                {/* Summary Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="p-4 bg-muted rounded-lg">
                    <div className="text-sm text-muted-foreground">Total Return</div>
                    <div className={`text-2xl font-bold ${state.result.total_return_pct >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {state.result.total_return_pct >= 0 ? '+' : ''}{state.result.total_return_pct.toFixed(2)}%
                    </div>
                  </div>

                  <div className="p-4 bg-muted rounded-lg">
                    <div className="text-sm text-muted-foreground">Win Rate</div>
                    <div className="text-2xl font-bold">
                      {state.result.win_rate.toFixed(1)}%
                    </div>
                    <div className={`w-full h-1 mt-2 rounded ${state.result.win_rate >= 55 ? 'bg-green-500' : 'bg-yellow-500'}`} />
                  </div>

                  <div className="p-4 bg-muted rounded-lg">
                    <div className="text-sm text-muted-foreground">Sharpe Ratio</div>
                    <div className="text-2xl font-bold">
                      {state.result.sharpe_ratio.toFixed(2)}
                    </div>
                    <div className={`w-full h-1 mt-2 rounded ${state.result.sharpe_ratio >= 1.0 ? 'bg-green-500' : 'bg-yellow-500'}`} />
                  </div>

                  <div className="p-4 bg-muted rounded-lg">
                    <div className="text-sm text-muted-foreground">Max Drawdown</div>
                    <div className="text-2xl font-bold text-red-500">
                      -{state.result.max_drawdown_pct.toFixed(1)}%
                    </div>
                    <div className={`w-full h-1 mt-2 rounded ${state.result.max_drawdown_pct <= 20 ? 'bg-green-500' : 'bg-red-500'}`} />
                  </div>
                </div>

                {/* Charts Section */}
                <div className="grid grid-cols-1 gap-6">
                  {state.result.equity_curve && state.result.equity_curve.length > 0 && selectedPattern === 'ALL' && (
                    <EquityCurveChart data={state.result.equity_curve} />
                  )}

                  {state.result.equity_curve && state.result.equity_curve.length > 0 && selectedPattern === 'ALL' && (
                    <MonthlyHeatmap data={state.result.equity_curve} />
                  )}

                  {filteredTrades.length > 0 && (
                    <PatternPerformanceTable trades={filteredTrades} />
                  )}
                </div>


                {/* Assessment Checklist */}
                {state.result.assessment && (
                  <div className="p-4 bg-muted rounded-lg">
                    <h4 className="font-semibold mb-3">Production Readiness Assessment</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="flex items-center gap-2">
                        <div className={`w-3 h-3 rounded-full ${getStatusColor(state.result.assessment.sharpe_pass)}`} />
                        <span className="text-sm">Sharpe &ge; 1.0</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className={`w-3 h-3 rounded-full ${getStatusColor(state.result.assessment.win_rate_pass)}`} />
                        <span className="text-sm">Win Rate &ge; 55%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className={`w-3 h-3 rounded-full ${getStatusColor(state.result.assessment.drawdown_pass)}`} />
                        <span className="text-sm">Drawdown &le; 20%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className={`w-3 h-3 rounded-full ${getStatusColor(state.result.assessment.profit_factor_pass)}`} />
                        <span className="text-sm">Profit Factor &ge; 1.5</span>
                      </div>
                    </div>
                    <div className="mt-4 pt-4 border-t">
                      <Badge variant={state.result.assessment.production_ready ? 'default' : 'destructive'}>
                        {state.result.assessment.production_ready ? 'PRODUCTION READY' : 'NOT READY - NEEDS IMPROVEMENT'}
                      </Badge>
                    </div>
                  </div>
                )}

                {/* Trade Stats */}
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <div className="text-3xl font-bold">{state.result.total_trades}</div>
                    <div className="text-sm text-muted-foreground">Total Trades</div>
                  </div>
                  <div>
                    <div className="text-3xl font-bold">{state.result.profit_factor.toFixed(2)}</div>
                    <div className="text-sm text-muted-foreground">Profit Factor</div>
                  </div>
                  <div>
                    <div className="text-3xl font-bold">{state.result.period || `${config.days}d`}</div>
                    <div className="text-sm text-muted-foreground">Test Period</div>
                  </div>
                </div>

                {/* Recent Trades (Filtered) */}
                {filteredTrades.length > 0 && (
                  <div>
                    <h4 className="font-semibold mb-2">Trades ({filteredTrades.length})</h4>
                    <div className="space-y-1 max-h-48 overflow-auto">
                      {filteredTrades.slice().reverse().slice(0, 50).map((trade, i) => (
                        <div key={i} className="flex justify-between items-center p-2 bg-muted/50 rounded text-sm">
                          <span className={trade.side === 'BUY' ? 'text-green-500' : 'text-red-500'}>
                            {trade.side}
                          </span>
                          <span>${trade.entry_price.toFixed(2)} → ${trade.exit_price?.toFixed(2) || '-'}</span>
                          <span className={trade.pnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                            {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                          </span>
                          <div className="flex gap-2">
                            <Badge variant="outline" className="text-xs">{trade.pattern || 'Unknown'}</Badge>
                            <Badge variant="outline" className="text-xs">{trade.exit_reason}</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
