// apps/web/src/hooks/useSolanix.ts
'use client';

import { useState, useEffect, useCallback } from 'react';

// ── Shared types (mirrored from packages/agents/src/solanix/types.ts) ─────────

export interface SolanaPosition {
  symbol: string;
  mintAddress: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPl: number;
  entryTime: number;
  highWatermark: number;
  trailingStopActive?: boolean;
  stagnationDays?: number;
}

export interface SolanaSignal {
  symbol: string;
  mintAddress: string;
  action: 'BUY' | 'SELL' | 'WAIT';
  confidence: number;
  reasoning: string[];
  currentPrice: number;
  source: 'ta' | 'dexscreener';
  timestamp: number;
}

export interface SolanaAccountState {
  usdcBalance: number;
  solBalance: number;
  portfolioValue: number;
}

// ── Status ────────────────────────────────────────────────────────────────────

interface SolanaRiskState {
  openPositions: number;
  dailyPnl: number;
  paperTrading: boolean;
}

interface SolanixStatus {
  status: string | null;
  account: SolanaAccountState | null;
  risk: SolanaRiskState | null;
  timestamp: string;
}

export function useSolanixStatus(refreshInterval = 10_000) {
  const [data, setData] = useState<SolanixStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/solanix/status');
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

export function useSolanixPositions(refreshInterval = 15_000) {
  const [positions, setPositions] = useState<SolanaPosition[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/solanix/positions');
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

// ── Signals ───────────────────────────────────────────────────────────────────

export function useSolanixSignals(refreshInterval = 30_000) {
  const [signals, setSignals] = useState<SolanaSignal[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/solanix/signals');
      if (!res.ok) { setError(`HTTP ${res.status}`); return; }
      const json = await res.json();
      setSignals(json.signals ?? []);
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

  return { signals, error };
}
