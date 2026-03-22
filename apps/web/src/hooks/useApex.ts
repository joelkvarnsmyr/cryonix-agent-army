'use client';
import { useState, useEffect } from 'react';

export interface ApexStatus {
    status: string;
    activeMode: string;
    capital: { total: number; deployed: number; available: number; reserve: number } | null;
    positions: Array<{
        id: string; symbol: string; direction: string; mode: string;
        entryPrice: number; currentPrice: number; quantity: number;
        entryTime: number; highWatermark: number; trailingActive: boolean;
        confluenceScore: number;
        contributingSignals: Array<{ source: string; signalType: string; confidence: number; score: number }>;
    }>;
    confluenceBoard: Array<{
        symbol: string; score: number; direction: string; mode: string; signals: string[];
        signalDetails?: Array<{ source: string; signalType: string; confidence: number; score: number }>;
    }>;
    performance: { totalPnl: number; winRate: number; trades: number; maxDrawdown: number };
    circuitBreaker: { drawdown: number; dailyLoss: number; consecutiveLosses: number };
    staleness: Record<string, boolean>;
}

export function useApexStatus(refreshMs = 15_000) {
    const [data, setData] = useState<ApexStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        const fetch_ = async () => {
            try {
                const res = await fetch('/api/apex/status');
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
