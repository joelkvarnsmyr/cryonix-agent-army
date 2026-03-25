'use client';

import { useState, useEffect, useCallback } from 'react';

interface AutoTradeConfig {
  TOTAL_CAPITAL: number;
  MAX_POSITION_SIZE_PCT: number;
  MIN_CONFIDENCE: number;
  MAX_DAILY_LOSS_PCT: number;
  MAX_OPEN_POSITIONS: number;
  MAX_TRADES_PER_DAY: number;
  TRADING_MODE: string;
  DEFAULT_LEVERAGE: number;
  TRAILING_STOP_PCT: number;
  AI_VALIDATION: boolean;
}

interface PositionDetail {
  symbol: string;
  side: string;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop: number;
  highWaterMark: number;
  orderId: string;
  openedAt: string;
  pattern: string;
  confidence: number;
  currentPrice: number;
  pnl: number;
  pnlPct: number;
}

interface DailyState {
  date: string;
  tradesExecuted: number;
  dailyPnl: number;
  unrealizedPnl?: number;
  totalDayPnl?: number;
}

interface GridConfig {
  symbol: string;
  levels: Array<{ price: number; triggered: boolean }>;
}

export interface CryonixConfig {
  trading: { mode: string; spot_only: boolean; margin_type: string; default_leverage: number };
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
  engine: { timeframe: string; candle_limit: number; news_scan_interval_seconds: number };
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

export interface AutoTradeStatus {
  success: boolean;
  status: string;
  config: AutoTradeConfig;
  toml?: CryonixConfig;
  positions: PositionDetail[];
  dailyState: DailyState;
  queues: { pending: number; approved: number };
  grids: GridConfig[];
  isTestnet: boolean;
}

export function useAutoTrade(refreshInterval: number = 15000) {
  const [data, setData] = useState<AutoTradeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-trade');
      const json = await res.json();
      if (json.success) {
        setData(json);
        setError(null);
      } else {
        setError(json.error || 'Failed to fetch');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchStatus, refreshInterval]);

  return { data, loading, error, refresh: fetchStatus };
}
