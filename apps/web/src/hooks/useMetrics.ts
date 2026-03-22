'use client';
import { useState, useEffect } from 'react';

export interface EcrHistoryPoint {
    ecr: number;
    realized: number;
    theoretical: number;
    timestamp: number;
}

export interface MetricsData {
    killRate: { killRate: number; profitable: number; total: number; byFilter?: Record<string, { won: number; total: number }> } | null;
    alphaDecay: { patterns: Record<string, { slope: number; trend: string; periods: number; latestEv: number }> } | null;
    mutationFitness: { versions: Array<{ configVersion: string; trades: number; winRate: number; avgPnl: number; sharpe: number }>; comparisons: Array<{ from: string; to: string; deltaSharpe: number; improved: boolean }> } | null;
    capitalVelocity: { velocity: number; volume: number; trades: number; days: number } | null;
    edgeCaptureRatio: { ecr: number; realized: number; theoretical: number; period: string } | null;
    ecrHistory: EcrHistoryPoint[];
}

export function useMetrics(refreshMs = 60_000) {
    const [data, setData] = useState<MetricsData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        const load = async () => {
            try {
                const res = await fetch('/api/metrics');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                if (active) { setData(json); setError(null); }
            } catch (e) { if (active) setError(String(e)); }
        };
        load();
        const id = setInterval(load, refreshMs);
        return () => { active = false; clearInterval(id); };
    }, [refreshMs]);

    return { data, error };
}
