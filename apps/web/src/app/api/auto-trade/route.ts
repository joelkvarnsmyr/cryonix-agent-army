import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logTrade, saveValidation, archivePosition } from '@cryonix/database';
import ccxt, { type Exchange } from 'ccxt';
import OpenAI from 'openai';

export const dynamic = 'force-dynamic';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  TOTAL_CAPITAL: 17,
  MAX_POSITION_SIZE_PCT: 0.12,     // 12% per position (~$2) — diversify across many positions
  MIN_CONFIDENCE: 0.65,
  MAX_DAILY_LOSS_PCT: 0.05,        // 5% (~$0.85)
  MAX_OPEN_POSITIONS: 10,          // Spread across up to 10 positions
  MAX_TRADES_PER_DAY: 6,
  MAX_SLIPPAGE_PCT: 0.5,
  SPOT_ONLY: true,                  // Margin account not available — spot only
  TRADING_MODE: 'spot' as 'spot' | 'margin' | 'future',
  MARGIN_TYPE: (process.env.MARGIN_TYPE || 'cross') as 'cross' | 'isolated',
  DEFAULT_LEVERAGE: parseInt(process.env.DEFAULT_LEVERAGE || '3'),
  MIN_ORDER_VALUE: 1.0,            // Global floor — actual minimum fetched per-pair from Binance
  TRAILING_STOP_PCT: 3.0,          // 3% trailing stop — let positions breathe
  MAX_PENDING_QUEUE: 30,           // Auto-trim queue beyond this
  AI_VALIDATION: true,             // Use GROK AI for signal validation
};

// ============================================================================
// GROK AI SINGLETON (Information Edge)
// ============================================================================

let grok: OpenAI | null = null;

function getGrok(): OpenAI | null {
  if (!CONFIG.AI_VALIDATION || !process.env.XAI_API_KEY) return null;
  if (grok) return grok;
  grok = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: 'https://api.x.ai/v1',
  });
  return grok;
}

// ============================================================================
// EXCHANGE SINGLETON
// ============================================================================

let exchange: Exchange | null = null;

function getExchange(): Exchange {
  if (exchange) return exchange;
  const isTestnet = process.env.BINANCE_TESTNET === 'true';
  const defaultType = CONFIG.TRADING_MODE === 'future' ? 'future' : 'spot';
  const config: any = {
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    enableRateLimit: true,
    options: {
      defaultType,
      defaultMarginMode: CONFIG.TRADING_MODE === 'margin' ? CONFIG.MARGIN_TYPE : undefined,
    },
  };
  if (isTestnet) {
    config.urls = {
      api: {
        public: 'https://testnet.binance.vision/api',
        private: 'https://testnet.binance.vision/api',
      },
    };
  }
  exchange = new ccxt.binance(config);
  console.log(`[Exchange] Initialized: mode=${CONFIG.TRADING_MODE}, leverage=${CONFIG.DEFAULT_LEVERAGE}x`);
  return exchange;
}

// ============================================================================
// DYNAMIC CAPITAL — fetch actual account value from Binance
// ============================================================================

let cachedCapital = CONFIG.TOTAL_CAPITAL;
let capitalLastFetched = 0;
const CAPITAL_CACHE_MS = 5 * 60 * 1000; // refresh every 5 min

async function getTotalCapital(): Promise<number> {
  const now = Date.now();
  if (now - capitalLastFetched < CAPITAL_CACHE_MS) return cachedCapital;
  try {
    const ex = getExchange();
    await ex.loadMarkets();
    const bal = (await ex.fetchBalance({ recvWindow: 10000 })) as any;
    let total = 0;
    for (const [coin, qty] of Object.entries(bal.total as Record<string, number>)) {
      if (!qty || qty <= 0) continue;
      if (coin === 'USDC' || coin === 'USDT') { total += qty; continue; }
      try {
        const t = await ex.fetchTicker(`${coin}/USDC`);
        total += qty * (t.last || 0);
      } catch { /* pair not found — skip dust */ }
    }
    if (total > 0) {
      cachedCapital = total;
      capitalLastFetched = now;
      console.log(`[CAPITAL] Dynamic total: $${total.toFixed(2)}`);
    }
  } catch (e) {
    console.warn('[CAPITAL] Fetch failed, using cached:', (e as Error).message);
  }
  return cachedCapital;
}

// ============================================================================
// TYPES
// ============================================================================

interface Signal {
  symbol: string;
  action: string;
  confidence: number;
  reason: string;
  patterns: string[];
  entry_price: number;
  stop_loss: number;
  target_price: number;
  indicators: Record<string, number | null>;
  position_size: number;
  is_deep_value?: boolean;
  is_grid_buy?: boolean;
}

interface OpenPosition {
  symbol: string;
  side: string;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop: number;    // Dynamic stop that follows price up
  highWaterMark: number;   // Highest price seen since entry
  orderId: string;
  openedAt: string;
  pattern: string;
  confidence: number;
}

// ============================================================================
// DAILY STATE (resets on server restart or new day)
// ============================================================================

let dailyState = {
  date: new Date().toDateString(),
  tradesExecuted: 0,
  dailyPnl: 0,
};

function resetDailyStateIfNeeded() {
  const today = new Date().toDateString();
  if (dailyState.date !== today) {
    dailyState = { date: today, tradesExecuted: 0, dailyPnl: 0 };
  }
}

// ============================================================================
// POSITION STORAGE (Redis-backed, survives restarts)
// ============================================================================

async function getOpenPositions(): Promise<OpenPosition[]> {
  const raw = await redis.get('positions:open');
  if (!raw) return [];
  try {
    return JSON.parse(raw as string);
  } catch {
    return [];
  }
}

async function saveOpenPositions(positions: OpenPosition[]): Promise<void> {
  await redis.set('positions:open', JSON.stringify(positions));
}

async function addPosition(pos: OpenPosition): Promise<void> {
  const positions = await getOpenPositions();
  positions.push(pos);
  await saveOpenPositions(positions);
}

async function removePosition(symbol: string): Promise<OpenPosition | null> {
  const positions = await getOpenPositions();
  const idx = positions.findIndex(p => p.symbol === symbol);
  if (idx === -1) return null;
  const removed = positions.splice(idx, 1)[0];
  await saveOpenPositions(positions);
  return removed;
}

// ============================================================================
// POSITION MONITORING - THE EXIT STRATEGY
// ============================================================================

interface MonitorResult {
  symbol: string;
  action: 'HOLD' | 'SOLD_TP' | 'SOLD_SL' | 'SOLD_TRAILING' | 'ERROR';
  currentPrice?: number;
  pnl?: number;
  pnlPct?: number;
  reason?: string;
  orderId?: string;
}

async function monitorPositions(): Promise<MonitorResult[]> {
  const positions = await getOpenPositions();
  if (positions.length === 0) return [];

  const ex = getExchange();
  const results: MonitorResult[] = [];

  for (const pos of positions) {
    try {
      const ticker = await ex.fetchTicker(pos.symbol);
      const currentPrice = ticker.last || 0;
      if (currentPrice === 0) continue;

      const pnl = pos.side === 'SELL'
        ? (pos.entryPrice - currentPrice) * pos.quantity  // SHORT: profit when price drops
        : (currentPrice - pos.entryPrice) * pos.quantity;  // LONG: profit when price rises
      const pnlPct = pos.side === 'SELL'
        ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
        : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      // Update high water mark and trailing stop
      if (currentPrice > pos.highWaterMark) {
        pos.highWaterMark = currentPrice;
        // Only start trailing after 1.5% profit (let positions breathe)
        const profitPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (profitPct >= 1.5) {
          const newTrailingStop = currentPrice * (1 - CONFIG.TRAILING_STOP_PCT / 100);
          if (newTrailingStop > pos.trailingStop) {
            pos.trailingStop = newTrailingStop;
          }
        }
      }

      // Check exit conditions
      let shouldSell = false;
      let exitReason = '';

      if (pos.side === 'SELL') {
        // SHORT position: exit by buying back
        // TP hit when price drops below target
        if (currentPrice <= pos.takeProfit) {
          shouldSell = true;
          exitReason = `Short TP hit: $${currentPrice.toFixed(4)} <= $${pos.takeProfit.toFixed(4)}`;
        }
        // SL hit when price rises above stop
        else if (currentPrice >= pos.stopLoss) {
          shouldSell = true;
          exitReason = `Short SL hit: $${currentPrice.toFixed(4)} >= $${pos.stopLoss.toFixed(4)}`;
        }
      } else {
        // LONG position: exit by selling
        // 1. Take-profit hit
        if (currentPrice >= pos.takeProfit) {
          shouldSell = true;
          exitReason = `Take-profit hit: $${currentPrice.toFixed(4)} >= $${pos.takeProfit.toFixed(4)}`;
        }
        // 2. Stop-loss hit
        else if (currentPrice <= pos.stopLoss) {
          shouldSell = true;
          exitReason = `Stop-loss hit: $${currentPrice.toFixed(4)} <= $${pos.stopLoss.toFixed(4)}`;
        }
        // 3. Trailing stop hit (only active when in profit)
        else if (pnl > 0 && currentPrice <= pos.trailingStop && pos.trailingStop > pos.entryPrice) {
          shouldSell = true;
          exitReason = `Trailing stop hit: $${currentPrice.toFixed(4)} <= $${pos.trailingStop.toFixed(4)} (high: $${pos.highWaterMark.toFixed(4)})`;
        }
      }

      if (shouldSell) {
        // Close the position (sell for LONG, buy-back for SHORT)
        const closeSide = pos.side === 'SELL' ? 'buy' : 'sell';
        console.log(`[MONITOR] Closing ${pos.side} ${pos.symbol}: ${exitReason}`);
        try {
          const closeParams: any = {};
          if (pos.side === 'SELL' && CONFIG.TRADING_MODE === 'margin') {
            closeParams.marginMode = CONFIG.MARGIN_TYPE;
            closeParams.type = 'margin';
          }
          const closeOrder = await ex.createMarketOrder(
            pos.symbol,
            closeSide,
            pos.quantity,
            undefined,
            closeParams
          );

          const closePrice = closeOrder.average || closeOrder.price || currentPrice;
          const realizedPnl = pos.side === 'SELL'
            ? (pos.entryPrice - closePrice) * pos.quantity
            : (closePrice - pos.entryPrice) * pos.quantity;
          const fees = (closeOrder.fee?.cost || 0);

          // Remove from open positions
          await removePosition(pos.symbol);

          // Update daily P&L
          dailyState.dailyPnl += realizedPnl - fees;

          // Log to database
          await logTrade({
            symbol: pos.symbol,
            side: closeSide.toUpperCase() as 'BUY' | 'SELL',
            quantity: String(pos.quantity),
            entryPrice: String(pos.entryPrice),
            exitPrice: String(closePrice),
            pnl: String(realizedPnl - fees),
            confidence: String(pos.confidence),
            pattern: pos.pattern,
            reasoning: exitReason,
            status: 'CLOSED',
            agentId: 'auto-trader',
          });

          const exitType = currentPrice >= pos.takeProfit ? 'SOLD_TP' :
            currentPrice <= pos.stopLoss ? 'SOLD_SL' : 'SOLD_TRAILING';

          // Archive to position_history with full context for evolution analysis
          try {
            await archivePosition({
              symbol: pos.symbol,
              side: pos.side,
              quantity: String(pos.quantity),
              entryPrice: String(pos.entryPrice),
              exitPrice: String(closePrice),
              stopLoss: String(pos.stopLoss),
              takeProfit: String(pos.takeProfit),
              pnl: String(realizedPnl - fees),
              pnlPercent: String(pnlPct),
              fees: String(fees),
              holdingPeriod: Math.round((Date.now() - new Date(pos.openedAt || Date.now()).getTime()) / 1000),
              openedAt: new Date(pos.openedAt || Date.now()),
              closedAt: new Date(),
              closeReason: exitType,
              pattern: pos.pattern,
              metadata: {
                highWaterMark: pos.highWaterMark,
                trailingStop: pos.trailingStop,
                confidence: pos.confidence,
                entryPrice: pos.entryPrice,
                exitReason,
              },
              agentId: 'auto-trader',
            });
          } catch (archiveErr) {
            console.warn(`[MONITOR] position_history archive failed (non-critical):`, archiveErr);
          }

          console.log(`[MONITOR] ${pos.symbol} ${exitType}: PnL $${(realizedPnl - fees).toFixed(4)} (${pnlPct.toFixed(2)}%)`);

          results.push({
            symbol: pos.symbol,
            action: exitType,
            currentPrice: closePrice,
            pnl: realizedPnl - fees,
            pnlPct,
            reason: exitReason,
            orderId: closeOrder.id,
          });
        } catch (closeError) {
          const errMsg = closeError instanceof Error ? closeError.message : String(closeError);
          console.error(`[MONITOR] Failed to close ${pos.symbol}:`, errMsg);
          results.push({
            symbol: pos.symbol,
            action: 'ERROR',
            currentPrice,
            pnl,
            pnlPct,
            reason: `Sell failed: ${errMsg}`,
          });
        }
      } else {
        // HOLD - update position data
        results.push({
          symbol: pos.symbol,
          action: 'HOLD',
          currentPrice,
          pnl,
          pnlPct,
          reason: `Entry: $${pos.entryPrice.toFixed(2)} | SL: $${pos.stopLoss.toFixed(2)} | TP: $${pos.takeProfit.toFixed(2)} | Trail: $${pos.trailingStop.toFixed(2)}`,
        });
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      results.push({ symbol: pos.symbol, action: 'ERROR', reason: errMsg });
    }
  }

  // Save updated positions (trailing stops may have moved)
  const currentPositions = await getOpenPositions();
  if (currentPositions.length > 0) {
    await saveOpenPositions(currentPositions);
  }

  return results;
}

// ============================================================================
// SELF-CALIBRATION: Pattern Win Rate + Expected Value
// ============================================================================

interface PatternStats {
  pattern: string;
  trades: number;
  wins: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  ev: number;
}

let calibrationCache: Record<string, PatternStats> = {};
let calibrationLastFetched = 0;
const CALIBRATION_CACHE_MS = 30 * 60 * 1000; // refresh every 30 min

async function getPatternCalibration(): Promise<Record<string, PatternStats>> {
  const now = Date.now();
  if (now - calibrationLastFetched < CALIBRATION_CACHE_MS && Object.keys(calibrationCache).length > 0) {
    return calibrationCache;
  }

  try {
    // Fetch from Redis cache first
    const cached = await redis.get('calibration:patterns');
    if (cached) {
      calibrationCache = JSON.parse(cached);
      calibrationLastFetched = now;
      return calibrationCache;
    }
  } catch {}

  // If no cache, return empty (calibration cron will populate it)
  return calibrationCache;
}

async function calculateExpectedValue(signal: Signal, cal?: Record<string, PatternStats>): Promise<{ ev: number; winRate: number; sampleSize: number; pattern: string } | null> {
  if (!cal) cal = await getPatternCalibration();
  if (Object.keys(cal).length === 0) return null; // No calibration data yet

  // Match signal patterns against calibration
  const patterns = signal.patterns || [];
  const patternKey = patterns.sort().join(', ');

  // Try exact multi-pattern match first, then individual patterns
  let stats = cal[patternKey];
  if (!stats) {
    // Find best single-pattern match
    for (const p of patterns) {
      if (cal[p] && (!stats || cal[p].trades > stats.trades)) {
        stats = cal[p];
      }
    }
  }

  if (!stats || stats.trades < 3) return null; // Not enough data

  const ev = (stats.winRate / 100 * stats.avgWin) - ((100 - stats.winRate) / 100 * Math.abs(stats.avgLoss));
  console.log(`[EV] ${signal.symbol} ${patternKey}: EV=$${ev.toFixed(4)} (win ${stats.winRate}% of ${stats.trades})`);

  return { ev, winRate: stats.winRate, sampleSize: stats.trades, pattern: patternKey };
}

// ============================================================================
// RISK CHECKS
// ============================================================================

async function passesRiskChecks(signal: Signal): Promise<{ pass: boolean; reason: string }> {
  resetDailyStateIfNeeded();

  if (signal.confidence < CONFIG.MIN_CONFIDENCE) {
    return { pass: false, reason: `Confidence ${(signal.confidence * 100).toFixed(1)}% < ${CONFIG.MIN_CONFIDENCE * 100}% min` };
  }

  if (CONFIG.SPOT_ONLY && signal.action !== 'BUY') {
    return { pass: false, reason: `Spot-only: skipping ${signal.action}` };
  }

  if (dailyState.tradesExecuted >= CONFIG.MAX_TRADES_PER_DAY) {
    return { pass: false, reason: `Daily limit (${CONFIG.MAX_TRADES_PER_DAY})` };
  }

  const capital = await getTotalCapital();
  if (dailyState.dailyPnl <= -(capital * CONFIG.MAX_DAILY_LOSS_PCT)) {
    return { pass: false, reason: `Daily loss limit ($${Math.abs(dailyState.dailyPnl).toFixed(2)})` };
  }

  // Check open positions from Redis (persistent)
  const openPositions = await getOpenPositions();
  if (openPositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
    return { pass: false, reason: `Max positions (${CONFIG.MAX_OPEN_POSITIONS})` };
  }

  if (openPositions.some(p => p.symbol === signal.symbol)) {
    return { pass: false, reason: `Already in ${signal.symbol}` };
  }

  // X sentiment alert check — reject if breaking negative news
  try {
    const baseAsset = signal.symbol.split('/')[0];
    const alert = await redis.get(`sentiment:alert:${baseAsset}`);
    if (alert && signal.action === 'BUY') {
      const alertLower = alert.toLowerCase();
      if (alertLower.includes('hack') || alertLower.includes('exploit') || alertLower.includes('rug') || alertLower.includes('sec') || alertLower.includes('crash')) {
        return { pass: false, reason: `X alert: ${alert}` };
      }
    }
  } catch {}

  // Check available cash before burning AI tokens
  try {
    const ex = getExchange();
    await ex.loadMarkets();
    const bal = await ex.fetchBalance({ recvWindow: 10000 });
    const usdc = (bal as any)?.free?.USDC || 0;
    if (usdc < CONFIG.MIN_ORDER_VALUE) {
      return { pass: false, reason: `Low cash $${usdc.toFixed(2)} < $${CONFIG.MIN_ORDER_VALUE} min` };
    }
  } catch (e) {
    // Don't block trading on balance check failure
    console.warn('[RISK] Balance check failed, proceeding:', (e as Error).message);
  }

  const risk = Math.abs(signal.entry_price - signal.stop_loss);
  const reward = Math.abs(signal.target_price - signal.entry_price);
  if (risk > 0 && reward / risk < 1.3) {
    return { pass: false, reason: `R/R ${(reward / risk).toFixed(2)} < 1.3` };
  }

  // === EV-MODEL: Expected Value filter based on historical pattern performance ===
  const ev = await calculateExpectedValue(signal);
  if (ev !== null && ev.ev < 0) {
    return { pass: false, reason: `Negative EV: $${ev.ev.toFixed(4)} (${ev.pattern} win ${ev.winRate}% of ${ev.sampleSize} trades)` };
  }

  return { pass: true, reason: 'OK' };
}

// ============================================================================
// AI VALIDATION - GROK "Second Opinion" (Information Edge)
// ============================================================================

interface AIValidation {
  approved: boolean;
  aiConfidence: number;
  reasoning: string;
  adjustedSL?: number;
  adjustedTP?: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    model: string;
  };
}

async function getAIValidation(signal: Signal): Promise<AIValidation> {
  const ai = getGrok();
  if (!ai) return { approved: true, aiConfidence: signal.confidence, reasoning: 'AI validation disabled' };

  try {
    const ex = getExchange();
    const ticker = await ex.fetchTicker(signal.symbol);

    // Fetch sentiment score from Redis
    const baseAsset = signal.symbol.split('/')[0];
    const sentimentKey = `sentiment:${baseAsset}`;
    const [sentimentRaw, sentimentAlert, evData] = await Promise.all([
      redis.get(sentimentKey),
      redis.get(`sentiment:alert:${baseAsset}`),
      getPatternCalibration(),
    ]);
    const sentimentScore = parseInt(sentimentRaw || '0');
    let sentimentLabel = 'Neutral';
    if (sentimentScore > 0) sentimentLabel = 'Positive';
    if (sentimentScore < 0) sentimentLabel = 'Negative';
    if (sentimentScore >= 2) sentimentLabel = 'Bullish';
    if (sentimentScore <= -2) sentimentLabel = 'Bearish';

    // Calculate EV for this signal's patterns
    const evResult = await calculateExpectedValue(signal, evData);
    const evCtx = evResult
      ? `- **Expected Value:** $${evResult.ev.toFixed(4)} (${evResult.winRate}% win rate over ${evResult.sampleSize} trades)`
      : '- **Expected Value:** insufficient data';
    const alertCtx = sentimentAlert ? `\n- **⚠️ X Alert:** ${sentimentAlert}` : '';

    // === DYNAMIC PORTFOLIO CONTEXT ===
    const [totalCapital, openPositions] = await Promise.all([
      getTotalCapital(),
      getOpenPositions(),
    ]);
    const positionValue = openPositions.reduce((sum, p) => sum + (p.entryPrice * p.quantity), 0);
    const availableCash = Math.max(0, totalCapital - positionValue);
    const positionList = openPositions.map(p =>
      `${p.symbol} $${(p.entryPrice * p.quantity).toFixed(2)}`
    ).join(', ') || 'none';

    const portfolioCtx = `**Portfolio (live from Binance):**
- **Total capital:** $${totalCapital.toFixed(2)} | **Available cash:** ~$${availableCash.toFixed(2)}
- **Open positions:** ${openPositions.length}/${CONFIG.MAX_OPEN_POSITIONS} [${positionList}]
- **Today:** ${dailyState.tradesExecuted}/${CONFIG.MAX_TRADES_PER_DAY} trades | P&L: $${dailyState.dailyPnl.toFixed(2)}`;

    // Use specialized prompt for deep value crash signals
    const isDeepValue = signal.is_deep_value || signal.patterns?.includes('DEEP_VALUE_CRASH');

    const prompt = isDeepValue
      ? `You are "CRASH ORACLE", analyzing a POTENTIAL MARKET CRASH BUY OPPORTUNITY. This is about catching "fat pitches" - rare deep value moments.

**CRASH DATA:**
- **Symbol:** ${signal.symbol}
- **Drawdown:** ${signal.indicators.drawdown_pct}% from recent high ($${signal.indicators.recent_high})
- **Drop Velocity:** ${signal.indicators.drop_velocity}%/hour
- **Volume Spike:** ${signal.indicators.volume_ratio}x average
- **Multi-TF RSI:** 15m=${signal.indicators.rsi}, 1h=${signal.indicators.rsi_1h ?? 'N/A'}, 4h=${signal.indicators.rsi_4h ?? 'N/A'}
- **Support Level:** $${signal.indicators.support_level ?? 'N/A'}

**LIVE MARKET:**
- **Current Price:** $${ticker.last?.toFixed(2)}
- **24h Change:** ${ticker.percentage?.toFixed(2)}%
- **Sentiment:** ${sentimentLabel} (${sentimentScore})${alertCtx}
${evCtx}

${portfolioCtx}
Is this PANIC SELLING (opportunity) or a FALLING KNIFE (avoid)?
Consider: drop velocity, volume pattern, multi-TF RSI alignment, isolated vs broad selloff.

JSON: {"approve": boolean, "confidence": number(0-100), "reasoning": "one sentence", "sl": number|null, "tp": number|null}`
      : `You are "RISK-BOT 9000", a pragmatic crypto trading risk analyst. Your job is to quickly validate trading signals. Approve signals with clear technical backing; reject only obvious traps.

**EVALUATE THIS ${signal.action} SIGNAL:**

**Technical Analysis:**
- **Symbol:** ${signal.symbol} | **Action:** ${signal.action}
- **TA Confidence:** ${(signal.confidence * 100).toFixed(0)}%
- **Patterns:** ${signal.patterns.join(', ')}
- **Reason:** ${signal.reason}
- **Entry:** $${signal.entry_price.toFixed(4)}, SL: $${signal.stop_loss.toFixed(4)}, TP: $${signal.target_price.toFixed(4)}

**Indicators:**
- **RSI:** ${signal.indicators?.rsi ?? 'N/A'} | **MACD hist:** ${signal.indicators?.macd_hist ?? 'N/A'}
- **BB:** lower=$${signal.indicators?.bb_lower ?? 'N/A'} mid=$${signal.indicators?.bb_mid ?? 'N/A'} upper=$${signal.indicators?.bb_upper ?? 'N/A'}
- **ATR:** ${signal.indicators?.atr_pct ?? 'N/A'}% | **EMA9/21:** ${signal.indicators?.ema9 ?? 'N/A'}/${signal.indicators?.ema21 ?? 'N/A'}
- **Volume:** ${signal.indicators?.volume_ratio ?? 'N/A'}x avg | **Trend aligned:** ${signal.indicators?.trend_aligned ?? 'N/A'}
- **ADX:** ${signal.indicators?.adx ?? 'N/A'} | **Market Regime:** ${signal.indicators?.market_regime ?? 'N/A'} | **HTF Trend:** ${signal.indicators?.htf_trend ?? 'N/A'}

**Live Market:**
- **Price:** $${ticker.last?.toFixed(4)} | **24h:** ${ticker.percentage?.toFixed(2)}%
- **Sentiment:** ${sentimentLabel} (${sentimentScore})${alertCtx}
${evCtx}

${portfolioCtx}

**Decision rules:**
- Approve if 2+ indicators confirm AND market regime supports the pattern type (trending patterns need ADX>25, mean-reversion needs ranging market).
- REJECT if signal goes AGAINST higher timeframe trend (HTF).
- REJECT or lower confidence if EV is negative (pattern historically loses money).
- BOOST confidence if X sentiment is bullish (score ≥2) AND technical signal aligns.
- Consider position concentration — reject if we already hold this asset.

JSON ONLY: {"approve": boolean, "confidence": number(0-100), "reasoning": "one sentence", "sl": number|null, "tp": number|null}`;

    // xAI search parameter for real-time X/news context
    const searchConfig: Record<string, unknown> = {};
    try { (searchConfig as any).search = { mode: 'auto' }; } catch {}

    const response = await ai.chat.completions.create({
      model: 'grok-3-mini',
      messages: [
        { role: 'system', content: 'You are RISK-BOT 9000, a strict trading risk analyst. You REJECT more signals than you approve. Only approve signals with clear technical confluence (2+ confirming indicators). Reject if: RSI is neutral (35-65), volume is below average, pattern is weak, risk/reward is marginal, or signal goes against higher timeframe trend. Your job is to PROTECT capital, not find trades. Respond with a single minified JSON object only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 200,
      ...searchConfig,
    });

    const content = response.choices[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { approved: true, aiConfidence: signal.confidence, reasoning: 'AI parse failed - proceeding' };

    const result = JSON.parse(jsonMatch[0]);
    console.log(`[AI] ${signal.symbol}: ${result.approve ? 'APPROVED' : 'REJECTED'} (${result.confidence}%) - ${result.reasoning}`);

    return {
      approved: result.approve,
      aiConfidence: (result.confidence || 50) / 100,
      reasoning: result.reasoning || 'No reasoning',
      adjustedSL: result.sl || undefined,
      adjustedTP: result.tp || undefined,
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
        model: response.model,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[AI] Validation error: ${msg}`);
    // On AI failure, proceed with original signal (fail-open)
    return { approved: true, aiConfidence: signal.confidence, reasoning: `AI error: ${msg}` };
  }
}

// ============================================================================
// POSITION SIZING (Half-Kelly)
// ============================================================================

async function calculatePositionSize(signal: Signal): Promise<number> {
  const capital = await getTotalCapital();
  const isDeepValue = signal.is_deep_value || signal.patterns?.includes('DEEP_VALUE_CRASH');

  // Deep value: 20% max, normal: 12%
  const maxPct = isDeepValue ? 0.20 : CONFIG.MAX_POSITION_SIZE_PCT;
  const maxPositionValue = capital * maxPct;

  // Deep value requires 80%+ confidence after AI blending
  if (isDeepValue && signal.confidence < 0.80) {
    console.log(`[SIZING] Deep value ${signal.symbol} rejected: confidence ${(signal.confidence * 100).toFixed(1)}% < 80%`);
    return 0;
  }

  const risk = Math.abs(signal.entry_price - signal.stop_loss);
  const reward = Math.abs(signal.target_price - signal.entry_price);
  const b = risk > 0 ? reward / risk : 1.5;
  const p = signal.confidence;
  const q = 1 - p;
  const kellyFraction = Math.max(0, ((p * b - q) / b) * 0.5);
  const positionValue = Math.min(capital * kellyFraction, maxPositionValue);

  if (isDeepValue) {
    console.log(`[SIZING] Deep value ${signal.symbol}: Kelly=${(kellyFraction * 100).toFixed(1)}%, value=$${positionValue.toFixed(2)} (max $${maxPositionValue.toFixed(2)})`);
  }

  if (!signal.entry_price || signal.entry_price <= 0) return 0;
  return positionValue / signal.entry_price;
}

// ============================================================================
// EXECUTE BUY + STORE POSITION
// ============================================================================

async function executeBuy(signal: Signal): Promise<{
  success: boolean;
  orderId?: string;
  executedPrice?: number;
  quantity?: number;
  error?: string;
}> {
  const ex = getExchange();
  const rawQuantity = await calculatePositionSize(signal);

  if (rawQuantity <= 0) {
    return { success: false, error: 'Position size too small' };
  }

  try {
    // Load market info for proper quantity rounding
    await ex.loadMarkets();
    const market = ex.market(signal.symbol);
    const quantity = ex.amountToPrecision(signal.symbol, rawQuantity);
    const qty = parseFloat(quantity);

    const positionValue = qty * signal.entry_price;
    // Use pair's actual Binance NOTIONAL minimum (not hardcoded)
    const pairMinNotional = market.limits?.cost?.min || CONFIG.MIN_ORDER_VALUE;
    if (positionValue < pairMinNotional) {
      return { success: false, error: `Value $${positionValue.toFixed(2)} < $${pairMinNotional} min (${signal.symbol})` };
    }

    console.log(`[AUTO-TRADE] BUY ${signal.symbol}: qty=${quantity}, ~$${positionValue.toFixed(2)}, minNotional=${market.limits?.cost?.min || '?'}`);

    // Order book spread check — skip illiquid pairs
    try {
      const orderBook = await ex.fetchOrderBook(signal.symbol, 5);
      if (orderBook.bids?.length && orderBook.asks?.length) {
        const bestBid = orderBook.bids[0]?.[0];
        const bestAsk = orderBook.asks[0]?.[0];
        if (bestBid && bestAsk && bestBid > 0) {
          const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
          if (spreadPct > 0.3) {
            return { success: false, error: `Spread too wide: ${spreadPct.toFixed(3)}% (max 0.3%)` };
          }
          console.log(`[AUTO-TRADE] ${signal.symbol} spread: ${spreadPct.toFixed(3)}%`);
        }
      }
    } catch (e) {
      // Non-fatal — proceed without spread check
    }

    const ticker = await ex.fetchTicker(signal.symbol);
    const currentPrice = ticker.last || signal.entry_price;

    const slippage = Math.abs(currentPrice - signal.entry_price) / signal.entry_price * 100;
    if (slippage > CONFIG.MAX_SLIPPAGE_PCT) {
      return { success: false, error: `Slippage ${slippage.toFixed(2)}%` };
    }

    const order = await ex.createMarketOrder(signal.symbol, 'buy', qty);
    const executedPrice = order.average || order.price || currentPrice;
    const executedQty = Number(order.filled) || qty;

    // Store position in Redis for monitoring
    await addPosition({
      symbol: signal.symbol,
      side: 'BUY',
      entryPrice: executedPrice,
      quantity: executedQty,
      stopLoss: signal.stop_loss,
      takeProfit: signal.target_price,
      trailingStop: signal.stop_loss,   // Starts at stop-loss
      highWaterMark: executedPrice,      // Starts at entry
      orderId: order.id,
      openedAt: new Date().toISOString(),
      pattern: signal.patterns?.join(', ') || '',
      confidence: signal.confidence,
    });

    dailyState.tradesExecuted++;

    console.log(`[AUTO-TRADE] Filled ${order.id} @ $${executedPrice}`);

    return { success: true, orderId: order.id, executedPrice, quantity: executedQty };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[AUTO-TRADE] BUY failed:`, errMsg);
    return { success: false, error: errMsg };
  }
}

// ============================================================================
// EXECUTE MARGIN SELL (SHORT) + STORE POSITION
// ============================================================================

async function executeMarginSell(signal: Signal): Promise<{
  success: boolean;
  orderId?: string;
  executedPrice?: number;
  quantity?: number;
  error?: string;
}> {
  if (CONFIG.TRADING_MODE === 'spot') {
    return { success: false, error: 'Margin sell not available in spot mode' };
  }

  const ex = getExchange();
  const quantity = await calculatePositionSize(signal);

  if (quantity <= 0) {
    return { success: false, error: 'Position size too small' };
  }

  const positionValue = quantity * signal.entry_price;
  if (positionValue < CONFIG.MIN_ORDER_VALUE) {
    return { success: false, error: `Value $${positionValue.toFixed(2)} < $${CONFIG.MIN_ORDER_VALUE} min` };
  }

  console.log(`[AUTO-TRADE] MARGIN SELL ${signal.symbol}: qty=${quantity.toFixed(6)}, ~$${positionValue.toFixed(2)}, leverage=${CONFIG.DEFAULT_LEVERAGE}x`);

  try {
    const ticker = await ex.fetchTicker(signal.symbol);
    const currentPrice = ticker.last || signal.entry_price;

    const slippage = Math.abs(currentPrice - signal.entry_price) / signal.entry_price * 100;
    if (slippage > CONFIG.MAX_SLIPPAGE_PCT) {
      return { success: false, error: `Slippage ${slippage.toFixed(2)}%` };
    }

    // For margin trading, use createMarketOrder with margin params
    const params: any = {};
    if (CONFIG.TRADING_MODE === 'margin') {
      params.marginMode = CONFIG.MARGIN_TYPE;
      params.type = 'margin';
    }

    const order = await ex.createMarketOrder(signal.symbol, 'sell', quantity, undefined, params);
    const executedPrice = order.average || order.price || currentPrice;
    const executedQty = order.filled || quantity;

    // Store short position in Redis for monitoring
    await addPosition({
      symbol: signal.symbol,
      side: 'SELL',
      entryPrice: executedPrice,
      quantity: executedQty,
      stopLoss: signal.stop_loss,
      takeProfit: signal.target_price,
      trailingStop: signal.stop_loss,
      highWaterMark: executedPrice,
      orderId: order.id,
      openedAt: new Date().toISOString(),
      pattern: signal.patterns?.join(', ') || '',
      confidence: signal.confidence,
    });

    dailyState.tradesExecuted++;

    console.log(`[AUTO-TRADE] SHORT Filled ${order.id} @ $${executedPrice}`);

    return { success: true, orderId: order.id, executedPrice, quantity: executedQty };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[AUTO-TRADE] MARGIN SELL failed:`, errMsg);
    return { success: false, error: errMsg };
  }
}

// ============================================================================
// QUEUE CLEANUP - prevent overflow
// ============================================================================

async function trimQueue(): Promise<number> {
  const len = await redis.llen('trades:pending');
  if (len > CONFIG.MAX_PENDING_QUEUE) {
    // Remove oldest signals (they're stale anyway)
    const excess = len - CONFIG.MAX_PENDING_QUEUE;
    for (let i = 0; i < excess; i++) {
      await redis.rpop('trades:pending');
    }
    // Also trim rejected queue
    await redis.ltrim('trades:rejected', 0, 99);
    return excess;
  }
  return 0;
}

// ============================================================================
// GRID TRIGGER CHECKING
// ============================================================================

interface GridResult {
  symbol: string;
  status: 'TRIGGERED' | 'EXECUTED' | 'FAILED' | 'SKIPPED';
  level?: number;
  price?: number;
  error?: string;
}

async function checkGridTriggers(): Promise<GridResult[]> {
  const results: GridResult[] = [];

  try {
    const activeGridsRaw = await redis.get('grid:active');
    if (!activeGridsRaw) return results;

    const activeGrids: string[] = JSON.parse(activeGridsRaw as string);
    if (activeGrids.length === 0) return results;

    // Check open positions - grid only works when we have capacity
    const openPositions = await getOpenPositions();
    if (openPositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
      return results;
    }

    const ex = getExchange();

    for (const symbol of activeGrids) {
      const configRaw = await redis.get(`grid:config:${symbol}`);
      if (!configRaw) continue;

      const config = JSON.parse(configRaw as string);
      if (config.status !== 'active') continue;

      // Check expiry
      if (new Date(config.expiresAt) < new Date()) {
        config.status = 'cancelled';
        await redis.set(`grid:config:${symbol}`, JSON.stringify(config));
        continue;
      }

      // Fetch current price
      const ticker = await ex.fetchTicker(symbol);
      const currentPrice = ticker.last || 0;
      if (currentPrice === 0) continue;

      // Check if price broke below grid floor (3% below lower bound)
      if (currentPrice < config.lowerBound * 0.97) {
        config.status = 'cancelled';
        await redis.set(`grid:config:${symbol}`, JSON.stringify(config));
        console.log(`[GRID] ${symbol} broke below range, cancelled`);
        results.push({ symbol, status: 'SKIPPED', error: 'Price below grid range' });
        continue;
      }

      // Check each unfilled level
      const buyLevels: number[] = config.buyLevels || [];
      const tpTargets: number[] = config.tpTargets || [];
      const filledLevels: number[] = config.filledLevels || [];

      for (let i = 0; i < buyLevels.length; i++) {
        if (filledLevels.includes(i)) continue;

        const levelPrice = buyLevels[i];
        const distancePct = Math.abs(currentPrice - levelPrice) / levelPrice;
        const isBelow = currentPrice <= levelPrice;

        if (isBelow || distancePct <= 0.0015) {
          console.log(`[GRID] ${symbol} hit level #${i}: $${currentPrice.toFixed(2)} -> $${levelPrice.toFixed(2)}`);

          // Check if we still have capacity
          const currentPositions = await getOpenPositions();
          if (currentPositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
            results.push({ symbol, status: 'SKIPPED', level: i, error: 'Max positions reached' });
            break;
          }

          if (currentPositions.some(p => p.symbol === symbol)) {
            results.push({ symbol, status: 'SKIPPED', level: i, error: 'Already in position' });
            break;
          }

          // Create grid signal - bypasses AI validation (LLM already set the range)
          const gridSignal: Signal = {
            symbol,
            action: 'BUY',
            confidence: 0.80,
            reason: `Grid level #${i}: $${levelPrice.toFixed(2)}`,
            patterns: ['GRID_BUY'],
            entry_price: currentPrice,
            stop_loss: config.lowerBound * 0.97,
            target_price: tpTargets[i] || currentPrice * 1.02,
            indicators: {
              rsi: 0,
              bb_width_pct: 0,
              volume_ratio: 0,
              atr_pct: 0,
            },
            position_size: (config.orderSizeUsd || 6) / currentPrice,
            is_grid_buy: true,
          };

          const execution = await executeBuy(gridSignal);

          if (execution.success) {
            // Mark level as filled
            filledLevels.push(i);
            config.filledLevels = filledLevels;
            await redis.set(`grid:config:${symbol}`, JSON.stringify(config));

            await logTrade({
              symbol,
              side: 'BUY',
              quantity: String(execution.quantity),
              entryPrice: String(execution.executedPrice),
              confidence: '0.80',
              pattern: 'GRID_BUY',
              reasoning: `Grid level #${i}: $${levelPrice.toFixed(2)} (range $${config.lowerBound}-$${config.upperBound})`,
              status: 'FILLED',
              agentId: 'grid-trader',
            });

            results.push({
              symbol,
              status: 'EXECUTED',
              level: i,
              price: execution.executedPrice,
            });

            // Only fill one level per cycle
            break;
          } else {
            results.push({
              symbol,
              status: 'FAILED',
              level: i,
              error: execution.error,
            });
          }
        }
      }

      // Check if all levels filled -> grid complete
      if (filledLevels.length >= buyLevels.length && buyLevels.length > 0) {
        config.status = 'completed';
        await redis.set(`grid:config:${symbol}`, JSON.stringify(config));
        console.log(`[GRID] ${symbol} grid completed - all ${buyLevels.length} levels filled`);
      }
    }
  } catch (error) {
    console.error('[GRID] Check error:', error);
  }

  return results;
}

// ============================================================================
// POST /api/auto-trade - Main loop: monitor + buy + cleanup
// ============================================================================

export async function POST() {
  try {
    resetDailyStateIfNeeded();

    // STEP 1: Monitor existing positions (check SL/TP/trailing)
    const monitorResults = await monitorPositions();
    const sells = monitorResults.filter(r => r.action !== 'HOLD' && r.action !== 'ERROR');

    // STEP 2: Trim queue to prevent overflow
    const trimmed = await trimQueue();

    // STEP 2.5: Check grid triggers (priority over normal signals)
    const gridResults = await checkGridTriggers();

    // STEP 3: Process new BUY signals (top 5 by confidence to save AI tokens)
    const rawList = await redis.lrange('trades:pending', 0, 49);
    const parsed: { signal: Signal; raw: string }[] = [];
    for (const raw of rawList) {
      try { parsed.push({ signal: JSON.parse(raw), raw }); } catch { continue; }
    }

    // STEP 3a: Boost signals from GainerScanner top movers
    let topMovers: string[] = [];
    try {
      const scannerRaw = await redis.get('scanner:top_movers');
      if (scannerRaw) {
        const scannerData = JSON.parse(scannerRaw);
        const gainers = (scannerData.gainers || [])
          .filter((g: any) => g.change_pct >= 3.0)
          .map((g: any) => g.symbol);
        const volSurges = (scannerData.volume_surges || [])
          .map((v: any) => v.symbol);
        topMovers = [...new Set([...gainers, ...volSurges])];
      }
    } catch { /* scanner data not available */ }

    for (const p of parsed) {
      if (topMovers.includes(p.signal.symbol)) {
        p.signal.confidence = Math.min(0.95, (p.signal.confidence || 0) + 0.10);
        p.signal.reason = (p.signal.reason || '') + ' | 🔥 GainerScanner top mover';
      }
    }

    parsed.sort((a, b) => (b.signal.confidence || 0) - (a.signal.confidence || 0));
    const topSignals = parsed.slice(0, 5);
    // Remove low-quality signals we won't process
    for (const p of parsed.slice(5)) {
      await redis.lrem('trades:pending', 1, p.raw);
    }

    let executed = 0;
    let rejected = 0;
    const buyResults: any[] = [];

    for (const { signal, raw } of topSignals) {

      const riskCheck = await passesRiskChecks(signal);

      if (!riskCheck.pass) {
        await redis.lrem('trades:pending', 1, raw);
        rejected++;
        buyResults.push({
          symbol: signal.symbol,
          status: 'RISK_REJECTED',
          reason: riskCheck.reason,
        });
        continue;
      }

      // STEP 3b: AI Validation (Information Edge)
      const aiResult = await getAIValidation(signal);

      // Log validation attempt (regardless of outcome)
      try {
        await saveValidation({
          signalId: undefined, // Linked if we had a signal ID
          symbol: signal.symbol,
          action: signal.action,
          originalConfidence: String(signal.confidence),
          adjustedConfidence: String(aiResult.aiConfidence),
          consensusLevel: 'UNKNOWN',
          sourceVotes: [],
          technicalIndicators: signal.indicators,
          priceTargets: {
            original: { entry: signal.entry_price, sl: signal.stop_loss, tp: signal.target_price },
            adjusted: { sl: aiResult.adjustedSL, tp: aiResult.adjustedTP }
          },
          entryTiming: 'IMMEDIATE',
          riskLevel: 'UNKNOWN',
          approved: aiResult.approved,
          reasoning: aiResult.reasoning,
          agentId: 'grok-validator',
          usage: aiResult.usage,
        });
      } catch (err) {
        console.error('[AUTO-TRADE] Failed to save validation:', err);
      }

      if (!aiResult.approved) {
        await redis.lrem('trades:pending', 1, raw);
        rejected++;
        buyResults.push({
          symbol: signal.symbol,
          status: 'AI_REJECTED',
          reason: aiResult.reasoning,
          aiConfidence: aiResult.aiConfidence,
        });
        continue;
      }

      // Apply AI-adjusted levels if provided
      if (aiResult.adjustedSL) signal.stop_loss = aiResult.adjustedSL;
      if (aiResult.adjustedTP) signal.target_price = aiResult.adjustedTP;

      // Blend TA + AI confidence (50% TA, 50% AI)
      signal.confidence = signal.confidence * 0.5 + aiResult.aiConfidence * 0.5;

      // Execute based on signal action
      const execution = signal.action === 'SELL'
        ? await executeMarginSell(signal)
        : await executeBuy(signal);
      await redis.lrem('trades:pending', 1, raw);

      if (execution.success) {
        await redis.lpush('trades:approved', JSON.stringify({
          ...signal,
          executedAt: new Date().toISOString(),
          orderId: execution.orderId,
          executedPrice: execution.executedPrice,
          executedQuantity: execution.quantity,
          aiValidation: aiResult.reasoning,
          blendedConfidence: signal.confidence,
        }));

        await logTrade({
          symbol: signal.symbol,
          side: signal.action as 'BUY' | 'SELL',
          quantity: String(execution.quantity),
          entryPrice: String(execution.executedPrice),
          confidence: String(signal.confidence),
          pattern: signal.patterns?.join(', ') || '',
          reasoning: `${signal.reason} | AI: ${aiResult.reasoning}`,
          status: 'FILLED',
          agentId: 'auto-trader',
        });

        executed++;
        buyResults.push({
          symbol: signal.symbol,
          status: 'EXECUTED',
          orderId: execution.orderId,
          price: execution.executedPrice,
          quantity: execution.quantity,
        });
      } else {
        rejected++;
        buyResults.push({
          symbol: signal.symbol,
          status: 'FAILED',
          error: execution.error,
        });
      }
    }

    return NextResponse.json({
      success: true,
      monitor: monitorResults,
      sells: sells.length,
      buys: executed,
      rejected,
      trimmed,
      dailyPnl: dailyState.dailyPnl,
      buyResults,
      gridResults,
    });
  } catch (error) {
    console.error('[AUTO-TRADE] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Auto-trade failed' },
      { status: 500 }
    );
  }
}

// ============================================================================
// GET /api/auto-trade - Status with position details
// ============================================================================

export async function GET() {
  resetDailyStateIfNeeded();

  const positions = await getOpenPositions();
  const pendingCount = await redis.llen('trades:pending');
  const approvedCount = await redis.llen('trades:approved');

  // Fetch current prices for positions
  const positionDetails: any[] = [];
  if (positions.length > 0) {
    const ex = getExchange();
    for (const pos of positions) {
      try {
        const ticker = await ex.fetchTicker(pos.symbol);
        const price = ticker.last || 0;
        const pnl = (price - pos.entryPrice) * pos.quantity;
        const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
        positionDetails.push({
          ...pos,
          currentPrice: price,
          pnl: +pnl.toFixed(4),
          pnlPct: +pnlPct.toFixed(2),
        });
      } catch {
        positionDetails.push({ ...pos, currentPrice: 0, pnl: 0, pnlPct: 0 });
      }
    }
  }

  // Fetch active grid configs
  const activeGridsRaw = await redis.get('grid:active');
  const activeGrids: string[] = activeGridsRaw ? JSON.parse(activeGridsRaw as string) : [];
  const gridConfigs: any[] = [];
  for (const sym of activeGrids) {
    const raw = await redis.get(`grid:config:${sym}`);
    if (raw) gridConfigs.push(JSON.parse(raw as string));
  }

  return NextResponse.json({
    success: true,
    status: 'active',
    config: CONFIG,
    positions: positionDetails,
    dailyState: {
      date: dailyState.date,
      tradesExecuted: dailyState.tradesExecuted,
      dailyPnl: dailyState.dailyPnl,
    },
    queues: { pending: pendingCount, approved: approvedCount },
    grids: gridConfigs,
    isTestnet: process.env.BINANCE_TESTNET === 'true',
  });
}
