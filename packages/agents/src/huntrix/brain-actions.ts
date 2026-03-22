// packages/agents/src/huntrix/brain-actions.ts
// Validates and applies Brain actions against safety bounds

import { readFileSync, writeFileSync } from 'fs';
import { parse, stringify } from '@iarna/toml';
import type { BrainAction } from './types';

// ── Safety Bounds ────────────────────────────────────────────────────────
export const PARAM_BOUNDS: Record<string, { min: number; max: number }> = {
  'exits.stop_loss_pct':                  { min: 1.0, max: 8.0 },
  'exits.take_profit_pct':                { min: 5.0, max: 30.0 },
  'exits.trailing_stop_pct':              { min: 2.0, max: 10.0 },
  'exits.trailing_activation_pct':        { min: 1.0, max: 5.0 },
  'exits.max_hold_minutes':               { min: 10,  max: 60 },
  'exits.dump_velocity_exit_pct_per_min': { min: 1.0, max: 5.0 },
  'exits.volume_reversal_checks':         { min: 2,   max: 5 },
  'exits.shill_drop_tighten_pct':         { min: 30.0, max: 70.0 },
  'exits.shill_tightened_trailing_pct':   { min: 1.0, max: 4.0 },
  'detection.min_volume_spike_multiplier':   { min: 2.0, max: 10.0 },
  'detection.max_entry_velocity_pct_per_min': { min: 5.0, max: 20.0 },
  'detection.min_entry_velocity_pct_per_min': { min: 0.5, max: 3.0 },
  'detection.max_already_pumped_pct':        { min: 10.0, max: 40.0 },
  'detection.max_spread_pct':                { min: 0.3, max: 1.0 },
  'scanner.min_shill_accounts':      { min: 3,   max: 10 },
  'scanner.min_coordination_score':  { min: 40,  max: 80 },
  'capital.max_position_size_usd':   { min: 10,  max: 50 },
  'limits.max_trades_per_day':       { min: 2,   max: 10 },
  'risk.max_daily_loss_pct':         { min: 5.0, max: 25.0 },
};

const FROZEN_PREFIXES = ['general.', 'timing.', 'telegram.', 'scanner.sources.', 'brain.'];
const FROZEN_KEYS = ['detection.phase_window_minutes'];

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateAction(action: BrainAction): ValidationResult {
  if (action.type === 'force_exit') {
    if (!action.symbol) return { valid: false, reason: 'force_exit requires symbol' };
    return { valid: true };
  }
  if (action.type === 'restart_runner') {
    return { valid: true };
  }
  if (action.type === 'adjust_param') {
    const param = action.param;
    if (!param) return { valid: false, reason: 'adjust_param requires param path' };
    if (action.new_value === undefined) return { valid: false, reason: 'adjust_param requires new_value' };

    // Frozen check
    if (FROZEN_PREFIXES.some(p => param.startsWith(p))) {
      return { valid: false, reason: `${param} is frozen — brain cannot modify it` };
    }
    if (FROZEN_KEYS.includes(param)) {
      return { valid: false, reason: `${param} is frozen — brain cannot modify it` };
    }

    // Bounds check
    const bounds = PARAM_BOUNDS[param];
    if (!bounds) return { valid: false, reason: `${param} is not in the adjustable parameters list` };
    if (action.new_value < bounds.min || action.new_value > bounds.max) {
      return { valid: false, reason: `${param} value ${action.new_value} outside bounds [${bounds.min}, ${bounds.max}]` };
    }
    return { valid: true };
  }
  return { valid: false, reason: `Unknown action type: ${action.type}` };
}

/**
 * Apply a validated adjust_param action to huntrix.toml.
 * Returns true if the file was modified.
 */
export function applyParamChange(tomlPath: string, param: string, newValue: number): boolean {
  const raw = readFileSync(tomlPath, 'utf-8');
  const doc = parse(raw) as any;

  const [section, key] = param.split('.');
  if (!doc[section] || doc[section][key] === undefined) {
    console.warn(`[brain-actions] Parameter ${param} not found in TOML`);
    return false;
  }
  if (doc[section][key] === newValue) return false; // no change needed

  doc[section][key] = newValue;
  writeFileSync(tomlPath, stringify(doc));
  return true;
}
