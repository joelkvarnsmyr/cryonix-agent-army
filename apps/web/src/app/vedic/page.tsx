'use client';

import { useEffect, useState, useCallback } from 'react';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import {
  MoonPhaseSvg,
  PlanetGlyph,
  VedicSignalBadge,
} from './vedic-visuals';
import {
  ComposedChart, Line, Bar, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';

// ── Types ────────────────────────────────────────────────────────────

interface VedicStatus {
  scout: {
    running: boolean;
    score: number;
    label: string;
    venusRx: boolean;
    mercuryRx: boolean;
    nRetrogrades: number;
    muhurtaLabel: string;
  };
  moon: {
    nakshatra: string;
    nakshatraBias: string;
    tithi: string;
    tithiNumber: number;
    moonPhasePct: number;
    paksha: string;
    horaLord: string;
    vara: string;
  } | null;
  planets: Record<string, { longitude: number; sign: string; degrees_in_sign: number; speed: number; is_retrograde: boolean }> | null;
  aspects: { active: number; nature: string; score: number } | null;
  trader: {
    running: boolean;
    balance?: number;
    totalPnl?: number;
    totalReturnPct?: number;
    trades?: number;
    wins?: number;
    losses?: number;
    winRate?: number;
    openPositions?: number;
    positions?: string[];
  };
  btd: {
    running: boolean;
    phase?: string;
    daysSinceDirect?: number;
    balance?: number;
    totalPnl?: number;
    totalReturnPct?: number;
    trades?: number;
    wins?: number;
    winRate?: number;
    openPositions?: number;
    entriesThisCycle?: number;
  };
  timestamp: string;
}

interface Position {
  symbol: string;
  pair: string;
  entryPrice: number;
  quantity: number;
  entryTime: number;
  entryReason: string;
  peakPrice: number;
  trailingActive: boolean;
  btdCycle?: string;
  btdDay?: number;
  source: 'trader' | 'btd' | 'futures';
  side?: 'LONG' | 'SHORT';
  currentPrice?: number;
  pnl?: number;
  pnlPct?: number;
}

interface Trade {
  action: string;
  base_asset: string;
  price: number;
  quantity: number;
  pnl?: number;
  pnl_pct?: number;
  reason?: string;
  hold_hours?: number;
  source: string;
  timestamp: number;
  datetime?: string;
}

interface TradesSummary {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
}

// ── V4 Signal definitions ───────────────────────────────────────────

interface V4Signal {
  name: string;
  key: string;
  bullishPts: number;
  bearishPts: number;
  description: string;
}

const V4_SIGNALS: V4Signal[] = [
  { name: 'Venus Rx', key: 'venus_rx', bullishPts: 0, bearishPts: -40, description: 'Venus retrograde gate' },
  { name: 'Jup-Sat Tight', key: 'jupiter_saturn_tight', bullishPts: 15, bearishPts: 0, description: 'Jupiter-Saturn conjunction' },
  { name: 'Mars-Rahu Tight', key: 'mars_rahu_tight', bullishPts: 10, bearishPts: 0, description: 'Mars-Rahu conjunction' },
  { name: 'Merc-Ven Tight', key: 'mercury_venus_tight', bullishPts: 0, bearishPts: -10, description: 'Mercury-Venus conjunction' },
  { name: 'Merc Speed', key: 'mercury_speed_fast', bullishPts: 8, bearishPts: 0, description: 'Mercury fast motion' },
  { name: 'Venus Speed', key: 'venus_speed_fast', bullishPts: 8, bearishPts: 0, description: 'Venus fast motion' },
  { name: 'Retro Count', key: 'retro_count', bullishPts: 5, bearishPts: -5, description: '0 retro=+5, 3+=−5' },
  { name: 'Venus-Sun', key: 'venus_near_sun', bullishPts: 0, bearishPts: -10, description: 'Venus combust (near Sun)' },
  { name: 'Eclipse Prox', key: 'eclipse_proximity', bullishPts: 0, bearishPts: -5, description: 'Proximity to eclipse' },
  { name: 'Planet Spread', key: 'planetary_spread', bullishPts: 5, bearishPts: -5, description: 'Planetary distribution' },
];

// ── Helpers ─────────────────────────────────────────────────────────

function formatHoldTime(entryTimeSec: number): string {
  const now = Date.now();
  // entryTime from Python is in SECONDS, Date.now() is in MILLISECONDS
  const entryMs = entryTimeSec < 1e12 ? entryTimeSec * 1000 : entryTimeSec;
  const diffMs = now - entryMs;
  if (diffMs < 0) return '0m';
  const totalMin = Math.floor(diffMs / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

function truncateReason(reason: string | undefined, maxLen = 25): string {
  if (!reason) return '';
  // Strip common boilerplate prefixes
  let r = reason
    .replace(/^(Entry reason: |Reason: |Signal: )/i, '')
    .replace(/score=\d+/g, '')
    .trim();
  if (r.length <= maxLen) return r;
  return r.slice(0, maxLen) + '...';
}

function computeDeployed(positions: Position[]): number {
  return positions.reduce((sum, p) => sum + p.entryPrice * p.quantity, 0);
}

// ── Upcoming events ─────────────────────────────────────────────────

function getUpcomingEvents(): { label: string; detail: string; color: string }[] {
  const now = new Date();
  const mercuryDirectDate = new Date('2026-03-21T00:00:00Z');
  const diffMs = mercuryDirectDate.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  const events: { label: string; detail: string; color: string }[] = [];
  if (diffDays > 0) {
    events.push({ label: 'Mercury Direct', detail: `in ${diffDays} day${diffDays !== 1 ? 's' : ''} (Mar 21)`, color: 'text-amber-400' });
  } else if (diffDays === 0) {
    events.push({ label: 'Mercury Direct', detail: 'TODAY', color: 'text-green-400' });
  } else {
    events.push({ label: 'Mercury Direct', detail: 'passed (Mar 21)', color: 'text-zinc-500' });
  }
  events.push({ label: 'Next Venus Rx', detail: '~October 2026', color: 'text-purple-400' });
  return events;
}

// ── Phase colors ─────────────────────────────────────────────────────

const phaseColors: Record<string, string> = {
  WAITING: 'text-zinc-400',
  VENUS_RX: 'text-red-400',
  COUNTDOWN: 'text-amber-400',
  ACTIVE: 'text-green-400',
  COOLDOWN: 'text-blue-400',
  OFFLINE: 'text-zinc-600',
};

const labelColors: Record<string, string> = {
  strong_buy: 'text-green-400 bg-green-400/10',
  buy: 'text-green-300 bg-green-300/10',
  neutral: 'text-zinc-400 bg-zinc-400/10',
  avoid: 'text-amber-400 bg-amber-400/10',
  strong_avoid: 'text-red-400 bg-red-400/10',
  venus_rx_block: 'text-red-500 bg-red-500/20 animate-pulse',
};

// ── Page ─────────────────────────────────────────────────────────────

export default function VedicPage() {
  const [status, setStatus] = useState<VedicStatus | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [summary, setSummary] = useState<TradesSummary | null>(null);
  const [forecast, setForecast] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, posRes, tradesRes] = await Promise.all([
        fetch('/api/vedic/status'),
        fetch('/api/vedic/positions'),
        fetch('/api/vedic/trades'),
      ]);
      if (statusRes.ok) setStatus(await statusRes.json());
      if (posRes.ok) {
        const p = await posRes.json();
        setPositions(p.positions ?? []);
      }
      if (tradesRes.ok) {
        const t = await tradesRes.json();
        setTrades(t.trades ?? []);
        setSummary(t.summary ?? null);
      }
      const forecastRes = await fetch('/api/vedic/forecast');
      if (forecastRes.ok) {
        const fc = await forecastRes.json();
        setForecast(fc.forecast ?? []);
      }
      setError(null);
    } catch (err) {
      setError('Failed to fetch vedic data');
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 10_000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  const s = status?.scout;
  const m = status?.moon;
  const tr = status?.trader;
  const btd = status?.btd;
  const fut = (status as any)?.futures;
  const bayes = (status as any)?.bayes;
  const upcomingEvents = getUpcomingEvents();

  // Compute deployed capital per wallet
  const traderPositions = positions.filter(p => p.source === 'trader');
  const btdPositions = positions.filter(p => p.source === 'btd');
  const futuresPositions = positions.filter(p => p.source === 'futures');
  const traderDeployed = computeDeployed(traderPositions);
  const btdDeployed = computeDeployed(btdPositions);
  const futuresDeployed = computeDeployed(futuresPositions);
  const traderEquity = (tr?.balance ?? 0) + traderDeployed;
  const btdEquity = (btd?.balance ?? 0) + btdDeployed;
  const futuresEquity = (fut?.balance ?? 0) + futuresDeployed;

  // Futures: count open longs/shorts
  const futuresLongs = futuresPositions.filter(p => p.side === 'LONG').length;
  const futuresShorts = futuresPositions.filter(p => p.side === 'SHORT').length;

  // Futures closed trade counts for WR
  const futuresClosed = fut?.trades ?? 0;

  return (
    <DashboardLayout>
      <div className="space-y-4 p-4 max-w-6xl mx-auto">
        {/* ── Header + Upcoming Events ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-purple-400">VEDIC</h1>
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono">
              V4 DATA-DRIVEN
            </span>
            {s?.venusRx && (
              <span className="text-xs px-2 py-0.5 rounded bg-red-500/30 text-red-300 animate-pulse font-bold">
                VENUS Rx ACTIVE
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {/* Upcoming Events */}
            <div className="flex items-center gap-3">
              {upcomingEvents.map((ev, i) => (
                <div key={i} className="flex items-center gap-1.5 text-xs">
                  <span className={`font-mono font-bold ${ev.color}`}>{ev.label}</span>
                  <span className="text-zinc-500">{ev.detail}</span>
                </div>
              ))}
            </div>
            <span className="text-xs text-zinc-500">{status?.timestamp ? new Date(status.timestamp).toLocaleString() : ''}</span>
          </div>
        </div>

        {error && <div className="text-red-400 text-sm bg-red-500/10 px-3 py-2 rounded">{error}</div>}

        {/* ── V3 Score Card ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Score */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500 mb-1">V4 Composite Score</div>
            <div className="flex items-center gap-3">
              <span className={`text-4xl font-bold font-mono ${(s?.score ?? 0) > 0 ? 'text-green-400' : (s?.score ?? 0) < -20 ? 'text-red-400' : 'text-zinc-300'}`}>
                {s?.score ?? '—'}
              </span>
              <span className={`text-sm px-2 py-0.5 rounded font-mono ${labelColors[s?.label ?? ''] ?? 'text-zinc-500'}`}>
                {s?.label ?? 'loading'}
              </span>
            </div>
            <div className="mt-2 flex gap-3 text-xs text-zinc-500">
              <span>Venus Rx: <span className={s?.venusRx ? 'text-red-400 font-bold' : 'text-green-400'}>{s?.venusRx ? 'YES' : 'No'}</span></span>
              <span>Merc Rx: <span className={s?.mercuryRx ? 'text-amber-400' : 'text-zinc-400'}>{s?.mercuryRx ? 'YES' : 'No'}</span></span>
              <span>Retro: {s?.nRetrogrades ?? 0}</span>
            </div>
          </div>

          {/* Moon */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500 mb-1">Moon State</div>
            {m ? (
              <div className="flex items-center gap-3">
                <MoonPhaseSvg phase={m.moonPhasePct} size={48} paksha={m.paksha} />
                <div>
                  <div className="text-sm font-mono text-zinc-200">{m.nakshatra}</div>
                  <div className="text-xs text-zinc-500">{m.tithi} ({m.paksha}) #{m.tithiNumber}</div>
                  <div className="text-xs text-zinc-500">Phase: {m.moonPhasePct}% | Hora: {m.horaLord} | {m.vara}</div>
                </div>
              </div>
            ) : <div className="text-zinc-600 text-sm">Loading...</div>}
          </div>

          {/* Planets */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500 mb-1">Planets</div>
            {status?.planets ? (
              <div className="grid grid-cols-3 gap-1 text-xs">
                {Object.entries(status.planets).map(([name, p]) => (
                  <div key={name} className={`flex items-center gap-1 ${p.is_retrograde ? 'text-red-400' : 'text-zinc-400'}`}>
                    <PlanetGlyph planet={name} size={14} />
                    <span className="font-mono">{p.sign.slice(0, 3)}</span>
                    {p.is_retrograde && <span className="text-[10px]">Rx</span>}
                  </div>
                ))}
              </div>
            ) : <div className="text-zinc-600 text-sm">Loading...</div>}
          </div>
        </div>

        {/* ── Wallets ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* V3 Trader Wallet */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${tr?.running ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'}`} />
                <span className="text-sm font-bold text-zinc-200">V3 Trader</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">PAPER</span>
              </div>
              <span className="text-xs text-zinc-500">{tr?.openPositions ?? 0} pos</span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <div className="text-lg font-mono text-zinc-200">${tr?.balance?.toFixed(0) ?? '—'}</div>
                <div className="text-[10px] text-zinc-500">Cash</div>
              </div>
              <div>
                <div className="text-lg font-mono text-zinc-300">${traderEquity.toFixed(0)}</div>
                <div className="text-[10px] text-zinc-500">Equity</div>
              </div>
              <div>
                <div className={`text-lg font-mono ${(tr?.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  ${tr?.totalPnl?.toFixed(2) ?? '0.00'}
                </div>
                <div className="text-[10px] text-zinc-500">P&L</div>
              </div>
              <div>
                <div className="text-lg font-mono text-zinc-200">{tr?.winRate?.toFixed(0) ?? 0}%</div>
                <div className="text-[10px] text-zinc-500">WR ({tr?.trades ?? 0}T)</div>
              </div>
            </div>
            {traderDeployed > 0 && (
              <div className="mt-2 text-xs text-blue-400 bg-blue-400/10 rounded px-2 py-1">
                Deployed: ${traderDeployed.toFixed(2)} across {traderPositions.length} position{traderPositions.length !== 1 ? 's' : ''}
              </div>
            )}
          </div>

          {/* BTD Wallet */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${btd?.running ? 'bg-purple-400 animate-pulse' : 'bg-zinc-600'}`} />
                <span className="text-sm font-bold text-zinc-200">BTD Trader</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">PAPER</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${phaseColors[btd?.phase ?? ''] ?? 'text-zinc-600'}`}>
                  {btd?.phase ?? 'OFFLINE'}
                </span>
              </div>
              <span className="text-xs text-zinc-500">
                {btd?.phase === 'ACTIVE' ? `Day ${btd?.daysSinceDirect?.toFixed(0)}` : ''}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <div className="text-lg font-mono text-zinc-200">${btd?.balance?.toFixed(0) ?? '—'}</div>
                <div className="text-[10px] text-zinc-500">Cash</div>
              </div>
              <div>
                <div className="text-lg font-mono text-zinc-300">${btdEquity.toFixed(0)}</div>
                <div className="text-[10px] text-zinc-500">Equity</div>
              </div>
              <div>
                <div className={`text-lg font-mono ${(btd?.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  ${btd?.totalPnl?.toFixed(2) ?? '0.00'}
                </div>
                <div className="text-[10px] text-zinc-500">P&L</div>
              </div>
              <div>
                <div className="text-lg font-mono text-zinc-200">{btd?.winRate?.toFixed(0) ?? 0}%</div>
                <div className="text-[10px] text-zinc-500">WR ({btd?.trades ?? 0}T)</div>
              </div>
            </div>
            {btdDeployed > 0 && (
              <div className="mt-2 text-xs text-purple-400 bg-purple-400/10 rounded px-2 py-1">
                Deployed: ${btdDeployed.toFixed(2)} across {btdPositions.length} position{btdPositions.length !== 1 ? 's' : ''}
              </div>
            )}
            {btd?.phase === 'COUNTDOWN' && (
              <div className="mt-2 text-xs text-amber-400 bg-amber-400/10 rounded px-2 py-1">
                Venus went direct — BTD entry in {Math.max(0, 7 - (btd?.daysSinceDirect ?? 0)).toFixed(0)} days
              </div>
            )}
            {btd?.phase === 'ACTIVE' && (
              <div className="mt-2 text-xs text-green-400 bg-green-400/10 rounded px-2 py-1">
                BTD window ACTIVE — {Math.max(0, 60 - (btd?.daysSinceDirect ?? 0)).toFixed(0)} days remaining | RSI&lt;50 filter
              </div>
            )}
          </div>
        </div>

        {/* ── Futures Wallet ── */}
        {fut?.running && (
          <div className="bg-zinc-900 border border-purple-500/30 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                <span className="text-sm font-bold text-zinc-200">Futures Paper</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">BAYES-DRIVEN</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">LONG+SHORT</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {futuresLongs > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-mono">{futuresLongs} LONG</span>
                )}
                {futuresShorts > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 font-mono">{futuresShorts} SHORT</span>
                )}
                {futuresLongs === 0 && futuresShorts === 0 && (
                  <span className="text-zinc-500">0 pos</span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-5 gap-2 text-center">
              <div>
                <div className="text-lg font-mono text-zinc-200">${fut.balance?.toFixed(0)}</div>
                <div className="text-[10px] text-zinc-500">Cash</div>
              </div>
              <div>
                <div className="text-lg font-mono text-zinc-300">${futuresEquity.toFixed(0)}</div>
                <div className="text-[10px] text-zinc-500">Equity</div>
              </div>
              <div>
                <div className={`text-lg font-mono ${fut.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  ${fut.totalPnl?.toFixed(2)}
                </div>
                <div className="text-[10px] text-zinc-500">P&L</div>
              </div>
              <div>
                <div className="text-lg font-mono text-zinc-200">
                  {futuresClosed > 0 ? `${fut.winRate?.toFixed(0)}%` : '—'}
                </div>
                <div className="text-[10px] text-zinc-500">WR ({futuresClosed}T)</div>
              </div>
              <div>
                <div className="text-sm font-mono text-zinc-300">${futuresDeployed.toFixed(0)}</div>
                <div className="text-[10px] text-zinc-500">Deployed</div>
              </div>
            </div>
          </div>
        )}

        {/* ── V4 Active Signals ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-bold text-zinc-300">V4 Active Signals</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">10 SIGNALS</span>
            {s && (
              <span className={`text-xs font-mono ml-auto ${(s.score ?? 0) > 0 ? 'text-green-400' : (s.score ?? 0) < 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                Net: {s.score > 0 ? '+' : ''}{s.score} pts
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {V4_SIGNALS.map((sig) => {
              // Determine signal state from status data
              const bayesSignals = bayes?.signals || {};
              const bayesSig = bayesSignals[sig.key];
              // Use bayes signal data if available, otherwise infer from scout flags
              let isActive = false;
              let isBullish = false;
              let isBearish = false;
              let points = 0;

              if (bayesSig) {
                // For binary signals: "True" = signal is firing, "False" = inactive
                const stateTrue = bayesSig.state === 'True';
                // Venus Rx, Merc-Ven tight, Venus near Sun, Eclipse = bearish when True
                const isBearishSignal = ['venus_rx', 'merc_venus_tight', 'venus_near_sun', 'eclipse_near'].includes(sig.key);
                isActive = stateTrue;
                isBullish = stateTrue && !isBearishSignal;
                isBearish = stateTrue && isBearishSignal;
                points = isActive ? (isBearish ? sig.bearishPts : sig.bullishPts) : 0;
              } else {
                // Fallback: infer from known scout data
                if (sig.key === 'venus_rx') {
                  isActive = s?.venusRx ?? false;
                  isBearish = isActive;
                  points = isActive ? sig.bearishPts : 0;
                } else if (sig.key === 'retro_count') {
                  const n = s?.nRetrogrades ?? 0;
                  isActive = n === 0 || n >= 3;
                  isBullish = n === 0;
                  isBearish = n >= 3;
                  points = isBullish ? sig.bullishPts : isBearish ? sig.bearishPts : 0;
                } else if (sig.key === 'mercury_speed_fast' || sig.key === 'venus_speed_fast') {
                  // Check from planet speeds if available
                  const planetName = sig.key === 'mercury_speed_fast' ? 'Mercury' : 'Venus';
                  const planetData = status?.planets?.[planetName];
                  if (planetData && !planetData.is_retrograde && planetData.speed > 1.2) {
                    isActive = true;
                    isBullish = true;
                    points = sig.bullishPts;
                  }
                } else if (sig.key === 'venus_near_sun') {
                  const venus = status?.planets?.Venus;
                  const sun = status?.planets?.Sun;
                  if (venus && sun) {
                    const diff = Math.abs(venus.longitude - sun.longitude);
                    const angDist = diff > 180 ? 360 - diff : diff;
                    if (angDist < 10) {
                      isActive = true;
                      isBearish = true;
                      points = sig.bearishPts;
                    }
                  }
                }
              }

              const bgColor = isActive
                ? isBullish
                  ? 'bg-green-500/10 border-green-500/30'
                  : 'bg-red-500/10 border-red-500/30'
                : 'bg-zinc-800/50 border-zinc-700/30';
              const textColor = isActive
                ? isBullish
                  ? 'text-green-400'
                  : 'text-red-400'
                : 'text-zinc-600';

              return (
                <div key={sig.key} className={`rounded-lg border px-2.5 py-2 ${bgColor}`}>
                  <div className={`text-[10px] font-mono font-bold ${textColor}`}>{sig.name}</div>
                  <div className="flex items-center justify-between mt-1">
                    <span className={`text-xs font-mono ${isActive ? textColor : 'text-zinc-700'}`}>
                      {isActive ? (points > 0 ? `+${points}` : `${points}`) : '--'}
                    </span>
                    <span className={`text-[9px] font-mono ${isActive ? 'text-zinc-400' : 'text-zinc-700'}`}>
                      {isActive ? (isBullish ? 'BULL' : 'BEAR') : 'OFF'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Bayesian Score ── */}
        {bayes && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-zinc-300">Bayesian Posterior</h3>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">SELF-LEARNING</span>
                <span className="text-[10px] text-zinc-600">{bayes.totalTrades} obs</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">P(up)=</span>
                <span className={`text-lg font-mono font-bold ${bayes.probability > 0.55 ? 'text-green-400' : bayes.probability < 0.45 ? 'text-red-400' : 'text-zinc-300'}`}>
                  {(bayes.probability * 100).toFixed(1)}%
                </span>
                <span className={`text-sm px-2 py-0.5 rounded font-mono ${labelColors[bayes.label] ?? 'text-zinc-500'}`}>
                  {bayes.label}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-3 md:grid-cols-5 gap-2 text-xs">
              {Object.entries(bayes.signals || {}).map(([name, sig]: [string, any]) => (
                <div key={name} className={`rounded px-2 py-1 ${sig.direction === 'bullish' ? 'bg-green-500/10 text-green-400' : sig.direction === 'bearish' ? 'bg-red-500/10 text-red-400' : 'bg-zinc-800 text-zinc-500'}`}>
                  <div className="font-mono text-[10px] opacity-60">{name}</div>
                  <div className="font-mono">{sig.state} <span className="opacity-50">LR={sig.lr}</span></div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Open Positions ── */}
        {positions.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-zinc-300">Open Positions</h3>
              <span className="text-xs text-zinc-500">{positions.length} total</span>
            </div>

            {/* Group: Trader */}
            {traderPositions.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold">V3 TRADER</span>
                  <span className="text-[10px] text-zinc-500">{traderPositions.length} pos | ${traderDeployed.toFixed(2)} deployed</span>
                </div>
                <div className="space-y-1.5">
                  {traderPositions.map((pos, i) => (
                    <PositionRow key={`trader-${i}`} pos={pos} />
                  ))}
                </div>
              </div>
            )}

            {/* Group: BTD */}
            {btdPositions.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold">BTD</span>
                  <span className="text-[10px] text-zinc-500">{btdPositions.length} pos | ${btdDeployed.toFixed(2)} deployed</span>
                </div>
                <div className="space-y-1.5">
                  {btdPositions.map((pos, i) => (
                    <PositionRow key={`btd-${i}`} pos={pos} />
                  ))}
                </div>
              </div>
            )}

            {/* Group: Futures */}
            {futuresPositions.length > 0 && (
              <div className="mb-1">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold">FUTURES</span>
                  <span className="text-[10px] text-zinc-500">{futuresPositions.length} pos | ${futuresDeployed.toFixed(2)} deployed</span>
                </div>
                <div className="space-y-1.5">
                  {futuresPositions.map((pos, i) => (
                    <PositionRow key={`fut-${i}`} pos={pos} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Trade History ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-zinc-300">Trade History</h3>
            {summary && (
              <div className="flex gap-3 text-xs text-zinc-500">
                <span>{summary.total} trades</span>
                <span className="text-green-400">{summary.wins}W</span>
                <span className="text-red-400">{summary.losses}L</span>
                <span>WR: {summary.winRate}%</span>
                <span className={summary.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                  ${summary.totalPnl.toFixed(2)}
                </span>
              </div>
            )}
          </div>
          {trades.length === 0 ? (
            <div className="text-zinc-600 text-sm py-4 text-center">No trades yet</div>
          ) : (
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {trades.slice(0, 50).map((t, i) => (
                <div key={i} className={`flex items-center justify-between text-xs py-1.5 px-2 rounded ${t.action === 'SELL' ? (t.pnl && t.pnl > 0 ? 'bg-green-500/5' : 'bg-red-500/5') : 'bg-zinc-800/30'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono font-bold ${t.action === 'BUY' ? 'text-green-400' : t.pnl && t.pnl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {t.action}
                    </span>
                    <span className={`px-1 rounded text-[10px] ${t.source === 'btd' ? 'bg-purple-500/20 text-purple-300' : t.source === 'futures' ? 'bg-purple-500/20 text-purple-300' : 'bg-blue-500/20 text-blue-300'}`}>
                      {t.source === 'btd' ? 'BTD' : t.source === 'futures' ? 'FUT' : 'V3'}
                    </span>
                    <span className="font-mono text-zinc-300">{t.base_asset}</span>
                    <span className="text-zinc-500">@ ${t.price?.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {t.pnl != null && (
                      <span className={`font-mono ${t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${t.pnl.toFixed(2)} ({t.pnl_pct?.toFixed(1)}%)
                      </span>
                    )}
                    {t.hold_hours != null && <span className="text-zinc-600">{t.hold_hours.toFixed(0)}h</span>}
                    <span className="text-zinc-600">{t.reason?.slice(0, 30)}</span>
                    <span className="text-zinc-700">{t.datetime ? new Date(t.datetime).toLocaleDateString() : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── V4 Score Forecast ── */}
        {forecast.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-zinc-300">V4 Score Forecast — Next 60 Days</h3>
              <span className="text-[10px] text-zinc-500">Deterministic (planetary positions pre-computed)</span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={forecast} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#666' }} interval={6} />
                <YAxis tick={{ fontSize: 9, fill: '#666' }} domain={[-50, 50]} />
                <Tooltip
                  contentStyle={{ background: '#1a1a1a', border: '1px solid #333', fontSize: 11 }}
                  labelStyle={{ color: '#999' }}
                  formatter={(value: number, name: string) => [value, name === 'score' ? 'V4 Score' : name]}
                />
                <ReferenceLine y={0} stroke="#555" strokeDasharray="3 3" />
                <ReferenceLine y={8} stroke="#22c55e" strokeDasharray="2 2" strokeOpacity={0.3} label={{ value: 'Buy', fill: '#22c55e', fontSize: 9 }} />
                <ReferenceLine y={-8} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.3} label={{ value: 'Avoid', fill: '#ef4444', fontSize: 9 }} />
                <Area dataKey="score" fill="#8b5cf6" fillOpacity={0.1} stroke="none" />
                <Line dataKey="score" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                {/* Mercury Rx indicator: show dots where Mercury is Rx */}
                <Line
                  dataKey={(d: any) => d.mercury_rx ? d.score : null}
                  stroke="#f59e0b"
                  strokeWidth={0}
                  dot={{ fill: '#f59e0b', r: 3 }}
                  connectNulls={false}
                  name="Mercury Rx"
                />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="flex gap-4 mt-1 text-[10px] text-zinc-500">
              <span><span className="inline-block w-3 h-0.5 bg-purple-500 mr-1"></span>V4 Score</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1"></span>Mercury Rx</span>
              <span className="text-green-500">--- Buy zone (&ge;8)</span>
              <span className="text-red-500">--- Avoid zone (&le;-8)</span>
            </div>
          </div>
        )}

        {/* ── Trade P&L Chart ── */}
        {trades.filter(t => t.pnl != null).length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-zinc-300">Trade P&L</h3>
              <span className="text-[10px] text-zinc-500">{summary?.total ?? 0} closed trades</span>
            </div>
            <ResponsiveContainer width="100%" height={150}>
              <ComposedChart
                data={trades.filter(t => t.pnl != null).map((t, i) => ({
                  name: `${t.base_asset} ${t.source}`,
                  pnl: t.pnl,
                  pnlPct: t.pnl_pct,
                  idx: i,
                }))}
                margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#666' }} />
                <YAxis tick={{ fontSize: 9, fill: '#666' }} />
                <Tooltip
                  contentStyle={{ background: '#1a1a1a', border: '1px solid #333', fontSize: 11 }}
                  formatter={(value: number) => [`$${value.toFixed(2)}`, 'P&L']}
                />
                <ReferenceLine y={0} stroke="#555" />
                <Bar
                  dataKey="pnl"
                  fill="#22c55e"
                  radius={[2, 2, 0, 0]}
                >
                  {trades.filter(t => t.pnl != null).map((t, i) => (
                    <Cell key={i} fill={(t.pnl ?? 0) >= 0 ? '#22c55e' : '#ef4444'} />
                  ))}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── Research Info ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-bold text-zinc-300 mb-2">Research Basis</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-zinc-500">
            <div>
              <div className="text-zinc-400 font-bold mb-1">V4 Model</div>
              <p>6 symbols x 2000 days. OOS validated +3.4%.</p>
              <p>10 signals: Venus Rx gate (p&lt;0.0001) + planetary aspects + speeds.</p>
            </div>
            <div>
              <div className="text-zinc-400 font-bold mb-1">BTD Strategy</div>
              <p>Entry Day+7 post-Venus-Rx, RSI&lt;50 filter.</p>
              <p>+33.7% avg 60d return. SL=12%, TP=40%.</p>
              <p>Mercury Rx gate (skip if both Rx).</p>
            </div>
            <div>
              <div className="text-zinc-400 font-bold mb-1">SHORT Signal (Futures)</div>
              <p>Sharpe 4.49, 96.4% WR, +6.5%/trade.</p>
              <p>Day+7 into Rx + trailing stop.</p>
              <p className="text-amber-400">Requires futures account (prepared).</p>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

// ── Position Row Component ────────────────────────────────────────────

function PositionRow({ pos }: { pos: Position }) {
  const holdTime = formatHoldTime(pos.entryTime);
  const deployed = pos.entryPrice * pos.quantity;
  const pnl = pos.pnl ?? (pos.currentPrice ? (pos.currentPrice - pos.entryPrice) * pos.quantity * (pos.side === 'SHORT' ? -1 : 1) : null);
  const pnlPct = pos.pnlPct ?? (pnl != null && deployed > 0 ? (pnl / deployed) * 100 : null);

  const sourceColors: Record<string, string> = {
    trader: 'bg-blue-500/20 text-blue-300',
    btd: 'bg-purple-500/20 text-purple-300',
    futures: 'bg-purple-500/20 text-purple-300',
  };
  const sourceLabel: Record<string, string> = {
    trader: 'V3',
    btd: 'BTD',
    futures: 'FUT',
  };

  return (
    <div className="flex items-center justify-between bg-zinc-800/50 rounded px-3 py-2">
      <div className="flex items-center gap-2">
        {/* Source badge */}
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${sourceColors[pos.source] ?? 'bg-zinc-700 text-zinc-400'}`}>
          {sourceLabel[pos.source] ?? pos.source.toUpperCase()}
        </span>
        {/* Side badge for futures */}
        {pos.source === 'futures' && pos.side && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ${pos.side === 'LONG' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
            {pos.side}
          </span>
        )}
        {/* Symbol */}
        <span className="font-mono text-sm text-zinc-200">{pos.symbol}</span>
        <span className="text-xs text-zinc-500">@ ${pos.entryPrice.toLocaleString()}</span>
        {/* P&L badge */}
        {pnl != null && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ${pnl >= 0 ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} {pnlPct != null ? `(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)` : ''}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs">
        {/* Hold time */}
        <span className="text-zinc-500 font-mono">{holdTime}</span>
        {/* Trailing indicator */}
        {pos.trailingActive && <span className="text-amber-400 font-bold">TRAIL</span>}
        {/* BTD cycle info */}
        {pos.btdCycle && <span className="text-purple-400">{pos.btdCycle} D+{pos.btdDay}</span>}
        {/* Truncated reason */}
        <span className="text-zinc-600 max-w-[120px] truncate" title={pos.entryReason}>
          {truncateReason(pos.entryReason)}
        </span>
      </div>
    </div>
  );
}
