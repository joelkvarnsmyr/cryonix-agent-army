/**
 * APEX Backtest v2 — Real OHLCV prices from Binance via CCXT
 *
 * Replays historical signals through the APEX confluence scorer, then
 * walks real 1h candles forward to simulate TP/SL/trailing/max-hold exits.
 *
 * Prerequisites:
 *   docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "
 *     SELECT symbol, action, confidence, pattern,
 *            timestamp as signal_time,
 *            EXTRACT(EPOCH FROM timestamp) as signal_epoch,
 *            entry_price
 *     FROM signals
 *     WHERE (pattern LIKE '%DIP_BUY%'
 *        OR pattern LIKE '%DEEP_VALUE%'
 *        OR pattern LIKE '%BOLLINGER_SQUEEZE%RSI_OVERSOLD%'
 *        OR pattern LIKE '%RSI_OVERSOLD%DIP_BUY%')
 *        AND action = 'BUY'
 *     ORDER BY timestamp
 *   " --csv > /tmp/apex_signals.csv
 *
 * Usage: npx tsx scripts/strategy-lab/apex-backtest.ts
 */

import * as fs from 'fs';

// ── Types ────────────────────────────────────────────────────────────────────

interface HistoricalSignal {
  symbol: string;
  action: string;
  confidence: number;
  pattern: string;
  signal_time: string;
  signal_epoch: number;
  entry_price: number;
}

interface Candle {
  timestamp: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Position {
  symbol: string;
  direction: 'long' | 'short';
  mode: 'dip_sniper' | 'confluence' | 'venus_rx';
  entryPrice: number;
  entryTime: number; // epoch seconds
  size: number;
  score: number;
  patterns: string;
  sources: string[];
}

interface TradeResult {
  symbol: string;
  mode: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsd: number;
  score: number;
  exitReason: string;
  holdHours: number;
  patterns: string;
  entryTime: string;
  sources: string[];
}

// ── OHLCV Cache ─────────────────────────────────────────────────────────────

class OhlcvCache {
  private cache: Map<string, Candle[]> = new Map();
  private exchange: any;

  constructor(exchange: any) {
    this.exchange = exchange;
  }

  async getCandles(
    symbol: string,
    sinceEpochSec: number,
    hours: number,
  ): Promise<Candle[]> {
    const sinceMs = sinceEpochSec * 1000;
    const endMs = sinceMs + hours * 3600_000;
    const cacheKey = `${symbol}:${Math.floor(sinceMs / 86400_000)}`; // per-day cache

    // Check cache for overlapping data
    const cached = this.cache.get(cacheKey);
    if (cached && cached.length > 0) {
      const filtered = cached.filter(c => c.timestamp >= sinceMs && c.timestamp <= endMs);
      if (filtered.length >= hours * 0.8) return filtered; // good enough
    }

    // Fetch from exchange — get full day + max_hold buffer
    const fetchLimit = Math.min(1000, hours + 24);
    try {
      const raw = await this.exchange.fetchOHLCV(symbol, '1h', sinceMs, fetchLimit);
      const candles: Candle[] = raw.map((c: number[]) => ({
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      }));

      // Merge into cache
      const existing = this.cache.get(cacheKey) ?? [];
      const merged = [...existing, ...candles];
      const deduped = Array.from(
        new Map(merged.map(c => [c.timestamp, c])).values()
      ).sort((a, b) => a.timestamp - b.timestamp);
      this.cache.set(cacheKey, deduped);

      return deduped.filter(c => c.timestamp >= sinceMs && c.timestamp <= endMs);
    } catch (err: any) {
      console.warn(`  [OHLCV] Failed to fetch ${symbol}: ${err.message}`);
      return [];
    }
  }

  get stats() {
    let totalCandles = 0;
    for (const v of this.cache.values()) totalCandles += v.length;
    return { keys: this.cache.size, candles: totalCandles };
  }
}

// ── Exit Simulator (walks real candles) ─────────────────────────────────────

interface ModeParams {
  tpPct: number;
  slPct: number;
  trailingPct: number;
  trailingActivPct: number;
  maxHoldH: number;
  sizePct: number;
}

function walkCandles(
  candles: Candle[],
  entryPrice: number,
  mode: ModeParams,
): { exitPrice: number; exitReason: string; holdHours: number; pnlPct: number } {
  let highWatermark = entryPrice;
  let trailingActive = false;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const holdHours = i + 1;

    // Intra-candle: check high first (optimistic for TP), then low (pessimistic for SL)
    const highPnl = ((c.high - entryPrice) / entryPrice) * 100;
    const lowPnl = ((c.low - entryPrice) / entryPrice) * 100;
    const closePnl = ((c.close - entryPrice) / entryPrice) * 100;

    // Update high watermark
    if (c.high > highWatermark) highWatermark = c.high;

    // TP hit (high touches target)
    if (highPnl >= mode.tpPct) {
      const tpPrice = entryPrice * (1 + mode.tpPct / 100);
      return {
        exitPrice: tpPrice,
        exitReason: 'TP',
        holdHours,
        pnlPct: mode.tpPct,
      };
    }

    // SL hit (low touches stop)
    if (lowPnl <= -mode.slPct) {
      const slPrice = entryPrice * (1 - mode.slPct / 100);
      return {
        exitPrice: slPrice,
        exitReason: 'SL',
        holdHours,
        pnlPct: -mode.slPct,
      };
    }

    // Trailing stop activation
    if (highPnl >= mode.trailingActivPct) {
      trailingActive = true;
    }

    // Trailing stop trigger
    if (trailingActive) {
      const dropFromHigh = ((highWatermark - c.low) / highWatermark) * 100;
      if (dropFromHigh >= mode.trailingPct) {
        const trailPrice = highWatermark * (1 - mode.trailingPct / 100);
        const trailPnl = ((trailPrice - entryPrice) / entryPrice) * 100;
        return {
          exitPrice: trailPrice,
          exitReason: 'TRAILING',
          holdHours,
          pnlPct: trailPnl,
        };
      }
    }

    // Max hold
    if (holdHours >= mode.maxHoldH) {
      return {
        exitPrice: c.close,
        exitReason: 'MAX_HOLD',
        holdHours,
        pnlPct: closePnl,
      };
    }
  }

  // Ran out of candles — exit at last close
  const last = candles[candles.length - 1];
  const pnl = last ? ((last.close - entryPrice) / entryPrice) * 100 : 0;
  return {
    exitPrice: last?.close ?? entryPrice,
    exitReason: 'DATA_END',
    holdHours: candles.length,
    pnlPct: pnl,
  };
}

// ── Confluence Scoring ──────────────────────────────────────────────────────

const BULLISH_WEIGHTS: Record<string, { points: number; minConf?: number }> = {
  'DEEP_VALUE_CRASH':                    { points: 30, minConf: 0.75 },
  'DIP_BUY':                             { points: 25, minConf: 0.70 },
  'RSI_OVERSOLD, DIP_BUY':              { points: 25, minConf: 0.70 },
  'BOLLINGER_SQUEEZE, RSI_OVERSOLD':    { points: 20, minConf: 0.65 },
  'BOLLINGER_SQUEEZE, DIP_BUY':         { points: 25, minConf: 0.70 },
};

interface MarketContext {
  fearGreed: number;
  btcDomTrend: 'rising' | 'falling' | 'flat';
  orakelRegime: 'bull' | 'bear' | 'sideways';
  polymarketScore: number;
  orakelDirection: Record<string, number>;
}

function scoreSignal(
  pattern: string,
  confidence: number,
  symbol: string,
  ctx: MarketContext,
): { score: number; sources: string[] } {
  let score = 0;
  const sources: string[] = [];

  // Check all pattern weights — match partial patterns too
  for (const [key, w] of Object.entries(BULLISH_WEIGHTS)) {
    if (pattern.includes(key) || key.includes(pattern)) {
      if (confidence >= (w.minConf ?? 0)) {
        score += w.points;
        sources.push(key);
        break; // Only count best match
      }
    }
  }

  // If no match found but pattern contains DIP_BUY or DEEP_VALUE, give base score
  if (sources.length === 0) {
    if (pattern.includes('DIP_BUY') && confidence >= 0.70) {
      score += 25;
      sources.push('DIP_BUY');
    } else if (pattern.includes('DEEP_VALUE') && confidence >= 0.75) {
      score += 30;
      sources.push('DEEP_VALUE_CRASH');
    } else if (pattern.includes('BOLLINGER_SQUEEZE') && pattern.includes('RSI_OVERSOLD') && confidence >= 0.65) {
      score += 20;
      sources.push('BOLLINGER+RSI');
    }
  }

  // ORAKEL regime
  if (ctx.orakelRegime === 'bull') {
    score += 10;
    sources.push('orakel_bull');
  }

  // ORAKEL direction
  const dirProb = ctx.orakelDirection[symbol] ?? 0.5;
  if (dirProb > 0.6) {
    score += 15;
    sources.push(`orakel_up`);
  }

  // CMC Fear & Greed
  if (ctx.fearGreed <= 25) {
    score += 15;
    sources.push(`F&G=${ctx.fearGreed}`);
  } else if (ctx.fearGreed <= 40) {
    score += 5;
    sources.push(`fear_${ctx.fearGreed}`);
  }

  // Polymarket
  if (ctx.polymarketScore >= 70) {
    score += 15;
    sources.push('polymarket_bull');
  }

  // BTC dominance
  if (ctx.btcDomTrend === 'falling') {
    score += 5;
    sources.push('btc_dom_fall');
  }

  return { score, sources };
}

// ── Mode Parameters ─────────────────────────────────────────────────────────

const MODES: Record<string, ModeParams> = {
  dip_sniper: { tpPct: 5, slPct: 2.5, trailingPct: 2, trailingActivPct: 2.5, maxHoldH: 48, sizePct: 20 },
  confluence: { tpPct: 6, slPct: 3, trailingPct: 2.5, trailingActivPct: 3, maxHoldH: 72, sizePct: 15 },
  venus_rx:   { tpPct: 8, slPct: 3, trailingPct: 3, trailingActivPct: 4, maxHoldH: 360, sizePct: 24 },
};

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  APEX Backtest v2 — Real OHLCV Prices');
  console.log('══════════════════════════════════════════════\n');

  // Load signals
  const csvPath = '/tmp/apex_signals.csv';
  if (!fs.existsSync(csvPath)) {
    console.error('Signal CSV not found. Export from Postgres first (see header).');
    process.exit(1);
  }

  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const signals: HistoricalSignal[] = lines.slice(1).map(line => {
    // Handle CSV with potential quoted fields
    const cols = line.match(/(".*?"|[^,]+)/g)?.map(c => c.replace(/"/g, '')) ?? [];
    return {
      symbol: cols[0],
      action: cols[1],
      confidence: parseFloat(cols[2]),
      pattern: cols[3] ?? '',
      signal_time: cols[4] ?? '',
      signal_epoch: parseFloat(cols[5]),
      entry_price: parseFloat(cols[6]),
    };
  }).filter(s => s.entry_price > 0 && !isNaN(s.confidence) && s.action === 'BUY');

  const uniqueSymbols = [...new Set(signals.map(s => s.symbol))];
  console.log(`Loaded ${signals.length} signals across ${uniqueSymbols.length} symbols`);
  console.log(`Period: ${signals[0]?.signal_time ?? '?'} — ${signals[signals.length - 1]?.signal_time ?? '?'}`);
  console.log(`Patterns: ${[...new Set(signals.map(s => s.pattern))].join(', ')}\n`);

  // Init CCXT
  const ccxt = await import('ccxt');
  const exchange = new ccxt.binance({ enableRateLimit: true });
  await exchange.loadMarkets();
  const ohlcvCache = new OhlcvCache(exchange);

  // Simulate market context (realistic cycling)
  const firstEpoch = signals[0].signal_epoch;
  const getContext = (epoch: number, symbol: string): MarketContext => {
    const dayIndex = Math.floor((epoch - firstEpoch) / 86400);
    // Realistic F&G: crypto market was 25-55 in Feb-Mar 2026
    const fgBase = 38 + Math.sin(dayIndex * 0.25) * 15;
    const fearGreed = Math.max(15, Math.min(60, Math.round(fgBase)));

    const dirSeed = Math.sin(epoch * 0.0001 + (symbol.charCodeAt(0) * 7)) * 0.5 + 0.5;

    return {
      fearGreed,
      btcDomTrend: dayIndex % 5 < 2 ? 'falling' : dayIndex % 5 < 4 ? 'flat' : 'rising',
      orakelRegime: fearGreed < 30 ? 'bear' : fearGreed > 45 ? 'bull' : 'sideways',
      polymarketScore: Math.round(35 + Math.sin(dayIndex * 0.4) * 20),
      orakelDirection: { [symbol.split('/')[0]]: dirSeed },
    };
  };

  // ── Backtest Engine ─────────────────────────────────────────────────────

  const capital = 950;
  const cashReserve = capital * 0.2;
  let available = capital - cashReserve;
  let peakCapital = capital;
  let currentCapital = capital;
  const maxPositions = 3;

  const closedTrades: TradeResult[] = [];
  const activeSymbols = new Set<string>();
  let consecutiveLosses = 0;
  let dailyPnl = 0;
  let lastDay = -1;
  let skippedNoData = 0;
  let skippedLowScore = 0;
  let skippedMaxPos = 0;
  let skippedDup = 0;
  let skippedCircuit = 0;

  const lastEntry: Record<string, number> = {};

  console.log('Running backtest with real OHLCV prices...\n');

  for (let i = 0; i < signals.length; i++) {
    const signal = signals[i];
    const baseSymbol = signal.symbol.split('/')[0];

    // Progress
    if (i % 200 === 0) {
      process.stdout.write(`\r  Processing signal ${i + 1}/${signals.length} (${closedTrades.length} trades)...`);
    }

    // Daily reset
    const signalDay = Math.floor(signal.signal_epoch / 86400);
    if (signalDay !== lastDay) {
      dailyPnl = 0;
      lastDay = signalDay;
    }

    // Circuit breakers — pause for 24h then reset, don't block entire backtest
    const drawdownPct = peakCapital > 0 ? ((peakCapital - currentCapital) / peakCapital) * 100 : 0;
    if (drawdownPct > 10) { skippedCircuit++; continue; }
    if (dailyPnl < -(capital * 0.05)) { skippedCircuit++; continue; }
    // Consecutive losses: pause for 24h (86400s) then resume with reduced sizing
    if (consecutiveLosses >= 3) {
      const lastTradeTime = closedTrades.length > 0 ? closedTrades[closedTrades.length - 1].holdHours : 0;
      const timeSinceLastLoss = closedTrades.length > 0
        ? signal.signal_epoch - (new Date(closedTrades[closedTrades.length - 1].entryTime).getTime() / 1000)
        : Infinity;
      if (timeSinceLastLoss < 86400) { skippedCircuit++; continue; }
      consecutiveLosses = 0; // Reset after 24h cooldown
    }

    // Score
    const ctx = getContext(signal.signal_epoch, signal.symbol);
    const { score, sources } = scoreSignal(signal.pattern, signal.confidence, baseSymbol, ctx);

    if (score < 40) { skippedLowScore++; continue; }
    if (activeSymbols.size >= maxPositions) { skippedMaxPos++; continue; }
    if (activeSymbols.has(baseSymbol)) { skippedDup++; continue; }
    if (lastEntry[baseSymbol] && (signal.signal_epoch - lastEntry[baseSymbol]) < 14400) {
      skippedDup++;
      continue;
    }

    // Determine mode + params
    const hasDip = signal.pattern.includes('DIP_BUY') || signal.pattern.includes('DEEP_VALUE');
    const mode = hasDip ? 'dip_sniper' : 'confluence';
    const modeParams = MODES[mode];

    // Position sizing
    const sizePct = score >= 60 ? modeParams.sizePct : modeParams.sizePct * 0.5;
    let posSize = Math.min(available, (capital * sizePct) / 100);
    if (posSize < 15) continue;

    // Fetch real candles from entry forward
    const candles = await ohlcvCache.getCandles(
      signal.symbol,
      signal.signal_epoch,
      modeParams.maxHoldH + 2, // small buffer
    );

    if (candles.length < 5) {
      skippedNoData++;
      continue;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 100));

    // Walk candles for exit
    const exit = walkCandles(candles, signal.entry_price, modeParams);
    const pnlUsd = posSize * (exit.pnlPct / 100);

    closedTrades.push({
      symbol: baseSymbol,
      mode,
      direction: 'long',
      entryPrice: signal.entry_price,
      exitPrice: exit.exitPrice,
      pnlPct: exit.pnlPct,
      pnlUsd,
      score,
      exitReason: exit.exitReason,
      holdHours: exit.holdHours,
      patterns: signal.pattern,
      entryTime: signal.signal_time,
      sources,
    });

    // Update capital
    currentCapital += pnlUsd;
    available = (currentCapital - cashReserve) - (closedTrades.length > 0 ? 0 : 0);
    dailyPnl += pnlUsd;
    if (pnlUsd > 0) consecutiveLosses = 0;
    else consecutiveLosses++;
    if (currentCapital > peakCapital) peakCapital = currentCapital;

    lastEntry[baseSymbol] = signal.signal_epoch;

    // Brief lock on symbol for cooldown (simulated — we process sequentially)
    // Real APEX would track active positions; here we just use cooldown
  }

  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  await exchange.close();

  // ── Results ─────────────────────────────────────────────────────────────

  const wins = closedTrades.filter(t => t.pnlUsd > 0);
  const losses = closedTrades.filter(t => t.pnlUsd <= 0);
  const totalPnl = closedTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  // Equity curve for max drawdown
  let runningPnl = 0;
  let runningPeak = 0;
  let maxDD = 0;
  for (const t of closedTrades) {
    runningPnl += t.pnlUsd;
    if (runningPnl > runningPeak) runningPeak = runningPnl;
    const dd = runningPeak - runningPnl;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdownPct = capital > 0 ? (maxDD / capital) * 100 : 0;

  // Sharpe
  const rets = closedTrades.map(t => t.pnlPct / 100);
  const avgRet = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const stdRet = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (rets.length - 1))
    : 0;
  const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252) : 0;

  // Profit factor
  const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  console.log('══════════════════════════════════════════════');
  console.log('  APEX BACKTEST v2 — REAL OHLCV RESULTS');
  console.log('══════════════════════════════════════════════\n');

  console.log(`Capital: $${capital} -> $${currentCapital.toFixed(2)}`);
  console.log(`Total P&L: $${totalPnl.toFixed(2)} (${((totalPnl / capital) * 100).toFixed(2)}%)`);
  console.log(`OHLCV cache: ${ohlcvCache.stats.keys} keys, ${ohlcvCache.stats.candles} candles\n`);

  console.log('-- Performance --');
  console.log(`Trades: ${closedTrades.length}`);
  console.log(`Win Rate: ${winRate.toFixed(1)}% (${wins.length}W / ${losses.length}L)`);
  console.log(`Avg Win: +${avgWin.toFixed(2)}%  |  Avg Loss: ${avgLoss.toFixed(2)}%`);
  console.log(`Profit Factor: ${profitFactor.toFixed(2)}`);
  console.log(`Sharpe Ratio: ${sharpe.toFixed(2)}`);
  console.log(`Max Drawdown: ${maxDrawdownPct.toFixed(1)}% ($${maxDD.toFixed(2)})`);
  console.log(`Avg Hold: ${(closedTrades.reduce((s, t) => s + t.holdHours, 0) / (closedTrades.length || 1)).toFixed(1)}h\n`);

  console.log('-- Signal Funnel --');
  console.log(`  Total eligible signals: ${signals.length}`);
  console.log(`  Skipped (score < 40):   ${skippedLowScore}`);
  console.log(`  Skipped (max positions): ${skippedMaxPos}`);
  console.log(`  Skipped (duplicate):     ${skippedDup}`);
  console.log(`  Skipped (circuit break):  ${skippedCircuit}`);
  console.log(`  Skipped (no OHLCV data): ${skippedNoData}`);
  console.log(`  Executed:                ${closedTrades.length}\n`);

  console.log('-- Per Mode --');
  for (const m of ['dip_sniper', 'confluence'] as const) {
    const mt = closedTrades.filter(t => t.mode === m);
    if (mt.length === 0) continue;
    const mw = mt.filter(t => t.pnlUsd > 0);
    const mp = mt.reduce((s, t) => s + t.pnlUsd, 0);
    console.log(`  ${m}: ${mt.length} trades, ${((mw.length / mt.length) * 100).toFixed(0)}% WR, $${mp.toFixed(2)} P&L`);
  }

  console.log('\n-- Per Symbol --');
  const symMap = new Map<string, TradeResult[]>();
  for (const t of closedTrades) {
    if (!symMap.has(t.symbol)) symMap.set(t.symbol, []);
    symMap.get(t.symbol)!.push(t);
  }
  for (const [sym, trades] of [...symMap.entries()].sort((a, b) => {
    const pnlA = a[1].reduce((s, t) => s + t.pnlUsd, 0);
    const pnlB = b[1].reduce((s, t) => s + t.pnlUsd, 0);
    return pnlB - pnlA;
  })) {
    const sw = trades.filter(t => t.pnlUsd > 0);
    const sp = trades.reduce((s, t) => s + t.pnlUsd, 0);
    console.log(`  ${sym.padEnd(8)} ${trades.length} trades  ${((sw.length / trades.length) * 100).toFixed(0).padStart(3)}% WR  $${sp.toFixed(2)}`);
  }

  console.log('\n-- Exit Reasons --');
  const exitMap = new Map<string, { count: number; pnl: number }>();
  for (const t of closedTrades) {
    const e = exitMap.get(t.exitReason) ?? { count: 0, pnl: 0 };
    e.count++;
    e.pnl += t.pnlUsd;
    exitMap.set(t.exitReason, e);
  }
  for (const [reason, { count, pnl }] of [...exitMap.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(12)} ${String(count).padStart(3)} trades  $${pnl.toFixed(2)}`);
  }

  console.log('\n-- Score Distribution --');
  const buckets = [
    { label: '40-49', min: 40, max: 49 },
    { label: '50-59', min: 50, max: 59 },
    { label: '60-69', min: 60, max: 69 },
    { label: '70+',   min: 70, max: 999 },
  ];
  for (const b of buckets) {
    const bt = closedTrades.filter(t => t.score >= b.min && t.score <= b.max);
    if (bt.length === 0) { console.log(`  Score ${b.label}: 0 trades`); continue; }
    const bw = bt.filter(t => t.pnlUsd > 0);
    const bp = bt.reduce((s, t) => s + t.pnlUsd, 0);
    console.log(`  Score ${b.label}: ${bt.length} trades, ${((bw.length / bt.length) * 100).toFixed(0)}% WR, $${bp.toFixed(2)}`);
  }

  console.log('\n-- Top 5 Trades --');
  const sorted = [...closedTrades].sort((a, b) => b.pnlUsd - a.pnlUsd);
  for (const t of sorted.slice(0, 5)) {
    console.log(`  ${t.symbol.padEnd(8)} ${t.mode} score=${t.score}: $${t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%) [${t.patterns}] ${t.exitReason} ${t.holdHours}h`);
  }

  console.log('\n-- Worst 5 Trades --');
  for (const t of sorted.slice(-5).reverse()) {
    console.log(`  ${t.symbol.padEnd(8)} ${t.mode} score=${t.score}: $${t.pnlUsd.toFixed(2)} (${t.pnlPct.toFixed(1)}%) [${t.patterns}] ${t.exitReason} ${t.holdHours}h`);
  }

  // Equity curve (text sparkline)
  console.log('\n-- Equity Curve --');
  let eq = 0;
  const eqPoints: number[] = [];
  for (const t of closedTrades) {
    eq += t.pnlUsd;
    eqPoints.push(eq);
  }
  if (eqPoints.length > 0) {
    const eqMin = Math.min(...eqPoints);
    const eqMax = Math.max(...eqPoints);
    const eqRange = eqMax - eqMin || 1;
    const barChars = '▁▂▃▄▅▆▇█';
    const sparkline = eqPoints.map(p => {
      const idx = Math.round(((p - eqMin) / eqRange) * (barChars.length - 1));
      return barChars[idx];
    }).join('');
    console.log(`  ${sparkline}`);
    console.log(`  Low: $${eqMin.toFixed(2)}  High: $${eqMax.toFixed(2)}  Final: $${eq.toFixed(2)}`);
  }

  console.log('\n-- vs Cryonix Baseline (same period) --');
  console.log('  Cryonix: 113 trades, 28% WR, -$5.55 total P&L');
  console.log(`  APEX:    ${closedTrades.length} trades, ${winRate.toFixed(0)}% WR, $${totalPnl.toFixed(2)} total P&L`);
  const selectivity = closedTrades.length > 0 ? ((closedTrades.length / 113) * 100).toFixed(0) : '0';
  console.log(`  Selectivity: ${selectivity}% of Cryonix trade count`);
  console.log(`  Edge: ${totalPnl > -5.55 ? 'APEX outperforms' : 'Cryonix outperforms'} by $${Math.abs(totalPnl - (-5.55)).toFixed(2)}`);
  console.log('\n══════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Backtest error:', err);
  process.exit(1);
});
