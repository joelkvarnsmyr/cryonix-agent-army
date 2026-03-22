// ── Manipulation Detection ──────────────────────────────────────

export type ManipulationType =
  | 'pump_and_dump'        // Classic P&D — coordinated buy → dump
  | 'coordinated_shill'    // Multi-account shill campaign on X/Telegram
  | 'whale_accumulation'   // Whale buying + social media hype generation
  | 'fake_news_pump'       // Fabricated news/partnership announcements
  | 'wash_trading_pump'    // Volume faked to attract FOMO buyers
  | 'influencer_pump';     // KOL/influencer coordinated push

export type PumpPhase =
  | 'pre_pump'     // Accumulation phase, shilling just starting
  | 'early_pump'   // Price starting to move, volume rising — ENTRY ZONE
  | 'mid_pump'     // Strong momentum, late but still possible — CAUTIOUS ENTRY
  | 'peak'         // Near top, high risk — DO NOT ENTER
  | 'dump'         // Sellers taking over — AVOID / EXIT
  | 'post_dump';   // Aftermath — avoid entirely

export interface ShillActivity {
  platform: 'x' | 'telegram' | 'discord' | 'reddit';
  account_count: number;
  mention_count: number;
  window_minutes: number;
  samples: string[];
  bot_likelihood: number; // 0-100
}

export interface ManipulationSignal {
  id: string;
  type: ManipulationType;
  symbol: string;
  exchange: string;              // which exchange detected this signal
  confidence: number;
  phase: PumpPhase;
  shill_activity: ShillActivity[];
  total_shill_accounts: number;
  price_at_detection: number;
  volume_24h: number;
  volume_spike_ratio: number;
  price_velocity: number;
  reasoning: string;
  estimated_peak_minutes: number | null;
  detected_at: string;
  source: 'x_scan' | 'telegram_cluster' | 'trending_anomaly' | 'combined' | 'goplus' | 'defi_llama' | 'rss_alert' | 'orderbook_spoof';
}

// ── Position Management ─────────────────────────────────────────

export interface HunterPosition {
  id: string;
  symbol: string;
  exchange: string;              // which exchange this position is on
  entry_price: number;
  current_price: number;
  size_usd: number;
  quantity: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  signal: ManipulationSignal;
  price_history: PriceTick[];
  trailing_high: number;
  trailing_active: boolean;
  entered_at: string;
  exit_reason: ExitReason | null;
  exit_price: number | null;
  exited_at: string | null;
}

export interface PriceTick {
  price: number;
  timestamp: number; // Unix ms
  volume: number;
}

export type ExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'dump_velocity'
  | 'volume_reversal'
  | 'max_hold_time'
  | 'shill_drop'
  | 'manual';

// ── Scanner Results ─────────────────────────────────────────────

export interface XScanResult {
  signals: ManipulationSignal[];
  model: string;
  tokens_used: number;
  scanned_at: string;
}

export interface TelegramClusterResult {
  symbol: string;
  channel_count: number;
  window_minutes: number;
  signals: Array<{
    channel: string;
    action: string;
    entry: number | null;
    timestamp: string;
  }>;
}

// ── New Scanner Result Types ────────────────────────────────────

export interface GoPlusTokenSecurity {
  contract: string;
  chain: 'eth' | 'bsc';
  is_honeypot: boolean;
  is_mintable: boolean;
  sell_tax: number;      // 0-100%
  buy_tax: number;       // 0-100%
  holder_count: number;
  lp_holder_count: number;
  is_open_source: boolean;
  risk_score: number;    // 0-100, higher = riskier
  checked_at: string;
}

export interface DefiLlamaHack {
  id: string;
  name: string;           // Protocol name
  chains: string[];
  amount: number;         // USD lost
  technique: string;
  date: string;           // ISO date
  symbols: string[];      // Extracted affected symbols
}

export interface RSSAlert {
  feedName: string;       // Which feed it came from
  title: string;
  link: string;
  published: string;
  category: 'exploit' | 'enforcement' | 'vulnerability' | 'scam' | 'general';
  symbols: string[];      // Extracted from title/description
  severity: 'high' | 'medium' | 'low';
}

export interface SpoofDetection {
  symbol: string;
  side: 'bid' | 'ask';
  wall_size_usd: number;
  wall_price: number;
  disappeared_pct: number;  // How much of the wall vanished (0-100)
  snapshot_interval_ms: number;
  detected_at: string;
}

// ── Agent State ─────────────────────────────────────────────────

export interface HuntrixState {
  status: 'scanning' | 'hunting' | 'in_position' | 'cooldown' | 'paused' | 'stopped';
  positions: HunterPosition[];
  recent_trades: HunterPosition[];
  active_signals: ManipulationSignal[];
  daily_pnl: number;
  trades_today: number;
  win_rate: number;
  paper_mode: boolean;
  virtual_balance: number;
  last_scan_at: string | null;
  consecutive_losses: number;
  updated_at: string;
}

// ── Config ──────────────────────────────────────────────────────

export interface HuntrixConfig {
  general: {
    name: string;
    description: string;
    mode: 'paper' | 'live';
    capital: number;
    currency: string;
  };
  scanner: {
    grok_model: string;
    manipulation_keywords: string[];
    min_shill_accounts: number;
    min_coordination_score: number;
    min_channels_for_cluster: number;
    cluster_window_minutes: number;
    sources: {
      goplus_enabled: boolean;
      goplus_fail_closed: boolean;
      defi_llama_enabled: boolean;
      rss_enabled: boolean;
      orderbook_spoof_enabled: boolean;
      rss_poll_interval_minutes: number;
    };
  };
  detection: {
    min_volume_spike_multiplier: number;
    max_entry_velocity_pct_per_min: number;
    min_entry_velocity_pct_per_min: number;
    max_already_pumped_pct: number;
    max_spread_pct: number;
    phase_window_minutes: number;
  };
  capital: {
    max_position_size_usd: number;
    virtual_balance: number;
  };
  limits: {
    max_open_positions: number;
    max_trades_per_day: number;
  };
  risk: {
    max_daily_loss_pct: number;
    max_consecutive_losses: number;
    consecutive_loss_cooldown_minutes: number;
    review_threshold_trades: number;
    review_min_win_rate: number;
  };
  exits: {
    stop_loss_pct: number;
    take_profit_pct: number;
    trailing_stop_pct: number;
    trailing_activation_pct: number;
    max_hold_minutes: number;
    dump_velocity_exit_pct_per_min: number;
    volume_reversal_checks: number;
    shill_drop_tighten_pct: number;
    shill_tightened_trailing_pct: number;
  };
  timing: {
    scan_interval_ms: number;
    price_check_ms: number;
    velocity_window_seconds: number;
    shill_recheck_ms: number;
  };
  telegram: {
    enabled: boolean;
    alert_on_detection: boolean;
    alert_on_entry: boolean;
    alert_on_exit: boolean;
    alert_on_circuit_breaker: boolean;
  };
  brain: HuntrixBrainConfig;
  exchanges: ExchangeConfig[];
}

// ── Brain ──────────────────────────────────────────────────────

export interface BrainAction {
  type: 'adjust_param' | 'force_exit' | 'restart_runner';
  param?: string;       // dot-path e.g. 'exits.stop_loss_pct'
  old_value?: number;
  new_value?: number;
  symbol?: string;      // for force_exit
  reasoning: string;
}

export interface HuntrixBrainConfig {
  enabled: boolean;
  cooldown_minutes: number;
  scheduled_hours: number[];
  acute_consecutive_losses: number;
  acute_daily_loss_pct: number;
}

// ── Multi-Exchange ────────────────────────────────────────────────

export interface ExchangeConfig {
  id: string;                      // CCXT exchange id: 'binance', 'bybit', 'mexc'
  enabled: boolean;
  role: 'scan' | 'trade' | 'scan+trade';
  api_key_env: string;             // env var name, NOT the actual key
  secret_env: string;
  password_env?: string;           // OKX, KuCoin, Bitget require passphrase
  priority: number;                // 1 = highest (prefer for execution)
}

// ── Pump Profiling ────────────────────────────────────────────────

export interface PumpProfile {
  id: string;
  symbol: string;
  exchange: string;
  detected_at: number;
  detection_phase: PumpPhase;
  source: ManipulationSignal['source'];
  price_at_detection: number;
  peak_price: number;
  peak_minutes: number;
  dump_start_price: number;
  duration_minutes: number;
  dump_velocity_pct_per_min: number;
  volume_spike_ratio: number;
  was_traded: boolean;
  pnl_pct: number | null;
}

export interface PumpStats {
  exchange: string;
  median_peak_minutes: number;
  median_duration_minutes: number;
  median_dump_velocity: number;
  sample_count: number;
}
