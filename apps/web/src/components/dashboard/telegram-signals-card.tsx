"use client";

import { useEffect, useState, useCallback } from 'react';
import { MessageSquare, Zap } from 'lucide-react';
import { Card, CardContent } from '@cryonix/ui';

interface TelegramSignal {
  symbol?: string;
  action?: string;
  confidence?: number;
  channel?: string;
  timestamp?: string;
}

interface ChannelStat {
  channelId: string;
  accuracy?: number;
  total?: number;
  wins?: number;
}

interface TelegramData {
  boostEnabled: boolean;
  activeSignals: number;
  signals: TelegramSignal[];
  channels: ChannelStat[];
}

export function TelegramSignalsCard() {
  const [data, setData]   = useState<TelegramData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/telegram-signals');
      if (!res.ok) return;
      const d = await res.json() as TelegramData;
      setData(d);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 30_000);
    return () => clearInterval(id);
  }, [fetch_]);

  const activeCount   = data?.activeSignals ?? 0;
  const boostEnabled  = data?.boostEnabled  ?? false;
  const channels      = data?.channels      ?? [];
  const signals       = (data?.signals ?? []).slice(0, 5);

  return (
    <Card className="glass-card overflow-hidden">
      <CardContent className="p-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Telegram Signals</span>
          </div>
          <div className="flex items-center gap-2">
            {boostEnabled && (
              <span className="flex items-center gap-1 text-[9px] font-mono text-emerald-400/70 border border-emerald-400/20 bg-emerald-400/5 px-1.5 py-0.5 rounded">
                <Zap className="h-2.5 w-2.5" />
                BOOST ON
              </span>
            )}
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
              activeCount > 0
                ? 'text-emerald-400 border-emerald-400/20 bg-emerald-400/5'
                : 'text-muted-foreground/50 border-white/[0.06]'
            }`}>
              {loading ? '…' : `${activeCount} active`}
            </span>
          </div>
        </div>

        {/* Channel quality */}
        {channels.length > 0 && (
          <div className="mb-3 space-y-1.5">
            {channels.slice(0, 3).map(ch => (
              <div key={ch.channelId} className="flex items-center justify-between text-xs font-mono">
                <span className="text-muted-foreground/60 truncate max-w-[120px]">@{ch.channelId}</span>
                <div className="flex items-center gap-3">
                  {ch.accuracy !== undefined && (
                    <span className={ch.accuracy >= 0.6 ? 'text-emerald-400/70' : 'text-amber-400/70'}>
                      {(ch.accuracy * 100).toFixed(0)}% acc
                    </span>
                  )}
                  {ch.total !== undefined && (
                    <span className="text-muted-foreground/35">{ch.total} sig</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Recent signals */}
        {signals.length > 0 ? (
          <div className="space-y-1">
            {signals.map((sig, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="font-mono text-foreground/70">{sig.symbol ?? '—'}</span>
                <span className={`font-mono text-xs ${
                  sig.action === 'BUY' ? 'text-emerald-400' : sig.action === 'SELL' ? 'text-red-400' : 'text-muted-foreground'
                }`}>{sig.action}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground/40 text-center py-2">
            {loading ? 'Loading…' : 'No active signals'}
          </div>
        )}

        {/* Channel count */}
        <div className="mt-3 text-[9px] font-mono text-muted-foreground/35 text-right">
          {channels.length} channel{channels.length !== 1 ? 's' : ''} tracked
        </div>

      </CardContent>
    </Card>
  );
}
