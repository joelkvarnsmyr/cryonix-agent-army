"use client";

import { Card, CardContent, CardHeader, CardTitle } from '@cryonix/ui';
import { useEffect } from 'react';

interface TradingChartProps {
  symbol: string;
}

export function TradingChart({ symbol }: TradingChartProps) {
  useEffect(() => {
    // TradingView widget will be loaded here
    if (typeof window !== 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://s3.tradingview.com/tv.js';
      script.async = true;
      script.onload = () => {
        if ((window as any).TradingView) {
          new (window as any).TradingView.widget({
            container_id: 'tradingview_chart',
            width: '100%',
            height: 500,
            symbol: `BINANCE:${symbol}`,
            interval: '15',
            timezone: 'Etc/UTC',
            theme: 'dark',
            style: '1',
            locale: 'en',
            toolbar_bg: '#0a0a0a',
            enable_publishing: false,
            hide_top_toolbar: false,
            hide_legend: false,
            save_image: false,
          });
        }
      };
      document.body.appendChild(script);
    }
  }, [symbol]);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{symbol}</span>
          <div className="flex items-center gap-2 text-sm font-normal">
            <span className="text-muted-foreground">15min</span>
            <span className="text-2xl font-bold text-green-500">$96,542</span>
            <span className="text-green-500 text-sm">+2.4%</span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div id="tradingview_chart" className="rounded-lg overflow-hidden" />
      </CardContent>
    </Card>
  );
}
