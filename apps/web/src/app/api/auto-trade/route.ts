import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logTrade } from '@cryonix/database';
import ccxt, { type Exchange } from 'ccxt';
import OpenAI from 'openai';

export const dynamic = 'force-dynamic';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  TOTAL_CAPITAL: 17,
  MAX_POSITION_SIZE_PCT: 0.35,     // 35% per position (~$6 max)
  MIN_CONFIDENCE: 0.75,
  MAX_DAILY_LOSS_PCT: 0.05,        // 5% (~$0.85)
  MAX_OPEN_POSITIONS: 2,
  MAX_TRADES_PER_DAY: 3,
  MAX_SLIPPAGE_PCT: 0.3,
  SPOT_ONLY: true,
  MIN_ORDER_VALUE: 5.5,
  TRAILING_STOP_PCT: 1.0,          // 1% trailing stop after profit
  MAX_PENDING_QUEUE: 20,           // Auto-trim queue beyond this
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
  const config: any = {
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
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
  return exchange;
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
  indicators: Record<string, number>;
  position_size: number;
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

      const pnl = (currentPrice - pos.entryPrice) * pos.quantity;
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      // Update high water mark and trailing stop
      if (currentPrice > pos.highWaterMark) {
        pos.highWaterMark = currentPrice;
        // Move trailing stop up (only goes up, never down)
        const newTrailingStop = currentPrice * (1 - CONFIG.TRAILING_STOP_PCT / 100);
        if (newTrailingStop > pos.trailingStop) {
          pos.trailingStop = newTrailingStop;
        }
      }

      // Check exit conditions
      let shouldSell = false;
      let exitReason = '';

      // 1. Take-profit hit
      if (currentPrice >= pos.takeProfit) {
        shouldSell = true;
        exitReason = `Take-profit hit: $${currentPrice.toFixed(2)} >= $${pos.takeProfit.toFixed(2)}`;
      }
      // 2. Stop-loss hit
      else if (currentPrice <= pos.stopLoss) {
        shouldSell = true;
        exitReason = `Stop-loss hit: $${currentPrice.toFixed(2)} <= $${pos.stopLoss.toFixed(2)}`;
      }
      // 3. Trailing stop hit (only active when in profit)
      else if (pnl > 0 && currentPrice <= pos.trailingStop && pos.trailingStop > pos.entryPrice) {
        shouldSell = true;
        exitReason = `Trailing stop hit: $${currentPrice.toFixed(2)} <= $${pos.trailingStop.toFixed(2)} (high: $${pos.highWaterMark.toFixed(2)})`;
      }

      if (shouldSell) {
        // SELL the position
        console.log(`[MONITOR] Selling ${pos.symbol}: ${exitReason}`);
        try {
          const sellOrder = await ex.createMarketOrder(
            pos.symbol,
            'sell',
            pos.quantity
          );

          const sellPrice = sellOrder.average || sellOrder.price || currentPrice;
          const realizedPnl = (sellPrice - pos.entryPrice) * pos.quantity;
          const fees = (sellOrder.fee?.cost || 0);

          // Remove from open positions
          await removePosition(pos.symbol);

          // Update daily P&L
          dailyState.dailyPnl += realizedPnl - fees;

          // Log to database
          await logTrade({
            symbol: pos.symbol,
            side: 'SELL',
            quantity: String(pos.quantity),
            entryPrice: String(pos.entryPrice),
            exitPrice: String(sellPrice),
            pnl: String(realizedPnl - fees),
            confidence: String(pos.confidence),
            pattern: pos.pattern,
            reasoning: exitReason,
            status: 'CLOSED',
            agentId: 'auto-trader',
          });

          const exitType = currentPrice >= pos.takeProfit ? 'SOLD_TP' :
                          currentPrice <= pos.stopLoss ? 'SOLD_SL' : 'SOLD_TRAILING';

          console.log(`[MONITOR] ${pos.symbol} ${exitType}: PnL $${(realizedPnl - fees).toFixed(4)} (${pnlPct.toFixed(2)}%)`);

          results.push({
            symbol: pos.symbol,
            action: exitType,
            currentPrice: sellPrice,
            pnl: realizedPnl - fees,
            pnlPct,
            reason: exitReason,
            orderId: sellOrder.id,
          });
        } catch (sellError) {
          const errMsg = sellError instanceof Error ? sellError.message : String(sellError);
          console.error(`[MONITOR] Failed to sell ${pos.symbol}:`, errMsg);
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

  if (dailyState.dailyPnl <= -(CONFIG.TOTAL_CAPITAL * CONFIG.MAX_DAILY_LOSS_PCT)) {
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

  const risk = Math.abs(signal.entry_price - signal.stop_loss);
  const reward = Math.abs(signal.target_price - signal.entry_price);
  if (risk > 0 && reward / risk < 1.3) {
    return { pass: false, reason: `R/R ${(reward / risk).toFixed(2)} < 1.3` };
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
    const sentimentScore = parseInt(await redis.get(sentimentKey) || '0');
    let sentimentLabel = 'Neutral';
    if (sentimentScore > 0) sentimentLabel = 'Positive';
    if (sentimentScore < 0) sentimentLabel = 'Negative';

    const prompt = `You are "RISK-BOT 9000", a hyper-skeptical, cynical, and world-weary crypto trading risk analyst. Your job is to find reasons NOT to make a trade. You only approve trades that are exceptionally obvious.

**EVALUATE THE FOLLOWING BUY SIGNAL:**

**1. Technical Analysis (The Chart Story):**
- **Symbol:** ${signal.symbol}
- **TA Confidence:** ${(signal.confidence * 100).toFixed(0)}%
- **Patterns:** ${signal.patterns.join(', ')}
- **Reason:** ${signal.reason}
- **Signal Price Points:** Entry: $${signal.entry_price.toFixed(2)}, SL: $${signal.stop_loss.toFixed(2)}, TP: $${signal.target_price.toFixed(2)}

**2. Live Market Data (The Reality):**
- **Current Price:** $${ticker.last?.toFixed(2)}
- **24h Change:** ${ticker.percentage?.toFixed(2)}%
- **24h Volume (Base):** ${ticker.baseVolume?.toFixed(0)}
- **Key Indicators:** RSI=${signal.indicators.rsi}, BB Width=${signal.indicators.bb_width_pct}%, Volume Ratio=${signal.indicators.volume_ratio}x

**3. News Sentiment (The Word on the Street):**
- **Recent Sentiment:** ${sentimentLabel} (Score: ${sentimentScore})

**4. Constraints (The Rules):**
- **Capital:** Micro-account ($17 total).
- **Position Size:** Max ~$6 per trade.
- **Rules:** Spot trading only.

**YOUR TASK:**
Critically analyze this. Is the TA story confirmed or contradicted by the live market reality and the news sentiment? Is this signal good enough for a micro-account where every penny counts? Be cynical.

Respond ONLY with a single, minified JSON object:
{"approve": boolean, "confidence": number(0-100), "reasoning": "Your cynical, one-sentence takedown or grudging approval.", "sl": number|null, "tp": number|null}`;

    const response = await ai.chat.completions.create({
      model: 'grok-3-mini-fast',
      messages: [
        { role: 'system', content: 'You are a cynical trading risk analyst named RISK-BOT 9000. Respond with a single, minified JSON object and nothing else.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 250,
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

function calculatePositionSize(signal: Signal): number {
  const maxPositionValue = CONFIG.TOTAL_CAPITAL * CONFIG.MAX_POSITION_SIZE_PCT;
  const risk = Math.abs(signal.entry_price - signal.stop_loss);
  const reward = Math.abs(signal.target_price - signal.entry_price);
  const b = risk > 0 ? reward / risk : 1.5;
  const p = signal.confidence;
  const q = 1 - p;
  const kellyFraction = Math.max(0, ((p * b - q) / b) * 0.5);
  const positionValue = Math.min(CONFIG.TOTAL_CAPITAL * kellyFraction, maxPositionValue);
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
  const quantity = calculatePositionSize(signal);

  if (quantity <= 0) {
    return { success: false, error: 'Position size too small' };
  }

  const positionValue = quantity * signal.entry_price;
  if (positionValue < CONFIG.MIN_ORDER_VALUE) {
    return { success: false, error: `Value $${positionValue.toFixed(2)} < $${CONFIG.MIN_ORDER_VALUE} min` };
  }

  console.log(`[AUTO-TRADE] BUY ${signal.symbol}: qty=${quantity.toFixed(6)}, ~$${positionValue.toFixed(2)}`);

  try {
    const ticker = await ex.fetchTicker(signal.symbol);
    const currentPrice = ticker.last || signal.entry_price;

    const slippage = Math.abs(currentPrice - signal.entry_price) / signal.entry_price * 100;
    if (slippage > CONFIG.MAX_SLIPPAGE_PCT) {
      return { success: false, error: `Slippage ${slippage.toFixed(2)}%` };
    }

    const order = await ex.createMarketOrder(signal.symbol, 'buy', quantity);
    const executedPrice = order.average || order.price || currentPrice;
    const executedQty = order.filled || quantity;

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

    // STEP 3: Process new BUY signals
    const rawList = await redis.lrange('trades:pending', 0, 49);
    let executed = 0;
    let rejected = 0;
    const buyResults: any[] = [];

    for (const raw of rawList) {
      let signal: Signal;
      try { signal = JSON.parse(raw); } catch { continue; }

      const riskCheck = await passesRiskChecks(signal);

      if (!riskCheck.pass) {
        // Clean non-BUY signals from queue
        if (signal.action !== 'BUY') {
          await redis.lrem('trades:pending', 1, raw);
          rejected++;
        }
        continue;
      }

      // STEP 3b: AI Validation (Information Edge)
      const aiResult = await getAIValidation(signal);
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

      // Execute BUY
      const execution = await executeBuy(signal);
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
          side: 'BUY',
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
    isTestnet: process.env.BINANCE_TESTNET === 'true',
  });
}
