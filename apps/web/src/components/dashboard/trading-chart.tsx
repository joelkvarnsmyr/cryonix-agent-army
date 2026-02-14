"use client";

import { Card, CardContent } from '@cryonix/ui';
import { useEffect, useRef, useState } from 'react';

interface TradingChartProps {
  symbol?: string;
}

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];

export function TradingChart({ symbol: initialSymbol = 'BTCUSDT' }: TradingChartProps) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !containerRef.current) return;

    // Clear previous widget
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
    }

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.async = true;
    script.onload = () => {
      if ((window as any).TradingView && containerRef.current) {
        widgetRef.current = new (window as any).TradingView.widget({
          container_id: 'tv_chart',
          width: '100%',
          height: '100%',
          symbol: `BINANCE:${symbol}`,
          interval: '15',
          timezone: 'Etc/UTC',
          theme: 'dark',
          style: '1',
          locale: 'en',
          toolbar_bg: '#050a18',
          enable_publishing: false,
          hide_top_toolbar: false,
          hide_legend: false,
          save_image: false,
          backgroundColor: 'rgba(5, 10, 24, 0)',
          gridColor: 'rgba(30, 42, 68, 0.3)',
        });
      }
    };
    document.body.appendChild(script);

    return () => {
      try { document.body.removeChild(script); } catch {}
    };
  }, [symbol]);

  return (
    <Card className="glass-card h-full flex flex-col">
      <CardContent className="p-0 flex-1 flex flex-col">
        {/* Symbol Tabs */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border/30">
          <div className="flex items-center gap-0.5">
            {SYMBOLS.map((sym) => (
              <button
                key={sym}
                onClick={() => setSymbol(sym)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-mono font-medium transition-all ${
                  symbol === sym
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                }`}
              >
                {sym.replace('USDT', '')}
              </button>
            ))}
          </div>
          <span className="text-[9px] font-mono text-muted-foreground/50">15m</span>
        </div>
        {/* Chart Container */}
        <div ref={containerRef} id="tv_chart" className="flex-1 min-h-[300px] rounded-b-lg overflow-hidden" />
      </CardContent>
    </Card>
  );
}
