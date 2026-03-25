'use client';

import { useState } from 'react';
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
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from 'recharts';
import { TrendingUp, TrendingDown, Activity, Target, AlertTriangle, Download } from 'lucide-react';
import { format } from 'date-fns';

interface BacktestTrade {
  id: string;
  timestamp: string;
  side: 'BUY' | 'SELL';
  entry_price: number;
  exit_price: number;
  pnl: number;
  pnl_percent: number;
  pattern?: string;
  exit_reason: string;
}

interface BacktestMetrics {
  total_return_pct: number;
  total_trades: number;
  win_rate: number;
  sharpe_ratio: number;
  sortino_ratio?: number;
  max_drawdown_pct: number;
  profit_factor: number;
  avg_win: number;
  avg_loss: number;
  largest_win: number;
  largest_loss: number;
  avg_trade_duration?: string;
  recovery_factor?: number;
}

interface EquityPoint {
  timestamp: string;
  equity: number;
}

interface BacktestResultsProps {
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  symbol: string;
  timeframe: string;
  period: string;
  initialCapital?: number;
}

export function BacktestResults({
  metrics,
  equityCurve,
  trades,
  symbol,
  timeframe,
  period,
  initialCapital = 10000,
}: BacktestResultsProps) {
  const [showAllTrades, setShowAllTrades] = useState(false);

  // Calculate trade distribution for histogram
  const tradeDistribution = calculateTradeDistribution(trades);

  // Metrics cards data
  const metricCards = [
    {
      label: 'Sharpe Ratio',
      value: metrics.sharpe_ratio.toFixed(2),
      status: metrics.sharpe_ratio >= 1.0 ? 'good' : metrics.sharpe_ratio >= 0.5 ? 'warning' : 'bad',
      threshold: '>= 1.0',
      icon: Activity,
    },
    {
      label: 'Win Rate',
      value: `${metrics.win_rate.toFixed(1)}%`,
      status: metrics.win_rate >= 55 ? 'good' : metrics.win_rate >= 45 ? 'warning' : 'bad',
      threshold: '>= 55%',
      icon: Target,
    },
    {
      label: 'Max Drawdown',
      value: `-${metrics.max_drawdown_pct.toFixed(1)}%`,
      status: metrics.max_drawdown_pct <= 15 ? 'good' : metrics.max_drawdown_pct <= 25 ? 'warning' : 'bad',
      threshold: '<= 15%',
      icon: AlertTriangle,
    },
    {
      label: 'Profit Factor',
      value: metrics.profit_factor.toFixed(2),
      status: metrics.profit_factor >= 1.5 ? 'good' : metrics.profit_factor >= 1.0 ? 'warning' : 'bad',
      threshold: '>= 1.5',
      icon: TrendingUp,
    },
  ];

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'good':
        return 'text-green-500';
      case 'warning':
        return 'text-yellow-500';
      case 'bad':
        return 'text-red-500';
      default:
        return 'text-muted-foreground';
    }
  };

  const getStatusBg = (status: string) => {
    switch (status) {
      case 'good':
        return 'bg-green-500/10 border-green-500/20';
      case 'warning':
        return 'bg-yellow-500/10 border-yellow-500/20';
      case 'bad':
        return 'bg-red-500/10 border-red-500/20';
      default:
        return 'bg-muted';
    }
  };

  const downloadCSV = () => {
    const headers = ['Timestamp', 'Side', 'Entry Price', 'Exit Price', 'PnL', 'PnL %', 'Pattern', 'Exit Reason'];
    const rows = trades.map((t) => [
      t.timestamp,
      t.side,
      t.entry_price,
      t.exit_price,
      t.pnl,
      t.pnl_percent,
      t.pattern || 'Unknown',
      t.exit_reason,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `backtest_${symbol}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Chart data formatting
  const chartData = equityCurve.map((d) => ({
    date: new Date(d.timestamp).getTime(),
    equity: d.equity,
    formattedDate: format(new Date(d.timestamp), 'MMM d, HH:mm'),
  }));

  const minEquity = chartData.length > 0 ? Math.min(...chartData.map((d) => d.equity)) * 0.99 : initialCapital * 0.9;
  const maxEquity = chartData.length > 0 ? Math.max(...chartData.map((d) => d.equity)) * 1.01 : initialCapital * 1.1;

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background border border-border p-2 rounded shadow-lg text-xs">
          <p className="font-semibold">{format(label, 'PP pp')}</p>
          <p className="text-primary font-mono">${payload[0].value.toFixed(2)}</p>
        </div>
      );
    }
    return null;
  };

  const HistogramTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background border border-border p-2 rounded shadow-lg text-xs">
          <p className="font-semibold">{payload[0].payload.range}</p>
          <p className="font-mono">{payload[0].value} trades</p>
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="col-span-full">
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              Backtest Results
              <Badge variant="outline">{symbol}</Badge>
              <Badge variant="secondary">{timeframe}</Badge>
            </CardTitle>
            <CardDescription>
              {period} period | {trades.length} trades | Initial: ${initialCapital.toLocaleString()}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Badge
              variant={metrics.total_return_pct >= 0 ? 'default' : 'destructive'}
              className="text-lg px-3 py-1"
            >
              {metrics.total_return_pct >= 0 ? '+' : ''}
              {metrics.total_return_pct.toFixed(2)}%
            </Badge>
            <Button variant="outline" size="sm" onClick={downloadCSV}>
              <Download className="h-4 w-4 mr-1" />
              CSV
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Performance Metrics Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {metricCards.map((metric) => {
            const Icon = metric.icon;
            return (
              <div
                key={metric.label}
                className={`p-4 rounded-lg border ${getStatusBg(metric.status)}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">{metric.label}</span>
                  <Icon className={`h-4 w-4 ${getStatusColor(metric.status)}`} />
                </div>
                <div className={`text-2xl font-bold ${getStatusColor(metric.status)}`}>
                  {metric.value}
                </div>
                <div className="text-xs text-muted-foreground mt-1">Target: {metric.threshold}</div>
              </div>
            );
          })}
        </div>

        {/* Additional Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="p-3 bg-muted rounded-lg">
            <div className="text-xs text-muted-foreground">Avg Win</div>
            <div className="text-lg font-semibold text-green-500">
              +${metrics.avg_win.toFixed(2)}
            </div>
          </div>
          <div className="p-3 bg-muted rounded-lg">
            <div className="text-xs text-muted-foreground">Avg Loss</div>
            <div className="text-lg font-semibold text-red-500">
              -${Math.abs(metrics.avg_loss).toFixed(2)}
            </div>
          </div>
          <div className="p-3 bg-muted rounded-lg">
            <div className="text-xs text-muted-foreground">Largest Win</div>
            <div className="text-lg font-semibold text-green-500">
              +${metrics.largest_win.toFixed(2)}
            </div>
          </div>
          <div className="p-3 bg-muted rounded-lg">
            <div className="text-xs text-muted-foreground">Largest Loss</div>
            <div className="text-lg font-semibold text-red-500">
              -${Math.abs(metrics.largest_loss).toFixed(2)}
            </div>
          </div>
          <div className="p-3 bg-muted rounded-lg">
            <div className="text-xs text-muted-foreground">Total Trades</div>
            <div className="text-lg font-semibold">{metrics.total_trades}</div>
          </div>
        </div>

        {/* Equity Curve Chart */}
        {chartData.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Equity Curve</h3>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    scale="time"
                    tickFormatter={(unixTime) => format(unixTime, 'MM/dd')}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickMargin={10}
                  />
                  <YAxis
                    domain={[minEquity, maxEquity]}
                    tickFormatter={(value) => `$${value}`}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    width={70}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine
                    y={initialCapital}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="3 3"
                    label={{
                      value: 'Initial',
                      position: 'right',
                      fill: 'hsl(var(--muted-foreground))',
                      fontSize: 10,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="equity"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Trade Distribution Histogram */}
        {tradeDistribution.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Trade Distribution (PnL %)</h3>
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={tradeDistribution}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="range"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={10}
                    angle={-45}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    allowDecimals={false}
                  />
                  <Tooltip content={<HistogramTooltip />} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {tradeDistribution.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.isPositive ? 'hsl(142, 76%, 36%)' : 'hsl(0, 84%, 60%)'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Recent Trades */}
        {trades.length > 0 && (
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-semibold">Trade History</h3>
              <Button variant="ghost" size="sm" onClick={() => setShowAllTrades(!showAllTrades)}>
                {showAllTrades ? 'Show Less' : `Show All (${trades.length})`}
              </Button>
            </div>
            <div className="space-y-1 max-h-[300px] overflow-auto">
              {(showAllTrades ? trades : trades.slice(0, 10)).map((trade) => (
                <div
                  key={trade.id}
                  className="flex justify-between items-center p-2 bg-muted/50 rounded text-sm"
                >
                  <div className="flex items-center gap-2">
                    {trade.pnl >= 0 ? (
                      <TrendingUp className="h-3 w-3 text-green-500" />
                    ) : (
                      <TrendingDown className="h-3 w-3 text-red-500" />
                    )}
                    <span className={trade.side === 'BUY' ? 'text-green-500' : 'text-red-500'}>
                      {trade.side}
                    </span>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    ${trade.entry_price.toFixed(2)} → ${trade.exit_price.toFixed(2)}
                  </span>
                  <span className={trade.pnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                    {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)} ({trade.pnl_percent.toFixed(1)}%)
                  </span>
                  <div className="flex gap-1">
                    <Badge variant="outline" className="text-xs">
                      {trade.pattern || 'Unknown'}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {trade.exit_reason}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Helper function to calculate trade distribution for histogram
function calculateTradeDistribution(trades: BacktestTrade[]) {
  const buckets: Record<string, { count: number; isPositive: boolean }> = {
    '< -5%': { count: 0, isPositive: false },
    '-5% to -3%': { count: 0, isPositive: false },
    '-3% to -1%': { count: 0, isPositive: false },
    '-1% to 0%': { count: 0, isPositive: false },
    '0% to 1%': { count: 0, isPositive: true },
    '1% to 3%': { count: 0, isPositive: true },
    '3% to 5%': { count: 0, isPositive: true },
    '> 5%': { count: 0, isPositive: true },
  };

  trades.forEach((trade) => {
    const pnlPct = trade.pnl_percent;
    if (pnlPct < -5) buckets['< -5%'].count++;
    else if (pnlPct < -3) buckets['-5% to -3%'].count++;
    else if (pnlPct < -1) buckets['-3% to -1%'].count++;
    else if (pnlPct < 0) buckets['-1% to 0%'].count++;
    else if (pnlPct < 1) buckets['0% to 1%'].count++;
    else if (pnlPct < 3) buckets['1% to 3%'].count++;
    else if (pnlPct < 5) buckets['3% to 5%'].count++;
    else buckets['> 5%'].count++;
  });

  return Object.entries(buckets).map(([range, data]) => ({
    range,
    count: data.count,
    isPositive: data.isPositive,
  }));
}
