'use client';

import { useState, useEffect, useCallback } from 'react';
import type { PolynixAccount } from '@/app/api/polynix/portfolio/route';
import type { PolynixPositionApi } from '@/app/api/polynix/positions/route';
import type { PolynixTrade } from '@/app/api/polynix/trades/route';

// -- Status -------------------------------------------------------------------

interface PolynixRisk {
  dailyPnl: number;
  consecutiveLosses: number;
  lastResetDate: string;
  circuitBreakerActive: boolean;
}

interface PolynixStatus {
  status: string | null;
  agent: { running: boolean; paperTrading: boolean };
  account: PolynixAccount | null;
  risk: PolynixRisk | null;
  lastSignal: any;
  timestamp: string;
}

export function usePolynixStatus(refreshInterval = 10_000) {
  const [data, setData] = useState<PolynixStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/polynix/status');
      if (!res.ok) { setError(`HTTP ${res.status}`); return; }
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, refreshInterval);
    return () => clearInterval(id);
  }, [fetch_, refreshInterval]);

  return { data, error };
}

// -- Positions ----------------------------------------------------------------

export function usePolynixPositions(refreshInterval = 10_000) {
  const [positions, setPositions] = useState<PolynixPositionApi[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/polynix/positions');
      if (!res.ok) { setError(`HTTP ${res.status}`); return; }
      const json = await res.json();
      setPositions(json.positions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, refreshInterval);
    return () => clearInterval(id);
  }, [fetch_, refreshInterval]);

  return { positions, error };
}

// -- Trades -------------------------------------------------------------------

interface TradesSummary {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
}

export function usePolynixTrades(refreshInterval = 15_000) {
  const [trades, setTrades] = useState<PolynixTrade[]>([]);
  const [summary, setSummary] = useState<TradesSummary>({ total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 });
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/polynix/trades');
      if (!res.ok) { setError(`HTTP ${res.status}`); return; }
      const json = await res.json();
      setTrades(json.trades ?? []);
      setSummary(json.summary ?? { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, refreshInterval);
    return () => clearInterval(id);
  }, [fetch_, refreshInterval]);

  return { trades, summary, error };
}
