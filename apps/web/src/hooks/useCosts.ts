'use client';

import { useState, useEffect, useCallback } from 'react';

interface CostWindow {
  h24: number;
  d7: number;
  d30: number;
  all: number;
}

interface ModelCost {
  model: string;
  calls: CostWindow;
  cost: CostWindow;
  tokens: { prompt_all: number; completion_all: number };
  first_call: string;
  last_call: string;
}

export interface CostsData {
  models: ModelCost[];
  totals: {
    calls: CostWindow;
    cost: CostWindow;
  };
  estimate: {
    daily_avg: number;
    monthly: number;
    days_tracked: number;
  };
}

export function useCosts(refreshInterval: number = 60000) {
  const [data, setData] = useState<CostsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCosts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/costs');
      const json = await res.json();

      if (json.success) {
        setData(json.data);
        setError(null);
      } else {
        setError(json.error);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch costs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCosts();
    const interval = setInterval(fetchCosts, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchCosts, refreshInterval]);

  return { data, loading, error, refresh: fetchCosts };
}
