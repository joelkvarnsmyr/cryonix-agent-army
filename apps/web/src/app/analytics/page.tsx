'use client';

import { useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cryonix/ui';

interface JournalTrade {
  symbol: string;
  pattern: string | null;
  confidence: number;
  entry_price: number;
  exit_price: number;
  pnl: number;
  pnl_percent: number;
  exit_reason: string | null;
  holding_period_h: number;
  config_version: string;
  reasoning: string;
  opened_at: string;
  closed_at: string;
}

interface JournalData {
  trades: JournalTrade[];
  summary: {
    total_trades: number;
    win_rate?: number;
    total_pnl?: number;
    avg_holding_h?: number;
    best_pattern?: string | null;
    worst_pattern?: string | null;
    config_versions_used?: string[];
  };
  config_comparison: Array<{
    version: string;
    trades: number;
    pnl: number;
    win_rate: number;
  }>;
  source: string;
  days: number;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<JournalData | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/analytics/journal?days=${days}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { setData(d); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground tracking-tight">Trade Analytics</h1>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              Source: {data?.source || '...'} | {data?.trades?.length || 0} trades in {days}d window
            </p>
          </div>
          <div className="flex gap-1.5">
            {[7, 14, 30].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  days === d
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-8">
            <div className="h-4 w-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            Loading journal data...
          </div>
        )}
        {error && (
          <Card className="border-red-500/30 bg-red-950/10">
            <CardContent className="p-4">
              <p className="text-red-400 text-sm font-mono">Error: {error}</p>
            </CardContent>
          </Card>
        )}

        {data && !loading && (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard label="Total Trades" value={String(data.summary.total_trades)} />
              <SummaryCard
                label="Win Rate"
                value={data.summary.win_rate != null ? `${data.summary.win_rate}%` : '-'}
                color={
                  data.summary.win_rate != null
                    ? Number(data.summary.win_rate) >= 50
                      ? 'text-emerald-400'
                      : 'text-red-400'
                    : undefined
                }
              />
              <SummaryCard
                label="Total P&L"
                value={data.summary.total_pnl != null ? `$${Number(data.summary.total_pnl).toFixed(2)}` : '-'}
                color={
                  data.summary.total_pnl != null
                    ? Number(data.summary.total_pnl) >= 0
                      ? 'text-emerald-400'
                      : 'text-red-400'
                    : undefined
                }
              />
              <SummaryCard
                label="Avg Holding"
                value={data.summary.avg_holding_h != null ? `${data.summary.avg_holding_h}h` : '-'}
              />
            </div>

            {/* Pattern Performance */}
            {(data.summary.best_pattern || data.summary.worst_pattern) && (
              <div className="grid grid-cols-2 gap-3">
                {data.summary.best_pattern && (
                  <Card className="border-border/40 bg-card/50 backdrop-blur-sm">
                    <CardContent className="p-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Best Pattern</p>
                      <Badge variant="outline" className="text-emerald-400 border-emerald-400/30 bg-emerald-950/20">
                        {data.summary.best_pattern}
                      </Badge>
                    </CardContent>
                  </Card>
                )}
                {data.summary.worst_pattern && (
                  <Card className="border-border/40 bg-card/50 backdrop-blur-sm">
                    <CardContent className="p-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Worst Pattern</p>
                      <Badge variant="outline" className="text-red-400 border-red-400/30 bg-red-950/20">
                        {data.summary.worst_pattern}
                      </Badge>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* Config Version Comparison */}
            {data.config_comparison.length > 0 && (
              <Card className="border-border/40 bg-card/50 backdrop-blur-sm">
                <CardHeader className="pb-3 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold tracking-tight">Config Versions</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 pt-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border/40 hover:bg-transparent">
                        <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70">Version</TableHead>
                        <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70 text-right">Trades</TableHead>
                        <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70 text-right">P&L</TableHead>
                        <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70 text-right">Win Rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.config_comparison.map(c => (
                        <TableRow key={c.version} className="border-border/20">
                          <TableCell className="py-2 font-mono text-xs">{c.version}</TableCell>
                          <TableCell className="py-2 text-right text-xs">{c.trades}</TableCell>
                          <TableCell className={`py-2 text-right font-mono text-xs ${c.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            ${c.pnl.toFixed(2)}
                          </TableCell>
                          <TableCell className={`py-2 text-right font-mono text-xs ${c.win_rate >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {c.win_rate}%
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Trade Journal Table */}
            <Card className="border-border/40 bg-card/50 backdrop-blur-sm">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold tracking-tight">Trade Journal</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-0">
                {data.trades.length === 0 ? (
                  <p className="text-muted-foreground text-sm py-4">No trades in the selected period</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border/40 hover:bg-transparent">
                          <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70">Date</TableHead>
                          <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70">Symbol</TableHead>
                          <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70">Pattern</TableHead>
                          <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70 text-right">P&L</TableHead>
                          <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70 text-right">P&L%</TableHead>
                          <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70">Exit</TableHead>
                          <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70 text-right">Hold</TableHead>
                          <TableHead className="h-8 text-[10px] uppercase tracking-widest text-muted-foreground/70">Config</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.trades.map((t, i) => (
                          <TableRow key={i} className="border-border/20">
                            <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                              {t.closed_at ? new Date(t.closed_at).toLocaleDateString('sv-SE') : '-'}
                            </TableCell>
                            <TableCell className="py-2 text-xs font-medium">{t.symbol}</TableCell>
                            <TableCell className="py-2">
                              {t.pattern ? (
                                <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0 border-border/40 bg-muted/30">
                                  {t.pattern}
                                </Badge>
                              ) : (
                                <span className="text-xs text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className={`py-2 text-right font-mono text-xs ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              ${t.pnl.toFixed(2)}
                            </TableCell>
                            <TableCell className={`py-2 text-right font-mono text-xs ${t.pnl_percent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {t.pnl_percent != null ? `${t.pnl_percent.toFixed(1)}%` : '-'}
                            </TableCell>
                            <TableCell className="py-2">
                              <ExitBadge reason={t.exit_reason} />
                            </TableCell>
                            <TableCell className="py-2 text-right text-xs text-muted-foreground">
                              {t.holding_period_h != null ? `${t.holding_period_h.toFixed(1)}h` : '-'}
                            </TableCell>
                            <TableCell className="py-2 font-mono text-[10px] text-muted-foreground">
                              {t.config_version || '-'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Card className="border-border/40 bg-card/50 backdrop-blur-sm">
      <CardContent className="p-4">
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{label}</p>
        <p className={`text-xl font-bold mt-1 tabular-nums ${color || 'text-card-foreground'}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function ExitBadge({ reason }: { reason: string | null }) {
  if (!reason) return <span className="text-xs text-muted-foreground">-</span>;

  const isProfit = reason === 'SOLD_TP' || reason === 'TAKE_PROFIT';
  const isLoss = reason === 'SOLD_SL' || reason === 'STOP_LOSS';

  return (
    <Badge
      variant="outline"
      className={`text-[10px] font-mono px-1.5 py-0 ${
        isProfit
          ? 'text-emerald-400 border-emerald-400/30 bg-emerald-950/20'
          : isLoss
          ? 'text-red-400 border-red-400/30 bg-red-950/20'
          : 'border-border/40 text-muted-foreground bg-muted/30'
      }`}
    >
      {reason}
    </Badge>
  );
}
