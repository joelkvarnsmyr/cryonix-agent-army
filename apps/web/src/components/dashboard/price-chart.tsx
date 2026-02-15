"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import { Card, CardContent } from '@cryonix/ui';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
} from 'lightweight-charts';

const SYMBOLS = [
  { id: 'BTC/USDC', label: 'BTC' },
  { id: 'ETH/USDC', label: 'ETH' },
  { id: 'SOL/USDC', label: 'SOL' },
  { id: 'BNB/USDC', label: 'BNB' },
];

const TIMEFRAMES = [
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1H' },
  { id: '4h', label: '4H' },
  { id: '1d', label: '1D' },
];

interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MarkerData {
  time: number;
  position: 'belowBar' | 'aboveBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown';
  text: string;
  size: number;
}

export function PriceChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);

  const [symbol, setSymbol] = useState('BTC/USDC');
  const [timeframe, setTimeframe] = useState('15m');
  const [loading, setLoading] = useState(true);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<number>(0);
  const [tradeCount, setTradeCount] = useState(0);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chart-data?action=candles&symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=200`);
      const json = await res.json();

      if (json.success && candleSeriesRef.current && volumeSeriesRef.current) {
        const candles: CandleData[] = json.candles;
        const markers: MarkerData[] = json.markers || [];

        candleSeriesRef.current.setData(candles.map(c => ({
          time: c.time as any,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })));

        volumeSeriesRef.current.setData(candles.map(c => ({
          time: c.time as any,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
        })));

        // Add price lines for trade entries
        setTradeCount(markers.length);
        for (const m of markers.slice(0, 5)) {
          const price = parseFloat(m.text.replace(/[^0-9.]/g, ''));
          if (price > 0) {
            candleSeriesRef.current.createPriceLine({
              price,
              color: m.color,
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: m.position === 'belowBar' ? 'BUY' : 'SELL',
            });
          }
        }

        // Update last price
        if (candles.length > 0) {
          const last = candles[candles.length - 1];
          const first = candles[0];
          setLastPrice(last.close);
          setPriceChange(((last.close - first.open) / first.open) * 100);
        }

        chartRef.current?.timeScale().fitContent();
      }
    } catch (err) {
      console.error('Failed to fetch chart data:', err);
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe]);

  // Create chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'hsl(215, 16%, 47%)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(30, 42, 68, 0.2)' },
        horzLines: { color: 'rgba(30, 42, 68, 0.2)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(0, 212, 255, 0.3)', width: 1, style: 2 },
        horzLine: { color: 'rgba(0, 212, 255, 0.3)', width: 1, style: 2 },
      },
      timeScale: {
        borderColor: 'rgba(30, 42, 68, 0.3)',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(30, 42, 68, 0.3)',
      },
      handleScroll: { vertTouchDrag: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(chartContainerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Fetch data on symbol/timeframe change
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <Card className="glass-card h-full flex flex-col">
      <CardContent className="p-0 flex-1 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
          <div className="flex items-center gap-3">
            {/* Symbol selector */}
            <div className="flex items-center gap-0.5">
              {SYMBOLS.map(s => (
                <button
                  key={s.id}
                  onClick={() => setSymbol(s.id)}
                  className={`px-2 py-1 rounded-md text-[10px] font-mono font-semibold transition-all ${
                    symbol === s.id
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className="h-4 w-px bg-border/30" />

            {/* Timeframe selector */}
            <div className="flex items-center gap-0.5">
              {TIMEFRAMES.map(tf => (
                <button
                  key={tf.id}
                  onClick={() => setTimeframe(tf.id)}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-all ${
                    timeframe === tf.id
                      ? 'bg-muted/40 text-foreground'
                      : 'text-muted-foreground/60 hover:text-muted-foreground'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>

          {/* Price display */}
          <div className="flex items-center gap-2">
            {lastPrice !== null && (
              <>
                <span className="font-mono text-sm font-bold text-foreground">
                  ${lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className={`font-mono text-[10px] font-semibold ${priceChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}%
                </span>
              </>
            )}
            {loading && (
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            )}
          </div>
        </div>

        {/* Chart */}
        <div ref={chartContainerRef} className="flex-1 min-h-[300px]" />

        {/* Legend */}
        <div className="px-3 py-1.5 border-t border-border/20 flex items-center gap-4 text-[9px] font-mono text-muted-foreground/50">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500" /> BUY
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm bg-red-500" /> SELL
          </span>
          <span className="ml-auto">
            {tradeCount > 0
              ? `${tradeCount} trades shown as price lines`
              : 'no trades in range'}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
