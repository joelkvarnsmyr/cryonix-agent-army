'use client';
import { useState, useEffect } from 'react';

export interface HuntrixStatus {
    status: string;
    paperMode: boolean;
    virtualBalance: number;
    positions: Array<{
        id: string; symbol: string; entry_price: number; current_price: number;
        size_usd: number; quantity: number; unrealized_pnl: number; unrealized_pnl_pct: number;
        trailing_high: number; trailing_active: boolean; entered_at: string;
        signal: { type: string; phase: string; confidence: number; source: string };
    }>;
    recentTrades: Array<{
        id: string; symbol: string; unrealized_pnl: number; unrealized_pnl_pct: number;
        exit_reason: string | null; exited_at: string | null;
        signal: { type: string };
    }>;
    activeSignals: Array<{
        symbol: string; type: string; phase: string; confidence: number;
        total_shill_accounts: number; source: string;
    }>;
    performance: { dailyPnl: number; tradesToday: number; winRate: number; totalTrades: number; totalWins: number };
    circuitBreaker: { consecutiveLosses: number; dailyLoss: number; cooldownUntil: number; isPaused: boolean };
    lastScanAt: string | null;
}

export function useHuntrixStatus(refreshMs = 10_000) {
    const [data, setData] = useState<HuntrixStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        const fetch_ = async () => {
            try {
                const res = await fetch('/api/huntrix/status');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                if (active) { setData(json); setError(null); }
            } catch (e) { if (active) setError(String(e)); }
        };
        fetch_();
        const id = setInterval(fetch_, refreshMs);
        return () => { active = false; clearInterval(id); };
    }, [refreshMs]);

    return { data, error };
}
