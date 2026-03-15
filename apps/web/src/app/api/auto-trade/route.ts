import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logTrade, saveValidation, archivePosition, createPosition, closePositionBySymbol, markLatestSignalExecuted } from '@cryonix/database';
import { fullConfig, loadConfig } from '@/lib/config';
import { getConfigVersion } from '@/lib/config-version';
import ccxt, { type Exchange } from 'ccxt';
import OpenAI from 'openai';

import { TimingService } from '@/lib/trading/timing';

export const dynamic = 'force-dynamic';

// ============================================================================
// ENVIRONMENT GUARD — prevent accidental real trading from dev/local
// ============================================================================

const CRYONIX_ENV = process.env.CRYONIX_ENV || 'development';
const IS_PRODUCTION = CRYONIX_ENV === 'production';

if (!IS_PRODUCTION) {
  console.warn(`⚠️ [AUTO-TRADE] Running in ${CRYONIX_ENV} mode — real order execution BLOCKED`);
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = loadConfig();
const TOML = fullConfig();

// ============================================================================
// INSTANCE LOCK — prevent multiple environments from trading the same account
// ============================================================================

const INSTANCE_ID = require('os').hostname();
const INSTANCE_LOCK_KEY = 'instance:trading_lock';
const INSTANCE_LOCK_TTL = TOML?.timing.instance_lock_ttl_seconds ?? 60;

async function acquireInstanceLock(): Promise<{ acquired: boolean; holder?: string }> {
  const result = await redis.set(INSTANCE_LOCK_KEY, INSTANCE_ID, 'EX', INSTANCE_LOCK_TTL, 'NX');
  if (result === 'OK') return { acquired: true };
  const holder = await redis.get(INSTANCE_LOCK_KEY);
  if (holder === INSTANCE_ID) {
    await redis.expire(INSTANCE_LOCK_KEY, INSTANCE_LOCK_TTL);
    return { acquired: true };
  }
  // Self-healing: if lock holder hasn't refreshed within 2x TTL, force-acquire
  // This handles stale locks from crashed/redeployed containers
  const ttl = await redis.ttl(INSTANCE_LOCK_KEY);
  if (ttl <= 0) {
    // Lock expired or has no TTL — force acquire
    await redis.set(INSTANCE_LOCK_KEY, INSTANCE_ID, 'EX', INSTANCE_LOCK_TTL);
    console.log(`[INSTANCE-LOCK] Force-acquired stale lock (was held by ${holder}, TTL=${ttl})`);
    return { acquired: true };
  }
  return { acquired: false, holder: holder as string };
}

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
    timeout: 10000, // 10s timeout on all Binance API calls
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
const CAPITAL_CACHE_MS = TOML?.timing.capital_cache_ms ?? 5 * 60 * 1000;

async function getTotalCapital(): Promise<number> {
  const now = Date.now();
  if (cachedCapital > 0 && (now - capitalLastFetched < CAPITAL_CACHE_MS)) return cachedCapital;
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
  aiEstimatedMinutes?: number;
  stagnationOverrideHours?: number;
  moonshot_score?: number;
  trade_type?: string;
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
  nativeSlOrderId?: string; // Binance-native stop-loss order (safety net)
  openedAt: string;
  pattern: string;
  confidence: number;
  isGridPosition?: boolean; // Track whether position came from grid strategy
  isScalpPosition?: boolean; // Track whether position is a scalp trade
  pnlPct?: number;         // Live P&L % (updated every monitoring cycle)
  currentPrice?: number;   // Last known price (updated every monitoring cycle)
  entryFee?: number;       // Fee paid on entry order (for total fee tracking)
  
  // --- NEW FIELDS FOR ETA & VELOCITY ---
  lastPrice?: number;      // Price from previous cycle to calculate velocity
  velocity?: number;       // Price change per minute ($/min)
  estimatedTpTime?: string; // ISO string for expected TP arrival
  aiEstimatedMinutes?: number; // Initial estimate from Grok
  stagnationOverrideHours?: number; // AI-suggested timeout
  etaNotified?: boolean;   // True once initial ETA Telegram sent
  stagnationWarned?: boolean; // True once stagnation warning Telegram sent
  moonshot_score?: number;
  trade_type?: string;
  exitPlan?: ExitPlan;
}

// ============================================================================
// TIERED EXIT ENGINE — T1/T2/T3 partial sells + ratcheting trail (Phase 3)
// ============================================================================

interface ExitTier {
  name: 'T1' | 'T2' | 'T3';
  targetPrice: number;
  sellPct: number;
  status: 'pending' | 'filled' | 'skipped';
  filledAt?: string;
  filledPrice?: number;
  filledQty?: number;
}

interface ExitPlan {
  tradeType: 'scalp' | 'standard' | 'moonshot';
  moonshotScore: number;
  atr: number;
  tiers: ExitTier[];
  originalQuantity: number;
  remainingQuantity: number;
  breakeven: boolean;
  highWaterMarkAt: string;
  ratchetTrailPrice: number;
  ratchetActive: boolean;
  stagnationHours: number;
}

// ── 3a. Replace native SL order ──────────────────────────────────────

async function replaceNativeSl(
  symbol: string,
  newQty: number,
  newStopPrice: number,
  oldOrderId?: string,
): Promise<string | undefined> {
  const ex = getExchange();
  // Cancel old SL (non-fatal if already triggered)
  if (oldOrderId) {
    try {
      await ex.cancelOrder(oldOrderId, symbol);
      console.log(`[TIERED-EXIT] Cancelled old native SL ${oldOrderId}`);
    } catch {
      // May already be triggered or expired
    }
  }
  try {
    const slPrice = ex.priceToPrecision(symbol, newStopPrice);
    const slLimitPrice = ex.priceToPrecision(symbol, newStopPrice * (1 - (TOML?.exits.native_sl_limit_offset ?? 0.005)));
    const roundedQty = parseFloat(ex.amountToPrecision(symbol, newQty));
    if (roundedQty <= 0) return undefined;
    const slOrder = await ex.createOrder(
      symbol,
      'STOP_LOSS_LIMIT',
      'sell',
      roundedQty,
      parseFloat(slLimitPrice),
      { stopPrice: parseFloat(slPrice) },
    );
    console.log(`[TIERED-EXIT] Native SL placed: ${slOrder.id} @ $${slPrice} (qty=${roundedQty}, limit $${slLimitPrice})`);
    return slOrder.id;
  } catch (err) {
    console.warn(`[TIERED-EXIT] Native SL placement failed (software SL active):`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

// ── 3b. Create exit plan for a new position ──────────────────────────

function createExitPlan(
  signal: Signal,
  executedPrice: number,
  executedQty: number,
  atr: number,
): ExitPlan | undefined {
  if (!TOML?.exits?.tiered_exits_enabled) return undefined;
  if (atr <= 0) return undefined;

  const tradeType: ExitPlan['tradeType'] =
    signal.trade_type === 'moonshot' ? 'moonshot' :
    signal.trade_type === 'scalp' ? 'scalp' : 'standard';
  const moonshotScore = signal.moonshot_score ?? 0;

  // ATR multipliers per trade type
  const t1Mult = TOML.exits[`t1_atr_mult_${tradeType}` as keyof typeof TOML.exits] as number ?? 2.0;
  const t2Mult = TOML.exits[`t2_atr_mult_${tradeType}` as keyof typeof TOML.exits] as number ?? 4.0;

  // Allocation percentages
  const t1Pct = TOML.exits[`t1_pct_${tradeType}` as keyof typeof TOML.exits] as number ?? 0.40;
  const t2Pct = TOML.exits[`t2_pct_${tradeType}` as keyof typeof TOML.exits] as number ?? 0.30;
  const t3Pct = TOML.exits[`t3_pct_${tradeType}` as keyof typeof TOML.exits] as number ?? 0.30;

  const t1Target = executedPrice + t1Mult * atr;
  const t2Target = executedPrice + t2Mult * atr;

  // Min split value check: if T1 portion notional is too small, degenerate plan
  const minSplit = TOML.exits.min_split_value ?? 7.50;
  const t1Qty = executedQty * t1Pct;
  const t1Value = t1Qty * t1Target;

  let tiers: ExitTier[];
  if (t1Value < minSplit) {
    // Degenerate: single exit at T2 price with 100% qty
    tiers = [
      { name: 'T1', targetPrice: t2Target, sellPct: 1.0, status: 'pending' },
      { name: 'T2', targetPrice: t2Target, sellPct: 0, status: 'skipped' },
      { name: 'T3', targetPrice: 0, sellPct: 0, status: 'skipped' },
    ];
  } else {
    tiers = [
      { name: 'T1', targetPrice: t1Target, sellPct: t1Pct, status: 'pending' },
      { name: 'T2', targetPrice: t2Target, sellPct: t2Pct, status: 'pending' },
      { name: 'T3', targetPrice: 0, sellPct: t3Pct, status: 'pending' }, // T3 = ratcheting trail, no fixed target
    ];
  }

  const stagnationKey = `stagnation_${tradeType}` as keyof typeof TOML.exits;
  const stagnationHours = TOML.exits[stagnationKey] as number ?? 16;

  return {
    tradeType,
    moonshotScore,
    atr,
    tiers,
    originalQuantity: executedQty,
    remainingQuantity: executedQty,
    breakeven: false,
    highWaterMarkAt: new Date().toISOString(),
    ratchetTrailPrice: 0,
    ratchetActive: false,
    stagnationHours,
  };
}

// ── 3c. Migration helper for existing positions ──────────────────────

function createDefaultExitPlan(pos: OpenPosition): ExitPlan | undefined {
  if (!TOML?.exits?.tiered_exits_enabled) return undefined;

  const tpAtr = TOML.exits.tp_atr_multiplier ?? 6.0;
  const derivedAtr = tpAtr > 0 ? (pos.takeProfit - pos.entryPrice) / tpAtr : 0;
  if (derivedAtr <= 0) return undefined;

  const tradeType: ExitPlan['tradeType'] =
    pos.trade_type === 'moonshot' ? 'moonshot' :
    pos.trade_type === 'scalp' ? 'scalp' : 'standard';

  const t1Pct = TOML.exits[`t1_pct_${tradeType}` as keyof typeof TOML.exits] as number ?? 0.40;
  const t2Pct = TOML.exits[`t2_pct_${tradeType}` as keyof typeof TOML.exits] as number ?? 0.30;
  const t3Pct = TOML.exits[`t3_pct_${tradeType}` as keyof typeof TOML.exits] as number ?? 0.30;

  const t1Target = (pos.entryPrice + pos.takeProfit) / 2; // Midpoint
  const t2Target = pos.takeProfit;

  const stagnationKey = `stagnation_${tradeType}` as keyof typeof TOML.exits;
  const stagnationHours = TOML.exits[stagnationKey] as number ?? 16;

  return {
    tradeType,
    moonshotScore: pos.moonshot_score ?? 0,
    atr: derivedAtr,
    tiers: [
      { name: 'T1', targetPrice: t1Target, sellPct: t1Pct, status: 'pending' },
      { name: 'T2', targetPrice: t2Target, sellPct: t2Pct, status: 'pending' },
      { name: 'T3', targetPrice: 0, sellPct: t3Pct, status: 'pending' },
    ],
    originalQuantity: pos.quantity,
    remainingQuantity: pos.quantity,
    breakeven: false,
    highWaterMarkAt: pos.openedAt || new Date().toISOString(),
    ratchetTrailPrice: 0,
    ratchetActive: false,
    stagnationHours,
  };
}

// ── 3d. Execute a partial sell ───────────────────────────────────────

async function executePartialSell(
  pos: OpenPosition,
  sellQty: number,
  tier: ExitTier,
  currentPrice: number,
): Promise<{ success: boolean; filledQty?: number; filledPrice?: number; fee?: number; error?: string }> {
  if (!IS_PRODUCTION) {
    console.log(`[DEV-MODE] Would partial sell ${pos.symbol} ${tier.name} — blocked`);
    return { success: false, error: 'blocked in dev mode' };
  }

  const ex = getExchange();
  try {
    await ex.loadMarkets();
    const roundedQty = parseFloat(ex.amountToPrecision(pos.symbol, sellQty));
    if (roundedQty <= 0) return { success: false, error: 'qty rounds to 0' };

    const notionalValue = roundedQty * currentPrice;
    if (notionalValue < CONFIG.MIN_ORDER_VALUE) {
      return { success: false, error: `notional $${notionalValue.toFixed(2)} < min $${CONFIG.MIN_ORDER_VALUE}` };
    }

    const order = await ex.createMarketOrder(pos.symbol, 'sell', roundedQty);
    const filledPrice = order.average || order.price || currentPrice;
    const filledQty = Number(order.filled) || roundedQty;
    const fee = order.fee?.cost || 0;

    console.log(`[TIERED-EXIT] ${tier.name} partial sell ${pos.symbol}: qty=${filledQty}, price=$${filledPrice}, fee=$${fee.toFixed(4)}`);
    return { success: true, filledQty, filledPrice, fee };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // NOTIONAL error: qty too small — caller should fallback to full sell
    console.warn(`[TIERED-EXIT] ${tier.name} partial sell failed for ${pos.symbol}: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

// ── 3e. Ratcheting trail multiplier ──────────────────────────────────

function getRatchetTrailMult(profitPct: number): number {
  if (profitPct >= 20) return TOML?.exits?.ratchet_20pct_mult ?? 3.0;
  if (profitPct >= 10) return TOML?.exits?.ratchet_10pct_mult ?? 2.5;
  if (profitPct >= 5) return TOML?.exits?.ratchet_5pct_mult ?? 2.0;
  return 1.0; // Base trailing_stop_pct
}

// ── 3f. Archive a partial exit ───────────────────────────────────────

async function archivePartialExit(
  pos: OpenPosition,
  tier: ExitTier,
  result: { filledQty?: number; filledPrice?: number; fee?: number },
  closeReason: string,
): Promise<void> {
  const filledQty = result.filledQty ?? 0;
  const filledPrice = result.filledPrice ?? 0;
  const pnl = (filledPrice - pos.entryPrice) * filledQty - (result.fee ?? 0);
  const pnlPct = pos.entryPrice > 0 ? ((filledPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;

  try {
    await archivePosition({
      symbol: pos.symbol,
      side: pos.side,
      quantity: String(filledQty),
      entryPrice: String(pos.entryPrice),
      exitPrice: String(filledPrice),
      stopLoss: String(pos.stopLoss),
      takeProfit: String(pos.takeProfit),
      pnl: String(pnl),
      pnlPercent: String(pnlPct),
      fees: String(result.fee ?? 0),
      holdingPeriod: Math.round((Date.now() - new Date(pos.openedAt || Date.now()).getTime()) / 1000),
      openedAt: new Date(pos.openedAt || Date.now()),
      closedAt: new Date(),
      closeReason,
      pattern: pos.pattern,
      metadata: { tier: tier.name, partial: true, configVersion: getConfigVersion() },
      agentId: 'auto-trader',
    });
  } catch (err) {
    console.warn(`[TIERED-EXIT] Archive partial exit failed (non-critical):`, err);
  }

  // Log partial trade
  try {
    await logTrade({
      symbol: pos.symbol,
      side: 'SELL',
      quantity: String(filledQty),
      entryPrice: String(pos.entryPrice),
      exitPrice: String(filledPrice),
      pnl: String(pnl),
      fees: String(result.fee ?? 0),
      confidence: String(pos.confidence),
      pattern: pos.pattern,
      reasoning: `${tier.name} partial sell (${(tier.sellPct * 100).toFixed(0)}%)`,
      status: 'CLOSED',
      agentId: 'auto-trader',
      configVersion: getConfigVersion(),
    });
  } catch { /* non-critical */ }

  // Track partial PnL in daily state
  try { await addDailyPnl(pnl); } catch (e) { console.warn('[DAILY_PNL] Failed to track PnL:', e); }
}

// ============================================================================
// CAPITAL ALLOCATOR — Single source of truth for strategy budgets
// ============================================================================

interface CapitalBudget {
  totalCapital: number;
  signalBudget: number;      // Max $ for signal trades
  gridBudget: number;        // Max $ for grid trades
  scalpBudget: number;       // Max $ for scalp trades
  reserve: number;           // Always kept free
  signalUsed: number;        // Currently allocated to signal positions
  gridUsed: number;          // Currently allocated to grid positions
  scalpUsed: number;         // Currently allocated to scalp positions
  signalRemaining: number;
  gridRemaining: number;
  scalpRemaining: number;
  regime: string;            // Current market regime
}

async function getCapitalBudget(): Promise<CapitalBudget> {
  const capital = await getTotalCapital();
  const positions = await getOpenPositions();

  // Get current market regime from latest signal data
  let regime = 'unknown';
  try {
    const regimeRaw = await redis.get('market:regime');
    if (regimeRaw) regime = regimeRaw;
  } catch (e) { console.warn('[CAPITAL] Failed to read market regime:', e); }

  // Base allocation
  let signalPct = CONFIG.SIGNAL_POOL_PCT;
  let gridPct = CONFIG.GRID_POOL_PCT;
  let reservePct = CONFIG.RESERVE_PCT;
  let scalpPct = CONFIG.SCALP_POOL_PCT ?? 0;

  // Regime-based adjustments
  if (regime === 'volatile') {
    // Volatile: pause grid, increase reserve, reduce signal pool
    gridPct = TOML?.regime.volatile_grid_pct ?? 0;
    reservePct = TOML?.regime.volatile_reserve_pct ?? 0.30;
    signalPct = TOML?.regime.volatile_signal_pct ?? 0.70;
    console.log('[ALLOCATOR] Volatile regime: grid paused, reserve increased to 30%');
  } else if (regime === 'trending') {
    // Trending: boost signal pool (trend strategies excel)
    signalPct = TOML?.regime.trending_signal_pct ?? 0.72;
    gridPct = TOML?.regime.trending_grid_pct ?? 0.18;
    reservePct = TOML?.regime.trending_reserve_pct ?? 0.10;
  }
  // ranging: default allocation (grid works well in ranges)

  const signalBudget = capital * signalPct;
  const gridBudget = capital * gridPct;
  const scalpBudget = capital * scalpPct;
  const reserve = capital * reservePct;

  // Calculate current usage
  let signalUsed = 0;
  let gridUsed = 0;
  let scalpUsed = 0;
  for (const pos of positions) {
    const posValue = pos.entryPrice * pos.quantity;
    if (pos.isGridPosition || pos.pattern === 'GRID_BUY') {
      gridUsed += posValue;
    } else if (pos.isScalpPosition) {
      scalpUsed += posValue;
    } else {
      signalUsed += posValue;
    }
  }

  return {
    totalCapital: capital,
    signalBudget,
    gridBudget,
    reserve,
    signalUsed,
    gridUsed,
    signalRemaining: Math.max(0, signalBudget - signalUsed),
    gridRemaining: Math.max(0, gridBudget - gridUsed),
    scalpBudget,
    scalpUsed,
    scalpRemaining: Math.max(0, scalpBudget - scalpUsed),
    regime,
  };
}

// Persist regime from engine signals so allocator can read it
async function updateMarketRegime(regime: string): Promise<void> {
  if (regime && regime !== 'unknown') {
    await redis.set('market:regime', regime, 'EX', TOML?.timing.regime_ttl_seconds ?? 3600);
  }
}

// ============================================================================
// DAILY STATE (Redis-backed, shared across workers, survives restarts)
// ============================================================================

interface DailyState {
  date: string;
  tradesExecuted: number;
  dailyPnl: number;
}

async function getDailyState(): Promise<DailyState> {
  const today = new Date().toDateString();
  try {
    const raw = await redis.get('daily:state');
    if (raw) {
      const state = JSON.parse(raw as string) as DailyState;
      if (state.date === today) return state;
    }
  } catch (e) { console.warn('[DAILY_STATE] Failed to read daily state:', e); }
  // New day or no state — return fresh
  return { date: today, tradesExecuted: 0, dailyPnl: 0 };
}

async function saveDailyState(state: DailyState): Promise<void> {
  await redis.set('daily:state', JSON.stringify(state), 'EX', 172800); // 48h TTL
}

// In-memory cache refreshed from Redis each cycle
let dailyState: DailyState = {
  date: new Date().toDateString(),
  tradesExecuted: 0,
  dailyPnl: 0,
};

async function syncDailyState(): Promise<void> {
  dailyState = await getDailyState();
}

async function incrementTradeCount(): Promise<void> {
  dailyState.tradesExecuted++;
  await saveDailyState(dailyState);
}

async function addDailyPnl(pnl: number): Promise<void> {
  dailyState.dailyPnl += pnl;
  await saveDailyState(dailyState);
}

async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message.slice(0, 4096),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch { /* non-critical */ }
}

function resetDailyStateIfNeeded() {
  const today = new Date().toDateString();
  if (dailyState.date !== today) {
    dailyState = { date: today, tradesExecuted: 0, dailyPnl: 0 };
    saveDailyState(dailyState).catch(() => { });
  }
}

// ============================================================================
// POSITION STORAGE (Redis-backed with atomic operations)
// ============================================================================

const POSITIONS_KEY = 'positions:open';
const POSITION_LOCK_KEY = 'positions:lock';
const LOCK_TTL = TOML?.timing.position_lock_ttl_seconds ?? 30;

async function acquirePositionLock(): Promise<boolean> {
  const result = await redis.set(POSITION_LOCK_KEY, Date.now().toString(), 'EX', LOCK_TTL, 'NX');
  return result === 'OK';
}

async function releasePositionLock(): Promise<void> {
  await redis.del(POSITION_LOCK_KEY);
}

async function getOpenPositions(): Promise<OpenPosition[]> {
  const raw = await redis.get(POSITIONS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw as string);
  } catch {
    return [];
  }
}

async function saveOpenPositions(positions: OpenPosition[]): Promise<void> {
  await redis.set(POSITIONS_KEY, JSON.stringify(positions));
}

async function syncRiskState(): Promise<void> {
  try {
    const positions = await getOpenPositions();
    const budget = await getCapitalBudget();
    const state = {
      total_capital: budget.totalCapital,
      available_capital: budget.signalRemaining + budget.gridRemaining,
      open_positions: positions.map(p => ({
        symbol: p.symbol,
        side: p.side || 'BUY',
        entry_price: p.entryPrice,
        quantity: p.quantity,
        stop_loss: p.stopLoss,
      })),
      daily_pnl: dailyState.dailyPnl,
      weekly_pnl: 0,
      daily_trades: dailyState.tradesExecuted,
      consecutive_losses: 0,
      last_reset_date: new Date().toISOString().split('T')[0],
      circuit_breaker_active: false,
      circuit_breaker_reason: '',
      circuit_breaker_until: null,
    };
    await redis.set('risk:portfolio_state', JSON.stringify(state));
  } catch (err) {
    console.error('[SYNC] Failed to sync risk:portfolio_state:', err);
  }
}

async function addPosition(pos: OpenPosition): Promise<void> {
  // Retry with lock to prevent race conditions
  for (let i = 0; i < 3; i++) {
    if (await acquirePositionLock()) {
      try {
        const positions = await getOpenPositions();
        // Prevent duplicate
        if (positions.some(p => p.symbol === pos.symbol)) {
          console.warn(`[POSITIONS] Duplicate prevented: ${pos.symbol} already open`);
          return;
        }
        positions.push(pos);
        await saveOpenPositions(positions);
        return;
      } finally {
        await releasePositionLock();
      }
    }
    await new Promise(r => setTimeout(r, 200 * (i + 1)));
  }
  // Fallback without lock if retries exhausted
  console.warn('[POSITIONS] Lock acquisition failed, proceeding without lock');
  const positions = await getOpenPositions();
  if (!positions.some(p => p.symbol === pos.symbol)) {
    positions.push(pos);
    await saveOpenPositions(positions);
  }
}

async function removePosition(symbol: string): Promise<OpenPosition | null> {
  for (let i = 0; i < 3; i++) {
    if (await acquirePositionLock()) {
      try {
        const positions = await getOpenPositions();
        const idx = positions.findIndex(p => p.symbol === symbol);
        if (idx === -1) return null;
        const removed = positions.splice(idx, 1)[0];
        await saveOpenPositions(positions);
        return removed;
      } finally {
        await releasePositionLock();
      }
    }
    await new Promise(r => setTimeout(r, 200 * (i + 1)));
  }
  // Fallback
  const positions = await getOpenPositions();
  const idx = positions.findIndex(p => p.symbol === symbol);
  if (idx === -1) return null;
  const removed = positions.splice(idx, 1)[0];
  await saveOpenPositions(positions);
  return removed;
}



// ============================================================================
// SCALP MODE — Detect scalp-eligible signals and set tight exit params
// ============================================================================
function isScalpEligible(signal: Signal): boolean {
  if (!TOML?.scalp?.enabled) return false;
  if ((signal as any).is_scalp) return true; // Explicitly tagged by signal hunter
  const scalpPatterns = TOML.scalp.scalp_patterns ?? ['VOLUME_SPIKE_UP', 'MACD_BULLISH_CROSS', 'EMA_CROSS_UP', 'MOMENTUM_GAINER'];
  const hasScalpPattern = signal.patterns?.some(p => scalpPatterns.includes(p));
  const hasVolume = (signal.indicators?.volume_ratio ?? 0) >= (TOML.scalp.min_volume_ratio ?? 1.5);
  const hasConfidence = signal.confidence >= (TOML.scalp.min_confidence ?? 0.70);
  return !!(hasScalpPattern && hasVolume && hasConfidence);
}

function getScalpExits(entryPrice: number): { stopLoss: number; takeProfit: number; trailingStop: number } {
  const slPct = TOML?.scalp?.sl_pct ?? 0.8;
  const tpPct = TOML?.scalp?.tp_pct ?? 1.5;
  return {
    stopLoss: entryPrice * (1 - slPct / 100),
    takeProfit: entryPrice * (1 + tpPct / 100),
    trailingStop: entryPrice * (1 - slPct / 100), // Start at SL, tightens when activated
  };
}
// ============================================================================
// POSITION MONITORING - THE EXIT STRATEGY
// ============================================================================

interface MonitorResult {
  symbol: string;
  action: 'HOLD' | 'SOLD_TP' | 'SOLD_SL' | 'SOLD_TRAILING' | 'SOLD_STAGNATION' | 'SOLD_DUST' | 'SOLD_T1' | 'SOLD_T2' | 'SOLD_T3' | 'ERROR';
  currentPrice?: number;
  pnl?: number;
  pnlPct?: number;
  reason?: string;
  orderId?: string;
}

// ============================================================================
// BALANCE RECONCILIATION — detect phantom positions & orphaned coins
// ============================================================================

let lastReconcileTime = 0;
const RECONCILE_INTERVAL_MS = TOML?.timing.reconcile_interval_ms ?? 10 * 60 * 1000;

async function reconcilePositions(): Promise<void> {
  const now = Date.now();
  if (now - lastReconcileTime < RECONCILE_INTERVAL_MS) return;
  lastReconcileTime = now;

  try {
    const positions = await getOpenPositions();
    if (positions.length === 0) return;

    const ex = getExchange();
    const bal = await ex.fetchBalance({ recvWindow: 10000 });
    const balTotal = (bal as any).total as Record<string, number>;

    for (const pos of positions) {
      const baseAsset = pos.symbol.split('/')[0];
      const actualQty = balTotal[baseAsset] || 0;

      if (actualQty < pos.quantity * (TOML?.reconciliation.phantom_threshold ?? 0.1)) {
        // Binance has <10% of what Redis claims — phantom position
        console.warn(`[RECONCILE] PHANTOM detected: ${pos.symbol} Redis=${pos.quantity}, Binance=${actualQty}. Removing.`);
        const removed = await removePosition(pos.symbol);
        if (removed) {
          const estimatedPnl = (pos.stopLoss - pos.entryPrice) * pos.quantity;
          await addDailyPnl(estimatedPnl);

          // Per-symbol loss cooldown: prevent re-buying a losing symbol too soon
          if (estimatedPnl < 0) {
            await redis.set(`cooldown:loss:${pos.symbol}`, Date.now().toString(), 'EX', TOML?.timing?.loss_cooldown_seconds ?? 7200);
          }

          await logTrade({
            symbol: pos.symbol,
            side: 'SELL',
            quantity: String(pos.quantity),
            entryPrice: String(pos.entryPrice),
            exitPrice: String(pos.stopLoss),
            pnl: String(estimatedPnl),
            fees: String(pos.entryFee || 0),
            confidence: String(pos.confidence),
            pattern: pos.pattern,
            reasoning: `Phantom position reconciled: Binance balance ${actualQty} vs Redis ${pos.quantity}`,
            status: 'CLOSED',
            agentId: 'auto-trader',
            configVersion: getConfigVersion(),
          });
        }
      } else if (actualQty < pos.quantity * (TOML?.reconciliation.mismatch_warning_low ?? 0.9)) {
        // Partial mismatch — log warning but don't auto-fix
        console.warn(`[RECONCILE] Quantity mismatch: ${pos.symbol} Redis=${pos.quantity}, Binance=${actualQty}`);
      }
    }
  } catch (err) {
    console.warn('[RECONCILE] Balance check failed (non-fatal):', err instanceof Error ? err.message : '');
  }
}

async function monitorPositions(): Promise<MonitorResult[]> {
  // Run periodic reconciliation
  await reconcilePositions();

  const positions = await getOpenPositions();
  if (positions.length === 0) return [];

  const ex = getExchange();
  const results: MonitorResult[] = [];

  for (const pos of positions) {
    try {
      // ── Native SL reconciliation ──────────────────────────────────
      // Check if Binance already filled the safety-net stop-loss order.
      // If so, the coins are already sold — clean up Redis + log trade.
      if (pos.nativeSlOrderId) {
        try {
          const slOrder = await ex.fetchOrder(pos.nativeSlOrderId, pos.symbol);
          if (slOrder.status === 'closed' && slOrder.filled && slOrder.filled > 0) {
            const fillPrice = slOrder.average || slOrder.price || pos.stopLoss;
            const realizedPnl = pos.side === 'SELL'
              ? (pos.entryPrice - fillPrice) * slOrder.filled
              : (fillPrice - pos.entryPrice) * slOrder.filled;
            const pnlPct = pos.side === 'SELL'
              ? ((pos.entryPrice - fillPrice) / pos.entryPrice) * 100
              : ((fillPrice - pos.entryPrice) / pos.entryPrice) * 100;

            console.log(`[RECONCILE] Native SL filled for ${pos.symbol}: ${slOrder.filled} @ $${fillPrice} | PnL $${realizedPnl.toFixed(4)} (${pnlPct.toFixed(2)}%)`);

            await removePosition(pos.symbol);
            await addDailyPnl(realizedPnl);

            // Per-symbol loss cooldown: prevent re-buying a losing symbol too soon
            if (realizedPnl < 0) {
              await redis.set(`cooldown:loss:${pos.symbol}`, Date.now().toString(), 'EX', TOML?.timing?.loss_cooldown_seconds ?? 7200);
            }

            const nativeSlFees = (slOrder.fee?.cost || 0) + (pos.entryFee || 0);
            await logTrade({
              symbol: pos.symbol,
              side: pos.side === 'SELL' ? 'BUY' : 'SELL',
              quantity: String(slOrder.filled),
              entryPrice: String(pos.entryPrice),
              exitPrice: String(fillPrice),
              pnl: String(realizedPnl),
              fees: String(nativeSlFees),
              confidence: String(pos.confidence),
              pattern: pos.pattern,
              reasoning: `Native SL triggered on Binance (order ${pos.nativeSlOrderId} filled @ $${fillPrice})`,
              status: 'CLOSED',
              agentId: 'auto-trader',
              configVersion: getConfigVersion(),
            });

            try {
              await archivePosition({
                symbol: pos.symbol,
                side: pos.side,
                quantity: String(slOrder.filled),
                entryPrice: String(pos.entryPrice),
                exitPrice: String(fillPrice),
                stopLoss: String(pos.stopLoss),
                takeProfit: String(pos.takeProfit),
                pnl: String(realizedPnl),
                pnlPercent: String(pnlPct),
                fees: String(nativeSlFees),
                holdingPeriod: Math.round((Date.now() - new Date(pos.openedAt || Date.now()).getTime()) / 1000),
                openedAt: new Date(pos.openedAt || Date.now()),
                closedAt: new Date(),
                closeReason: 'SOLD_SL',
                pattern: pos.pattern,
                metadata: { nativeSlFill: true, nativeSlOrderId: pos.nativeSlOrderId, fillPrice, configVersion: getConfigVersion() },
                agentId: 'auto-trader',
              });
            } catch (archiveErr) {
              console.warn(`[RECONCILE] position_history archive failed:`, archiveErr);
            }

            // Sync close to Postgres positions table
            try { await closePositionBySymbol(pos.symbol, String(fillPrice), String(realizedPnl), String(pnlPct)); } catch (e) { console.warn(`[RECONCILE] closePositionBySymbol failed for ${pos.symbol}:`, e); }

            results.push({
              symbol: pos.symbol,
              action: 'SOLD_SL',
              currentPrice: fillPrice,
              pnl: realizedPnl,
              pnlPct,
              reason: `Native SL filled on Binance @ $${fillPrice}`,
            });
            continue; // Skip normal monitoring for this position
          }
        } catch (slCheckErr) {
          // Non-fatal: order may not exist yet or API glitch
          console.warn(`[RECONCILE] SL order check failed for ${pos.symbol}:`, slCheckErr instanceof Error ? slCheckErr.message : '');
        }
      }
      // ── End native SL reconciliation ──────────────────────────────

      const ticker = await ex.fetchTicker(pos.symbol);
      const currentPrice = ticker.last || 0;
      if (currentPrice === 0) continue;

      const pnl = pos.side === 'SELL'
        ? (pos.entryPrice - currentPrice) * pos.quantity  // SHORT: profit when price drops
        : (currentPrice - pos.entryPrice) * pos.quantity;  // LONG: profit when price rises
      const pnlPct = pos.side === 'SELL'
        ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
        : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      // Persist live P&L to Redis so Telegram bot can read it
      pos.pnlPct = Math.round(pnlPct * 100) / 100;
      
      // --- TIMING & VELOCITY (REFACTORED) ---
      const timing = TimingService.calculateMetrics(
        currentPrice,
        pos.entryPrice,
        pos.takeProfit,
        pos.side,
        pos.velocity,
        pos.lastPrice
      );
      
      const previousEta = pos.estimatedTpTime;
      pos.velocity = timing.velocity;
      pos.lastPrice = timing.lastPrice;
      pos.estimatedTpTime = timing.estimatedTpTime;
      pos.currentPrice = currentPrice;

      // --- ETA Telegram Alerts ---
      try {
        // 1. Alert when ETA is first established
        if (timing.estimatedTpTime && !pos.etaNotified) {
          pos.etaNotified = true;
          const minsToTp = Math.round((new Date(timing.estimatedTpTime).getTime() - Date.now()) / 60000);
          const etaLabel = minsToTp > 60 ? `${(minsToTp / 60).toFixed(1)}h` : `${minsToTp}min`;
          await sendTelegramAlert(
            `⏱️ <b>ETA: ${pos.symbol}</b>\n\nEstimerad TP-tid: ${etaLabel}\nEntry: $${pos.entryPrice.toFixed(4)} → TP: $${pos.takeProfit.toFixed(4)}\nVelocity: $${timing.velocity.toFixed(6)}/min`
          );
        }

        // 2. Alert on drastic ETA change (>2x shift)
        if (previousEta && timing.estimatedTpTime && pos.etaNotified) {
          const oldMins = Math.max(1, (new Date(previousEta).getTime() - Date.now()) / 60000);
          const newMins = Math.max(1, (new Date(timing.estimatedTpTime).getTime() - Date.now()) / 60000);
          const ratio = newMins / oldMins;
          if (ratio > 2.0 || ratio < 0.5) {
            const oldLabel = oldMins > 60 ? `${(oldMins / 60).toFixed(1)}h` : `${Math.round(oldMins)}min`;
            const newLabel = newMins > 60 ? `${(newMins / 60).toFixed(1)}h` : `${Math.round(newMins)}min`;
            const direction = ratio > 2.0 ? '🐢 Momentum tappat' : '🚀 Acceleration';
            await sendTelegramAlert(
              `${direction}: <b>${pos.symbol}</b>\n\nETA ändrad: ${oldLabel} → ${newLabel}\nP&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`
            );
          }
        }
      } catch { /* non-critical */ }

      // Update high water mark and trailing stop
      if (currentPrice > pos.highWaterMark) {
        pos.highWaterMark = currentPrice;
        // Only start trailing after activation threshold (let positions breathe)
        const profitPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const trailingActivation = pos.isScalpPosition
            ? (TOML?.scalp?.trailing_activation_pct ?? 0.8)
            : (TOML?.exits.trailing_activation_pct ?? 1.5);
          const trailingPct = pos.isScalpPosition
            ? (TOML?.scalp?.trailing_pct ?? 0.5)
            : CONFIG.TRAILING_STOP_PCT;
          if (profitPct >= trailingActivation) {
          const newTrailingStop = currentPrice * (1 - trailingPct / 100);
          if (newTrailingStop > pos.trailingStop) {
            pos.trailingStop = newTrailingStop;
          }
        }
      }

      // Proactive dust prevention: sell while we still can
      const currentValue = currentPrice * pos.quantity;

      // Check exit conditions
      let shouldSell = false;
      let exitReason = '';

      const dustFloor = TOML?.reconciliation?.dust_sell_floor ?? 5.0;
      if (currentValue < CONFIG.MIN_ORDER_VALUE && currentValue >= dustFloor) {
        shouldSell = true;
        exitReason = `Dust prevention: value $${currentValue.toFixed(2)} approaching NOTIONAL minimum`;
      }

      // ── TIERED EXIT ENGINE (Phase 3) ──────────────────────────────────
      // For non-grid LONG positions with tiered_exits_enabled:
      // T1 partial sell → T2 partial sell → T3 ratcheting trail → full close
      // Falls through to legacy SL/TP/trailing for grid, SHORT, or feature off.
      const tieredEnabled = !!(TOML?.exits?.tiered_exits_enabled) && !pos.isGridPosition && pos.side !== 'SELL';

      if (tieredEnabled && !shouldSell) {
        // Auto-create exitPlan for legacy positions that don't have one
        if (!pos.exitPlan) {
          pos.exitPlan = createDefaultExitPlan(pos);
          if (pos.exitPlan) {
            console.log(`[TIERED-EXIT] Default plan created for legacy position ${pos.symbol}: T1=$${pos.exitPlan.tiers[0].targetPrice.toFixed(4)}, T2=$${pos.exitPlan.tiers[1].targetPrice.toFixed(4)}`);
          }
        }

        if (pos.exitPlan) {
          const ep = pos.exitPlan;
          const t1 = ep.tiers[0];
          const t2 = ep.tiers[1];
          const t3 = ep.tiers[2];
          const profitPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

          // ── T1: First partial sell ──
          if (t1.status === 'pending' && currentPrice >= t1.targetPrice) {
            const sellQty = ep.originalQuantity * t1.sellPct;
            const result = await executePartialSell(pos, sellQty, t1, currentPrice);

            if (result.success) {
              t1.status = 'filled';
              t1.filledAt = new Date().toISOString();
              t1.filledPrice = result.filledPrice;
              t1.filledQty = result.filledQty;
              ep.remainingQuantity -= result.filledQty!;
              pos.quantity = ep.remainingQuantity;

              // Move SL to breakeven
              ep.breakeven = true;
              pos.stopLoss = pos.entryPrice * 1.0005; // Tiny profit above entry

              // Replace native SL with new qty + breakeven price
              const newSlId = await replaceNativeSl(pos.symbol, ep.remainingQuantity, pos.stopLoss, pos.nativeSlOrderId);
              if (newSlId) pos.nativeSlOrderId = newSlId;

              // Update display TP to T2
              pos.takeProfit = t2.status !== 'skipped' ? t2.targetPrice : t1.targetPrice;

              await archivePartialExit(pos, t1, result, 'SOLD_T1');
              const t1Pnl = ((result.filledPrice! - pos.entryPrice) / pos.entryPrice * 100).toFixed(2);
              await sendTelegramAlert(
                `🎯 <b>T1 HIT: ${pos.symbol}</b>\n\nSåld ${(t1.sellPct * 100).toFixed(0)}% @ $${result.filledPrice!.toFixed(4)} (+${t1Pnl}%)\nSL → breakeven ($${pos.stopLoss.toFixed(4)})\nKvar: ${(ep.remainingQuantity).toFixed(6)} (${((1 - t1.sellPct) * 100).toFixed(0)}%)`
              );
              console.log(`[TIERED-EXIT] T1 HIT ${pos.symbol}: sold ${result.filledQty} @ $${result.filledPrice}, SL→breakeven, remaining=${ep.remainingQuantity}`);
            } else if (result.error?.includes('NOTIONAL') || result.error?.includes('MIN_NOTIONAL')) {
              // Fallback: sell everything as T1
              t1.sellPct = 1.0;
              t2.status = 'skipped';
              t3.status = 'skipped';
              shouldSell = true;
              exitReason = `T1 NOTIONAL fallback: partial too small, selling 100% @ $${currentPrice.toFixed(4)}`;
            }
            // else: stay pending, retry next cycle
          }

          // ── T2: Second partial sell ──
          if (!shouldSell && t1.status === 'filled' && t2.status === 'pending' && currentPrice >= t2.targetPrice) {
            let t2SellQty = ep.originalQuantity * t2.sellPct;

            // Dust check: if remaining after T2 < MIN_ORDER_VALUE, sell 100%
            const remainingAfterT2 = ep.remainingQuantity - t2SellQty;
            const remainingValue = remainingAfterT2 * currentPrice;
            if (remainingValue < CONFIG.MIN_ORDER_VALUE) {
              t2SellQty = ep.remainingQuantity; // Sell everything
              t3.status = 'skipped';
              console.log(`[TIERED-EXIT] ${pos.symbol} T2 absorbing T3 dust (remaining would be $${remainingValue.toFixed(2)})`);
            }

            const result = await executePartialSell(pos, t2SellQty, t2, currentPrice);

            if (result.success) {
              t2.status = 'filled';
              t2.filledAt = new Date().toISOString();
              t2.filledPrice = result.filledPrice;
              t2.filledQty = result.filledQty;
              ep.remainingQuantity -= result.filledQty!;
              pos.quantity = ep.remainingQuantity;

              if (t3.status === 'skipped' || ep.remainingQuantity <= 0) {
                // All sold — full close
                shouldSell = false; // Already handled by partial sells
                await removePosition(pos.symbol);
                try { await closePositionBySymbol(pos.symbol, String(result.filledPrice), String(0), String(profitPct)); } catch { }
                await archivePartialExit(pos, t2, result, 'SOLD_T2');
                const t2Pnl = ((result.filledPrice! - pos.entryPrice) / pos.entryPrice * 100).toFixed(2);
                await sendTelegramAlert(
                  `🎯🎯 <b>T2 HIT (full close): ${pos.symbol}</b>\n\nSåld resterande @ $${result.filledPrice!.toFixed(4)} (+${t2Pnl}%)\nAlla tiers klara!`
                );
                results.push({
                  symbol: pos.symbol,
                  action: 'SOLD_T2',
                  currentPrice: result.filledPrice!,
                  pnl: (result.filledPrice! - pos.entryPrice) * result.filledQty!,
                  pnlPct: profitPct,
                  reason: 'T2 full close (T3 absorbed)',
                });
                continue; // Skip further monitoring for this position
              }

              // Activate ratcheting trail for T3
              ep.ratchetActive = true;
              const ratchetMult = getRatchetTrailMult(profitPct);
              const baseTrailPct = TOML?.exits?.trailing_stop_pct ?? 3.0;
              ep.ratchetTrailPrice = currentPrice * (1 - (baseTrailPct * ratchetMult) / 100);
              ep.highWaterMarkAt = new Date().toISOString();

              // Replace native SL for remaining qty
              const newSlId = await replaceNativeSl(pos.symbol, ep.remainingQuantity, ep.ratchetTrailPrice, pos.nativeSlOrderId);
              if (newSlId) pos.nativeSlOrderId = newSlId;

              await archivePartialExit(pos, t2, result, 'SOLD_T2');
              const t2Pnl = ((result.filledPrice! - pos.entryPrice) / pos.entryPrice * 100).toFixed(2);
              await sendTelegramAlert(
                `🎯🎯 <b>T2 HIT: ${pos.symbol}</b>\n\nSåld ${(t2.sellPct * 100).toFixed(0)}% @ $${result.filledPrice!.toFixed(4)} (+${t2Pnl}%)\nRatchet trail aktiv (trail=$${ep.ratchetTrailPrice.toFixed(4)})\nKvar: ${ep.remainingQuantity.toFixed(6)} (${(t3.sellPct * 100).toFixed(0)}%)`
              );
              console.log(`[TIERED-EXIT] T2 HIT ${pos.symbol}: sold ${result.filledQty} @ $${result.filledPrice}, ratchet trail active @ $${ep.ratchetTrailPrice.toFixed(4)}`);
            }
          }

          // ── T3: Ratcheting trailing stop ──
          if (!shouldSell && ep.ratchetActive && t3.status === 'pending') {
            // Update trail on new highs
            if (currentPrice > pos.highWaterMark) {
              const ratchetMult = getRatchetTrailMult(profitPct);
              const baseTrailPct = TOML?.exits?.trailing_stop_pct ?? 3.0;
              const newTrail = currentPrice * (1 - (baseTrailPct * ratchetMult) / 100);
              if (newTrail > ep.ratchetTrailPrice) {
                ep.ratchetTrailPrice = newTrail;
                ep.highWaterMarkAt = new Date().toISOString();
              }
            }

            // Check if trail triggered
            if (currentPrice <= ep.ratchetTrailPrice && ep.ratchetTrailPrice > pos.entryPrice) {
              shouldSell = true;
              exitReason = `T3 ratchet trail hit: $${currentPrice.toFixed(4)} <= $${ep.ratchetTrailPrice.toFixed(4)} (high: $${pos.highWaterMark.toFixed(4)})`;
            }
          }

          // ── Tiered stagnation: use per-type timeout ──
          if (!shouldSell && pos.openedAt) {
            const ageMs = Date.now() - new Date(pos.openedAt).getTime();
            const ageHours = ageMs / (1000 * 60 * 60);
            const timeout = ep.stagnationHours;
            const minPnl = TOML?.exits?.stagnation_min_pnl_pct ?? 1.0;

            if (ageHours >= timeout && Math.abs(pnlPct) < minPnl) {
              shouldSell = true;
              exitReason = `Tiered stagnation exit: ${ageHours.toFixed(1)}h old (limit ${timeout}h, type=${ep.tradeType}), movement ${pnlPct.toFixed(2)}%`;
            }

            // Stagnation warning — 2h before auto-exit
            if (!shouldSell && !pos.stagnationWarned) {
              const hoursRemaining = timeout - ageHours;
              if (hoursRemaining > 0 && hoursRemaining <= 2) {
                pos.stagnationWarned = true;
                await sendTelegramAlert(
                  `⏳ <b>Stagnation-varning: ${pos.symbol}</b>\n\n${ep.tradeType} position (${ageHours.toFixed(1)}h)\nRörelse: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\nAuto-exit om ~${hoursRemaining.toFixed(1)}h\nTimeout: ${timeout}h (${ep.tradeType})`
                );
              }
            }
          }

          // SL still applies even with tiered exits
          if (!shouldSell && currentPrice <= pos.stopLoss) {
            shouldSell = true;
            exitReason = `Stop-loss hit: $${currentPrice.toFixed(4)} <= $${pos.stopLoss.toFixed(4)}`;
          }
        }
        // If no exitPlan could be created, fall through to legacy logic below
      }

      // ── LEGACY EXIT LOGIC (grid positions, SHORT, feature off, or no exitPlan) ──
      if (!tieredEnabled || !pos.exitPlan) {
        if (!shouldSell) {
          // Stagnation exit (REFACTORED)
          if (pos.openedAt) {
            const stagnation = TimingService.isStagnant(pos.openedAt, pnlPct, {
              isScalp: pos.isScalpPosition,
              overrideHours: pos.stagnationOverrideHours,
              defaultTimeout: TOML?.exits?.stagnation_timeout_hours,
              minPnl: TOML?.exits?.stagnation_min_pnl_pct,
              scalpMaxHoldMins: TOML?.scalp?.max_hold_minutes
            });

            if (stagnation.stagnant) {
              shouldSell = true;
              exitReason = `Stagnation exit: ${stagnation.ageHours.toFixed(1)}h old (limit ${stagnation.timeout}h), movement ${pnlPct.toFixed(2)}%`;
            }

            // Stagnation warning — 2h before auto-exit
            if (!stagnation.stagnant && !pos.stagnationWarned) {
              const hoursRemaining = stagnation.timeout - stagnation.ageHours;
              if (hoursRemaining > 0 && hoursRemaining <= 2) {
                pos.stagnationWarned = true;
                await sendTelegramAlert(
                  `⏳ <b>Stagnation-varning: ${pos.symbol}</b>\n\nPosition har rört sig ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% på ${stagnation.ageHours.toFixed(1)}h\nAuto-exit om ~${hoursRemaining.toFixed(1)}h om ingen rörelse\nTimeout: ${stagnation.timeout}h | Tröskel: ±1.0%`
                );
              }
            }
          }
        }

        if (!shouldSell) {
          if (pos.side === 'SELL') {
            // SHORT position: exit by buying back
            if (currentPrice <= pos.takeProfit) {
              shouldSell = true;
              exitReason = `Short TP hit: $${currentPrice.toFixed(4)} <= $${pos.takeProfit.toFixed(4)}`;
            }
            else if (currentPrice >= pos.stopLoss) {
              shouldSell = true;
              exitReason = `Short SL hit: $${currentPrice.toFixed(4)} >= $${pos.stopLoss.toFixed(4)}`;
            }
          } else {
            // LONG position: exit by selling
            if (currentPrice >= pos.takeProfit) {
              shouldSell = true;
              exitReason = `Take-profit hit: $${currentPrice.toFixed(4)} >= $${pos.takeProfit.toFixed(4)}`;
            }
            else if (currentPrice <= pos.stopLoss) {
              shouldSell = true;
              exitReason = `Stop-loss hit: $${currentPrice.toFixed(4)} <= $${pos.stopLoss.toFixed(4)}`;
            }
            else if (pnl > 0 && currentPrice <= pos.trailingStop && pos.trailingStop > pos.entryPrice) {
              shouldSell = true;
              exitReason = `Trailing stop hit: $${currentPrice.toFixed(4)} <= $${pos.trailingStop.toFixed(4)} (high: $${pos.highWaterMark.toFixed(4)})`;
            }
          }
        }
      }

      // On-chain alert check — severity-based response (Intelligent Alert System)
      // info: no action | warning x1: log only | warning x2+: SL→breakeven
      // critical: SL→breakeven | emergency: force close (cancel native SL + market sell)
      if (!shouldSell) {
        try {
          const baseAsset = pos.symbol.split('/')[0];
          const alertRaw = await redis.get(`sentiment:alert:${baseAsset}`) as string | null;
          if (alertRaw) {
            let severity = 'warning';
            let reason = alertRaw;
            let source: string | null = null;
            let confirmedCount = 1;
            let timingUncertain = false;
            try {
              const parsed = JSON.parse(alertRaw);
              severity = parsed.severity ?? 'warning';
              reason = parsed.reason ?? alertRaw;
              source = parsed.source ?? null;
              confirmedCount = parsed.confirmed_count ?? 1;
              timingUncertain = parsed.context?.timing_uncertain ?? false;
            } catch { /* not JSON — treat as warning with confirmed_count=1 */ }

            // Freshness guard: timing_uncertain → treat as info
            if (timingUncertain) severity = 'info';

            const notifiedKey = `onchain:notified:${pos.symbol}`;
            const alreadyNotified = await redis.get(notifiedKey);
            const minConfirmations = TOML?.alerts?.min_confirmations_for_action ?? 2;

            if (severity === 'emergency') {
              // Emergency: force close — cancel native SL first, then market sell
              shouldSell = true;
              exitReason = `On-chain alert (emergency): ${reason}`;
              if (!alreadyNotified) {
                await redis.set(notifiedKey, '1', 'EX', 3600);
                await sendTelegramAlert(
                  `🚨 <b>EMERGENCY CLOSE: ${pos.symbol}</b>\n\nKälla: ${source ?? 'okänd'}\nVarning: ${reason}\nÅtgärd: Position force-closed (market sell)`
                );
              }
            } else if (severity === 'critical') {
              // Critical: tighten SL to breakeven
              if (!alreadyNotified) {
                const newSl = pos.entryPrice * 0.9995;
                if (newSl > pos.stopLoss) {
                  const oldSl = pos.stopLoss;
                  pos.stopLoss = newSl;
                  await redis.set(notifiedKey, '1', 'EX', 3600);
                  console.log(`[MONITOR] On-chain critical ${pos.symbol}: SL ${oldSl.toFixed(4)} → ${newSl.toFixed(4)}`);
                  await sendTelegramAlert(
                    `🚨 <b>Kritisk on-chain varning: ${pos.symbol}</b>\n\nKälla: ${source ?? 'okänd'}\nVarning: ${reason}\nÅtgärd: Stop-loss dragit till entry (${newSl.toFixed(4)})`
                  );
                }
              }
            } else if (severity === 'warning' && confirmedCount >= minConfirmations) {
              // Warning with enough confirmations: tighten SL to breakeven
              if (!alreadyNotified) {
                const newSl = pos.entryPrice * 0.9995;
                if (newSl > pos.stopLoss) {
                  const oldSl = pos.stopLoss;
                  pos.stopLoss = newSl;
                  await redis.set(notifiedKey, '1', 'EX', 3600);
                  console.log(`[MONITOR] On-chain warning x${confirmedCount} ${pos.symbol}: SL ${oldSl.toFixed(4)} → ${newSl.toFixed(4)}`);
                  await sendTelegramAlert(
                    `⚠️ <b>On-chain varning (bekräftad x${confirmedCount}): ${pos.symbol}</b>\n\nKälla: ${source ?? 'okänd'}\nVarning: ${reason}\nÅtgärd: Stop-loss dragit till entry (${newSl.toFixed(4)})`
                  );
                }
              }
            } else if (severity === 'warning' && confirmedCount < minConfirmations) {
              // Warning with insufficient confirmations: log only, no SL change
              console.log(`[MONITOR] On-chain warning (${confirmedCount}/${minConfirmations} confirmations) ${pos.symbol}: ${reason} — no action`);
            }
            // info severity: no action
          }
        } catch { /* non-critical — never block normal position monitoring */ }
      }

      if (shouldSell) {
        // Close the position (sell for LONG, buy-back for SHORT)
        const closeSide = pos.side === 'SELL' ? 'buy' : 'sell';
        console.log(`[MONITOR] Closing ${pos.side} ${pos.symbol}: ${exitReason}`);

        // ENVIRONMENT GUARD: block real sells outside production
        if (!IS_PRODUCTION) {
          console.log(`[DEV-MODE] Would SELL ${pos.symbol} — blocked (CRYONIX_ENV=${CRYONIX_ENV})`);
          continue;
        }

        try {
          // Cancel Binance-native SL order before selling (prevent double execution)
          if (pos.nativeSlOrderId) {
            try {
              await ex.cancelOrder(pos.nativeSlOrderId, pos.symbol);
              console.log(`[MONITOR] Cancelled native SL ${pos.nativeSlOrderId}`);
            } catch (cancelErr) {
              // May already be triggered or expired — non-fatal
              console.warn(`[MONITOR] Native SL cancel failed (may already be triggered):`, cancelErr instanceof Error ? cancelErr.message : '');
            }
          }

          const closeParams: any = {};
          if (pos.side === 'SELL' && CONFIG.TRADING_MODE === 'margin') {
            closeParams.marginMode = CONFIG.MARGIN_TYPE;
            closeParams.type = 'margin';
          }

          // Use actual Binance balance instead of pos.quantity to handle fee-adjusted amounts
          let sellQty = pos.quantity;
          if (closeSide === 'sell') {
            const baseAsset = pos.symbol.split('/')[0];
            const bal = (await ex.fetchBalance()) as any;
            const freeBalance = Number(bal.free?.[baseAsset] || 0);
            if (freeBalance > 0 && freeBalance < sellQty) {
              console.log(`[MONITOR] ${pos.symbol}: adjusting sell qty from ${sellQty} to ${freeBalance} (fee-adjusted balance)`);
              sellQty = freeBalance;
            }
          }

          const roundedSellQty = parseFloat(ex.amountToPrecision(pos.symbol, sellQty));
          const closeOrder = await ex.createMarketOrder(
            pos.symbol,
            closeSide,
            roundedSellQty,
            undefined,
            closeParams
          );

          const closePrice = closeOrder.average || closeOrder.price || currentPrice;
          const realizedPnl = pos.side === 'SELL'
            ? (pos.entryPrice - closePrice) * pos.quantity
            : (closePrice - pos.entryPrice) * pos.quantity;
          const exitFee = closeOrder.fee?.cost || 0;
          const fees = exitFee + (pos.entryFee || 0);

          // Remove from open positions
          await removePosition(pos.symbol);

          // Per-symbol loss cooldown: prevent re-buying a losing symbol too soon
          if ((realizedPnl - fees) < 0) {
            await redis.set(`cooldown:loss:${pos.symbol}`, Date.now().toString(), 'EX', TOML?.timing?.loss_cooldown_seconds ?? 7200);
          }

          // Update daily P&L (persisted to Redis)
          await addDailyPnl(realizedPnl - fees);

          // Log to database
          await logTrade({
            symbol: pos.symbol,
            side: closeSide.toUpperCase() as 'BUY' | 'SELL',
            quantity: String(pos.quantity),
            entryPrice: String(pos.entryPrice),
            exitPrice: String(closePrice),
            pnl: String(realizedPnl - fees),
            fees: String(fees),
            confidence: String(pos.confidence),
            pattern: pos.pattern,
            reasoning: exitReason,
            status: 'CLOSED',
            agentId: 'auto-trader',
            configVersion: getConfigVersion(),
          });

          const exitType = exitReason.startsWith('T3 ratchet') ? 'SOLD_T3' :
            exitReason.startsWith('Tiered stagnation') ? 'SOLD_STAGNATION' :
            exitReason.startsWith('Stagnation') ? 'SOLD_STAGNATION' :
            exitReason.startsWith('Dust') ? 'SOLD_DUST' :
            exitReason.startsWith('T1 NOTIONAL') ? 'SOLD_T1' :
            currentPrice >= pos.takeProfit ? 'SOLD_TP' :
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
                configVersion: getConfigVersion(),
              },
              agentId: 'auto-trader',
            });
          } catch (archiveErr) {
            console.warn(`[MONITOR] position_history archive failed (non-critical):`, archiveErr);
          }

          // Sync close to Postgres positions table
          try { await closePositionBySymbol(pos.symbol, String(closePrice), String(realizedPnl - fees), String(pnlPct)); } catch (e) { console.warn(`[MONITOR] closePositionBySymbol failed for ${pos.symbol}:`, e); }

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

          // NOTIONAL filter: position value too small for Binance to accept the sell order.
          // Write off as dust — remove from tracking and record the realized loss.
          if (errMsg.includes('NOTIONAL') || errMsg.includes('MIN_NOTIONAL')) {
            const dustValue = pos.quantity * currentPrice;
            console.warn(`[MONITOR] ${pos.symbol} DUST: value $${dustValue.toFixed(2)} below NOTIONAL minimum — writing off`);

            await removePosition(pos.symbol);
            await addDailyPnl(pnl);

            // Per-symbol loss cooldown: prevent re-buying a losing symbol too soon
            if (pnl < 0) {
              await redis.set(`cooldown:loss:${pos.symbol}`, Date.now().toString(), 'EX', TOML?.timing?.loss_cooldown_seconds ?? 7200);
            }

            // Cancel native SL if present (position is gone, SL would be orphaned)
            if (pos.nativeSlOrderId) {
              try { await ex.cancelOrder(pos.nativeSlOrderId, pos.symbol); } catch { }
            }

            await logTrade({
              symbol: pos.symbol,
              side: 'SELL',
              quantity: String(pos.quantity),
              entryPrice: String(pos.entryPrice),
              exitPrice: String(currentPrice),
              pnl: String(pnl),
              fees: String(pos.entryFee || 0),
              confidence: String(pos.confidence),
              pattern: pos.pattern,
              reasoning: `DUST write-off: value $${dustValue.toFixed(2)} below NOTIONAL`,
              status: 'CLOSED',
              agentId: 'auto-trader',
              configVersion: getConfigVersion(),
            });

            try {
              await archivePosition({
                symbol: pos.symbol,
                side: pos.side,
                quantity: String(pos.quantity),
                entryPrice: String(pos.entryPrice),
                exitPrice: String(currentPrice),
                stopLoss: String(pos.stopLoss),
                takeProfit: String(pos.takeProfit),
                pnl: String(pnl),
                pnlPercent: String(pnlPct),
                fees: '0',
                holdingPeriod: Math.round((Date.now() - new Date(pos.openedAt || Date.now()).getTime()) / 1000),
                openedAt: new Date(pos.openedAt || Date.now()),
                closedAt: new Date(),
                closeReason: 'DUST_NOTIONAL',
                pattern: pos.pattern,
                metadata: {
                  highWaterMark: pos.highWaterMark,
                  trailingStop: pos.trailingStop,
                  confidence: pos.confidence,
                  dustValue,
                  configVersion: getConfigVersion(),
                },
                agentId: 'auto-trader',
              });
            } catch (archiveErr) {
              console.warn(`[MONITOR] dust archive failed:`, archiveErr);
            }

            // Sync close to Postgres positions table
            try { await closePositionBySymbol(pos.symbol, String(currentPrice), String(pnl), String(pnlPct)); } catch (e) { console.warn(`[MONITOR] closePositionBySymbol failed for ${pos.symbol} (dust):`, e); }

            results.push({
              symbol: pos.symbol,
              action: 'DUST_NOTIONAL' as any,
              currentPrice,
              pnl,
              pnlPct,
              reason: `Dust write-off: value $${dustValue.toFixed(2)} below NOTIONAL`,
            });
            continue;
          }

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
  // CRITICAL: Save the SAME positions array that was mutated in the loop above,
  // NOT a fresh read from Redis (which would lose trailing stop updates)
  const updatedPositions = positions.filter(p =>
    !results.some(r => r.symbol === p.symbol && r.action !== 'HOLD' && r.action !== 'ERROR')
  );
  if (updatedPositions.length > 0) {
    await saveOpenPositions(updatedPositions);
  } else if (positions.length > 0) {
    // All positions were closed — clear Redis
    await saveOpenPositions([]);
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
const CALIBRATION_CACHE_MS = TOML?.timing.calibration_cache_ms ?? 30 * 60 * 1000;

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
  } catch (e) { console.warn('[CALIBRATION] Failed to read pattern calibration:', e); }

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

  if (!stats || stats.trades < (TOML?.ev_model.min_trades_for_ev ?? 5)) return null; // Need minimum trades for meaningful EV

  const ev = (stats.winRate / 100 * stats.avgWin) - ((100 - stats.winRate) / 100 * Math.abs(stats.avgLoss));
  console.log(`[EV] ${signal.symbol} ${patternKey}: EV=$${ev.toFixed(4)} (win ${stats.winRate}% of ${stats.trades})`);

  return { ev, winRate: stats.winRate, sampleSize: stats.trades, pattern: patternKey };
}

// ============================================================================
// RISK CHECKS
// ============================================================================


// ============================================================================
// SMART ROTATION — Replace weak positions with stronger signals
// ============================================================================

function scorePosition(pos: OpenPosition): number {
  let score = 0;
  const pnl = pos.pnlPct ?? 0;
  const ageHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
  const hwmDistance = pos.highWaterMark > 0
    ? ((pos.currentPrice ?? pos.entryPrice) - pos.highWaterMark) / pos.highWaterMark
    : 0;

  // P&L component (0-40 pts): profitable positions score higher
  if (pnl > 5) score += 40;
  else if (pnl > 2) score += 30;
  else if (pnl > 0) score += 20;
  else if (pnl > -2) score += 10;
  else if (pnl > -5) score += 5;
  // else: 0 pts for heavy losers

  // Momentum component (-15 to +15 pts): how far from high water mark
  if (hwmDistance > -0.01) score += 15;       // Near or at HWM — strong
  else if (hwmDistance > -0.03) score += 5;   // Slight pullback
  else if (hwmDistance > -0.05) score -= 5;   // Fading
  else score -= 15;                            // Well below HWM — weak

  // Age component (-15 to +15 pts): fresh positions get benefit of doubt
  if (ageHours < 1) score += 15;              // Just opened — don't rotate
  else if (ageHours < 4) score += 5;          // Still fresh
  else if (ageHours < 12) score += 0;         // Neutral
  else if (ageHours < 24) score -= 5;         // Getting stale
  else score -= 15;                            // Very old — likely stagnant

  // Confidence component (0-10 pts)
  score += Math.round((pos.confidence ?? 0.5) * 10);

  // Grid positions are never rotated
  if (pos.isGridPosition) score += 1000;

  return score;
}

function scoreSignal(signal: Signal): number {
  let score = 0;
  const conf = signal.confidence ?? 0.5;

  // Confidence component (15-45 pts)
  score += Math.round(conf * 45);

  // Pattern quality bonus
  const strongPatterns = ['DEEP_VALUE_CRASH', 'VOLUME_SPIKE_UP', 'DIP_BUY'];
  if (signal.patterns && signal.patterns.some(p => strongPatterns.includes(p))) score += 10;

  // Multi-pattern bonus
  if (signal.patterns && signal.patterns.length > 1) score += 15;

  // Grok-hunter signals get a bonus (pre-validated by Grok search)
  if ((signal as any).source === 'grok_signal_hunter') score += 8;

  return score;
}

async function trySmartRotation(
  signal: Signal,
  openPositions: OpenPosition[],
): Promise<{ shouldRotate: boolean; victim?: OpenPosition; reason?: string }> {
  const rotationEnabled = TOML?.rotation?.enabled ?? false;
  if (!rotationEnabled) {
    return { shouldRotate: false, reason: 'rotation disabled' };
  }

  const minAdvantage = TOML?.rotation?.min_score_advantage ?? 15;
  const minHoldMinutes = TOML?.rotation?.min_hold_minutes ?? 30;

  // Score the incoming signal
  const signalScore = scoreSignal(signal);

  // Score all positions and find the weakest non-grid position
  const candidates = openPositions
    .filter(p => !p.isGridPosition && p.pattern !== 'GRID_BUY')
    .filter(p => {
      const ageMin = (Date.now() - new Date(p.openedAt).getTime()) / 60000;
      return ageMin >= minHoldMinutes;
    })
    .map(p => ({ position: p, score: scorePosition(p) }))
    .sort((a, b) => a.score - b.score);

  if (candidates.length === 0) {
    return { shouldRotate: false, reason: 'no eligible positions to rotate' };
  }

  const weakest = candidates[0];
  const advantage = signalScore - weakest.score;

  console.log(`[ROTATION] Signal ${signal.symbol} score=${signalScore} vs weakest ${weakest.position.symbol} score=${weakest.score} (advantage=${advantage}, need=${minAdvantage})`);

  // Check hunter exit recommendations
  let hunterBoost = 0;
  try {
    const exitRec = await redis.get(`hunter:exit:${weakest.position.symbol}`);
    if (exitRec) {
      hunterBoost = 10;
      console.log(`[ROTATION] Hunter recommends exiting ${weakest.position.symbol} (+${hunterBoost} boost)`);
    }
  } catch (e) { console.warn('[ROTATION] Hunter exit check failed:', e); }

  if (advantage + hunterBoost >= minAdvantage) {
    return {
      shouldRotate: true,
      victim: weakest.position,
      reason: `Signal ${signal.symbol} (${signalScore}pts) beats ${weakest.position.symbol} (${weakest.score}pts) by ${advantage + hunterBoost}pts`,
    };
  }

  return {
    shouldRotate: false,
    reason: `Advantage ${advantage + hunterBoost}pts < required ${minAdvantage}pts`,
  };
}

async function executeRotationClose(
  ex: Exchange,
  victim: OpenPosition,
  reason: string,
): Promise<{ success: boolean; pnl: number }> {
  const currentPrice = victim.currentPrice ?? victim.entryPrice;

  console.log(`[ROTATION] Closing ${victim.symbol} @ ~$${currentPrice} for rotation: ${reason}`);

  try {
    // Cancel native SL if exists
    if (victim.nativeSlOrderId) {
      try {
        await ex.cancelOrder(victim.nativeSlOrderId, victim.symbol);
        console.log(`[ROTATION] Cancelled native SL ${victim.nativeSlOrderId}`);
      } catch (e) {
        console.warn(`[ROTATION] Native SL cancel failed:`, e instanceof Error ? e.message : '');
      }
    }

    // Market sell — use actual balance to handle fee-adjusted amounts
    let rotationSellQty = victim.quantity;
    const baseAsset = victim.symbol.split('/')[0];
    const rotBal = (await ex.fetchBalance()) as any;
    const rotFree = Number(rotBal.free?.[baseAsset] || 0);
    if (rotFree > 0 && rotFree < rotationSellQty) {
      console.log(`[ROTATION] ${victim.symbol}: adjusting qty from ${rotationSellQty} to ${rotFree}`);
      rotationSellQty = rotFree;
    }
    const closeOrder = await ex.createMarketOrder(
      victim.symbol,
      'sell',
      parseFloat(ex.amountToPrecision(victim.symbol, rotationSellQty)),
    );

    const closePrice = closeOrder.average || closeOrder.price || currentPrice;
    const realizedPnl = (closePrice - victim.entryPrice) * victim.quantity;
    const exitFee = closeOrder.fee?.cost || 0;
    const fees = exitFee + (victim.entryFee || 0);
    const netPnl = realizedPnl - fees;

    // Remove from positions
    await removePosition(victim.symbol);

    // Loss cooldown if negative
    if (netPnl < 0) {
      await redis.set(
        `cooldown:loss:${victim.symbol}`,
        Date.now().toString(),
        'EX',
        TOML?.timing?.loss_cooldown_seconds ?? 1800,
      );
    }

    // Update daily PnL
    await addDailyPnl(netPnl);

    // Log trade
    await logTrade({
      symbol: victim.symbol,
      side: 'SELL',
      quantity: String(victim.quantity),
      entryPrice: String(victim.entryPrice),
      exitPrice: String(closePrice),
      pnl: String(netPnl),
      fees: String(fees),
      confidence: String(victim.confidence),
      pattern: victim.pattern,
      reasoning: `[ROTATION] ${reason}`,
      status: 'CLOSED',
      agentId: 'auto-trader',
      configVersion: getConfigVersion(),
    });

    console.log(`[ROTATION] ✅ Closed ${victim.symbol}: PnL $${netPnl.toFixed(4)} (${((closePrice - victim.entryPrice) / victim.entryPrice * 100).toFixed(1)}%)`);

    return { success: true, pnl: netPnl };
  } catch (err) {
    console.error(`[ROTATION] ❌ Failed to close ${victim.symbol}:`, err);
    return { success: false, pnl: 0 };
  }
}

async function passesRiskChecks(signal: Signal): Promise<{ pass: boolean; reason: string }> {
  await syncDailyState();
  resetDailyStateIfNeeded();

  // Symbol whitelist filter
  const whitelist = TOML?.trading?.symbol_whitelist;
  if (whitelist && whitelist.length > 0 && !whitelist.includes(signal.symbol)) {
    return { pass: false, reason: `Symbol ${signal.symbol} not in whitelist` };
  }

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
    // Don't hard-reject — let the main loop try smart rotation
    return { pass: false, reason: `Max positions (${CONFIG.MAX_OPEN_POSITIONS}) [rotation-eligible]` };
  }

  // Capital allocator: enforce per-strategy budgets
  const isGrid = signal.patterns?.includes('GRID_BUY') || (signal as any).is_grid_buy;
  const isScalp = !isGrid && isScalpEligible(signal);
  const budget = await getCapitalBudget();

  // Update regime from signal if available
  if (signal.indicators?.market_regime) {
    await updateMarketRegime(String(signal.indicators.market_regime));
  }

  if (isGrid) {
    // Grid strategy checks
    const gridPositions = openPositions.filter(p => p.isGridPosition || p.pattern === 'GRID_BUY');
    if (gridPositions.length >= CONFIG.MAX_GRID_POSITIONS) {
      return { pass: false, reason: `Max grid positions (${CONFIG.MAX_GRID_POSITIONS})` };
    }
    if (budget.gridRemaining < CONFIG.MIN_ORDER_VALUE) {
      return { pass: false, reason: `Grid budget exhausted ($${budget.gridRemaining.toFixed(2)} remaining of $${budget.gridBudget.toFixed(2)})` };
    }
    if (budget.regime === 'volatile') {
      return { pass: false, reason: 'Grid paused: volatile market regime' };
    }
  } else if (isScalp) {
    // Scalp strategy checks
    const scalpPositions = openPositions.filter(p => p.isScalpPosition);
    if (scalpPositions.length >= (CONFIG.MAX_SCALP_POSITIONS ?? 2)) {
      return { pass: false, reason: `Max scalp positions (${CONFIG.MAX_SCALP_POSITIONS ?? 2})` };
    }
    if (budget.scalpRemaining < CONFIG.MIN_ORDER_VALUE) {
      return { pass: false, reason: `Scalp budget exhausted ($${budget.scalpRemaining.toFixed(2)} remaining of $${budget.scalpBudget.toFixed(2)})` };
    }
  } else {
    // Signal strategy checks
    const signalPositions = openPositions.filter(p => !p.isGridPosition && p.pattern !== 'GRID_BUY' && !p.isScalpPosition);
    if (signalPositions.length >= CONFIG.MAX_SIGNAL_POSITIONS) {
      return { pass: false, reason: `Max signal positions (${CONFIG.MAX_SIGNAL_POSITIONS})` };
    }
    if (budget.signalRemaining < CONFIG.MIN_ORDER_VALUE) {
      return { pass: false, reason: `Signal budget exhausted ($${budget.signalRemaining.toFixed(2)} remaining of $${budget.signalBudget.toFixed(2)})` };
    }
  }

  if (openPositions.some(p => p.symbol === signal.symbol)) {
    return { pass: false, reason: `Already in ${signal.symbol}` };
  }

  // Per-symbol loss cooldown: don't re-buy a symbol that just lost money
  const lossCooldown = await redis.get(`cooldown:loss:${signal.symbol}`);
  if (lossCooldown) {
    const mins = Math.round((Date.now() - parseInt(lossCooldown as string)) / 60000);
    return { pass: false, reason: `Loss cooldown: ${signal.symbol} lost ${mins}min ago` };
  }

  // Dedup: reject if an execution is already in progress for this symbol
  const executing = await redis.get(`executing:${signal.symbol}`);
  if (executing) {
    return { pass: false, reason: `Execution in progress for ${signal.symbol}` };
  }

  // X sentiment alert check — severity-based filtering (Intelligent Alert System)
  try {
    const baseAsset = signal.symbol.split('/')[0];
    const alertRaw = await redis.get(`sentiment:alert:${baseAsset}`) as string | null;
    if (alertRaw && signal.action === 'BUY') {
      let severity = 'warning';
      let confirmedCount = 1;
      let reason = alertRaw;
      let timingUncertain = false;
      try {
        const parsed = JSON.parse(alertRaw);
        severity = parsed.severity ?? 'warning';
        confirmedCount = parsed.confirmed_count ?? 1;
        reason = parsed.reason ?? alertRaw;
        timingUncertain = parsed.context?.timing_uncertain ?? false;
      } catch { /* not JSON — treat as warning with confirmed_count=1 (backward compat) */ }

      // Freshness guard: timing_uncertain → treat as info (no action)
      if (timingUncertain) severity = 'info';

      const minConfirmations = TOML?.alerts?.min_confirmations_for_action ?? 2;

      if (severity === 'critical' || severity === 'emergency') {
        return { pass: false, reason: `X alert [${severity}]: ${reason}` };
      } else if (severity === 'warning' && confirmedCount >= minConfirmations) {
        return { pass: false, reason: `X alert [warning x${confirmedCount}]: ${reason}` };
      } else if (severity === 'warning' && confirmedCount < minConfirmations) {
        console.log(`[BUY-FILTER] X alert warning (${confirmedCount}/${minConfirmations} confirmations) for ${baseAsset} — pass, log only: ${reason}`);
      }
      // info severity: pass — no impact
    }
  } catch (e) { console.warn('[BUY-FILTER] X sentiment check failed:', e); }

  // ── CoinMarketCap macro filters ──────────────────────────────────────
  const cmcEnabled = TOML?.coinmarketcap?.enabled ?? false;
  if (cmcEnabled && signal.action === 'BUY') {
    const baseAsset = signal.symbol.split('/')[0];

    // Market cap rank filter — reject illiquid micro-caps
    try {
      const mcapRaw = await redis.get(`cmc:mcap:${baseAsset}`);
      if (mcapRaw) {
        const mcap = JSON.parse(mcapRaw as string);
        const maxRank = TOML?.coinmarketcap?.max_rank ?? 500;
        if (maxRank > 0 && mcap.rank > maxRank) {
          return { pass: false, reason: `CMC rank #${mcap.rank} > max ${maxRank}` };
        }
        const maxFdvMc = TOML?.coinmarketcap?.max_fdv_mc_ratio ?? 4.0;
        if (maxFdvMc > 0 && mcap.fdv_mc_ratio > maxFdvMc) {
          return { pass: false, reason: `FDV/MC ${mcap.fdv_mc_ratio.toFixed(1)}x > max ${maxFdvMc}x (dilution risk)` };
        }
      }
    } catch { /* CMC data unavailable — skip filter */ }

    // Global market cap crash → force volatile regime
    try {
      const globalRaw = await redis.get('cmc:global');
      if (globalRaw) {
        const global = JSON.parse(globalRaw as string);
        const mcDropThreshold = TOML?.coinmarketcap?.global_mc_drop_volatile_pct ?? 3.0;
        if (global.total_market_cap_yesterday_pct < -mcDropThreshold) {
          await redis.set('market:regime', 'volatile', 'EX', TOML?.timing?.regime_ttl_seconds ?? 3600);
          console.log(`[CMC] Global MC down ${global.total_market_cap_yesterday_pct.toFixed(1)}% — forcing volatile regime`);
        }
      }
    } catch { /* CMC data unavailable — skip */ }
  }

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
  const minRR = TOML?.risk.min_risk_reward ?? 1.3;
  if (risk > 0 && reward / risk < minRR) {
    return { pass: false, reason: `R/R ${(reward / risk).toFixed(2)} < ${minRR}` };
  }

  // === WEAK PATTERN FILTER: reject single-pattern signals with known poor performance ===
  // These patterns consistently lose money when they fire alone (no confirming pattern).
  // Data: RSI_OVERSOLD solo → 33% WR, -$0.48 total | EMA_BULLISH_CROSS solo → 0% WR, -$0.05
  const weakSoloPatterns: string[] = TOML?.patterns?.weak_solo_patterns ?? ['RSI_OVERSOLD', 'EMA_BULLISH_CROSS', 'MACD_BULLISH_CROSS'];
  const patterns = signal.patterns || [];
  if (patterns.length === 1 && weakSoloPatterns.includes(patterns[0])) {
    return { pass: false, reason: `Weak solo pattern: ${patterns[0]} (requires 2+ confirming patterns)` };
  }

  // === DIP FOCUS MODE: require at least one value pattern ===
  // Backtest: DIP_BUY+DV = 80-100% WR, MACD+EMA alone = 0-25% WR.
  // When enabled, rejects trend-only signals UNLESS strong trend conditions are met.
  const dipFocusMode = TOML?.patterns?.dip_focus_mode ?? false;
  if (dipFocusMode) {
    const valuePatterns: string[] = TOML?.patterns?.value_patterns ?? ['DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE'];
    const hasValuePattern = patterns.some((p: string) => valuePatterns.includes(p));
    if (!hasValuePattern) {
      // Exception: allow trend signals in strong trending markets
      const adx = Number(signal.indicators?.adx ?? 0);
      const htfTrend = String(signal.indicators?.htf_trend ?? '');
      const trendAligned = Boolean(signal.indicators?.trend_aligned);
      const adxThreshold = TOML?.patterns?.trending_adx_threshold ?? 30;
      const isTrendPattern = patterns.some((p: string) => ['MACD_BULLISH_CROSS', 'EMA_BULLISH_CROSS'].includes(p));

      if (isTrendPattern && adx >= adxThreshold && (htfTrend === 'bullish' || trendAligned)) {
        console.log(`[TREND-PASS] ${signal.symbol}: trend signal allowed (ADX=${adx.toFixed(0)}, HTF=${htfTrend}, patterns=${patterns.join('+')})`);
      } else {
        return { pass: false, reason: `Dip focus: no value pattern (has: ${patterns.join(', ')}, ADX=${adx.toFixed(0)})` };
      }
    }
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
  thinkingSummary?: string;
  adjustedSL?: number;
  adjustedTP?: number;
  estimatedMinutesToTarget?: number;
  stagnationThresholdHours?: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    model: string;
  };
}

async function getAIValidation(signal: Signal): Promise<AIValidation> {
  const ai = getGrok();
  if (!ai) return { approved: false, aiConfidence: 0, reasoning: 'AI validation unavailable (fail-closed: no API key or client)' };

  try {
    const ex = getExchange();
    const ticker = await ex.fetchTicker(signal.symbol);

    // Fetch sentiment score from Redis
    const baseAsset = signal.symbol.split('/')[0];
    const sentimentKey = `sentiment:${baseAsset}`;
    const [sentimentRaw, sentimentAlert, sentimentContextRaw, evData] = await Promise.all([
      redis.get(sentimentKey),
      redis.get(`sentiment:alert:${baseAsset}`),
      redis.get(`sentiment:context:${baseAsset}`),
      getPatternCalibration(),
    ]);
    const sentimentScore = parseInt(sentimentRaw || '0');
    let sentimentLabel = 'Neutral';
    if (sentimentScore > 0) sentimentLabel = 'Positive';
    if (sentimentScore < 0) sentimentLabel = 'Negative';
    if (sentimentScore >= 2) sentimentLabel = 'Bullish';
    if (sentimentScore <= -2) sentimentLabel = 'Bearish';

    // Parse X narrative context for richer AI prompt
    let xNarrative = '';
    try {
      if (sentimentContextRaw) {
        const ctx = JSON.parse(sentimentContextRaw as string);
        xNarrative = ctx.narrative || '';
      }
    } catch { /* ignore parse errors */ }

    // Calculate EV for this signal's patterns
    const evResult = await calculateExpectedValue(signal, evData);
    const evCtx = evResult
      ? `EV: $${evResult.ev.toFixed(4)} (${evResult.winRate}% win rate, ${evResult.sampleSize} trades)`
      : 'EV: insufficient data';
    const alertCtx = sentimentAlert ? ` | ⚠️ X Alert: ${sentimentAlert}` : '';

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

    const slDiff = signal.entry_price - signal.stop_loss;
    const rr = signal.stop_loss > 0 && Math.abs(slDiff) > 0.0000001
      ? ((signal.target_price - signal.entry_price) / slDiff).toFixed(2)
      : 'N/A';

    // Classify signal type for prompt selection
    const valuePatterns: string[] = TOML?.patterns?.value_patterns ?? ['DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE'];
    const isDeepValue = signal.is_deep_value || signal.patterns?.includes('DEEP_VALUE_CRASH');
    const isDipBuy = signal.patterns?.some((p: string) => valuePatterns.includes(p) && p !== 'DEEP_VALUE_CRASH');
    const isMeanReversion = isDeepValue || isDipBuy;

    // Dynamic values from cryonix.toml for AI context
    const rsiOversold = TOML?.indicators?.rsi_oversold ?? 30;
    const adxThreshold = TOML?.indicators?.adx_trending_threshold ?? 25;
    const alertKeywords = (TOML?.sentiment?.alert_keywords ?? ['hack', 'exploit', 'rug', 'delist', 'scam']).join(', ');
    const minConf = Math.round((TOML?.risk?.min_confidence ?? 0.70) * 100);
    const strategyMode = TOML?.patterns?.dip_focus_mode ? 'Smart Dip Hunter (mean-reversion focus)' : 'All patterns';
    const stagnationDefault = TOML?.exits?.stagnation_timeout_hours ?? 16;

    const timingContext = `
TIME HORIZON: We trade across multiple horizons. Set estimated_minutes_to_target and stagnation_threshold_hours proportionally:
- Scalps (TP <2%): 15-60 min target, stagnation 1-2h
- Standard (TP 2-5%): 2-12h target, stagnation 6-16h
- Swing (TP 5-15%): 12-72h target, stagnation 24-48h
Default stagnation timeout is ${stagnationDefault}h. If position hasn't moved ±1% by stagnation_threshold_hours, it auto-exits.`;

    const jsonSchema = `{"approve":bool,"confidence":0-100,"reasoning":"string","sl":number|null,"tp":number|null,"estimated_minutes_to_target":number,"stagnation_threshold_hours":number}`;

    const systemPrompt = isDeepValue
      ? `You are a crash-buying specialist for crypto markets. Evaluate whether a large drawdown is PANIC SELLING (buy opportunity) or a FALLING KNIFE (avoid).
${timingContext}

Respond with ONLY a JSON object.
JSON: ${jsonSchema}`
      : isDipBuy
      ? `You are a mean-reversion specialist for crypto dip buying. Strategy: ${strategyMode}.

1. THINK through whether this dip is a buying opportunity or start of a larger decline
2. SEARCH X for any breaking news or negative catalysts about this coin
3. Evaluate whether the dip is structural or fundamental
${timingContext}

Respond with ONLY a JSON object.
JSON: ${jsonSchema}`
      : `You are a crypto trading risk analyst with access to real-time X/Twitter data and web search. Strategy: ${strategyMode}.

1. THINK through the technical setup step by step
2. SEARCH X for any breaking news, hacks, or sentiment shifts
3. Evaluate risk-reward and momentum
${timingContext}

Respond with ONLY a JSON object.
JSON: ${jsonSchema}`;

    const tpDistancePct = signal.entry_price > 0
      ? ((signal.target_price - signal.entry_price) / signal.entry_price * 100).toFixed(1)
      : '?';

    const prompt = isDeepValue
      ? `CRASH BUY ANALYSIS: ${signal.symbol}
Drawdown: ${signal.indicators.drawdown_pct}% from $${signal.indicators.recent_high}
TP distance: ${tpDistancePct}%`
      : `SIGNAL: ${signal.action} ${signal.symbol}
Setup: ${signal.patterns.join(' + ')} | TA confidence: ${(signal.confidence * 100).toFixed(0)}%
Entry: $${signal.entry_price.toFixed(4)} | SL: $${signal.stop_loss.toFixed(4)} | TP: $${signal.target_price.toFixed(4)}
TP distance: ${tpDistancePct}%`;

    // Build request with reasoning and search capabilities
    const modelId = TOML?.ai.model ?? 'grok-4-1-fast-reasoning';
    const isReasoningModel = modelId.includes('reasoning');

    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: TOML?.ai.temperature ?? 0.1,
    };

    // Reasoning models use max_completion_tokens, non-reasoning use max_tokens
    if (isReasoningModel) {
      requestBody.max_completion_tokens = TOML?.ai.max_tokens ?? 800;
      requestBody.reasoning = { effort: TOML?.ai.reasoning_effort ?? 'high' };
    } else {
      requestBody.max_tokens = TOML?.ai.max_tokens ?? 800;
    }

    // Enable xAI live search for real-time X/news context
    // 'on' = always search X (not 'auto' which sometimes skips)
    requestBody.search = { mode: 'on' };

    const response = await ai.chat.completions.create(requestBody as any);

    const content = response.choices[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { approved: false, aiConfidence: 0, reasoning: 'AI parse failed - rejecting (fail-closed)' };

    const result = JSON.parse(jsonMatch[0]);

    // Extract reasoning tokens from usage details
    const usageDetails = (response.usage as any)?.completion_tokens_details;
    const reasoningTokens = usageDetails?.reasoning_tokens || 0;

    // Extract reasoning_content if model returns it
    const reasoningContent = (response.choices[0]?.message as any)?.reasoning_content;
    const thinkingSummary = reasoningContent
      ? (typeof reasoningContent === 'string' ? reasoningContent.slice(0, 500) : JSON.stringify(reasoningContent).slice(0, 500))
      : undefined;

    console.log(`[AI] ${signal.symbol}: ${result.approve ? 'APPROVED' : 'REJECTED'} (${result.confidence}%) [${modelId}, ${reasoningTokens} thinking tokens] - ${result.reasoning}`);

    return {
      approved: result.approve,
      aiConfidence: (result.confidence || 50) / 100,
      reasoning: result.reasoning || 'No reasoning',
      thinkingSummary,
      adjustedSL: result.sl || undefined,
      adjustedTP: result.tp || undefined,
      estimatedMinutesToTarget: result.estimated_minutes_to_target || undefined,
      stagnationThresholdHours: result.stagnation_threshold_hours || undefined,
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        reasoning_tokens: reasoningTokens,
        total_tokens: response.usage?.total_tokens || 0,
        model: response.model,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[AI] Validation error: ${msg}`);
    // On AI failure, reject (fail-closed) — don't trade without validation
    return { approved: false, aiConfidence: 0, reasoning: `AI error (fail-closed): ${msg}` };
  }
}

// ============================================================================
// POSITION SIZING (Half-Kelly)
// ============================================================================

async function calculatePositionSize(signal: Signal): Promise<number> {
  const budget = await getCapitalBudget();
  const capital = budget.totalCapital;
  const isDeepValue = signal.is_deep_value || signal.patterns?.includes('DEEP_VALUE_CRASH');
  const isGrid = signal.patterns?.includes('GRID_BUY') || (signal as any).is_grid_buy;

  // Use strategy-specific budget, not total capital
  const isScalp = !isGrid && isScalpEligible(signal);
  const availableBudget = isGrid ? budget.gridRemaining : isScalp ? budget.scalpRemaining : budget.signalRemaining;

  // Deep value: configurable max, normal: CONFIG max
  const maxPct = isDeepValue ? (TOML?.capital.deep_value_max_pct ?? 0.20) : CONFIG.MAX_POSITION_SIZE_PCT;
  const maxPositionValue = Math.min(capital * maxPct, availableBudget);

  // Deep value requires high confidence after AI blending
  const deepValueMinConf = TOML?.capital.deep_value_min_confidence ?? 0.80;
  if (isDeepValue && signal.confidence < deepValueMinConf) {
    console.log(`[SIZING] Deep value ${signal.symbol} rejected: confidence ${(signal.confidence * 100).toFixed(1)}% < ${(deepValueMinConf * 100).toFixed(0)}%`);
    return 0;
  }

  const risk = Math.abs(signal.entry_price - signal.stop_loss);
  const reward = Math.abs(signal.target_price - signal.entry_price);
  const b = risk > 0 ? reward / risk : 1.5;
  const p = signal.confidence;
  const q = 1 - p;
  const kellyFraction = Math.max(0, ((p * b - q) / b) * (TOML?.capital.kelly_fraction_multiplier ?? 0.5));
  let positionValue = Math.min(capital * kellyFraction, maxPositionValue);

  // Ensure position clears NOTIONAL minimum.
  // With small capital, Kelly often produces values below NOTIONAL.
  if (positionValue < CONFIG.MIN_ORDER_VALUE && availableBudget >= CONFIG.MIN_ORDER_VALUE) {
    positionValue = CONFIG.MIN_ORDER_VALUE;
  }

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
  // ENVIRONMENT GUARD: block real orders outside production
  if (!IS_PRODUCTION) {
    console.log(`[DEV-MODE] Would BUY ${signal.symbol} — blocked (CRYONIX_ENV=${CRYONIX_ENV})`);
    return { success: false, error: `Execution blocked: CRYONIX_ENV=${CRYONIX_ENV} (not production)` };
  }

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

    // Post-rounding check: amountToPrecision() can round down enough to drop below minimum
    const postRoundValue = qty * signal.entry_price;
    if (postRoundValue < CONFIG.MIN_ORDER_VALUE) {
      return { success: false, error: `Post-rounding value $${postRoundValue.toFixed(2)} < $${CONFIG.MIN_ORDER_VALUE} min` };
    }

    const positionValue = qty * signal.entry_price;
    // Use pair's actual Binance NOTIONAL minimum with safety buffer.
    // Without buffer, a $5.00 buy that drops 5% becomes $4.75 → unsellable dust.
    const pairMinNotional = market.limits?.cost?.min || CONFIG.MIN_ORDER_VALUE;
    const notionalBuffer = TOML?.capital?.notional_safety_buffer ?? 1.5;
    const safeMinNotional = Math.max(pairMinNotional * notionalBuffer, CONFIG.MIN_ORDER_VALUE);
    if (positionValue < safeMinNotional) {
      return { success: false, error: `Value $${positionValue.toFixed(2)} < $${safeMinNotional.toFixed(2)} safe min (${signal.symbol}, notional=${pairMinNotional})` };
    }

    console.log(`[AUTO-TRADE] BUY ${signal.symbol}: qty=${quantity}, ~$${positionValue.toFixed(2)}, minNotional=${market.limits?.cost?.min || '?'}`);

    // Order book spread check — skip illiquid pairs
    try {
      const orderBook = await ex.fetchOrderBook(signal.symbol, TOML?.exits.orderbook_depth ?? 5);
      if (orderBook.bids?.length && orderBook.asks?.length) {
        const bestBid = orderBook.bids[0]?.[0];
        const bestAsk = orderBook.asks[0]?.[0];
        if (bestBid && bestAsk && bestBid > 0) {
          const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
          const maxSpread = TOML?.exits.max_spread_pct ?? 0.3;
          if (spreadPct > maxSpread) {
            return { success: false, error: `Spread too wide: ${spreadPct.toFixed(3)}% (max ${maxSpread}%)` };
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
    const entryFee = order.fee?.cost || 0;

    // Place Binance-native stop-loss order as safety net
    // This protects against auto-trader container crashes
    let nativeSlOrderId: string | undefined;
    try {
      const slPrice = ex.priceToPrecision(signal.symbol, signal.stop_loss);
      // Stop-limit: trigger at SL price, limit slightly below to ensure fill
      const slLimitPrice = ex.priceToPrecision(signal.symbol, signal.stop_loss * (TOML?.exits.native_sl_limit_offset ?? 0.995));
      const slOrder = await ex.createOrder(
        signal.symbol,
        'STOP_LOSS_LIMIT',
        'sell',
        executedQty,
        parseFloat(slLimitPrice),
        { stopPrice: parseFloat(slPrice) }
      );
      nativeSlOrderId = slOrder.id;
      console.log(`[AUTO-TRADE] Native SL placed: ${slOrder.id} @ $${slPrice} (limit $${slLimitPrice})`);
    } catch (slErr) {
      // Non-fatal — software SL still active as fallback
      console.warn(`[AUTO-TRADE] Native SL failed (software SL active):`, slErr instanceof Error ? slErr.message : String(slErr));
    }

    // Create tiered exit plan (Phase 3)
    const signalAtr = signal.indicators?.atr ?? 0;
    const exitPlan = createExitPlan(signal, executedPrice, executedQty, signalAtr as number);
    if (exitPlan) {
      console.log(`[TIERED-EXIT] Plan created for ${signal.symbol}: type=${exitPlan.tradeType}, ATR=${signalAtr}, T1=$${exitPlan.tiers[0].targetPrice.toFixed(4)}, T2=$${exitPlan.tiers[1].targetPrice.toFixed(4)}`);
    }

    // If exitPlan exists, use T1 as initial display TP for backward compat
    const displayTp = exitPlan ? exitPlan.tiers[0].targetPrice : signal.target_price;

    // Store position in Redis for monitoring
    await addPosition({
      symbol: signal.symbol,
      side: 'BUY',
      entryPrice: executedPrice,
      quantity: executedQty,
      stopLoss: signal.stop_loss,
      takeProfit: displayTp,
      trailingStop: signal.stop_loss,   // Starts at stop-loss
      highWaterMark: executedPrice,      // Starts at entry
      orderId: order.id,
      nativeSlOrderId,                  // Track native SL for cancellation on exit
      openedAt: new Date().toISOString(),
      pattern: signal.patterns?.join(', ') || '',
      confidence: signal.confidence,
      isGridPosition: !!(signal as any).is_grid_buy,
      isScalpPosition: isScalpEligible(signal),
      entryFee,
      aiEstimatedMinutes: signal.aiEstimatedMinutes,
      stagnationOverrideHours: signal.stagnationOverrideHours,
      moonshot_score: signal.moonshot_score,
      trade_type: signal.trade_type,
      exitPlan,
    });

    // Sync to Postgres positions table
    try {
      await createPosition({
        symbol: signal.symbol,
        quantity: String(executedQty),
        entryPrice: String(executedPrice),
        stopLoss: signal.stop_loss ? String(signal.stop_loss) : undefined,
        takeProfit: signal.target_price ? String(signal.target_price) : undefined,
      });
    } catch (err) {
      console.error('[SYNC] Failed to create position in Postgres:', err);
    }

    await incrementTradeCount();

    console.log(`[AUTO-TRADE] Filled ${order.id} @ $${executedPrice} (fee: $${entryFee.toFixed(4)})`);

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

  // ENVIRONMENT GUARD: block real orders outside production
  if (!IS_PRODUCTION) {
    console.log(`[DEV-MODE] Would MARGIN SELL ${signal.symbol} — blocked (CRYONIX_ENV=${CRYONIX_ENV})`);
    return { success: false, error: `Execution blocked: CRYONIX_ENV=${CRYONIX_ENV} (not production)` };
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

    // Sync to Postgres positions table
    try {
      await createPosition({
        symbol: signal.symbol,
        quantity: String(executedQty),
        entryPrice: String(executedPrice),
        stopLoss: signal.stop_loss ? String(signal.stop_loss) : undefined,
        takeProfit: signal.target_price ? String(signal.target_price) : undefined,
      });
    } catch (err) {
      console.error('[SYNC] Failed to create short position in Postgres:', err);
    }

    await incrementTradeCount();

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
    const excess = len - CONFIG.MAX_PENDING_QUEUE;
    // Log what we're about to drop (sample first few for debugging)
    const dropped: string[] = [];
    for (let i = 0; i < excess; i++) {
      const raw = await redis.rpop('trades:pending');
      if (raw && dropped.length < 3) {
        try {
          const sig = JSON.parse(raw as string);
          dropped.push(`${sig.symbol} ${sig.action} conf=${(sig.confidence * 100).toFixed(0)}%`);
        } catch { dropped.push('(parse error)'); }
      }
    }
    console.log(`[TRIM] Dropped ${excess} stale signals from queue (was ${len}, now ${CONFIG.MAX_PENDING_QUEUE}). Sample: ${dropped.join(', ')}`);
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

        if (isBelow || distancePct <= (TOML?.grid.level_trigger_tolerance ?? 0.0015)) {
          console.log(`[GRID] ${symbol} hit level #${i}: $${currentPrice.toFixed(2)} -> $${levelPrice.toFixed(2)}`);

          // Check if we still have capacity — use capital allocator
          const gridBudget = await getCapitalBudget();
          const currentPositions = await getOpenPositions();
          const gridPositions = currentPositions.filter(p => p.isGridPosition || p.pattern === 'GRID_BUY');
          if (currentPositions.length >= CONFIG.MAX_OPEN_POSITIONS || gridPositions.length >= CONFIG.MAX_GRID_POSITIONS) {
            results.push({ symbol, status: 'SKIPPED', level: i, error: 'Max positions reached' });
            break;
          }

          if (gridBudget.regime === 'volatile') {
            results.push({ symbol, status: 'SKIPPED', level: i, error: 'Grid paused: volatile regime' });
            break;
          }

          if (currentPositions.some(p => p.symbol === symbol)) {
            results.push({ symbol, status: 'SKIPPED', level: i, error: 'Already in position' });
            break;
          }

          // Proportional grid sizing: use grid budget / max levels, not hardcoded $6
          const gridOrderSize = Math.min(
            config.orderSizeUsd || gridBudget.gridBudget / 3,
            gridBudget.gridRemaining
          );
          if (gridOrderSize < CONFIG.MIN_ORDER_VALUE) {
            results.push({ symbol, status: 'SKIPPED', level: i, error: `Grid budget exhausted ($${gridBudget.gridRemaining.toFixed(2)})` });
            break;
          }

          // Basic safety checks before grid execution — only block on critical/emergency alerts
          try {
            const baseAsset = symbol.split('/')[0];
            const xAlertRaw = await redis.get(`sentiment:alert:${baseAsset}`);
            if (xAlertRaw) {
              let gridAlertSeverity = 'warning';
              let gridAlertReason = xAlertRaw as string;
              try {
                const parsed = JSON.parse(xAlertRaw as string);
                gridAlertSeverity = parsed.severity ?? 'warning';
                gridAlertReason = parsed.reason ?? (xAlertRaw as string);
                // Freshness guard
                if (parsed.context?.timing_uncertain) gridAlertSeverity = 'info';
              } catch { /* plain string — treat as warning (pass for grid) */ }
              if (gridAlertSeverity === 'critical' || gridAlertSeverity === 'emergency') {
                results.push({ symbol, status: 'SKIPPED', level: i, error: `X alert [${gridAlertSeverity}]: ${gridAlertReason}` });
                continue;
              }
            }
          } catch {}

          // Create grid signal (LLM already set the range, but spread/alerts checked above)
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
            position_size: gridOrderSize / currentPrice,
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
              configVersion: getConfigVersion(),
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
    // INSTANCE LOCK: ensure only one environment trades this Binance account
    const lock = await acquireInstanceLock();
    if (!lock.acquired) {
      console.warn(`[INSTANCE-LOCK] Trading blocked — another instance holds lock: ${lock.holder}`);
      return NextResponse.json({
        success: false,
        error: `Instance lock held by ${lock.holder}. Only one trading instance allowed per Binance account.`,
        instanceId: INSTANCE_ID,
        lockHolder: lock.holder,
      }, { status: 409 });
    }

    resetDailyStateIfNeeded();

    // Push shared risk config to Redis for Python engine
    await redis.set('config:risk', JSON.stringify(CONFIG), 'EX', TOML?.timing.regime_ttl_seconds ?? 3600);

    // STEP 1: Monitor existing positions (check SL/TP/trailing)
    // Acquire position lock for entire monitor cycle to prevent race conditions
    // on trailing stop updates and position saves
    let monitorLockAcquired = false;
    for (let i = 0; i < 5; i++) {
      if (await acquirePositionLock()) { monitorLockAcquired = true; break; }
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
    let monitorResults: MonitorResult[];
    try {
      monitorResults = await monitorPositions();
    } finally {
      if (monitorLockAcquired) await releasePositionLock();
    }
    const sells = monitorResults.filter(r => r.action !== 'HOLD' && r.action !== 'ERROR');

    // ACUTE TRIGGER: Track consecutive SL losses for AI Brain
    const slSells = sells.filter(s => s.action === 'SOLD_SL');
    if (slSells.length > 0) {
      try {
        const streakRaw = await redis.get('brain:loss_streak');
        const currentStreak = streakRaw ? parseInt(streakRaw) : 0;
        const newStreak = currentStreak + slSells.length;
        await redis.set('brain:loss_streak', String(newStreak), 'EX', 86400);

        if (newStreak >= 3) {
          await redis.set('brain:acute_trigger', JSON.stringify({
            streak: newStreak,
            last_losses: slSells.map(s => ({ symbol: s.symbol, pnl: s.pnl })),
            triggered_at: new Date().toISOString(),
          }), 'EX', 3600);
          console.log(`[BRAIN] Acute trigger set: ${newStreak} consecutive losses`);
        }
      } catch (e) {
        console.error('[BRAIN] Loss streak tracking error:', e);
      }
    }

    // Reset streak on any win
    const wins = sells.filter(s => s.action === 'SOLD_TP' || s.action === 'SOLD_TRAILING');
    if (wins.length > 0) {
      await redis.del('brain:loss_streak').catch(() => {});
    }

    // Sync risk state after monitoring (positions may have closed)
    await syncRiskState();

    // STEP 2: Trim queue to prevent overflow
    const trimmed = await trimQueue();

    // STEP 2.5: Check grid triggers (priority over normal signals)
    const gridResults = await checkGridTriggers();

    // STEP 3: Process new BUY signals (top by confidence to save AI tokens)
    const rawList = await redis.lrange('trades:pending', 0, 49);
    const parsed: { signal: Signal; raw: string }[] = [];
    const SIGNAL_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — stale signals are irrelevant (scanner runs every 10s)
    for (const raw of rawList) {
      try {
        const signal = JSON.parse(raw);
        // Normalize pattern names to uppercase (Python engine sends UPPERCASE, but TOML/test may use lowercase)
        if (signal.patterns && Array.isArray(signal.patterns)) {
          signal.patterns = signal.patterns.map((p: string) => p.toUpperCase());
        }
        // Drop stale signals — market has moved since detection
        if (signal.timestamp) {
          const age = Date.now() - new Date(signal.timestamp).getTime();
          if (age > SIGNAL_MAX_AGE_MS) {
            await redis.lrem('trades:pending', 1, raw);
            continue;
          }
        }
        parsed.push({ signal, raw });
      } catch { continue; }
    }

    // STEP 3a: Boost signals from GainerScanner top movers (only if direction matches)
    let topMovers: string[] = [];
    let topMoverDirections: Record<string, number> = {};
    try {
      const scannerRaw = await redis.get('scanner:top_movers');
      if (scannerRaw) {
        const scannerData = JSON.parse(scannerRaw);
        const gainers = (scannerData.gainers || [])
          .filter((g: any) => (g.change_1h ?? g.change_pct ?? 0) >= (TOML?.boosting.gainer_min_change_pct ?? 3.0));
        for (const g of gainers) {
          topMoverDirections[g.symbol] = g.change_1h ?? g.change_pct ?? 0;
        }
        const volSurges = (scannerData.volume_surges || [])
          .map((v: any) => v.symbol);
        topMovers = [...new Set([...gainers.map((g: any) => g.symbol), ...volSurges])];
      }
    } catch { /* scanner data not available */ }

    for (const p of parsed) {
      if (topMovers.includes(p.signal.symbol)) {
        const change = topMoverDirections[p.signal.symbol] || 0;
        const isBuy = p.signal.action === 'BUY';
        // Only boost if gainer direction matches signal: BUY on positive change, SELL on negative
        if ((isBuy && change > 0) || (!isBuy && change < 0)) {
          p.signal.confidence = Math.min(0.95, (p.signal.confidence || 0) + (TOML?.boosting.gainer_confidence_boost ?? 0.10));
          p.signal.reason = (p.signal.reason || '') + ` | 🔥 GainerScanner top mover (${change > 0 ? '+' : ''}${change.toFixed(1)}%)`;
        }
      }
    }

    // STEP 3b: Telegram Signal Boost — external channel convergence
    let telegramBoosts: Record<string, { delta: number; channels: string[]; consensus: number }> = {};
    try {
      const telegramRaw = await redis.get('signals:telegram:active');
      if (telegramRaw) {
        const telegramData = JSON.parse(telegramRaw as string);
        if (telegramData.boost_enabled) {
          const cutoff = Date.now() - (TOML?.boosting.telegram_window_minutes ?? 30) * 60 * 1000;
          for (const sig of (telegramData.signals || [])) {
            const sigTime = new Date(sig.latest_at || telegramData.timestamp).getTime();
            if (sigTime > cutoff) {
              telegramBoosts[sig.symbol] = {
                delta: sig.confidence_delta,
                channels: sig.channels || [sig.channel],
                consensus: sig.consensus || 1,
              };
            }
          }
        }
      }
    } catch { /* telegram source unavailable — silent fail */ }

    for (const p of parsed) {
      const boost = telegramBoosts[p.signal.symbol];
      if (boost && p.signal.action === 'BUY') {
        const oldConf = p.signal.confidence;
        p.signal.confidence = Math.min(0.95, p.signal.confidence + boost.delta);
        p.signal.reason += ` | 📱 Telegram (${boost.channels.join(', ')}) +${(boost.delta * 100).toFixed(0)}%`;
        console.log(`[TELEGRAM-BOOST] ${p.signal.symbol}: ${oldConf.toFixed(2)} → ${p.signal.confidence.toFixed(2)} (${boost.consensus} channels)`);
      }
    }

    // STEP 3c: CoinMarketCap macro adjustments (Fear & Greed + BTC dominance)
    const cmcBoostEnabled = TOML?.coinmarketcap?.enabled ?? false;
    if (cmcBoostEnabled) {
      try {
        const fgRaw = await redis.get('cmc:fear_greed');
        const globalRaw = await redis.get('cmc:global');
        const fg = fgRaw ? JSON.parse(fgRaw as string) : null;
        const global = globalRaw ? JSON.parse(globalRaw as string) : null;

        for (const p of parsed) {
          if (p.signal.action !== 'BUY') continue;
          const isDeepValue = p.signal.is_deep_value || p.signal.patterns?.includes('DEEP_VALUE_CRASH');

          // Fear & Greed adjustments
          if (fg) {
            const fearThreshold = TOML?.coinmarketcap?.fear_threshold ?? 20;
            const greedThreshold = TOML?.coinmarketcap?.greed_threshold ?? 80;

            if (fg.value <= fearThreshold) {
              // Extreme Fear: boost deep-value, require higher confidence for others
              if (isDeepValue) {
                const boost = TOML?.coinmarketcap?.fear_deep_value_boost ?? 0.08;
                p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
                p.signal.reason += ` | 😱 F&G=${fg.value} deep-value boost +${(boost * 100).toFixed(0)}%`;
              }
              // Non-deep-value signals get a note (filtering happens in passesRiskChecks via higher threshold)
            } else if (fg.value >= greedThreshold) {
              // Extreme Greed: penalize all BUY signals (FOMO filter)
              const penalty = TOML?.coinmarketcap?.greed_confidence_penalty ?? 0.10;
              p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
              p.signal.reason += ` | 🤑 F&G=${fg.value} greed penalty -${(penalty * 100).toFixed(0)}%`;
            }
          }

          // BTC dominance rise → penalize altcoin signals
          if (global) {
            const domRise = TOML?.coinmarketcap?.btc_dominance_rise_alt_penalty ?? 2.0;
            const domChange = global.btc_dominance_24h_pct || 0;
            const baseAsset = p.signal.symbol.split('/')[0];
            if (domChange > domRise && baseAsset !== 'BTC') {
              const penalty = TOML?.coinmarketcap?.alt_dominance_penalty ?? 0.05;
              p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
              p.signal.reason += ` | 📊 BTC dom +${domChange.toFixed(1)}% alt penalty`;
            }
          }
        }
      } catch { /* CMC data unavailable — skip adjustments */ }
    }

    // STEP 3d: Coinglass derivatives adjustments (funding rate + OI + L/S ratio)
    // Always runs — CCXT fallback means data is present even without API key.
    try {
      for (const p of parsed) {
        if (p.signal.action !== 'BUY') continue;
        const base = p.signal.symbol.replace('/USDC', '').replace('/USDT', '');

        // ── Funding Rate ──
        const fundingRaw = await redis.get(`coinglass:funding:${base}`);
        if (fundingRaw) {
          const f = JSON.parse(fundingRaw) as { rate: number };
          const rate = f.rate;
          const extremeNeg = TOML?.coinglass?.funding_extreme_negative_threshold ?? -0.0005;
          const mildNeg    = TOML?.coinglass?.funding_negative_threshold        ?? -0.0002;
          const extremePos = TOML?.coinglass?.funding_extreme_positive_threshold ?? 0.001;
          const mildPos    = TOML?.coinglass?.funding_positive_threshold         ?? 0.0005;

          if (rate <= extremeNeg) {
            const boost = TOML?.coinglass?.funding_squeeze_boost ?? 0.08;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | 📉 Funding ${(rate * 100).toFixed(3)}% squeeze +${(boost * 100).toFixed(0)}%`;
          } else if (rate <= mildNeg) {
            const boost = TOML?.coinglass?.funding_bearish_boost ?? 0.04;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | 📉 Funding ${(rate * 100).toFixed(3)}% bearish +${(boost * 100).toFixed(0)}%`;
          } else if (rate >= extremePos) {
            const penalty = TOML?.coinglass?.funding_crowded_penalty ?? 0.08;
            p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
            p.signal.reason += ` | 📈 Funding ${(rate * 100).toFixed(3)}% crowded -${(penalty * 100).toFixed(0)}%`;
          } else if (rate >= mildPos) {
            const penalty = TOML?.coinglass?.funding_positive_penalty ?? 0.04;
            p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
            p.signal.reason += ` | 📈 Funding ${(rate * 100).toFixed(3)}% long-heavy -${(penalty * 100).toFixed(0)}%`;
          }
        }

        // ── Open Interest ──
        const oiRaw = await redis.get(`coinglass:oi:${base}`);
        if (oiRaw) {
          const oi = JSON.parse(oiRaw) as { oi_change_24h_pct: number };
          const oiChange = oi.oi_change_24h_pct;
          const surgeThreshold = TOML?.coinglass?.oi_surge_threshold ?? 0.10;
          const patterns = p.signal.patterns || [];
          const isDipPattern = patterns.some((pat: string) =>
            ['DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE'].includes(pat)
          );

          if (oiChange >= surgeThreshold) {
            const boost = TOML?.coinglass?.oi_trend_boost ?? 0.05;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | 📊 OI +${(oiChange * 100).toFixed(1)}% trend +${(boost * 100).toFixed(0)}%`;
          } else if (oiChange <= -surgeThreshold) {
            if (isDipPattern) {
              const boost = TOML?.coinglass?.oi_capitulation_boost ?? 0.04;
              p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
              p.signal.reason += ` | 📊 OI ${(oiChange * 100).toFixed(1)}% capitulation +${(boost * 100).toFixed(0)}%`;
            } else {
              const penalty = TOML?.coinglass?.oi_panic_penalty ?? 0.05;
              p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
              p.signal.reason += ` | 📊 OI ${(oiChange * 100).toFixed(1)}% panic -${(penalty * 100).toFixed(0)}%`;
            }
          }
        }

        // ── Long/Short Ratio (Coinglass API only) ──
        const lsRaw = await redis.get(`coinglass:ls:${base}`);
        if (lsRaw) {
          const ls = JSON.parse(lsRaw) as { ls_ratio: number };
          const ratio = ls.ls_ratio;
          const squeezeThreshold = TOML?.coinglass?.ls_short_squeeze_threshold ?? 0.8;
          const crowdedThreshold = TOML?.coinglass?.ls_crowded_long_threshold ?? 2.5;

          if (ratio <= squeezeThreshold) {
            const boost = TOML?.coinglass?.ls_squeeze_boost ?? 0.06;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | ⚡ L/S ${ratio.toFixed(2)} squeeze +${(boost * 100).toFixed(0)}%`;
          } else if (ratio >= crowdedThreshold) {
            const penalty = TOML?.coinglass?.ls_crowded_penalty ?? 0.06;
            p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
            p.signal.reason += ` | ⚡ L/S ${ratio.toFixed(2)} crowded -${(penalty * 100).toFixed(0)}%`;
          }
        }
      }
    } catch { /* Coinglass data unavailable — skip adjustments */ }

    // STEP 3e: Polymarket prediction market adjustments
    try {
      console.log(`[POLYMARKET] Step 3e: checking ${parsed.length} signals against prediction market data`);
      const [pmCryptoRaw, pmFedRaw, pmGeoRaw, pmOilRaw] = await Promise.all([
        redis.get('polymarket:crypto'),
        redis.get('polymarket:fed'),
        redis.get('polymarket:geopolitik'),
        redis.get('polymarket:oil'),
      ]);

      for (const p of parsed) {
        if (p.signal.action !== 'BUY') continue;
        const baseAsset = p.signal.symbol.split('/')[0];
        const patterns = p.signal.patterns || [];
        const isDeepValue = patterns.some((pat: string) =>
          ['DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE'].includes(pat)
        );

        // Crypto sentiment from prediction markets
        if (pmCryptoRaw) {
          const crypto = JSON.parse(pmCryptoRaw);
          if (crypto.score <= 20 && isDeepValue) {
            // Very bearish prediction market + deep value signal = contrarian boost
            const boost = TOML?.polymarket?.crypto_bearish_dv_boost ?? 0.06;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | 🔮 Polymarket crypto very_bearish, contrarian DV +${(boost * 100).toFixed(0)}%`;
            console.log(`[POLYMARKET] 🔮 ${p.signal.symbol}: contrarian DV boost +${(boost * 100).toFixed(0)}% (crypto score: ${crypto.score})`);
          } else if (crypto.score >= 80) {
            // Very bullish = possible FOMO, slight penalty
            const penalty = TOML?.polymarket?.crypto_bullish_penalty ?? 0.05;
            p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
            p.signal.reason += ` | 🔮 Polymarket crypto euphoria -${(penalty * 100).toFixed(0)}%`;
            console.log(`[POLYMARKET] 🔮 ${p.signal.symbol}: FOMO penalty -${(penalty * 100).toFixed(0)}% (crypto score: ${crypto.score})`);
          }
        }

        // Fed dovish/hawkish sentiment
        if (pmFedRaw) {
          const fed = JSON.parse(pmFedRaw);
          const dovishThreshold = TOML?.polymarket?.fed_dovish_threshold ?? 70;
          const hawkishThreshold = TOML?.polymarket?.fed_hawkish_threshold ?? 30;
          if (fed.score >= dovishThreshold) {
            const boost = TOML?.polymarket?.fed_dovish_boost ?? 0.04;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | 🔮 Fed dovish (${fed.score}) +${(boost * 100).toFixed(0)}%`;
            console.log(`[POLYMARKET] 🔮 ${p.signal.symbol}: Fed dovish boost +${(boost * 100).toFixed(0)}% (fed score: ${fed.score})`);
          } else if (fed.score <= hawkishThreshold) {
            const penalty = TOML?.polymarket?.fed_hawkish_penalty ?? 0.05;
            p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
            p.signal.reason += ` | 🔮 Fed hawkish (${fed.score}) -${(penalty * 100).toFixed(0)}%`;
          }
        }

        // Geopolitical risk — block non-BTC alts in extreme risk
        if (pmGeoRaw) {
          const geo = JSON.parse(pmGeoRaw);
          const riskThreshold = TOML?.polymarket?.geopolitik_risk_threshold ?? 70;
          const btcOnly = TOML?.polymarket?.geopolitik_btc_only ?? true;
          if (geo.score <= (100 - riskThreshold) && btcOnly && baseAsset !== 'BTC') {
            // High geopolitical risk (low bullish score) — block non-BTC
            p.signal.confidence = 0;
            p.signal.reason += ` | 🔮 Geo risk high (${geo.score}), BTC-only mode`;
          }
        }

        // Oil price pressure — high oil = headwind for risk-on crypto
        if (pmOilRaw) {
          const oil = JSON.parse(pmOilRaw);
          const oilThreshold = TOML?.polymarket?.oil_bullish_threshold ?? 70;
          if (oil.score >= oilThreshold) {
            const penalty = TOML?.polymarket?.oil_risk_penalty ?? 0.03;
            p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
            p.signal.reason += ` | 🔮 Oil bullish (${oil.score}) risk-off -${(penalty * 100).toFixed(0)}%`;
          }
        }
      }
    } catch { /* Polymarket data unavailable — skip */ }

    parsed.sort((a, b) => (b.signal.confidence || 0) - (a.signal.confidence || 0));
    const topSignals = parsed.slice(0, 15);
    // Remove low-quality signals we won't process
    for (const p of parsed.slice(15)) {
      await redis.lrem('trades:pending', 1, p.raw);
    }

    let executed = 0;
    let rejected = 0;
    const buyResults: any[] = [];

    for (const { signal, raw } of topSignals) {

      const riskCheck = await passesRiskChecks(signal);

      if (!riskCheck.pass) {
        // Smart rotation: if rejected due to max positions, try replacing weakest position
        if (riskCheck.reason.includes('[rotation-eligible]')) {
          const currentPositions = await getOpenPositions();
          const rotation = await trySmartRotation(signal, currentPositions);
          if (rotation.shouldRotate && rotation.victim) {
            console.log(`[ROTATION] 🔄 Rotating: closing ${rotation.victim.symbol} for ${signal.symbol}`);
            const rotationEx = getExchange(); await rotationEx.loadMarkets(); const closeResult = await executeRotationClose(rotationEx, rotation.victim, rotation.reason || 'smart rotation');
            if (closeResult.success) {
              console.log(`[ROTATION] Slot freed — proceeding with ${signal.symbol}`);
              // Don't reject — fall through to AI validation + execution
            } else {
              await redis.lrem('trades:pending', 1, raw);
              rejected++;
              buyResults.push({
                symbol: signal.symbol,
                status: 'ROTATION_FAILED',
                reason: `Failed to close ${rotation.victim.symbol}`,
              });
              continue;
            }
          } else {
            await redis.lrem('trades:pending', 1, raw);
            rejected++;
            buyResults.push({
              symbol: signal.symbol,
              status: 'RISK_REJECTED',
              reason: `${riskCheck.reason} | rotation: ${rotation.reason}`,
            });
            continue;
          }
        } else {
          await redis.lrem('trades:pending', 1, raw);
          rejected++;
          buyResults.push({
            symbol: signal.symbol,
            status: 'RISK_REJECTED',
            reason: riskCheck.reason,
          });
          continue;
        }
      }

      // STEP 3b: AI Validation (Information Edge)
      const aiResult = await getAIValidation(signal);

      // Calculate consensus from confidence delta
      const confDelta = Math.abs(aiResult.aiConfidence - signal.confidence);
      const consensusScore = confDelta < 0.1 ? 0.8 : confDelta < 0.2 ? 0.6 : confDelta < 0.3 ? 0.4 : 0.2;
      const consensusLevel = consensusScore >= 0.8 ? 'STRONG'
        : consensusScore >= 0.6 ? 'MODERATE'
          : consensusScore >= 0.4 ? 'WEAK'
            : 'CONFLICTING';
      const riskLevel = signal.confidence >= 0.8 ? 'LOW' : signal.confidence >= 0.65 ? 'MEDIUM' : 'HIGH';

      // Log validation attempt (regardless of outcome)
      try {
        await saveValidation({
          signalId: undefined, // Linked if we had a signal ID
          symbol: signal.symbol,
          action: signal.action,
          originalConfidence: String(signal.confidence),
          adjustedConfidence: String(aiResult.aiConfidence),
          consensusLevel,
          sourceVotes: [],
          technicalIndicators: signal.indicators,
          priceTargets: {
            original: { entry: signal.entry_price, sl: signal.stop_loss, tp: signal.target_price },
            adjusted: { sl: aiResult.adjustedSL, tp: aiResult.adjustedTP }
          },
          entryTiming: 'IMMEDIATE',
          riskLevel,
          approved: aiResult.approved,
          reasoning: aiResult.reasoning,
          agentId: 'grok-validator',
          usage: {
            ...aiResult.usage,
            thinkingSummary: aiResult.thinkingSummary,
          },
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

      // Wire AI timing estimates to signal for position creation
      if (aiResult.estimatedMinutesToTarget) signal.aiEstimatedMinutes = aiResult.estimatedMinutesToTarget;
      if (aiResult.stagnationThresholdHours) signal.stagnationOverrideHours = aiResult.stagnationThresholdHours;

      // Moonshot classification — use engine score or pattern-based fallback
      if (!signal.moonshot_score) {
        let score = 50; // default: standard
        const patterns = signal.patterns || [];
        const volumeRatio = (signal.indicators?.volume_ratio as number) || 0;
        const volumeThreshold = TOML?.moonshot?.volume_threshold ?? 2.0;

        if (patterns.includes('DIP_BUY')) score = 20;
        else if (patterns.includes('DEEP_VALUE_CRASH')) score = 50;
        else if (patterns.includes('BOLLINGER_SQUEEZE') && patterns.includes('VOLUME_SPIKE_UP')) score = 70;
        else if (patterns.includes('BOLLINGER_SQUEEZE')) score = 50;

        if (volumeRatio >= volumeThreshold) score = Math.min(100, score + 30);

        signal.moonshot_score = score;
        const scalp = TOML?.moonshot?.scalp_threshold ?? 30;
        const moon = TOML?.moonshot?.moonshot_threshold ?? 70;
        signal.trade_type = score < scalp ? 'scalp' : score >= moon ? 'moonshot' : 'standard';
      }
      console.log(`[CLASSIFY] ${signal.symbol}: moonshot_score=${signal.moonshot_score}, type=${signal.trade_type}`);

      // Blend TA + AI confidence, normalized to ensure weights sum to 1.0
      const rawTaWeight = TOML?.ai.ta_weight ?? 0.5;
      const rawAiWeight = TOML?.ai.ai_weight ?? 0.5;
      const weightSum = rawTaWeight + rawAiWeight;
      const taWeight = weightSum > 0 ? rawTaWeight / weightSum : 0.5;
      const aiWeight = weightSum > 0 ? rawAiWeight / weightSum : 0.5;
      signal.confidence = Math.round((signal.confidence * taWeight + aiResult.aiConfidence * aiWeight) * 10000) / 10000;

      // X Sentiment confidence adjustment — bullish X buzz boosts, bearish penalizes
      if (signal.action === 'BUY') {
        try {
          const baseAsset = signal.symbol.split('/')[0];
          const xScore = parseInt((await redis.get(`sentiment:${baseAsset}`)) || '0');
          const bullishBoost = TOML?.sentiment?.bullish_boost ?? 0.05;
          const strongBullishBoost = TOML?.sentiment?.strong_bullish_boost ?? 0.08;
          const bearishPenalty = TOML?.sentiment?.bearish_penalty ?? 0.05;

          if (xScore >= 3) {
            signal.confidence += strongBullishBoost;
            console.log(`[SENTIMENT] ${signal.symbol}: +${(strongBullishBoost * 100).toFixed(0)}% boost (X score ${xScore}, strong bullish)`);
          } else if (xScore >= 2) {
            signal.confidence += bullishBoost;
            console.log(`[SENTIMENT] ${signal.symbol}: +${(bullishBoost * 100).toFixed(0)}% boost (X score ${xScore}, bullish)`);
          } else if (xScore <= -2) {
            signal.confidence -= bearishPenalty;
            console.log(`[SENTIMENT] ${signal.symbol}: -${(bearishPenalty * 100).toFixed(0)}% penalty (X score ${xScore}, bearish)`);
          }
          // Clamp confidence to valid range after all adjustments
          signal.confidence = Math.max(0, Math.min(0.95, signal.confidence));
        } catch { /* sentiment unavailable — no adjustment */ }
      }

      // Dedup lock: prevent duplicate executions for the same symbol
      const dedupKey = `executing:${signal.symbol}`;
      const acquired = await redis.set(dedupKey, '1', 'EX', 30, 'NX');
      if (!acquired) {
        await redis.lrem('trades:pending', 1, raw);
        rejected++;
        buyResults.push({
          symbol: signal.symbol,
          status: 'DEDUP_REJECTED',
          reason: `Execution already in progress for ${signal.symbol}`,
        });
        continue;
      }

      // Re-verify capital budget right before execution to prevent over-allocation
      // (positions may have been opened since initial budget check in passesRiskChecks)
      if (signal.action === 'BUY') {
        try {
          const freshBudget = await getCapitalBudget();
          const isGrid = signal.patterns?.includes('GRID_BUY');
          const remaining = isGrid ? freshBudget.gridRemaining : freshBudget.signalRemaining;
          const minOrder = TOML?.capital?.min_order_value ?? CONFIG.MIN_ORDER_VALUE;
          if (remaining < minOrder) {
            await redis.lrem('trades:pending', 1, raw);
            await redis.del(dedupKey);
            rejected++;
            buyResults.push({
              symbol: signal.symbol,
              status: 'BUDGET_EXHAUSTED',
              reason: `${isGrid ? 'Grid' : 'Signal'} budget remaining $${remaining.toFixed(2)} < min $${minOrder}`,
            });
            continue;
          }
        } catch (budgetErr) {
          console.error('[BUDGET-CHECK] Re-verification failed:', budgetErr);
          // Proceed — don't block trading on budget check errors
        }
      }

      // Execute based on signal action
      let execution;
      try {
        execution = signal.action === 'SELL'
          ? await executeMarginSell(signal)
          : await executeBuy(signal);
      } finally {
        await redis.del(dedupKey);
      }
      await redis.lrem('trades:pending', 1, raw);

      if (execution.success) {
        await redis.lpush('trades:approved', JSON.stringify({
          ...signal,
          executedAt: new Date().toISOString(),
          orderId: execution.orderId,
          executedPrice: execution.executedPrice,
          executedQuantity: execution.quantity,
          aiValidation: aiResult.reasoning,
          aiThinking: aiResult.thinkingSummary,
          aiModel: aiResult.usage?.model,
          blendedConfidence: signal.confidence,
        }));
        // Keep only last 50 approved trades (prevent unbounded growth)
        await redis.ltrim('trades:approved', 0, 49);

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
          configVersion: getConfigVersion(),
        });

        // Mark matching signal as executed in Postgres
        try {
          await markLatestSignalExecuted(signal.symbol, signal.action);
        } catch (err) {
          console.error('[SYNC] Failed to mark signal executed:', err);
        }

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

    // Sync risk state after all position changes
    if (executed > 0 || sells.length > 0) {
      await syncRiskState();
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

  // Capital budget for dashboard visibility
  const budget = await getCapitalBudget();

  const unrealizedPnl = positionDetails.reduce((sum: number, pos: any) => sum + (pos.pnl || 0), 0);

  return NextResponse.json({
    success: true,
    status: 'active',
    config: CONFIG,
    budget: {
      totalCapital: budget.totalCapital,
      regime: budget.regime,
      signal: { budget: budget.signalBudget, used: budget.signalUsed, remaining: budget.signalRemaining },
      grid: { budget: budget.gridBudget, used: budget.gridUsed, remaining: budget.gridRemaining },
      reserve: budget.reserve,
    },
    positions: positionDetails,
    dailyState: {
      date: dailyState.date,
      tradesExecuted: dailyState.tradesExecuted,
      dailyPnl: dailyState.dailyPnl,
      unrealizedPnl: +unrealizedPnl.toFixed(4),
      totalDayPnl: +(dailyState.dailyPnl + unrealizedPnl).toFixed(4),
    },
    queues: { pending: pendingCount, approved: approvedCount },
    grids: gridConfigs,
    isTestnet: process.env.BINANCE_TESTNET === 'true',
    instanceId: INSTANCE_ID,
    lockHolder: await redis.get(INSTANCE_LOCK_KEY),
    toml: fullConfig(),
    cmc: await (async () => {
      try {
        const fgRaw = await redis.get('cmc:fear_greed');
        const globalRaw = await redis.get('cmc:global');
        return {
          fearGreed: fgRaw ? JSON.parse(fgRaw as string) : null,
          global: globalRaw ? JSON.parse(globalRaw as string) : null,
        };
      } catch { return null; }
    })(),
    polymarket: await (async () => {
      try {
        const raw = await redis.get('polymarket:summary');
        return raw ? JSON.parse(raw as string) : null;
      } catch { return null; }
    })(),
  });
}
