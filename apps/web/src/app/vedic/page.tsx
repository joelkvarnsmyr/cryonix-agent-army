'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Bar,
} from 'recharts';
import {
  CurrentStatePanel,
  VedicSignalBadge,
  DashaBadge,
  PlanetGlyph,
  MoonPhaseSvg,
} from './vedic-visuals';

// ── Types ────────────────────────────────────────────────────────────

interface VedicDataPoint {
  date: string;
  price: number;
  score: number;
  label: string;
  muhurta: string;
  muhurta_score: number;
  nakshatra: string;
  nakshatra_score: number;
  tithi: string;
  tithi_number: number;
  paksha: string;
  moon_phase: number;
  mercury_rx: boolean;
  aspect_score: number;
  retrogrades: string[];
  transit_score: number;
  lagna_sign: string;
  bhava_score: number;
  dasha_lord: string;
  dasha_bias: number;
}

// ── Constants ────────────────────────────────────────────────────────

const SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOT',
  'LINK', 'ATOM', 'DOGE', 'NEAR', 'SUI', 'UNI', 'AAVE', 'LTC',
];

const PERIOD_OPTIONS = [
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
];

const LABEL_COLORS: Record<string, string> = {
  very_bullish: '#10b981',
  bullish: '#6ee7b7',
  neutral: '#6b7280',
  bearish: '#f87171',
  very_bearish: '#dc2626',
};

// ── Helper: format date ──────────────────────────────────────────────

function formatDate(d: string) {
  const [, m, day] = d.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m)]} ${Number(day)}`;
}

function formatPrice(p: number) {
  if (p >= 10000) return `$${(p / 1000).toFixed(1)}k`;
  if (p >= 100) return `$${p.toFixed(0)}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  return `$${p.toFixed(4)}`;
}

// ── Custom Tooltip ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload as VedicDataPoint | undefined;
  if (!point) return null;

  return (
    <div className="bg-zinc-900/95 border border-zinc-700/60 rounded-lg px-3 py-2 text-xs font-mono shadow-xl max-w-xs">
      <div className="flex items-center gap-2 mb-1.5">
        <MoonPhaseSvg phase={point.moon_phase} paksha={point.paksha} size={28} />
        <div>
          <div className="text-zinc-400">{label}</div>
          <div className="flex items-center gap-1 mt-0.5">
            <VedicSignalBadge score={point.score} label={point.label} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span className="text-zinc-500">Price</span>
        <span className="text-white">{formatPrice(point.price)}</span>

        <span className="text-zinc-500">Vedic Score</span>
        <span style={{ color: LABEL_COLORS[point.label] || '#6b7280' }}>
          {point.score} ({point.label?.replace('_', ' ')})
        </span>

        <span className="text-zinc-500">Transit</span>
        <span className={point.transit_score > 0 ? 'text-emerald-400' : point.transit_score < -10 ? 'text-red-400' : 'text-zinc-300'}>
          {point.transit_score}
        </span>

        <span className="text-zinc-500">Lagna</span>
        <span className="text-amber-300">{point.lagna_sign || '—'}</span>

        <span className="text-zinc-500">Bhava</span>
        <span className={point.bhava_score > 0 ? 'text-emerald-400' : 'text-red-400'}>
          {point.bhava_score?.toFixed(2)}
        </span>

        <span className="text-zinc-500">Muhurta</span>
        <span className="text-zinc-300">{point.muhurta}</span>

        <span className="text-zinc-500">Moon</span>
        <span className="text-zinc-300">{point.nakshatra} ({point.paksha})</span>

        <span className="text-zinc-500">Tithi</span>
        <span className="text-zinc-300">#{point.tithi_number} {point.tithi}</span>

        <span className="text-zinc-500">Dasha</span>
        <span className="text-violet-400">{point.dasha_lord} ({point.dasha_bias > 0 ? '+' : ''}{point.dasha_bias?.toFixed(1)})</span>

        {point.mercury_rx && (
          <>
            <span className="text-zinc-500">Mercury</span>
            <span className="text-red-400">RETROGRADE</span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Stats Card ───────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg px-3 py-2">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-mono font-semibold ${color ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-500">{sub}</div>}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

export default function VedicPage() {
  const [symbol, setSymbol] = useState('BTC');
  const [days, setDays] = useState(365);
  const [data, setData] = useState<VedicDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [overlay, setOverlay] = useState<'score' | 'transit' | 'muhurta' | 'moon'>('score');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/vedic/chart?symbol=${symbol}&days=${days}`);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      setData(json.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [symbol, days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Computed stats ──
  const stats = useMemo(() => {
    if (!data.length) return null;

    const scores = data.map(d => d.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const bullishDays = data.filter(d => d.score >= 15).length;
    const bearishDays = data.filter(d => d.score <= -15).length;
    const mercRxDays = data.filter(d => d.mercury_rx).length;
    const shukla = data.filter(d => d.paksha === 'Shukla').length;

    // Price change
    const firstPrice = data[0]?.price ?? 0;
    const lastPrice = data[data.length - 1]?.price ?? 0;
    const priceChange = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice * 100) : 0;

    // Correlation: vedic score vs next-day price change
    let corrSum = 0;
    let count = 0;
    for (let i = 0; i < data.length - 1; i++) {
      const nextReturn = (data[i + 1].price - data[i].price) / data[i].price;
      corrSum += data[i].score * nextReturn;
      count++;
    }

    // Current state
    const latest = data[data.length - 1];

    return {
      avgScore: avgScore.toFixed(1),
      bullishDays,
      bearishDays,
      mercRxDays,
      shukla,
      priceChange: priceChange.toFixed(1),
      corrSignal: count > 0 ? (corrSum / count > 0 ? 'positive' : 'negative') : 'n/a',
      latest,
    };
  }, [data]);

  // ── Overlay Y value ──
  const getOverlayKey = () => {
    switch (overlay) {
      case 'score': return 'score';
      case 'transit': return 'transit_score';
      case 'muhurta': return 'muhurta_score';
      case 'moon': return 'moon_phase';
    }
  };

  const overlayLabel = () => {
    switch (overlay) {
      case 'score': return 'Vedic Score';
      case 'transit': return 'Transit Score';
      case 'muhurta': return 'Muhurta';
      case 'moon': return 'Moon Phase %';
    }
  };

  // Mercury retrograde periods for highlighting
  const mercRxPeriods = useMemo(() => {
    const periods: { start: string; end: string }[] = [];
    let current: { start: string; end: string } | null = null;
    for (const d of data) {
      if (d.mercury_rx) {
        if (!current) current = { start: d.date, end: d.date };
        else current.end = d.date;
      } else {
        if (current) { periods.push(current); current = null; }
      }
    }
    if (current) periods.push(current);
    return periods;
  }, [data]);

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-mono font-semibold text-violet-400">VEDIC ASTROLOGY</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-violet-400/30 bg-violet-400/5 text-violet-400">
              RESEARCH
            </span>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            {/* Symbol selector */}
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              title="Select crypto symbol"
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-violet-500"
            >
              {SYMBOLS.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            {/* Period */}
            <div className="flex gap-0.5 bg-zinc-900 border border-zinc-700 rounded p-0.5">
              {PERIOD_OPTIONS.map(p => (
                <button
                  key={p.days}
                  onClick={() => setDays(p.days)}
                  className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors ${
                    days === p.days
                      ? 'bg-violet-500/20 text-violet-400'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Overlay selector */}
            <div className="flex gap-0.5 bg-zinc-900 border border-zinc-700 rounded p-0.5">
              {(['score', 'transit', 'muhurta', 'moon'] as const).map(o => (
                <button
                  key={o}
                  onClick={() => setOverlay(o)}
                  className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors ${
                    overlay === o
                      ? 'bg-violet-500/20 text-violet-400'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {o === 'score' ? 'Score' : o === 'transit' ? 'Transit' : o === 'muhurta' ? 'Muhurta' : 'Moon'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Loading / Error */}
        {loading && (
          <div className="h-96 flex items-center justify-center">
            <div className="text-xs font-mono text-zinc-500 animate-pulse">
              Computing {days} days of vedic data for {symbol}...
            </div>
          </div>
        )}

        {error && (
          <div className="h-96 flex items-center justify-center">
            <div className="text-xs font-mono text-red-400">{error}</div>
          </div>
        )}

        {/* Chart */}
        {!loading && !error && data.length > 0 && (
          <>
            {/* Current vedic state — rich SVG visuals */}
            {stats?.latest && (
              <CurrentStatePanel
                score={stats.latest.score}
                label={stats.latest.label}
                moonPhase={stats.latest.moon_phase}
                paksha={stats.latest.paksha}
                nakshatra={stats.latest.nakshatra}
                lagnaSign={stats.latest.lagna_sign}
                dashaLord={stats.latest.dasha_lord}
                dashaBias={stats.latest.dasha_bias}
                retrogrades={stats.latest.retrogrades ?? []}
                mercuryRx={stats.latest.mercury_rx}
                muhurta={stats.latest.muhurta}
                tithi={stats.latest.tithi}
                tithiNumber={stats.latest.tithi_number}
              />
            )}

            {/* Stats row */}
            {stats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                <StatCard
                  label="Avg Score"
                  value={stats.avgScore}
                  color={Number(stats.avgScore) > 0 ? 'text-emerald-400' : 'text-red-400'}
                />
                <StatCard label="Bullish Days" value={String(stats.bullishDays)} sub={`of ${data.length}`} color="text-emerald-400" />
                <StatCard label="Bearish Days" value={String(stats.bearishDays)} sub={`of ${data.length}`} color="text-red-400" />
                <StatCard label="Price" value={`${stats.priceChange}%`} color={Number(stats.priceChange) >= 0 ? 'text-emerald-400' : 'text-red-400'} />
                <StatCard label="Mercury Rx" value={`${stats.mercRxDays}d`} sub={`${(stats.mercRxDays / data.length * 100).toFixed(0)}%`} color="text-amber-400" />
                <StatCard label="Shukla" value={`${stats.shukla}d`} sub="waxing moon" color="text-sky-400" />
                <StatCard
                  label="Now"
                  value={stats.latest?.label?.replace('_', ' ') ?? '—'}
                  sub={`score: ${stats.latest?.score ?? '—'}`}
                  color={LABEL_COLORS[stats.latest?.label ?? ''] ? `text-[${LABEL_COLORS[stats.latest?.label ?? '']}]` : 'text-zinc-300'}
                />
                <StatCard
                  label="Dasha"
                  value={stats.latest?.dasha_lord ?? '—'}
                  sub={`bias: ${stats.latest?.dasha_bias?.toFixed(1) ?? '—'}`}
                  color="text-violet-400"
                />
              </div>
            )}

            {/* Main chart */}
            <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-mono text-zinc-400">
                  {symbol}/USDC + {overlayLabel()} ({data.length} days)
                </span>
                <div className="flex items-center gap-3 text-[10px] font-mono text-zinc-500">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-0.5 bg-white inline-block" /> Price
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-0.5 bg-violet-400 inline-block" /> {overlayLabel()}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 bg-red-400/20 inline-block rounded" /> Mercury Rx
                  </span>
                </div>
              </div>

              <ResponsiveContainer width="100%" height={420}>
                <ComposedChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />

                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDate}
                    tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'monospace' }}
                    interval={Math.max(Math.floor(data.length / 12), 1)}
                    stroke="#3f3f46"
                  />

                  {/* Left Y: Price */}
                  <YAxis
                    yAxisId="price"
                    orientation="left"
                    tickFormatter={formatPrice}
                    tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'monospace' }}
                    stroke="#3f3f46"
                    domain={['auto', 'auto']}
                  />

                  {/* Right Y: Vedic Score */}
                  <YAxis
                    yAxisId="vedic"
                    orientation="right"
                    tick={{ fill: '#8b5cf6', fontSize: 10, fontFamily: 'monospace' }}
                    stroke="#3f3f46"
                    domain={overlay === 'moon' ? [0, 100] : [-100, 100]}
                  />

                  <Tooltip content={<ChartTooltip />} />

                  {/* Zero line for vedic score */}
                  {overlay !== 'moon' && (
                    <ReferenceLine yAxisId="vedic" y={0} stroke="#4b5563" strokeDasharray="2 2" />
                  )}

                  {/* Mercury Rx periods as semi-transparent bars */}
                  <Bar
                    yAxisId="vedic"
                    dataKey={(d: VedicDataPoint) => d.mercury_rx ? (overlay === 'moon' ? 100 : 100) : 0}
                    fill="#ef444420"
                    stroke="none"
                    isAnimationActive={false}
                  />

                  {/* Vedic score area */}
                  <Area
                    yAxisId="vedic"
                    dataKey={getOverlayKey()}
                    stroke="#8b5cf6"
                    strokeWidth={1}
                    fill="#8b5cf610"
                    dot={false}
                    isAnimationActive={false}
                  />

                  {/* Price line */}
                  <Line
                    yAxisId="price"
                    type="monotone"
                    dataKey="price"
                    stroke="#ffffff"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Correlation analysis */}
            <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-4">
              <div className="text-xs font-mono text-zinc-400 mb-3">Vedic Signal Correlation Analysis</div>
              <CorrelationTable data={data} />
            </div>

            {/* Dasha timeline */}
            <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-4">
              <div className="text-xs font-mono text-zinc-400 mb-3">Dasha Period Performance</div>
              <DashaTable data={data} />
            </div>

            {/* Mercury Rx performance */}
            {mercRxPeriods.length > 0 && (
              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-4">
                <div className="text-xs font-mono text-zinc-400 mb-3">Mercury Retrograde Periods</div>
                <MercuryRxTable data={data} periods={mercRxPeriods} />
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ── Correlation Table ────────────────────────────────────────────────

function CorrelationTable({ data }: { data: VedicDataPoint[] }) {
  const analysis = useMemo(() => {
    const buckets: Record<string, { returns: number[]; count: number }> = {
      'very_bullish': { returns: [], count: 0 },
      'bullish': { returns: [], count: 0 },
      'neutral': { returns: [], count: 0 },
      'bearish': { returns: [], count: 0 },
      'very_bearish': { returns: [], count: 0 },
    };

    for (let i = 0; i < data.length - 1; i++) {
      const label = data[i].label;
      const nextReturn = (data[i + 1].price - data[i].price) / data[i].price * 100;
      if (buckets[label]) {
        buckets[label].returns.push(nextReturn);
        buckets[label].count++;
      }
    }

    return Object.entries(buckets).map(([label, b]) => {
      const avg = b.returns.length > 0 ? b.returns.reduce((a, c) => a + c, 0) / b.returns.length : 0;
      const positive = b.returns.filter(r => r > 0).length;
      const winRate = b.returns.length > 0 ? (positive / b.returns.length * 100) : 0;
      return { label, count: b.count, avgReturn: avg, winRate };
    });
  }, [data]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-zinc-500 border-b border-zinc-800">
            <th className="text-left py-1.5 px-2">Vedic Label</th>
            <th className="text-right py-1.5 px-2">Days</th>
            <th className="text-right py-1.5 px-2">Avg Next-Day Return</th>
            <th className="text-right py-1.5 px-2">Win Rate</th>
            <th className="text-left py-1.5 px-2">Signal Value</th>
          </tr>
        </thead>
        <tbody>
          {analysis.map(a => {
            const valueColor = a.avgReturn > 0.1 ? 'text-emerald-400' :
              a.avgReturn < -0.1 ? 'text-red-400' : 'text-zinc-400';
            const quality = a.label.includes('bullish') && a.avgReturn > 0 ? 'CONFIRMED' :
              a.label.includes('bearish') && a.avgReturn < 0 ? 'CONFIRMED' :
                a.count === 0 ? '—' : 'MIXED';

            return (
              <tr key={a.label} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                <td className="py-1.5 px-2" style={{ color: LABEL_COLORS[a.label] }}>
                  {a.label.replace('_', ' ')}
                </td>
                <td className="text-right py-1.5 px-2 text-zinc-300">{a.count}</td>
                <td className={`text-right py-1.5 px-2 ${valueColor}`}>
                  {a.avgReturn > 0 ? '+' : ''}{a.avgReturn.toFixed(3)}%
                </td>
                <td className="text-right py-1.5 px-2 text-zinc-300">
                  {a.count > 0 ? `${a.winRate.toFixed(0)}%` : '—'}
                </td>
                <td className={`py-1.5 px-2 ${quality === 'CONFIRMED' ? 'text-emerald-400' : quality === 'MIXED' ? 'text-amber-400' : 'text-zinc-500'}`}>
                  {quality}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Dasha Performance Table ──────────────────────────────────────────

function DashaTable({ data }: { data: VedicDataPoint[] }) {
  const dashaPerf = useMemo(() => {
    const buckets: Record<string, { returns: number[]; days: number }> = {};

    for (let i = 0; i < data.length - 1; i++) {
      const lord = data[i].dasha_lord || 'Unknown';
      if (!buckets[lord]) buckets[lord] = { returns: [], days: 0 };
      const ret = (data[i + 1].price - data[i].price) / data[i].price * 100;
      buckets[lord].returns.push(ret);
      buckets[lord].days++;
    }

    return Object.entries(buckets)
      .map(([lord, b]) => {
        const avg = b.returns.reduce((a, c) => a + c, 0) / b.returns.length;
        const total = b.returns.reduce((a, c) => a + c, 0);
        return { lord, days: b.days, avgReturn: avg, totalReturn: total };
      })
      .sort((a, b) => b.totalReturn - a.totalReturn);
  }, [data]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-zinc-500 border-b border-zinc-800">
            <th className="text-left py-1.5 px-2">Dasha Lord</th>
            <th className="text-right py-1.5 px-2">Days</th>
            <th className="text-right py-1.5 px-2">Avg Daily Return</th>
            <th className="text-right py-1.5 px-2">Total Return</th>
          </tr>
        </thead>
        <tbody>
          {dashaPerf.map(d => (
            <tr key={d.lord} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
              <td className="py-1.5 px-2 text-violet-400 flex items-center gap-1">
                    <PlanetGlyph planet={d.lord} size={18} />
                    {d.lord}
                  </td>
              <td className="text-right py-1.5 px-2 text-zinc-300">{d.days}</td>
              <td className={`text-right py-1.5 px-2 ${d.avgReturn > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {d.avgReturn > 0 ? '+' : ''}{d.avgReturn.toFixed(3)}%
              </td>
              <td className={`text-right py-1.5 px-2 ${d.totalReturn > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {d.totalReturn > 0 ? '+' : ''}{d.totalReturn.toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Mercury Rx Table ─────────────────────────────────────────────────

function MercuryRxTable({ data, periods }: { data: VedicDataPoint[]; periods: { start: string; end: string }[] }) {
  const rxPerf = useMemo(() => {
    return periods.map(p => {
      const start = data.find(d => d.date === p.start);
      const end = data.find(d => d.date === p.end);
      if (!start || !end) return null;

      const priceChange = ((end.price - start.price) / start.price * 100);
      const daysInPeriod = data.filter(d => d.date >= p.start && d.date <= p.end).length;

      return {
        start: p.start,
        end: p.end,
        days: daysInPeriod,
        startPrice: start.price,
        endPrice: end.price,
        change: priceChange,
      };
    }).filter(Boolean) as Array<{ start: string; end: string; days: number; startPrice: number; endPrice: number; change: number }>;
  }, [data, periods]);

  const avgChange = rxPerf.length > 0 ? rxPerf.reduce((a, p) => a + p.change, 0) / rxPerf.length : 0;

  return (
    <div>
      <div className="text-[10px] font-mono text-zinc-500 mb-2">
        {rxPerf.length} retrograde periods | Avg price change: {' '}
        <span className={avgChange > 0 ? 'text-emerald-400' : 'text-red-400'}>
          {avgChange > 0 ? '+' : ''}{avgChange.toFixed(2)}%
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-zinc-500 border-b border-zinc-800">
              <th className="text-left py-1.5 px-2">Period</th>
              <th className="text-right py-1.5 px-2">Days</th>
              <th className="text-right py-1.5 px-2">Start Price</th>
              <th className="text-right py-1.5 px-2">End Price</th>
              <th className="text-right py-1.5 px-2">Change</th>
            </tr>
          </thead>
          <tbody>
            {rxPerf.map((p, i) => (
              <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                <td className="py-1.5 px-2 text-amber-400">{p.start} → {p.end}</td>
                <td className="text-right py-1.5 px-2 text-zinc-300">{p.days}</td>
                <td className="text-right py-1.5 px-2 text-zinc-300">{formatPrice(p.startPrice)}</td>
                <td className="text-right py-1.5 px-2 text-zinc-300">{formatPrice(p.endPrice)}</td>
                <td className={`text-right py-1.5 px-2 ${p.change > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {p.change > 0 ? '+' : ''}{p.change.toFixed(2)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
