import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logTrade, saveValidation, archivePosition, createPosition, closePositionBySymbol, markLatestSignalExecuted } from '@cryonix/database';
import { fullConfig, loadConfig } from '@/lib/config';
import { getConfigVersion } from '@/lib/config-version';
import ccxt, { type Exchange } from 'ccxt';
import OpenAI from 'openai';

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
  pnlPct?: number;         // Live P&L % (updated every monitoring cycle)
  currentPrice?: number;   // Last known price (updated every monitoring cycle)
  entryFee?: number;       // Fee paid on entry order (for total fee tracking)
}

// ============================================================================
// CAPITAL ALLOCATOR — Single source of truth for strategy budgets
// ============================================================================

interface CapitalBudget {
  totalCapital: number;
  signalBudget: number;      // Max $ for signal trades
  gridBudget: number;        // Max $ for grid trades
  reserve: number;           // Always kept free
  signalUsed: number;        // Currently allocated to signal positions
  gridUsed: number;          // Currently allocated to grid positions
  signalRemaining: number;
  gridRemaining: number;
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
  } catch { }

  // Base allocation
  let signalPct = CONFIG.SIGNAL_POOL_PCT;
  let gridPct = CONFIG.GRID_POOL_PCT;
  let reservePct = CONFIG.RESERVE_PCT;

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
  const reserve = capital * reservePct;

  // Calculate current usage
  let signalUsed = 0;
  let gridUsed = 0;
  for (const pos of positions) {
    const posValue = pos.entryPrice * pos.quantity;
    if (pos.isGridPosition || pos.pattern === 'GRID_BUY') {
      gridUsed += posValue;
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
  } catch { }
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
// POSITION MONITORING - THE EXIT STRATEGY
// ============================================================================

interface MonitorResult {
  symbol: string;
  action: 'HOLD' | 'SOLD_TP' | 'SOLD_SL' | 'SOLD_TRAILING' | 'SOLD_STAGNATION' | 'SOLD_DUST' | 'ERROR';
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
            await redis.set(`cooldown:loss:${pos.symbol}`, Date.now().toString(), 'EX', 7200);
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
              await redis.set(`cooldown:loss:${pos.symbol}`, Date.now().toString(), 'EX', 7200);
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
                fees: '0',
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
            try { await closePositionBySymbol(pos.symbol, String(fillPrice), String(realizedPnl), String(pnlPct)); } catch { }

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
      pos.currentPrice = currentPrice;

      // Update high water mark and trailing stop
      if (currentPrice > pos.highWaterMark) {
        pos.highWaterMark = currentPrice;
        // Only start trailing after activation threshold (let positions breathe)
        const profitPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (profitPct >= (TOML?.exits.trailing_activation_pct ?? 1.5)) {
          const newTrailingStop = currentPrice * (1 - CONFIG.TRAILING_STOP_PCT / 100);
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

      if (currentValue < CONFIG.MIN_ORDER_VALUE && currentValue >= 5.0) {
        shouldSell = true;
        exitReason = `Dust prevention: value $${currentValue.toFixed(2)} approaching NOTIONAL minimum`;
      }

      // Stagnation exit: sell positions that haven't moved >1% in N hours
      if (!shouldSell && pos.openedAt) {
        const ageHours = (Date.now() - new Date(pos.openedAt).getTime()) / (1000 * 60 * 60);
        const stagnationTimeout = TOML?.exits.stagnation_timeout_hours ?? 8;
        if (ageHours > stagnationTimeout && Math.abs(pnlPct) < 1.0) {
          shouldSell = true;
          exitReason = `Stagnation exit: ${ageHours.toFixed(1)}h old, only ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% movement (< 1%)`;
        }
      }

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
          const exitFee = closeOrder.fee?.cost || 0;
          const fees = exitFee + (pos.entryFee || 0);

          // Remove from open positions
          await removePosition(pos.symbol);

          // Per-symbol loss cooldown: prevent re-buying a losing symbol too soon
          if ((realizedPnl - fees) < 0) {
            await redis.set(`cooldown:loss:${pos.symbol}`, Date.now().toString(), 'EX', 7200);
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

          const exitType = exitReason.startsWith('Stagnation') ? 'SOLD_STAGNATION' :
            exitReason.startsWith('Dust') ? 'SOLD_DUST' :
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
          try { await closePositionBySymbol(pos.symbol, String(closePrice), String(realizedPnl - fees), String(pnlPct)); } catch { }

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
              await redis.set(`cooldown:loss:${pos.symbol}`, Date.now().toString(), 'EX', 7200);
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
            try { await closePositionBySymbol(pos.symbol, String(currentPrice), String(pnl), String(pnlPct)); } catch { }

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
  } catch { }

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
    return { pass: false, reason: `Max positions (${CONFIG.MAX_OPEN_POSITIONS})` };
  }

  // Capital allocator: enforce per-strategy budgets
  const isGrid = signal.patterns?.includes('GRID_BUY') || (signal as any).is_grid_buy;
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
  } else {
    // Signal strategy checks
    const signalPositions = openPositions.filter(p => !p.isGridPosition && p.pattern !== 'GRID_BUY');
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

  // X sentiment alert check — reject if breaking negative news
  try {
    const baseAsset = signal.symbol.split('/')[0];
    const alert = await redis.get(`sentiment:alert:${baseAsset}`);
    if (alert && signal.action === 'BUY') {
      const alertLower = (alert as string).toLowerCase();
      const alertKeywords = TOML?.sentiment.alert_keywords ?? ['hack', 'exploit', 'rug', 'sec', 'crash', 'delist', 'lawsuit', 'ban', 'scam', 'fraud', 'investigation', 'vulnerability'];
      if (alertKeywords.some((kw: string) => alertLower.includes(kw))) {
        return { pass: false, reason: `X alert: ${alert}` };
      }
    }
  } catch { }

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
  const weakSoloPatterns = ['RSI_OVERSOLD', 'EMA_BULLISH_CROSS', 'MACD_BULLISH_CROSS'];
  const patterns = signal.patterns || [];
  if (patterns.length === 1 && weakSoloPatterns.includes(patterns[0])) {
    return { pass: false, reason: `Weak solo pattern: ${patterns[0]} (requires 2+ confirming patterns)` };
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

    // Use specialized prompt for deep value crash signals
    const isDeepValue = signal.is_deep_value || signal.patterns?.includes('DEEP_VALUE_CRASH');

    const systemPrompt = isDeepValue
      ? `You are a crash-buying specialist for crypto markets. Evaluate whether a large drawdown is PANIC SELLING (buy opportunity) or a FALLING KNIFE (avoid). Use your reasoning to analyze drop velocity, volume patterns, multi-timeframe RSI alignment, and whether the selloff is isolated or broad-based. Search X/Twitter for breaking news about this asset. Respond with ONLY a JSON object.`
      : `You are a crypto trading risk analyst with access to real-time X/Twitter data and web search. Your role:

1. THINK through the technical setup step by step (use your reasoning capability)
2. SEARCH X for any breaking news, hacks, delistings, or sentiment shifts about this coin
3. Evaluate risk-reward, indicator confluence, and market regime alignment
4. Give a clear approve/reject with calibrated confidence

Key principles:
- On a $${totalCapital.toFixed(0)} account, missed good trades cost more than small losses
- Approve signals with 2+ confirming indicators or 1 strong signal (RSI<30, Bollinger squeeze with volume)
- REJECT if: signal contradicts higher-timeframe trend, negative EV pattern, or X reveals bad news
- BOOST confidence if X sentiment is bullish AND technical setup aligns
- Adjust SL/TP if you see better levels based on your analysis

Respond with ONLY a JSON object.`;

    const prompt = isDeepValue
      ? `CRASH BUY ANALYSIS: ${signal.symbol}

Drawdown: ${signal.indicators.drawdown_pct}% from $${signal.indicators.recent_high}
Drop velocity: ${signal.indicators.drop_velocity}%/hr | Volume: ${signal.indicators.volume_ratio}x avg
RSI: 15m=${signal.indicators.rsi} | 1h=${signal.indicators.rsi_1h ?? '?'} | 4h=${signal.indicators.rsi_4h ?? '?'}
Support: $${signal.indicators.support_level ?? '?'} | Price: $${ticker.last?.toFixed(4)} | 24h: ${ticker.percentage?.toFixed(2)}%
Sentiment: ${sentimentLabel}${alertCtx} | ${evCtx}
Portfolio: $${totalCapital.toFixed(2)} total, $${availableCash.toFixed(2)} free, ${openPositions.length}/${CONFIG.MAX_OPEN_POSITIONS} positions [${positionList}]

JSON: {"approve":bool,"confidence":0-100,"reasoning":"2-3 sentences","sl":number|null,"tp":number|null}`
      : `SIGNAL: ${signal.action} ${signal.symbol}

Setup: ${signal.patterns.join(' + ')} | TA confidence: ${(signal.confidence * 100).toFixed(0)}%
Reason: ${signal.reason}
Entry: $${signal.entry_price.toFixed(4)} | SL: $${signal.stop_loss.toFixed(4)} | TP: $${signal.target_price.toFixed(4)} | R:R=${rr}

Indicators:
RSI=${signal.indicators?.rsi ?? '?'} | MACD hist=${signal.indicators?.macd_hist ?? '?'} | ADX=${signal.indicators?.adx ?? '?'}
BB: low=$${signal.indicators?.bb_lower ?? '?'} mid=$${signal.indicators?.bb_mid ?? '?'} up=$${signal.indicators?.bb_upper ?? '?'}
ATR=${signal.indicators?.atr_pct ?? '?'}% | EMA9/21=${signal.indicators?.ema9 ?? '?'}/${signal.indicators?.ema21 ?? '?'}
Volume: ${signal.indicators?.volume_ratio ?? '?'}x avg | Trend aligned: ${signal.indicators?.trend_aligned ?? '?'}
Regime: ${signal.indicators?.market_regime ?? '?'} | HTF trend: ${signal.indicators?.htf_trend ?? '?'}

Market: $${ticker.last?.toFixed(4)} now | 24h: ${ticker.percentage?.toFixed(2)}% | Sentiment: ${sentimentLabel} (${sentimentScore})${alertCtx}
${evCtx}
Portfolio: $${totalCapital.toFixed(2)} capital, $${availableCash.toFixed(2)} free, ${openPositions.length}/${CONFIG.MAX_OPEN_POSITIONS} positions [${positionList}]
Today: ${dailyState.tradesExecuted}/${CONFIG.MAX_TRADES_PER_DAY} trades | P&L: $${dailyState.dailyPnl.toFixed(2)}

JSON: {"approve":bool,"confidence":0-100,"reasoning":"2-3 sentences with specific indicator references","sl":number|null,"tp":number|null}`;

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
    requestBody.search = { mode: 'auto' };

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
  const availableBudget = isGrid ? budget.gridRemaining : budget.signalRemaining;

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
    // Use pair's actual Binance NOTIONAL minimum with 50% buffer.
    // Without buffer, a $5.00 buy that drops 5% becomes $4.75 → unsellable dust.
    // Default to $5 (not CONFIG.MIN_ORDER_VALUE) when market data is missing.
    const pairMinNotional = market.limits?.cost?.min || 5.0;
    const safeMinNotional = Math.max(pairMinNotional * 1.5, CONFIG.MIN_ORDER_VALUE);
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
      nativeSlOrderId,                  // Track native SL for cancellation on exit
      openedAt: new Date().toISOString(),
      pattern: signal.patterns?.join(', ') || '',
      confidence: signal.confidence,
      isGridPosition: !!(signal as any).is_grid_buy,
      entryFee,
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
    const SIGNAL_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes — stale signals are irrelevant
    for (const raw of rawList) {
      try {
        const signal = JSON.parse(raw);
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

      // Blend TA + AI confidence, rounded to avoid floating-point artifacts
      const taWeight = TOML?.ai.ta_weight ?? 0.5;
      const aiWeight = TOML?.ai.ai_weight ?? 0.5;
      signal.confidence = Math.round((signal.confidence * taWeight + aiResult.aiConfidence * aiWeight) * 10000) / 10000;

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
  });
}
