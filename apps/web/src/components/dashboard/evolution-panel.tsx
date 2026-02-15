"use client";

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, Badge } from '@cryonix/ui';
import {
  Dna, CheckCircle, XCircle, Clock, Zap,
  TrendingUp, TrendingDown, ChevronDown, ChevronRight,
  BarChart3, RefreshCw
} from 'lucide-react';

interface EvolutionRun {
  id: number;
  runId: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  status: string;
  performanceData: any;
  changesMade: any;
}

interface CalibrationPattern {
  pattern: string;
  trades: number;
  wins: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  ev: number;
  totalPnl: number;
}

export function EvolutionPanel() {
  const [runs, setRuns] = useState<EvolutionRun[]>([]);
  const [calibration, setCalibration] = useState<Record<string, CalibrationPattern> | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [view, setView] = useState<'runs' | 'calibration'>('runs');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/evolution');
      const json = await res.json();
      if (json.success) {
        setRuns(json.runs || []);
        setCalibration(json.calibration || null);
      }
    } catch (err) {
      console.error('Failed to fetch evolution data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 120000); // 2min
    return () => clearInterval(interval);
  }, [fetchData]);

  const statusConfig: Record<string, { icon: typeof CheckCircle; color: string; label: string }> = {
    SUCCESS: { icon: CheckCircle, color: 'text-emerald-400', label: 'SUCCESS' },
    FAILED: { icon: XCircle, color: 'text-red-400', label: 'FAILED' },
    RUNNING: { icon: Zap, color: 'text-amber-400', label: 'RUNNING' },
    SKIPPED: { icon: Clock, color: 'text-muted-foreground', label: 'SKIPPED' },
    NO_EVOLUTION_NEEDED: { icon: CheckCircle, color: 'text-blue-400', label: 'STABLE' },
  };

  const calibrationPatterns = calibration ? Object.values(calibration).sort((a, b) => b.trades - a.trades) : [];

  return (
    <Card className="glass-card overflow-hidden">
      <CardContent className="p-0">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border/30">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="h-5 w-5 rounded-md bg-violet-500/10 flex items-center justify-center border border-violet-500/20">
                <Dna className="h-3 w-3 text-violet-400" />
              </div>
              <span className="text-xs font-semibold">Evolution</span>
              {runs.length > 0 && (
                <span className="text-[9px] font-mono text-muted-foreground/40">
                  {runs.length} runs
                </span>
              )}
            </div>
            <button onClick={fetchData} className="text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* View toggle */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setView('runs')}
              className={`px-2 py-1 rounded text-[9px] font-mono font-medium transition-all ${
                view === 'runs'
                  ? 'bg-violet-500/10 text-violet-400 border border-violet-500/20'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Dna className="h-2.5 w-2.5 inline mr-1" />Runs
            </button>
            <button
              onClick={() => setView('calibration')}
              className={`px-2 py-1 rounded text-[9px] font-mono font-medium transition-all ${
                view === 'calibration'
                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <BarChart3 className="h-2.5 w-2.5 inline mr-1" />Calibration
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="max-h-[320px] overflow-y-auto">
          {view === 'runs' ? (
            /* Evolution Runs Timeline */
            runs.length === 0 ? (
              <div className="text-center py-8 px-4">
                <Dna className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-[10px] text-muted-foreground/50 font-mono">No evolution runs yet</p>
                <p className="text-[9px] text-muted-foreground/30 font-mono mt-1">
                  Runs at 03:00 UTC when performance dips
                </p>
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {runs.map((run) => {
                  const config = statusConfig[run.status || 'SKIPPED'] || statusConfig.SKIPPED;
                  const StatusIcon = config.icon;
                  const perf = run.performanceData as any;
                  const changes = run.changesMade as any;
                  const isExpanded = expandedRun === run.id;
                  const date = new Date(run.startedAt);

                  return (
                    <div
                      key={run.id}
                      className="rounded-lg border border-border/20 hover:border-border/40 transition-all cursor-pointer overflow-hidden"
                      onClick={() => setExpandedRun(isExpanded ? null : run.id)}
                    >
                      <div className="px-3 py-2.5 flex items-center gap-3">
                        {/* Timeline dot */}
                        <div className="flex flex-col items-center gap-0.5">
                          <StatusIcon className={`h-3.5 w-3.5 ${config.color}`} />
                          <span className="text-[8px] font-mono text-muted-foreground/40">
                            {date.toLocaleDateString('sv-SE', { month: 'short', day: 'numeric' })}
                          </span>
                        </div>

                        {/* Run info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-[8px] h-4 px-1.5 ${config.color} border-current/20`}>
                              {config.label}
                            </Badge>
                            {run.durationSeconds && (
                              <span className="text-[9px] font-mono text-muted-foreground/40">
                                {run.durationSeconds}s
                              </span>
                            )}
                          </div>

                          {/* Performance summary */}
                          {perf && (
                            <div className="flex items-center gap-3 mt-1 text-[9px] font-mono">
                              {perf.totalPnl !== undefined && (
                                <span className={perf.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                  {perf.totalPnl >= 0 ? '+' : ''}{Number(perf.totalPnl).toFixed(4)} PnL
                                </span>
                              )}
                              {perf.totalTrades !== undefined && (
                                <span className="text-muted-foreground/50">{perf.totalTrades} trades</span>
                              )}
                              {perf.weakestPattern && (
                                <span className="text-red-400/60">weak: {perf.weakestPattern}</span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Expand arrow */}
                        {isExpanded
                          ? <ChevronDown className="h-3 w-3 text-muted-foreground/40" />
                          : <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
                        }
                      </div>

                      {/* Expanded details */}
                      {isExpanded && (
                        <div className="px-3 pb-3 border-t border-border/20">
                          {/* Changes made */}
                          {changes && (
                            <div className="mt-2">
                              <p className="text-[9px] font-mono text-muted-foreground/50 mb-1">MUTATIONS</p>
                              {Array.isArray(changes) ? (
                                changes.map((c: any, i: number) => (
                                  <div key={i} className="text-[9px] font-mono text-foreground/60 bg-muted/10 rounded px-2 py-1 mb-0.5">
                                    {c.file || c.description || JSON.stringify(c)}
                                  </div>
                                ))
                              ) : typeof changes === 'object' ? (
                                <pre className="text-[9px] font-mono text-foreground/50 bg-muted/10 rounded p-2 overflow-auto max-h-32">
                                  {JSON.stringify(changes, null, 2)}
                                </pre>
                              ) : (
                                <span className="text-[9px] font-mono text-foreground/50">{String(changes)}</span>
                              )}
                            </div>
                          )}

                          {/* Structural issues */}
                          {perf?.structuralIssues && perf.structuralIssues.length > 0 && (
                            <div className="mt-2">
                              <p className="text-[9px] font-mono text-muted-foreground/50 mb-1">ISSUES DETECTED</p>
                              <div className="flex flex-wrap gap-1">
                                {perf.structuralIssues.map((issue: string) => (
                                  <Badge key={issue} variant="outline" className="text-[8px] h-4 px-1.5 text-amber-400 border-amber-500/20">
                                    {issue}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            /* Calibration View */
            calibrationPatterns.length === 0 ? (
              <div className="text-center py-8 px-4">
                <BarChart3 className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-[10px] text-muted-foreground/50 font-mono">No calibration data</p>
                <p className="text-[9px] text-muted-foreground/30 font-mono mt-1">
                  POST /api/calibration to generate
                </p>
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {calibrationPatterns.map((pat) => {
                  const evPositive = pat.ev > 0;
                  return (
                    <div key={pat.pattern} className="rounded-lg bg-muted/10 border border-border/20 px-3 py-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-[10px] font-semibold text-foreground/80">
                          {pat.pattern}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className={`font-mono text-[10px] font-bold ${evPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                            EV {evPositive ? '+' : ''}{pat.ev.toFixed(4)}
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 text-[9px] font-mono">
                        <div>
                          <span className="text-muted-foreground/50 block">Trades</span>
                          <span>{pat.trades}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground/50 block">Win Rate</span>
                          <span className={pat.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}>
                            {pat.winRate.toFixed(1)}%
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground/50 block">Avg Win</span>
                          <span className="text-emerald-400/70">${pat.avgWin.toFixed(4)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground/50 block">Total PnL</span>
                          <span className={pat.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {pat.totalPnl >= 0 ? '+' : ''}${pat.totalPnl.toFixed(4)}
                          </span>
                        </div>
                      </div>
                      {/* Visual win rate bar */}
                      <div className="mt-1.5 h-1 rounded-full bg-muted/20 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${pat.winRate >= 50 ? 'bg-emerald-500/50' : 'bg-red-500/50'}`}
                          style={{ width: `${Math.min(pat.winRate, 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      </CardContent>
    </Card>
  );
}
