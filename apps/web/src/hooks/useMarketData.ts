'use client';

import { useState, useEffect, useCallback } from 'react';

interface Ticker {
  symbol: string;
  price: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
  timestamp: number;
}

interface Portfolio {
  totalValue: number;
  holdings: Array<{
    currency: string;
    amount: number;
    usdValue: number;
    free: number;
    locked: number;
  }>;
  updated: string;
}

interface Analysis {
  symbol: string;
  marketData: any;
  indicators: any;
  analysis: {
    signal: 'BUY' | 'SELL' | 'HOLD';
    confidence: number;
    entry: number;
    target: number;
    stopLoss: number;
    reasoning: string[];
    summary: string;
  };
}

export function useMarketData(symbol: string = 'BTC/USDT', refreshInterval: number = 10000) {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTicker = useCallback(async () => {
    try {
      const res = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}&action=ticker`);
      const data = await res.json();

      if (data.success) {
        setTicker(data.data);
        setError(null);
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    fetchTicker();
    const interval = setInterval(fetchTicker, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchTicker, refreshInterval]);

  return { ticker, loading, error, refresh: fetchTicker };
}

export function usePortfolio(refreshInterval: number = 30000) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await fetch('/api/portfolio');
      const data = await res.json();

      if (data.success) {
        setPortfolio(data.data);
        setError(null);
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchPortfolio, refreshInterval]);

  return { portfolio, loading, error, refresh: fetchPortfolio, setPortfolio };
}

export function useAnalysis(symbol: string = 'BTC/USDT') {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      const data = await res.json();

      if (data.success) {
        setAnalysis(data.data);
        setError(null);
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  return { analysis, loading, error, analyze };
}

export function useMultipleTickers(symbols: string[] = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']) {
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTickers = useCallback(async () => {
    try {
      const res = await fetch('/api/market?action=tickers');
      const data = await res.json();

      if (data.success) {
        setTickers(data.data);
        setError(null);
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTickers();
    const interval = setInterval(fetchTickers, 10000);
    return () => clearInterval(interval);
  }, [fetchTickers]);

  return { tickers, loading, error, refresh: fetchTickers };
}
