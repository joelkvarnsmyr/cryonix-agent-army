"use client";

import Link from 'next/link';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';

const ACCENT_COLORS: Record<string, { text: string; dot: string; chart: string; glow: string }> = {
  cyan:   { text: 'text-primary',     dot: 'bg-primary',     chart: 'hsl(191, 100%, 50%)', glow: 'shadow-[0_0_12px_hsl(191,100%,50%,0.15)]' },
  purple: { text: 'text-purple-400',  dot: 'bg-purple-400',  chart: 'hsl(270, 80%, 70%)',  glow: 'shadow-[0_0_12px_rgba(192,132,252,0.15)]' },
  violet: { text: 'text-violet-400',  dot: 'bg-violet-400',  chart: 'hsl(258, 90%, 66%)',  glow: 'shadow-[0_0_12px_rgba(167,139,250,0.15)]' },
  amber:  { text: 'text-amber-400',   dot: 'bg-amber-400',   chart: 'hsl(38, 92%, 50%)',   glow: 'shadow-[0_0_12px_rgba(251,191,36,0.15)]' },
  orange: { text: 'text-orange-400',  dot: 'bg-orange-400',  chart: 'hsl(25, 95%, 53%)',   glow: 'shadow-[0_0_12px_rgba(251,146,60,0.15)]' },
};

const INSTANCE_ROUTES: Record<string, string> = {
  cryonix: '/',
  vedic: '/vedic',
  aktienix: '/aktienix',
  solanix: '/solanix',
  polynix: '/polynix',
  copynix: '/copynix',
  psinix: '/psinix',
};

interface InstanceCardProps {
  id: string;
  label: string;
  accent: string;
  status: 'online' | 'offline' | 'degraded';
  portfolioValue: number;
  dailyPnl: number;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  maxPositions: number;
  equityCurve: Array<{ date: string; value: number }>;
}

export function InstanceCard({
  id, label, accent, status, portfolioValue, dailyPnl, totalPnl,
  winRate, totalTrades, openPositions, maxPositions, equityCurve,
}: InstanceCardProps) {
  const colors = ACCENT_COLORS[accent] ?? ACCENT_COLORS.cyan;
  const route = INSTANCE_ROUTES[id] ?? '/';
  // Defensive: ensure numeric values are actually numbers (not objects/arrays from API)
  const safePortfolio = typeof portfolioValue === 'number' ? portfolioValue : 0;
  const safeTotalPnl = typeof totalPnl === 'number' ? totalPnl : 0;
  const safeDailyPnl = typeof dailyPnl === 'number' ? dailyPnl : 0;
  const safeWinRate = typeof winRate === 'number' ? winRate : 0;
  const safeOpenPositions = typeof openPositions === 'number' ? openPositions : 0;
  const pnlColor = safeTotalPnl >= 0 ? 'text-emerald-400' : 'text-red-400';
  const dailyColor = safeDailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <Link href={route}>
      <div className={`glass-card rounded-xl p-4 border border-border/20 hover:border-border/40 transition-all cursor-pointer group ${colors.glow}`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${status === 'online' ? colors.dot : status === 'degraded' ? 'bg-amber-400' : 'bg-zinc-500'} ${status === 'online' ? 'animate-pulse-dot' : ''}`} />
            <span className={`text-xs font-bold font-mono tracking-wider ${colors.text}`}>{label}</span>
          </div>
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
            status === 'online' ? 'bg-emerald-400/10 text-emerald-400' :
            status === 'degraded' ? 'bg-amber-400/10 text-amber-400' :
            'bg-zinc-500/10 text-zinc-500'
          }`}>
            {status.toUpperCase()}
          </span>
        </div>

        {/* Sparkline */}
        {equityCurve.length > 2 && (
          <div className="h-12 mb-3 -mx-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={equityCurve}>
                <defs>
                  <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.chart} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={colors.chart} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={colors.chart}
                  strokeWidth={1.5}
                  fill={`url(#grad-${id})`}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-y-2 gap-x-4">
          <div>
            <p className="text-[8px] font-mono text-muted-foreground/50 uppercase">Portfolio</p>
            <p className="text-sm font-mono font-semibold tabular-nums">${safePortfolio.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
          <div>
            <p className="text-[8px] font-mono text-muted-foreground/50 uppercase">Total P&L</p>
            <p className={`text-sm font-mono font-semibold tabular-nums ${pnlColor}`}>
              {safeTotalPnl >= 0 ? '+' : ''}${Math.abs(safeTotalPnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div>
            <p className="text-[8px] font-mono text-muted-foreground/50 uppercase">Win Rate</p>
            <p className="text-sm font-mono font-semibold tabular-nums">{safeWinRate.toFixed(1)}%</p>
          </div>
          <div>
            <p className="text-[8px] font-mono text-muted-foreground/50 uppercase">Positions</p>
            <p className="text-sm font-mono font-semibold tabular-nums">
              {safeOpenPositions}<span className="text-muted-foreground/40">/{maxPositions}</span>
            </p>
          </div>
        </div>

        {/* Daily P&L footer */}
        <div className="mt-3 pt-2 border-t border-border/15 flex items-center justify-between">
          <span className="text-[9px] font-mono text-muted-foreground/45">Today</span>
          <span className={`text-xs font-mono font-semibold tabular-nums ${dailyColor}`}>
            {safeDailyPnl >= 0 ? '+' : ''}${Math.abs(safeDailyPnl).toFixed(2)}
          </span>
        </div>
      </div>
    </Link>
  );
}
