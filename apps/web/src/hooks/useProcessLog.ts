'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ProcessEvent } from '@/app/api/process-log/route';
import { useWebSocket } from '@/hooks/use-websocket';

export type { ProcessEvent };

export function useProcessLog(refreshInterval: number = 10000) {
  const [events, setEvents] = useState<ProcessEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { signals: wsSignals, trades: wsTrades, alerts: wsAlerts } = useWebSocket();

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/process-log?limit=80');
      const json = await res.json();
      if (json.success) {
        setEvents(json.events);
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
    fetchEvents();
    const interval = setInterval(fetchEvents, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchEvents, refreshInterval]);

  // Merge WebSocket real-time events on top of DB events
  useEffect(() => {
    if (wsSignals.length === 0 && wsTrades.length === 0 && wsAlerts.length === 0) return;

    const liveEvents: ProcessEvent[] = [];

    for (const sig of wsSignals.slice(0, 5)) {
      liveEvents.push({
        id: `ws-sig-${sig.id || Date.now()}`,
        timestamp: new Date(sig.timestamp || Date.now()).toISOString(),
        type: 'signal_detected',
        symbol: sig.symbol,
        action: sig.action,
        status: 'pending',
        title: `LIVE: ${sig.pattern || 'Signal'} on ${sig.symbol}`,
        description: `${sig.action} at ${((sig.confidence || 0) * 100).toFixed(0)}% confidence`,
        agent: sig.agent_id || 'MarketScout',
        confidence: sig.confidence,
      });
    }

    for (const trade of wsTrades.slice(0, 5)) {
      liveEvents.push({
        id: `ws-trade-${trade.orderId || Date.now()}`,
        timestamp: new Date(trade.timestamp || Date.now()).toISOString(),
        type: 'trade_executed',
        symbol: trade.symbol,
        action: trade.side,
        status: 'executed',
        title: `LIVE: ${trade.side} ${trade.symbol}`,
        description: `Qty: ${trade.quantity} @ $${trade.price?.toLocaleString()}`,
        agent: 'AutoTrader',
      });
    }

    if (liveEvents.length > 0) {
      setEvents(prev => {
        const dbIds = new Set(prev.map(e => e.id));
        const newLive = liveEvents.filter(e => !dbIds.has(e.id));
        return [...newLive, ...prev].slice(0, 100);
      });
    }
  }, [wsSignals, wsTrades, wsAlerts]);

  return { events, loading, error, refresh: fetchEvents };
}
