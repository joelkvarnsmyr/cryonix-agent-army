"use client";

import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@cryonix/ui';

interface SymbolSentiment {
  score: number;
  volume: string;
  narrative: string;
  alert: string | null;
}

interface SentimentData {
  timestamp: string;
  data: Record<string, SymbolSentiment>;
  model?: string;
  tokens?: number;
}

function scoreColor(score: number): string {
  if (score <= -2) return 'text-red-400';
  if (score < 0) return 'text-orange-400';
  if (score === 0) return 'text-muted-foreground';
  if (score <= 1) return 'text-lime-400';
  return 'text-emerald-400';
}

function scoreLabel(score: number): string {
  if (score <= -2) return 'FEAR';
  if (score < 0) return 'BEARISH';
  if (score === 0) return 'NEUTRAL';
  if (score <= 1) return 'BULLISH';
  return 'GREED';
}

function volumeIcon(vol: string): string {
  if (vol === 'high') return '███';
  if (vol === 'medium') return '██░';
  return '█░░';
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export function SentimentCard() {
  const [data, setData] = useState<SentimentData | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/x-sentiment');
      if (!res.ok) return;
      const json = await res.json();
      if (json.status === 'ok' && json.data) {
        setData(typeof json.data === 'object' && json.data.data ? json.data : { timestamp: new Date().toISOString(), data: json.data });
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => clearInterval(id);
  }, [fetch_]);

  const symbols = data?.data ? Object.entries(data.data) : [];
  const alerts = symbols.filter(([, s]) => s.alert);
  const sorted = [...symbols].sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score));

  return (
    <Card className="glass-card overflow-hidden" style={{ boxShadow: '0 0 0 1px rgba(168,85,247,0.12), 0 0 12px rgba(168,85,247,0.04)' }}>
      <CardContent className="p-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-purple-400/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">X Sentiment</span>
          </div>
          {data?.timestamp && (
            <span className="text-[9px] font-mono text-muted-foreground/40">
              {timeAgo(data.timestamp)}
            </span>
          )}
        </div>

        {/* Alerts */}
        {alerts.length > 0 && (
          <div className="mb-3 space-y-1">
            {alerts.map(([symbol, s]) => (
              <div key={symbol} className="flex items-center gap-1.5 px-2 py-1 rounded bg-red-400/10 border border-red-400/20">
                <AlertTriangle className="h-3 w-3 text-red-400 flex-shrink-0" />
                <span className="text-[10px] font-mono text-red-400 font-semibold">{symbol}</span>
                <span className="text-[10px] font-mono text-red-400/70 truncate">{s.alert}</span>
              </div>
            ))}
          </div>
        )}

        {symbols.length === 0 ? (
          <div className="text-sm text-muted-foreground/40 text-center py-2">No sentiment data</div>
        ) : (
          <div className="space-y-1.5">
            {sorted.slice(0, 8).map(([symbol, s]) => (
              <div key={symbol} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-foreground/80 w-10">{symbol}</span>
                  <span className={`text-[10px] font-mono font-semibold ${scoreColor(s.score)}`}>
                    {s.score > 0 ? '+' : ''}{s.score}
                  </span>
                  <span className={`text-[9px] font-mono ${scoreColor(s.score)}`}>
                    {scoreLabel(s.score)}
                  </span>
                </div>
                <span className="text-[9px] font-mono text-muted-foreground/30" title={`Volume: ${s.volume}`}>
                  {volumeIcon(s.volume)}
                </span>
              </div>
            ))}
          </div>
        )}

        {symbols.length > 0 && (
          <div className="mt-3 text-[9px] font-mono text-muted-foreground/35 text-right">
            {symbols.length} coin{symbols.length !== 1 ? 's' : ''} tracked
          </div>
        )}
      </CardContent>
    </Card>
  );
}
