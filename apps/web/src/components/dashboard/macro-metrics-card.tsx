"use client";

import { useState, useEffect, useCallback } from 'react';
import { Globe, Gauge } from 'lucide-react';
import { Card, CardContent } from '@cryonix/ui';

interface CmcData {
  fearGreed: { value: number; classification: string } | null;
  global: {
    total_market_cap: number;
    btc_dominance: number;
    total_market_cap_yesterday_pct: number;
    btc_dominance_24h_pct: number;
  } | null;
  regime: string;
}

function fgColor(value: number): string {
  if (value <= 25) return 'text-red-400';
  if (value <= 45) return 'text-orange-400';
  if (value <= 55) return 'text-yellow-400';
  if (value <= 75) return 'text-lime-400';
  return 'text-emerald-400';
}

function fgBg(value: number): string {
  if (value <= 25) return 'bg-red-400';
  if (value <= 45) return 'bg-orange-400';
  if (value <= 55) return 'bg-yellow-400';
  if (value <= 75) return 'bg-lime-400';
  return 'bg-emerald-400';
}

const REGIME_STYLE: Record<string, string> = {
  trending:  'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  volatile:  'text-amber-400 bg-amber-400/10 border-amber-400/20',
  ranging:   'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
  unknown:   'text-muted-foreground bg-white/[0.03] border-white/[0.06]',
};

function formatMcap(val: number): string {
  if (val >= 1e12) return `$${(val / 1e12).toFixed(2)}T`;
  if (val >= 1e9) return `$${(val / 1e9).toFixed(0)}B`;
  return `$${(val / 1e6).toFixed(0)}M`;
}

export function MacroMetricsCard() {
  const [data, setData] = useState<CmcData | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/cmc');
      if (res.ok) setData(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => clearInterval(id);
  }, [fetch_]);

  const fg = data?.fearGreed;
  const gl = data?.global;
  const regime = data?.regime ?? 'unknown';
  const hasData = fg || gl;

  return (
    <Card className="glass-card overflow-hidden" style={{ boxShadow: '0 0 0 1px rgba(14,165,233,0.12), 0 0 12px rgba(14,165,233,0.04)' }}>
      <CardContent className="p-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-sky-400/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Macro</span>
          </div>
          <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${REGIME_STYLE[regime] ?? REGIME_STYLE.unknown}`}>
            {regime.toUpperCase()}
          </span>
        </div>

        {!hasData ? (
          <div className="text-sm text-muted-foreground/40 text-center py-2">CMC data unavailable</div>
        ) : (
          <>
            {/* Fear & Greed gauge */}
            {fg && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider">Fear & Greed</span>
                  <span className={`text-xs font-mono font-semibold ${fgColor(fg.value)}`}>
                    {fg.classification}
                  </span>
                </div>
                <div className="relative h-2 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full ${fgBg(fg.value)} transition-all duration-700`}
                    style={{ width: `${fg.value}%` }}
                  />
                </div>
                <div className="flex justify-between mt-0.5">
                  <span className="text-[8px] font-mono text-red-400/40">0</span>
                  <span className={`text-xs font-mono font-bold ${fgColor(fg.value)}`}>{fg.value}</span>
                  <span className="text-[8px] font-mono text-emerald-400/40">100</span>
                </div>
              </div>
            )}

            {/* Global metrics */}
            {gl && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-white/[0.03] p-2.5">
                  <div className="text-[9px] font-mono text-muted-foreground/50 mb-0.5 uppercase tracking-wider">Total MC</div>
                  <div className="font-mono text-sm text-foreground">{formatMcap(gl.total_market_cap)}</div>
                  <div className={`text-[10px] font-mono ${gl.total_market_cap_yesterday_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {gl.total_market_cap_yesterday_pct >= 0 ? '+' : ''}{gl.total_market_cap_yesterday_pct.toFixed(1)}%
                  </div>
                </div>
                <div className="rounded-lg bg-white/[0.03] p-2.5">
                  <div className="text-[9px] font-mono text-muted-foreground/50 mb-0.5 uppercase tracking-wider">BTC Dom</div>
                  <div className="font-mono text-sm text-foreground">{gl.btc_dominance.toFixed(1)}%</div>
                  <div className={`text-[10px] font-mono ${gl.btc_dominance_24h_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {gl.btc_dominance_24h_pct >= 0 ? '+' : ''}{gl.btc_dominance_24h_pct.toFixed(1)}%
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
