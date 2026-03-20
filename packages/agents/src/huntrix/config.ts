import { readFileSync, existsSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';
import type { HuntrixConfig } from './types';

export type { HuntrixConfig };

export const HUNTRIX_DEFAULTS: HuntrixConfig = {
  general: {
    name: 'Huntrix',
    description: 'Manipulation Detection & Ride Trader',
    mode: 'paper',
    capital: 100.0,
    currency: 'USDC',
  },
  scanner: {
    grok_model: 'grok-3-mini',
    manipulation_keywords: [
      'pump', '100x', 'moon', 'gem', 'alpha call',
      'next big', 'load up', 'accumulate',
    ],
    min_shill_accounts: 5,
    min_coordination_score: 60,
    min_channels_for_cluster: 3,
    cluster_window_minutes: 5,
  },
  detection: {
    min_volume_spike_multiplier: 3.0,
    max_entry_velocity_pct_per_min: 10.0,
    min_entry_velocity_pct_per_min: 1.0,
    max_already_pumped_pct: 20.0,
    max_spread_pct: 0.5,
    phase_window_minutes: 60,
  },
  capital: {
    max_position_size_usd: 25.0,
    virtual_balance: 100.0,
  },
  limits: {
    max_open_positions: 2,
    max_trades_per_day: 5,
  },
  risk: {
    max_daily_loss_pct: 15.0,
    max_consecutive_losses: 3,
    consecutive_loss_cooldown_minutes: 60,
    review_threshold_trades: 20,
    review_min_win_rate: 30.0,
  },
  exits: {
    stop_loss_pct: 3.0,
    take_profit_pct: 15.0,
    trailing_stop_pct: 5.0,
    trailing_activation_pct: 2.0,
    max_hold_minutes: 30,
    dump_velocity_exit_pct_per_min: 2.0,
    volume_reversal_checks: 3,
    shill_drop_tighten_pct: 50.0,
    shill_tightened_trailing_pct: 2.0,
  },
  timing: {
    scan_interval_ms: 120_000,
    price_check_ms: 5_000,
    velocity_window_seconds: 60,
    shill_recheck_ms: 60_000,
  },
  telegram: {
    enabled: true,
    alert_on_detection: true,
    alert_on_entry: true,
    alert_on_exit: true,
    alert_on_circuit_breaker: true,
  },
};

export function loadHuntrixConfig(filePath?: string): HuntrixConfig {
  const tomlPath = filePath ?? join(process.cwd(), 'huntrix.toml');
  if (!existsSync(tomlPath)) return HUNTRIX_DEFAULTS;
  try {
    const raw = readFileSync(tomlPath, 'utf-8');
    const parsed = parse(raw) as Partial<HuntrixConfig>;
    return {
      general: { ...HUNTRIX_DEFAULTS.general, ...parsed.general },
      scanner: { ...HUNTRIX_DEFAULTS.scanner, ...parsed.scanner },
      detection: { ...HUNTRIX_DEFAULTS.detection, ...parsed.detection },
      capital: { ...HUNTRIX_DEFAULTS.capital, ...parsed.capital },
      limits: { ...HUNTRIX_DEFAULTS.limits, ...parsed.limits },
      risk: { ...HUNTRIX_DEFAULTS.risk, ...parsed.risk },
      exits: { ...HUNTRIX_DEFAULTS.exits, ...parsed.exits },
      timing: { ...HUNTRIX_DEFAULTS.timing, ...parsed.timing },
      telegram: { ...HUNTRIX_DEFAULTS.telegram, ...parsed.telegram },
    };
  } catch {
    console.warn('[huntrix] Failed to parse huntrix.toml, using defaults');
    return HUNTRIX_DEFAULTS;
  }
}
