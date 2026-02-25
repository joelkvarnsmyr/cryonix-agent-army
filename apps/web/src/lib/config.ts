import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { parse } from '@iarna/toml';
import { join } from 'path';
import { RISK_CONFIG, type RiskConfig } from '@cryonix/types';

// ============================================================================
// TOML Configuration Loader
// ============================================================================
//
// Reads cryonix.toml and exports:
//   - CONFIG: same shape as RISK_CONFIG (backward compatible with auto-trade)
//   - fullConfig(): complete TOML structure for future phases
//
// Fallback: if TOML is missing, returns RISK_CONFIG defaults.
// ============================================================================

export interface CryonixConfig {
  trading: { mode: string; spot_only: boolean; margin_type: string; default_leverage: number; symbol_whitelist?: string[] };
  capital: {
    max_position_size_pct: number; min_order_value: number;
    signal_pool_pct: number; grid_pool_pct: number; reserve_pct: number;
    kelly_fraction_multiplier: number; deep_value_max_pct: number; deep_value_min_confidence: number;
  };
  limits: {
    max_open_positions: number; max_signal_positions: number;
    max_grid_positions: number; max_trades_per_day: number; max_pending_queue: number;
  };
  risk: {
    max_daily_loss_pct: number; max_weekly_loss_pct: number;
    max_consecutive_losses: number; max_correlation: number;
    volatility_pause_atr_pct: number; liquidation_buffer_pct: number;
    min_confidence: number; min_risk_reward: number;
  };
  exits: {
    trailing_stop_pct: number; trailing_activation_pct: number;
    max_slippage_pct: number; max_spread_pct: number; orderbook_depth: number;
    sl_atr_multiplier: number; tp_atr_multiplier: number;
    deep_value_sl_atr: number; deep_value_tp_atr: number;
    native_sl_limit_offset: number;
    stagnation_timeout_hours: number;
  };
  indicators: {
    rsi_period: number; rsi_oversold: number; rsi_overbought: number;
    bollinger_period: number; bollinger_std: number; bollinger_squeeze_pct: number;
    macd_fast: number; macd_slow: number; macd_signal: number;
    ema_fast: number; ema_slow: number;
    atr_period: number; adx_period: number; adx_trending_threshold: number;
    volume_sma_period: number; volume_spike_threshold: number; volume_confirmation: number;
    min_candles: number;
  };
  patterns: {
    dip_buy_drawdown: number; dip_buy_lookback: number; dip_buy_max_rsi: number;
    deep_value_threshold: number; deep_value_support_lookback_days: number;
    deep_value_rug_pull_velocity: number;
    dip_focus_mode: boolean; value_patterns: string[];
  };
  consensus: {
    single_pattern_penalty: number; two_pattern_boost: number;
    three_pattern_boost: number; ranging_trend_penalty: number;
  };
  regime: {
    volatile_atr_expansion: number;
    volatile_signal_pct: number; volatile_grid_pct: number; volatile_reserve_pct: number;
    trending_signal_pct: number; trending_grid_pct: number; trending_reserve_pct: number;
  };
  boosting: {
    gainer_min_change_pct: number; gainer_confidence_boost: number;
    telegram_window_minutes: number; telegram_boost_enabled: boolean;
  };
  ev_model: { min_trades_for_ev: number; calibration_lookback_days: number; calibration_min_trades: number };
  sentiment: { expiration_seconds: number; alert_keywords: string[] };
  ai: { enabled: boolean; model: string; reasoning_effort: string; temperature: number; max_tokens: number; ta_weight: number; ai_weight: number };
  timing: {
    auto_trader_poll_ms: number; health_check_interval_ms: number;
    telegram_poll_ms: number; trade_alert_poll_ms: number;
    ws_heartbeat_ms: number; ws_timeout_ms: number;
    capital_cache_ms: number; calibration_cache_ms: number; regime_ttl_seconds: number;
    reconcile_interval_ms: number; instance_lock_ttl_seconds: number; position_lock_ttl_seconds: number;
  };
  engine: { timeframe: string; candle_limit: number; signal_cooldown_seconds: number; news_scan_interval_seconds: number };
  grid: { level_trigger_tolerance: number };
  reconciliation: {
    phantom_threshold: number; mismatch_warning_low: number;
    mismatch_warning_high: number; dust_sell_floor: number;
  };
  coinmarketcap: {
    enabled: boolean; poll_interval_seconds: number;
    fear_threshold: number; greed_threshold: number;
    fear_deep_value_boost: number; fear_min_confidence: number;
    greed_confidence_penalty: number;
    max_rank: number; max_fdv_mc_ratio: number;
    global_mc_drop_volatile_pct: number;
    btc_dominance_rise_alt_penalty: number; alt_dominance_penalty: number;
  };
}

let _tomlConfig: CryonixConfig | null = null;
let _loaded = false;
let _tomlHash: string = 'none';

function loadToml(): CryonixConfig | null {
  if (_loaded) return _tomlConfig;
  _loaded = true;

  const paths = [
    '/app/cryonix.toml',                                  // Docker container
    join(process.cwd(), 'cryonix.toml'),                   // Dev (repo root via Next.js)
    join(process.cwd(), '../../cryonix.toml'),             // Dev (from apps/web)
  ];

  for (const p of paths) {
    try {
      const raw = readFileSync(p, 'utf-8');
      _tomlConfig = parse(raw) as unknown as CryonixConfig;
      _tomlHash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
      console.log(`[CONFIG] Loaded cryonix.toml from ${p} (hash: ${_tomlHash})`);
      return _tomlConfig;
    } catch {
      continue;
    }
  }

  console.warn('[CONFIG] cryonix.toml not found — using RISK_CONFIG defaults');
  return null;
}

/**
 * Returns short SHA-256 hash of the loaded TOML file.
 * Use to verify all containers are running the same config.
 */
export function configHash(): string {
  loadToml();
  return _tomlHash;
}

/**
 * Returns the full TOML config, or null if not available.
 * Use this in future phases when migrating individual values.
 */
export function fullConfig(): CryonixConfig | null {
  return loadToml();
}

/**
 * Returns CONFIG object matching RISK_CONFIG shape.
 * TOML values override RISK_CONFIG defaults where available.
 * This ensures backward compatibility during migration.
 */
export function loadConfig(): RiskConfig {
  const toml = loadToml();
  if (!toml) return RISK_CONFIG;

  return {
    TOTAL_CAPITAL: 0, // Always auto-detect
    SIGNAL_POOL_PCT: toml.capital.signal_pool_pct,
    GRID_POOL_PCT: toml.capital.grid_pool_pct,
    RESERVE_PCT: toml.capital.reserve_pct,
    MAX_POSITION_SIZE_PCT: toml.capital.max_position_size_pct,
    MAX_OPEN_POSITIONS: toml.limits.max_open_positions,
    MAX_SIGNAL_POSITIONS: toml.limits.max_signal_positions,
    MAX_GRID_POSITIONS: toml.limits.max_grid_positions,
    MIN_ORDER_VALUE: toml.capital.min_order_value,
    MIN_CONFIDENCE: toml.risk.min_confidence,
    MAX_DAILY_LOSS_PCT: toml.risk.max_daily_loss_pct,
    MAX_WEEKLY_LOSS_PCT: toml.risk.max_weekly_loss_pct,
    MAX_SLIPPAGE_PCT: toml.exits.max_slippage_pct,
    MAX_TRADES_PER_DAY: toml.limits.max_trades_per_day,
    MAX_PENDING_QUEUE: toml.limits.max_pending_queue,
    SPOT_ONLY: toml.trading.spot_only,
    TRADING_MODE: toml.trading.mode as 'spot' | 'margin' | 'future',
    MARGIN_TYPE: toml.trading.margin_type as 'cross' | 'isolated',
    DEFAULT_LEVERAGE: toml.trading.default_leverage,
    TRAILING_STOP_PCT: toml.exits.trailing_stop_pct,
    AI_VALIDATION: toml.ai.enabled,
  } as const;
}
