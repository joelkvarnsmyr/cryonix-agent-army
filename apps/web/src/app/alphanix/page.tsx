'use client';

import { useEffect, useState, useCallback } from 'react';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';

/* ── Types ─────────────────────────────────────────────────────────────────── */

interface PodRisk {
  dailyPnl?: number;
  canTrade?: boolean;
  consecutiveLosses?: number;
}

interface PodInfo {
  state: string | null;
  risk: PodRisk | null;
  lastHeartbeat: number | null;
}

interface OrchestratorState {
  totalCapital?: number;
  pods?: Record<string, { strategy?: string; capital?: number }>;
}

interface StatusResponse {
  status: string | null;
  orchestrator: OrchestratorState | null;
  pods: Record<string, PodInfo>;
  timestamp: string;
}

interface Position {
  symbol: string;
  qty: number;
  avgEntryPrice?: number;
  entryPrice?: number;
  currentPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
  adapter?: string;
  openedAt?: string;
  holdingHours?: number;
}

interface PositionsResponse {
  positions: Record<string, Position[]>;
  timestamp: string;
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return 'now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function stateColor(state: string | null): string {
  if (!state) return 'text-muted-foreground';
  switch (state) {
    case 'scanning':
    case 'running':
    case 'trading':
      return 'text-emerald-400';
    case 'paused':
    case 'cooldown':
    case 'pre-market':
      return 'text-amber-400';
    case 'error':
    case 'stopped':
      return 'text-red-400';
    default:
      return 'text-muted-foreground';
  }
}

function stateDot(state: string | null): string {
  if (!state) return 'bg-muted-foreground';
  switch (state) {
    case 'scanning':
    case 'running':
    case 'trading':
      return 'bg-emerald-400 animate-pulse';
    case 'paused':
    case 'cooldown':
    case 'pre-market':
      return 'bg-amber-400';
    case 'error':
    case 'stopped':
      return 'bg-red-400';
    default:
      return 'bg-muted-foreground';
  }
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function AlphanixPage() {
  const [statusData, setStatusData] = useState<StatusResponse | null>(null);
  const [positionsData, setPositionsData] = useState<PositionsResponse | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, posRes] = await Promise.all([
        fetch('/api/alphanix/status'),
        fetch('/api/alphanix/positions'),
      ]);
      if (statusRes.ok) setStatusData(await statusRes.json());
      if (posRes.ok) setPositionsData(await posRes.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const agentStatus = statusData?.status ?? 'offline';
  const orchestrator = statusData?.orchestrator;
  const pods = statusData?.pods ?? {};
  const podIds = Object.keys(pods);
  const positions = positionsData?.positions ?? {};
  const totalCapital = orchestrator?.totalCapital ?? 0;

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-4">

        {/* ── Status Cards ────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3">
          {/* Agent Status */}
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-1">AGENT STATUS</div>
            <div className="flex items-center justify-center gap-2">
              <span className={`w-2 h-2 rounded-full ${agentStatus === 'running' ? 'bg-emerald-400 animate-pulse' : agentStatus === 'offline' ? 'bg-red-400' : 'bg-amber-400'}`} />
              <span className={`text-lg font-bold font-mono uppercase ${agentStatus === 'running' ? 'text-emerald-400' : agentStatus === 'offline' ? 'text-red-400' : 'text-amber-400'}`}>
                {agentStatus}
              </span>
            </div>
          </div>

          {/* Total Capital */}
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-1">TOTAL CAPITAL</div>
            <div className="text-lg font-bold font-mono text-foreground">
              ${totalCapital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          {/* Active Pods */}
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-1">ACTIVE PODS</div>
            <div className="text-lg font-bold font-mono text-foreground">
              {podIds.length}
            </div>
          </div>
        </div>

        {/* ── Pods Section ────────────────────────────────────────── */}
        <div>
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2">
            PODS {podIds.length > 0 && `(${podIds.length})`}
          </div>
          {podIds.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
              <div className="text-sm text-muted-foreground/40">No pods registered</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {podIds.map(podId => {
                const pod = pods[podId];
                const orchPod = orchestrator?.pods?.[podId];
                const risk = pod?.risk;
                const dailyPnl = risk?.dailyPnl ?? 0;

                return (
                  <div key={podId} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                    {/* Pod header */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${stateDot(pod.state)}`} />
                        <span className="font-mono text-sm font-semibold text-foreground">{podId}</span>
                      </div>
                      <span className={`text-xs font-mono uppercase ${stateColor(pod.state)}`}>
                        {pod.state ?? 'unknown'}
                      </span>
                    </div>

                    {/* Strategy */}
                    {orchPod?.strategy && (
                      <div className="text-xs font-mono text-muted-foreground/50 mb-2">
                        Strategy: <span className="text-foreground/70">{orchPod.strategy}</span>
                        {orchPod.capital != null && (
                          <span className="ml-2 text-muted-foreground/40">
                            ${orchPod.capital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Risk metrics */}
                    <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                      <div className="rounded-lg bg-white/[0.03] p-2 text-center">
                        <div className="text-muted-foreground/50 text-[10px] mb-0.5">DAILY P&L</div>
                        <div className={dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          {dailyPnl >= 0 ? '+' : ''}{(dailyPnl ?? 0).toFixed(2)}%
                        </div>
                      </div>
                      <div className="rounded-lg bg-white/[0.03] p-2 text-center">
                        <div className="text-muted-foreground/50 text-[10px] mb-0.5">CAN TRADE</div>
                        <div className={risk?.canTrade ? 'text-emerald-400' : 'text-red-400'}>
                          {risk?.canTrade ? 'YES' : 'NO'}
                        </div>
                      </div>
                      <div className="rounded-lg bg-white/[0.03] p-2 text-center">
                        <div className="text-muted-foreground/50 text-[10px] mb-0.5">LOSSES</div>
                        <div className={
                          (risk?.consecutiveLosses ?? 0) >= 3 ? 'text-red-400' :
                          (risk?.consecutiveLosses ?? 0) >= 1 ? 'text-amber-400' : 'text-foreground'
                        }>
                          {risk?.consecutiveLosses ?? 0}
                        </div>
                      </div>
                    </div>

                    {/* Heartbeat */}
                    <div className="mt-2 text-[10px] font-mono text-muted-foreground/40 text-right">
                      heartbeat: {timeAgo(pod.lastHeartbeat)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Positions Section ───────────────────────────────────── */}
        <div>
          <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2">
            POSITIONS
          </div>
          {podIds.length === 0 || Object.values(positions).every(p => p.length === 0) ? (
            <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
              <div className="text-sm text-muted-foreground/40">No open positions</div>
            </div>
          ) : (
            <div className="space-y-3">
              {podIds.map(podId => {
                const podPositions = positions[podId] ?? [];
                if (podPositions.length === 0) return null;

                return (
                  <div key={podId} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                    <div className="text-[10px] font-mono text-muted-foreground/50 tracking-wider mb-2">
                      {podId.toUpperCase()} ({podPositions.length})
                    </div>

                    {/* Table header */}
                    <div className="grid grid-cols-5 gap-2 text-[10px] font-mono text-muted-foreground/40 mb-1 px-1">
                      <span>SYMBOL</span>
                      <span className="text-right">QTY</span>
                      <span className="text-right">ENTRY</span>
                      <span className="text-right">CURRENT</span>
                      <span className="text-right">P&L</span>
                    </div>

                    {/* Rows */}
                    <div className="space-y-1">
                      {podPositions.map((pos) => {
                        const pnl = pos.unrealizedPnl ?? 0;
                        const pnlPct = pos.unrealizedPnlPct ?? 0;
                        const entry = pos.avgEntryPrice ?? pos.entryPrice ?? 0;
                        const current = pos.currentPrice ?? 0;
                        const plColor = pnl >= 0 ? 'text-emerald-400' : 'text-red-400';

                        return (
                          <div key={`${podId}-${pos.symbol}`} className="grid grid-cols-5 gap-2 text-xs font-mono px-1 py-0.5 rounded hover:bg-white/[0.02]">
                            <span className="text-foreground/80">{pos.symbol}</span>
                            <span className="text-right text-muted-foreground">{typeof pos.qty === 'number' ? pos.qty.toFixed(4) : pos.qty}</span>
                            <span className="text-right text-muted-foreground">${entry.toFixed(2)}</span>
                            <span className={`text-right ${plColor}`}>${current.toFixed(2)}</span>
                            <span className={`text-right ${plColor}`}>
                              {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-center py-1 text-[10px] font-mono text-muted-foreground/40">
          Alphanix Alpha Intelligence Engine &middot; Auto-refreshes every 30s
        </div>

      </div>
    </DashboardLayout>
  );
}
