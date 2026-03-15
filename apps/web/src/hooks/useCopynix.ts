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
  winRate: number | null;
  pnl: number | null;
  lastActive: string | null;
}

export interface CopynixTrade {
  timestamp: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  price: number;
  qty: number;
  pnl: number | null;
  reason: string;
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
