"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@cryonix/ui';
import {
  Wallet, TrendingUp, TrendingDown, Crosshair, Radio,
  Activity, Zap, Clock, ChevronUp, ChevronDown
} from 'lucide-react';
import { usePortfolio, useMultipleTickers } from '@/hooks/useMarketData';
import { useAutoTrade } from '@/hooks/useAutoTrade';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import * as m from 'motion/react-client';

function LiveClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString('sv-SE', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'UTC',
      }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
      {time} <span className="text-muted-foreground/30">UTC</span>
    </span>
  );
}

function MiniPrice({ symbol, price, change }: { symbol: string; price: number; change: number }) {
  const isUp = change >= 0;
  const formatted = price >= 1000
    ? price.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : price >= 1 ? price.toFixed(2) : price.toFixed(4);

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-muted/10 transition-colors">
      <span className="font-mono text-[10px] font-semibold text-foreground/70">{symbol}</span>
      <span className="font-mono text-[10px] text-foreground/50">${formatted}</span>
      <span className={`font-mono text-[9px] font-medium ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
        {isUp ? '+' : ''}{change.toFixed(1)}%
      </span>
    </div>
  );
}

interface VitalMetricProps {
  label: string;
  value: string;
  subValue?: string;
  icon: typeof Wallet;
  color: string;
  trend?: 'up' | 'down' | null;
}

function VitalMetric({ label, value, subValue, icon: Icon, color, trend }: VitalMetricProps) {
  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex items-center gap-3 px-4 py-2.5"
    >
      <div className={`h-8 w-8 rounded-lg flex items-center justify-center`}
        style={{ background: `${color}12`, border: `1px solid ${color}25` }}>
        <Icon className="h-4 w-4" style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider">{label}</p>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-lg font-bold tracking-tight text-foreground/90">
            {value}
          </span>
          {trend && (
            trend === 'up'
              ? <ChevronUp className="h-3 w-3 text-emerald-400" />
              : <ChevronDown className="h-3 w-3 text-red-400" />
          )}
          {subValue && (
            <span className={`font-mono text-[10px] ${
              subValue.startsWith('+') ? 'text-emerald-400' : subValue.startsWith('-') ? 'text-red-400' : 'text-muted-foreground/60'
            }`}>
              {subValue}
            </span>
          )}
        </div>
      </div>
    </m.div>
  );
}

export function SystemVitals() {
  const { portfolio } = usePortfolio(15000);
  const { data: autoTrade } = useAutoTrade(10000);
  const { health } = useSystemHealth(30000);
  const { tickers } = useMultipleTickers();

  const totalValue = portfolio?.totalValue || 0;
  const dailyPnl = autoTrade?.dailyState?.dailyPnl || 0;
  const dailyPnlPct = totalValue > 0 ? (dailyPnl / totalValue) * 100 : 0;
  const positions = autoTrade?.positions?.length || 0;
  const maxPos = autoTrade?.config?.MAX_OPEN_POSITIONS || 5;
  const pending = autoTrade?.queues?.pending || 0;
  const approved = autoTrade?.queues?.approved || 0;
  const tradesExecuted = autoTrade?.dailyState?.tradesExecuted || 0;
  const maxTrades = autoTrade?.config?.MAX_TRADES_PER_DAY || 6;
  const healthyCount = health?.summary?.healthy || 0;
  const totalServices = health?.summary?.total || 4;
  const isTestnet = autoTrade?.isTestnet ?? true;
  const mode = autoTrade?.config?.TRADING_MODE || 'spot';
  const leverage = autoTrade?.config?.DEFAULT_LEVERAGE || 1;

  // Filter key tickers
  const watchlist = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'DOT/USDT', 'AVAX/USDT'];
  const filteredTickers = tickers
    .filter(t => watchlist.includes(t.symbol))
    .sort((a, b) => watchlist.indexOf(a.symbol) - watchlist.indexOf(b.symbol));

  return (
    <Card className="glass-card overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-center justify-between">
          {/* Left: Key Metrics */}
          <div className="flex items-center divide-x divide-border/30">
            <VitalMetric
              label="Portfolio"
              value={`$${totalValue.toFixed(2)}`}
              icon={Wallet}
              color="#00d4ff"
              trend={dailyPnl > 0 ? 'up' : dailyPnl < 0 ? 'down' : null}
              subValue={dailyPnl !== 0 ? `${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(4)}` : undefined}
            />
            <VitalMetric
              label="Daily P&L"
              value={`${dailyPnlPct >= 0 ? '+' : ''}${dailyPnlPct.toFixed(2)}%`}
              subValue={`${tradesExecuted}/${maxTrades} trades`}
              icon={dailyPnl >= 0 ? TrendingUp : TrendingDown}
              color={dailyPnl >= 0 ? '#10b981' : '#ef4444'}
            />
            <VitalMetric
              label="Positions"
              value={`${positions}/${maxPos}`}
              subValue={`${mode} ${leverage > 1 ? leverage + 'x' : ''}`}
              icon={Crosshair}
              color="#a78bfa"
            />
            <VitalMetric
              label="Signals"
              value={`${pending + approved}`}
              subValue={pending > 0 ? `${pending}p ${approved}a` : 'pipeline clear'}
              icon={Radio}
              color="#f59e0b"
            />
            <VitalMetric
              label="Health"
              value={`${healthyCount}/${totalServices}`}
              subValue={health?.totalLatency ? `${health.totalLatency}ms` : undefined}
              icon={Activity}
              color={healthyCount === totalServices ? '#10b981' : '#f59e0b'}
            />
          </div>

          {/* Right: Live prices + clock + env badge */}
          <div className="flex items-center gap-1 pr-3">
            {/* Mini price tickers */}
            <div className="hidden xl:flex items-center gap-0">
              {filteredTickers.slice(0, 4).map(t => (
                <MiniPrice
                  key={t.symbol}
                  symbol={t.symbol.replace('/USDT', '')}
                  price={t.price}
                  change={t.change24h}
                />
              ))}
            </div>

            {/* Separator */}
            <div className="h-6 w-px bg-border/20 mx-2" />

            {/* Environment badge */}
            <div className={`px-2 py-0.5 rounded text-[8px] font-mono font-bold tracking-wider ${
              isTestnet
                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            }`}>
              {isTestnet ? 'TESTNET' : 'LIVE'}
            </div>

            {/* Clock */}
            <div className="flex items-center gap-1.5 pl-2">
              <Clock className="h-3 w-3 text-muted-foreground/30" />
              <LiveClock />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
