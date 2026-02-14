'use client';

import { useState, useEffect, useCallback } from 'react';

interface AutoTradeConfig {
  TOTAL_CAPITAL: number;
  MAX_POSITION_SIZE_PCT: number;
  MIN_CONFIDENCE: number;
  MAX_DAILY_LOSS_PCT: number;
  MAX_OPEN_POSITIONS: number;
  MAX_TRADES_PER_DAY: number;
  TRADING_MODE: string;
  DEFAULT_LEVERAGE: number;
  TRAILING_STOP_PCT: number;
  AI_VALIDATION: boolean;
}

interface PositionDetail {
  symbol: string;
  side: string;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop: number;
  highWaterMark: number;
  orderId: string;
  openedAt: string;
  pattern: string;
  confidence: number;
  currentPrice: number;
  pnl: number;
  pnlPct: number;
}

interface DailyState {
  date: string;
  tradesExecuted: number;
  dailyPnl: number;
}

interface GridConfig {
  symbol: string;
  levels: Array<{ price: number; triggered: boolean }>;
}

export interface AutoTradeStatus {
  success: boolean;
  status: string;
  config: AutoTradeConfig;
  positions: PositionDetail[];
  dailyState: DailyState;
  queues: { pending: number; approved: number };
  grids: GridConfig[];
  isTestnet: boolean;
}

export function useAutoTrade(refreshInterval: number = 15000) {
  const [data, setData] = useState<AutoTradeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-trade');
      const json = await res.json();
      if (json.success) {
        setData(json);
        setError(null);
      } else {
        setError(json.error || 'Failed to fetch');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchStatus, refreshInterval]);

  return { data, loading, error, refresh: fetchStatus };
}
