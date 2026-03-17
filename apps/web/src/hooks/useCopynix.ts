// apps/web/src/hooks/useCopynix.ts
'use client';

import { useState, useEffect, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CopynixStatus {
  status: 'running' | 'stopped' | 'error';
  trackedWallets: number;
  blockchain: string;
  paperTrading: boolean;
  account: {
    portfolioValue: number;
    usdcBalance: number;
  };
  risk: {
    openPositions: number;
    maxPositions: number;
    tradesToday: number;
    maxTradesPerDay: number;
    dailyPnlDollar: number;
  };
  timestamp: string;
}

export interface CopynixPosition {
  symbol: string;
  mint: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  consensusLevel: 'strong' | 'medium' | 'single';
  entryTime: number;
}

export interface CopynixWallet {
  address: string;
  label: string;
  score: number | null;
  winRate: number | null;
  pnl: number | null;
  lastActive: string | null;
}

export interface CopynixTrade {
  id: number;
  timestamp: string;
  symbol: string;
  mint: string;
  side: 'BUY' | 'SELL';
  qty: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  dollarAmount: number | null;
  realizedPnl: number | null;
  consensusLevel: string | null;
  walletCount: number | null;
  confidence: number | null;
  exitReason: string | null;
}

export interface CopynixTradesSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
}

export interface CopynixEquityPoint {
  timestamp: string;
  cumulativePnl: number;
}

// ── Status ───────────────────────────────────────────────────────────────────

export function useCopynixStatus(refreshInterval = 10_000) {
  const [data, setData] = useState<CopynixStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/copynix/status');
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

// ── Portfolio ────────────────────────────────────────────────────────────────

export function useCopynixPortfolio(refreshInterval = 10_000) {
  const [data, setData] = useState<{ portfolioValue: number; usdcBalance: number; dailyPnl: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/copynix/portfolio');
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

// ── Positions ────────────────────────────────────────────────────────────────

export function useCopynixPositions(refreshInterval = 10_000) {
  const [positions, setPositions] = useState<CopynixPosition[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/copynix/positions');
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

// ── Trades ───────────────────────────────────────────────────────────────────

export function useCopynixTrades(limit = 50, refreshInterval = 30_000) {
  const [trades, setTrades] = useState<CopynixTrade[]>([]);
  const [summary, setSummary] = useState<CopynixTradesSummary>({ totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 });
  const [equityCurve, setEquityCurve] = useState<CopynixEquityPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`/api/copynix/trades?limit=${limit}`);
      if (!res.ok) { setError(`HTTP ${res.status}`); return; }
      const json = await res.json();
      setTrades(json.trades ?? []);
      setSummary(json.summary ?? { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 });
      setEquityCurve(json.equityCurve ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [limit]);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, refreshInterval);
    return () => clearInterval(id);
  }, [fetch_, refreshInterval]);

  return { trades, summary, equityCurve, error };
}

// ── Wallets ──────────────────────────────────────────────────────────────────

export function useCopynixWallets(refreshInterval = 60_000) {
  const [wallets, setWallets] = useState<CopynixWallet[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/copynix/wallets');
      if (!res.ok) { setError(`HTTP ${res.status}`); return; }
      const json = await res.json();
      setWallets(json.wallets ?? []);
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

  return { wallets, error };
}
