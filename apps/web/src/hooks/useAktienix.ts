// apps/web/src/hooks/useAktienix.ts
'use client';

import { useState, useEffect, useCallback } from 'react';
import type { AktienixAccount } from '@/app/api/aktienix/portfolio/route';
import type { AktienixPosition } from '@/app/api/aktienix/positions/route';
import type { AktienixTrade } from '@/app/api/aktienix/trades/route';

// ── Status ────────────────────────────────────────────────────────────────────

interface MarketHours {
  phase: 'pre' | 'regular' | 'after' | 'closed';
  isOpen: boolean;
  localTime: string;
}

interface AgentStatus {
  running: boolean;
  broker: string;
  lastPoll: string | null;
}

interface AktienixStatus {
  market: MarketHours;
  agent: AgentStatus;
  timestamp: string;
}

export function useAktienixStatus(refreshInterval = 30_000) {
  const [data, setData] = useState<AktienixStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/aktienix/status');
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

// ── Portfolio ─────────────────────────────────────────────────────────────────

export function useAktienixPortfolio(refreshInterval = 15_000) {
  const [data, setData] = useState<AktienixAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/aktienix/portfolio');
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

// ── Positions ─────────────────────────────────────────────────────────────────

export function useAktienixPositions(refreshInterval = 15_000) {
  const [positions, setPositions] = useState<AktienixPosition[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/aktienix/positions');
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

// ── Trades ────────────────────────────────────────────────────────────────────

interface TradesSummary {
  total: number;
  winRate: number;
  totalPnl: number;
}

export function useAktienixTrades(limit = 20, refreshInterval = 30_000) {
  const [trades, setTrades] = useState<AktienixTrade[]>([]);
  const [summary, setSummary] = useState<TradesSummary>({ total: 0, winRate: 0, totalPnl: 0 });
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`/api/aktienix/trades?limit=${limit}`);
      if (!res.ok) { setError(`HTTP ${res.status}`); return; }
      const json = await res.json();
      setTrades(json.trades ?? []);
      setSummary(json.summary ?? { total: 0, winRate: 0, totalPnl: 0 });
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

  return { trades, summary, error };
}
