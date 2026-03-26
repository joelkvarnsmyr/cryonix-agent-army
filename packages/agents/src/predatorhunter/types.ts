/**
 * Predator Hunter — Type Definitions
 *
 * Types for the counter-exploitation trading agent that detects
 * manipulation campaigns and profits from early pump phases.
 */

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
  /** Platform where shill activity was detected */
  platform: 'x' | 'telegram' | 'discord' | 'reddit';
  /** Number of unique accounts pushing this token */
  account_count: number;
  /** How many mentions in the detection window */
  mention_count: number;
  /** Detection window in minutes */
  window_minutes: number;
  /** Sample messages/tweets detected */
  samples: string[];
  /** Are the accounts new/bot-like? */
  bot_likelihood: number; // 0-100
}

export interface ManipulationSignal {
  /** Unique signal ID */
  id: string;
  /** Detected manipulation type */
  type: ManipulationType;
  /** Trading pair (e.g. "SOL/USDC") */
  symbol: string;
  /** AI confidence that this is actual manipulation (0-100) */
  confidence: number;
  /** Estimated current pump phase */
  phase: PumpPhase;
  /** Shill activity data per platform */
  shill_activity: ShillActivity[];
  /** Total shill accounts across platforms */
  total_shill_accounts: number;
  /** Price when signal was detected */
  price_at_detection: number;
  /** 24h volume at detection */
  volume_24h: number;
  /** Volume spike ratio vs average */
  volume_spike_ratio: number;
  /** Current price velocity (%/min) */
  price_velocity: number;
  /** AI reasoning for the classification */
  reasoning: string;
  /** Estimated time to peak (minutes), null if unknown */
  estimated_peak_minutes: number | null;
  /** ISO timestamp */
  detected_at: string;
  /** Source that triggered the detection */
  source: 'x_scan' | 'telegram_cluster' | 'trending_anomaly' | 'combined';
}

// ── Position Management ─────────────────────────────────────────

export interface HunterPosition {
  /** Position ID */
  id: string;
  /** Trading pair */
  symbol: string;
  /** Entry price */
  entry_price: number;
  /** Current price */
  current_price: number;
  /** Position size in USDC */
  size_usd: number;
  /** Amount of base asset */
  quantity: number;
  /** Unrealized P&L in USDC */
  unrealized_pnl: number;
  /** Unrealized P&L percentage */
  unrealized_pnl_pct: number;
  /** reference to the manipulation signal that triggered entry */
  signal: ManipulationSignal;
  /** Price history for velocity tracking (last 60 data points) */
  price_history: PriceTick[];
  /** Trailing stop high watermark */
  trailing_high: number;
  /** Is trailing stop active? */
  trailing_active: boolean;
  /** ISO timestamp of entry */
  entered_at: string;
  /** How the position was exited (null if still open) */
  exit_reason: ExitReason | null;
  /** Exit price (null if still open) */
  exit_price: number | null;
  /** ISO timestamp of exit */
  exited_at: string | null;
}

export interface PriceTick {
  price: number;
  timestamp: number; // Unix ms
  volume: number;    // Trade volume in the tick
}

export type ExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'dump_velocity'       // Price dropped too fast
  | 'volume_reversal'     // Sell volume overtook buy volume
  | 'max_hold_time'       // Held too long (30 min cap)
  | 'shill_drop'          // Social activity collapsed
  | 'manual';             // Operator intervention

// ── Scanner Results ─────────────────────────────────────────────

export interface XScanResult {
  /** Symbols with detected manipulation */
  signals: ManipulationSignal[];
  /** Grok model used */
  model: string;
  /** Tokens consumed */
  tokens_used: number;
  /** ISO timestamp */
  scanned_at: string;
}

export interface TelegramClusterResult {
  /** Symbol being pushed by multiple channels */
  symbol: string;
  /** Number of distinct channels pushing this symbol */
  channel_count: number;
  /** Time window of the cluster (minutes) */
  window_minutes: number;
  /** Individual signals from each channel */
  signals: Array<{
    channel: string;
    action: string;
    entry: number | null;
    timestamp: string;
  }>;
}

// ── Agent State ─────────────────────────────────────────────────

export interface PredatorHunterState {
  /** Agent status */
  status: 'scanning' | 'hunting' | 'in_position' | 'cooldown' | 'paused' | 'stopped';
  /** Open positions */
  positions: HunterPosition[];
  /** Closed positions (last 24h for stats) */
  recent_trades: HunterPosition[];
  /** Active manipulation signals being watched */
  active_signals: ManipulationSignal[];
  /** Daily P&L */
  daily_pnl: number;
  /** Total trades today */
  trades_today: number;
  /** Win rate (recent trades) */
  win_rate: number;
  /** Paper trading mode? */
  paper_mode: boolean;
  /** Virtual balance (paper mode) */
  virtual_balance: number;
  /** Last scan timestamp */
  last_scan_at: string | null;
  /** Consecutive losses (for circuit breaker) */
  consecutive_losses: number;
  /** ISO timestamp of state update */
  updated_at: string;
}

// ── Config ──────────────────────────────────────────────────────

export interface PredatorHunterConfig {
  broker: {
    paper_trading: boolean;
  };
  scanner: {
    model: string;
    temperature: number;
    max_tokens: number;
    scan_interval_ms: number;
    min_shill_accounts: number;
    min_coordinated_mentions: number;
    coordination_window_minutes: number;
    pump_keywords: string[];
    known_pump_channels: string[];
  };
  detection: {
    min_volume_spike_ratio: number;
    min_price_velocity: number;
    max_price_velocity: number;
    max_already_pumped_pct: number;
    min_pnd_confidence: number;
    min_shill_confidence: number;
    min_whale_confidence: number;
    max_cmc_rank: number;
    max_spread_pct: number;
  };
  capital: {
    virtual_balance: number;
    max_position_size_usd: number;
    max_capital_per_trade_pct: number;
    min_order_value: number;
  };
  limits: {
    max_open_positions: number;
    max_trades_per_day: number;
    cooldown_after_loss_minutes: number;
  };
  risk: {
    max_daily_loss_pct: number;
    max_weekly_loss_pct: number;
    max_consecutive_losses: number;
  };
  exits: {
    sl_pct: number;
    tp_pct: number;
    trailing_stop_pct: number;
    trailing_activation_pct: number;
    dump_velocity_pct: number;
    dump_velocity_window_seconds: number;
    volume_reversal_checks: number;
    max_hold_minutes: number;
    shill_drop_threshold_pct: number;
    shill_drop_trailing_pct: number;
  };
  timing: {
    position_check_ms: number;
    api_timeout_ms: number;
    symbol_cooldown_minutes: number;
  };
}
