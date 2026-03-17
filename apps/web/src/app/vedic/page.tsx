'use client';

import { useEffect, useState, useCallback } from 'react';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import {
  MoonPhaseSvg,
  PlanetGlyph,
  VedicSignalBadge,
} from './vedic-visuals';

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
  source: 'trader' | 'btd';
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

  return (
    <DashboardLayout>
      <div className="space-y-4 p-4 max-w-6xl mx-auto">
        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-purple-400">VEDIC</h1>
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono">
              V3 DATA-DRIVEN
            </span>
            {s?.venusRx && (
              <span className="text-xs px-2 py-0.5 rounded bg-red-500/30 text-red-300 animate-pulse font-bold">
                VENUS Rx ACTIVE
              </span>
            )}
          </div>
          <span className="text-xs text-zinc-500">{status?.timestamp ? new Date(status.timestamp).toLocaleString() : ''}</span>
        </div>

        {error && <div className="text-red-400 text-sm bg-red-500/10 px-3 py-2 rounded">{error}</div>}

        {/* ── V3 Score Card ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Score */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500 mb-1">V3 Composite Score</div>
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
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-lg font-mono text-zinc-200">${tr?.balance?.toFixed(0) ?? '—'}</div>
                <div className="text-[10px] text-zinc-500">Balance</div>
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
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-lg font-mono text-zinc-200">${btd?.balance?.toFixed(0) ?? '—'}</div>
                <div className="text-[10px] text-zinc-500">Balance</div>
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
        {(status as any)?.futures?.running && (
          <div className="bg-zinc-900 border border-purple-500/30 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                <span className="text-sm font-bold text-zinc-200">Futures Paper</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">BAYES-DRIVEN</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">LONG+SHORT</span>
              </div>
              <span className="text-xs text-zinc-500">{(status as any).futures.openPositions} pos</span>
            </div>
            <div className="grid grid-cols-5 gap-2 text-center">
              <div>
                <div className="text-lg font-mono text-zinc-200">${(status as any).futures.balance?.toFixed(0)}</div>
                <div className="text-[10px] text-zinc-500">Balance</div>
              </div>
              <div>
                <div className={`text-lg font-mono ${(status as any).futures.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  ${(status as any).futures.totalPnl?.toFixed(2)}
                </div>
                <div className="text-[10px] text-zinc-500">P&L</div>
              </div>
              <div>
                <div className="text-lg font-mono text-zinc-200">{(status as any).futures.winRate?.toFixed(0)}%</div>
                <div className="text-[10px] text-zinc-500">WR ({(status as any).futures.trades}T)</div>
              </div>
              <div>
                <div className="text-sm font-mono text-green-400">{(status as any).futures.longTrades}L {(status as any).futures.longWr}%</div>
                <div className="text-[10px] text-zinc-500">Longs</div>
              </div>
              <div>
                <div className="text-sm font-mono text-red-400">{(status as any).futures.shortTrades}S {(status as any).futures.shortWr}%</div>
                <div className="text-[10px] text-zinc-500">Shorts</div>
              </div>
            </div>
          </div>
        )}

        {/* ── Bayesian Score ── */}
        {(status as any)?.bayes && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-zinc-300">Bayesian Posterior</h3>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">SELF-LEARNING</span>
                <span className="text-[10px] text-zinc-600">{(status as any).bayes.totalTrades} obs</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">P(up)=</span>
                <span className={`text-lg font-mono font-bold ${(status as any).bayes.probability > 0.55 ? 'text-green-400' : (status as any).bayes.probability < 0.45 ? 'text-red-400' : 'text-zinc-300'}`}>
                  {((status as any).bayes.probability * 100).toFixed(1)}%
                </span>
                <span className={`text-sm px-2 py-0.5 rounded font-mono ${labelColors[(status as any).bayes.label] ?? 'text-zinc-500'}`}>
                  {(status as any).bayes.label}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-3 md:grid-cols-5 gap-2 text-xs">
              {Object.entries((status as any).bayes.signals || {}).map(([name, sig]: [string, any]) => (
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
            <h3 className="text-sm font-bold text-zinc-300 mb-2">Open Positions</h3>
            <div className="space-y-2">
              {positions.map((pos, i) => (
                <div key={i} className="flex items-center justify-between bg-zinc-800/50 rounded px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${pos.source === 'btd' ? 'bg-purple-500/20 text-purple-300' : 'bg-blue-500/20 text-blue-300'}`}>
                      {pos.source === 'btd' ? 'BTD' : 'V3'}
                    </span>
                    <span className="font-mono text-sm text-zinc-200">{pos.symbol}</span>
                    <span className="text-xs text-zinc-500">@ ${pos.entryPrice.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-zinc-500">qty: {pos.quantity.toFixed(6)}</span>
                    {pos.trailingActive && <span className="text-amber-400">TRAILING</span>}
                    {pos.btdCycle && <span className="text-purple-400">{pos.btdCycle} D+{pos.btdDay}</span>}
                    <span className="text-zinc-500">{pos.entryReason?.slice(0, 40)}</span>
                  </div>
                </div>
              ))}
            </div>
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
                    <span className={`px-1 rounded text-[10px] ${t.source === 'btd' ? 'bg-purple-500/20 text-purple-300' : 'bg-blue-500/20 text-blue-300'}`}>
                      {t.source === 'btd' ? 'BTD' : 'V3'}
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

        {/* ── Research Info ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-bold text-zinc-300 mb-2">Research Basis</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-zinc-500">
            <div>
              <div className="text-zinc-400 font-bold mb-1">V3 Model</div>
              <p>6 symbols x 2000 days. OOS validated +3.4%.</p>
              <p>Venus Rx gate (p&lt;0.0001) + Merc Rx + Retro count + Paksha.</p>
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
