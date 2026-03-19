"use client";

import { useState, useEffect, useCallback } from 'react';

interface InstanceData {
  id: string;
  label: string;
  accent: string;
  status: 'online' | 'offline' | 'degraded';
  portfolioValue: number;
  dailyPnl: number;
  dailyPnlPct: number;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  maxPositions: number;
  recentTrades: Array<{
    symbol: string;
    side: string;
    pnl: number;
    timestamp: string;
  }>;
  equityCurve: Array<{ date: string; value: number }>;
}

interface OverviewData {
  timestamp: string;
  totalPortfolioValue: number;
  totalDailyPnl: number;
  blendedWinRate: number;
  instancesOnline: number;
  instancesTotal: number;
  instances: InstanceData[];
}

export function useOverview(refreshInterval = 30000) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, refreshInterval);
    return () => clearInterval(id);
  }, [fetchData, refreshInterval]);

  return { data, loading, error, refetch: fetchData };
}
