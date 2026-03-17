'use client';

import { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';

function timeAgo(ts: number) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

interface Position {
    symbol: string; side: 'LONG' | 'SHORT'; qty: number; entryPrice: number;
    currentPrice: number; unrealizedPnl: number; psiAtEntry: number;
    coherenceAtEntry: number; entryTime: number; trailingActive: boolean;
}

interface PsinixState {
    status: string; portfolioValue: number; balance: number;
    positions: Position[]; totalPnl: number; wins: number; losses: number;
    winRate: number; pollCount: number; updatedAt: number;
}

interface Trade {
    id: number; timestamp: string; symbol: string; side: string;
    dollarAmount: number | null; realizedPnl: number | null;
    psi: number | null; coherence: number | null; reason: string;
}

export default function PsinixPage() {
    const [state, setState] = useState<PsinixState | null>(null);
    const [trades, setTrades] = useState<Trade[]>([]);
    const [summary, setSummary] = useState({ totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 });

    const fetchState = useCallback(async () => {
        try {
            const res = await fetch('/api/psinix/status');
            if (res.ok) setState(await res.json());
        } catch { /* skip */ }
    }, []);

    const fetchTrades = useCallback(async () => {
        try {
            const res = await fetch('/api/psinix/trades?limit=20');
            if (res.ok) {
                const data = await res.json();
                setTrades(data.trades ?? []);
                setSummary(data.summary ?? { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 });
            }
        } catch { /* skip */ }
    }, []);

    useEffect(() => {
        fetchState(); fetchTrades();
        const id1 = setInterval(fetchState, 10_000);
        const id2 = setInterval(fetchTrades, 30_000);
        return () => { clearInterval(id1); clearInterval(id2); };
    }, [fetchState, fetchTrades]);

    const isRunning = state?.status === 'running';
    const portfolioValue = state?.portfolioValue ?? 0;
    const balance = state?.balance ?? 0;
    const positions = state?.positions ?? [];
    const totalPnl = state?.totalPnl ?? 0;

    return (
        <DashboardLayout>
            <div className="max-w-2xl mx-auto space-y-4">

                {/* Status bar */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <span className="text-xs font-mono font-semibold text-violet-400">Ψnix</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/5 text-amber-400">
                            PAPER
                        </span>
                        <span className="text-[10px] font-mono text-muted-foreground/50">
                            Phase Convergence Trading
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
                        <span className="font-mono">{isRunning ? 'RUNNING' : 'OFFLINE'}</span>
                    </div>
                </div>

                {/* Portfolio card */}
                <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
                    <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-1">PORTFOLIO VALUE</div>
                    <div className={`text-3xl font-bold tracking-tight ${portfolioValue >= 1000 ? 'text-emerald-400' : 'text-red-400'}`}>
                        ${portfolioValue.toFixed(2)}
                    </div>
                    <div className="mt-1 flex items-center justify-center gap-3 text-sm">
                        <span className={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} total P/L
                        </span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-3 text-xs text-muted-foreground">
                        <div className="rounded-lg bg-white/[0.03] p-2">
                            <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">CASH</div>
                            <div className="font-mono text-foreground">${balance.toFixed(2)}</div>
                        </div>
                        <div className="rounded-lg bg-white/[0.03] p-2">
                            <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">POSITIONS</div>
                            <div className="font-mono text-foreground">{positions.length} / 3</div>
                        </div>
                        <div className="rounded-lg bg-white/[0.03] p-2">
                            <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px]">WIN RATE</div>
                            <div className="font-mono text-foreground">
                                {state?.wins ?? 0}W/{state?.losses ?? 0}L
                            </div>
                        </div>
                    </div>
                </div>

                {/* Open positions */}
                <div>
                    <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-2">
                        OPEN POSITIONS {positions.length > 0 && `(${positions.length})`}
                    </div>
                    {positions.length === 0 ? (
                        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
                            <div className="text-sm text-muted-foreground/40">Waiting for phase transition...</div>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {positions.map(pos => {
                                const pnlPct = pos.entryPrice > 0
                                    ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === 'LONG' ? 1 : -1)
                                    : 0;
                                const plColor = pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
                                const sideColor = pos.side === 'LONG' ? 'text-emerald-400 border-emerald-400/30 bg-emerald-400/5' : 'text-violet-400 border-violet-400/30 bg-violet-400/5';
                                return (
                                    <div key={pos.symbol} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                                        <div className="flex items-start justify-between mb-1">
                                            <div className="flex items-center gap-2">
                                                <span className="font-mono text-sm font-semibold text-foreground">{pos.symbol.split('/')[0]}</span>
                                                <span className={`text-[9px] font-mono px-1 py-0.5 rounded border ${sideColor}`}>
                                                    {pos.side}
                                                </span>
                                            </div>
                                            <span className={`text-base font-bold ${plColor}`}>
                                                {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                                            </span>
                                        </div>
                                        <div className="text-xs font-mono text-muted-foreground space-y-0.5">
                                            <div>
                                                <span className="text-muted-foreground/50">Entry </span>
                                                ${pos.entryPrice.toFixed(2)}
                                                <span className="text-muted-foreground/30 mx-1">&rarr;</span>
                                                <span className={plColor}>${pos.currentPrice.toFixed(2)}</span>
                                            </div>
                                            <div className={plColor}>
                                                {pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)} unrealized
                                            </div>
                                            <div className="flex items-center gap-3 text-muted-foreground/50">
                                                <span>Ψ={pos.psiAtEntry.toFixed(3)}</span>
                                                <span>C={pos.coherenceAtEntry.toFixed(3)}</span>
                                                <span>{timeAgo(pos.entryTime)}</span>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Recent trades */}
                <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                    <div className="flex items-center justify-between mb-2.5">
                        <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest">RECENT TRADES</div>
                        {summary.totalTrades > 0 && (
                            <div className="flex gap-3 text-xs text-muted-foreground">
                                <span className={summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                    {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toFixed(2)}
                                </span>
                            </div>
                        )}
                    </div>
                    {trades.length === 0 ? (
                        <div className="text-sm text-muted-foreground/40">No trades yet</div>
                    ) : (
                        <div className="space-y-1.5">
                            {trades.slice(0, 10).map((t) => (
                                <div key={t.id} className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className={`font-mono text-xs w-8 ${t.side === 'BUY' ? 'text-emerald-400' : 'text-violet-400'}`}>
                                            {t.side}
                                        </span>
                                        <span className="font-mono text-xs text-foreground/80 w-12">{t.symbol.split('/')[0]}</span>
                                        {t.psi != null && (
                                            <span className="text-[9px] font-mono text-muted-foreground/40">
                                                Ψ={t.psi.toFixed(3)}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {t.side === 'SELL' && t.realizedPnl != null && (
                                            <span className={`text-xs font-mono ${t.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                {t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)}
                                            </span>
                                        )}
                                        {t.side === 'BUY' && t.dollarAmount != null && (
                                            <span className="text-xs font-mono text-muted-foreground/50">
                                                ${t.dollarAmount.toFixed(0)}
                                            </span>
                                        )}
                                        <span className="text-[10px] font-mono text-muted-foreground/40 w-14 text-right">
                                            {timeAgo(new Date(t.timestamp).getTime())}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* How Ψnix works */}
                <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                    <div className="text-[10px] font-mono text-muted-foreground/60 tracking-widest mb-3">HOW Ψnix WORKS</div>
                    <div className="space-y-2 text-xs text-muted-foreground/70 leading-relaxed">
                        <div className="font-mono text-center text-violet-400/80 text-sm py-2">
                            Ψ(t) = tanh(β&middot;C&middot;&Sigma;w&#7522;&sigma;&#7522;) &times; Kelly &times; C&sup2;
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <div className="rounded-lg bg-white/[0.02] p-2">
                                <div className="text-violet-400/60 font-mono text-[10px] mb-0.5">C(t) — Coherence</div>
                                <div>Kuramoto order parameter. Measures how synchronized all signals are. C=1 means all agree.</div>
                            </div>
                            <div className="rounded-lg bg-white/[0.02] p-2">
                                <div className="text-violet-400/60 font-mono text-[10px] mb-0.5">β(t) — Temperature</div>
                                <div>1/entropy. Ordered markets get sharp decisions. Chaotic markets get cautious ones.</div>
                            </div>
                            <div className="rounded-lg bg-white/[0.02] p-2">
                                <div className="text-violet-400/60 font-mono text-[10px] mb-0.5">C&sup2; — Safety</div>
                                <div>At C=0.5, only 25% position. At C=0.3, only 9%. Built-in protection against noise.</div>
                            </div>
                            <div className="rounded-lg bg-white/[0.02] p-2">
                                <div className="text-violet-400/60 font-mono text-[10px] mb-0.5">Phase Transition</div>
                                <div>Trades only fire when C &gt; 0.6. Like water freezing — sudden state change.</div>
                            </div>
                        </div>
                        <div className="text-[10px] text-muted-foreground/40 font-mono text-center pt-1">
                            Sources: Copynix wallets &middot; Polymarket &middot; Fear & Greed &middot; Smart Money
                        </div>
                    </div>
                </div>

            </div>
        </DashboardLayout>
    );
}
