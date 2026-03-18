import { readFileSync, existsSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';

export interface CopynixTomlConfig {
    broker: { paper_trading: boolean };
    wallets: { tracked: string[]; max_tracked: number; discovery_enabled: boolean; discovery_interval_hours: number; scores: Record<string, number> };
    consensus: { min_wallets_strong: number; min_wallets_medium: number; time_window_minutes: number; cooldown_hours: number };
    capital: { max_position_size_usd: number; max_capital_per_trade_pct: number; min_order_value: number; max_portfolio_exposure_pct: number; max_risk_per_trade_pct: number };
    limits: { max_open_positions: number; max_trades_per_day: number };
    risk: { min_confidence: number; max_daily_loss_pct: number; max_weekly_loss_pct: number; max_consecutive_losses: number };
    safety: { min_token_age_hours: number; min_liquidity_usd: number; min_holders: number; min_lp_burnt_pct: number; require_immutable_supply: boolean };
    exits: {
        take_profit_pct: number;
        rug_sl_pct: number;
        rug_window_minutes: number;
        standard_sl_pct: number;
        wide_sl_pct: number;
        wide_sl_after_minutes: number;
        trailing_stop_pct: number;
        trailing_activation_pct: number;
        leader_exit_enabled: boolean;
        leader_exit_timeout_s: number;
        stagnation_timeout_hours: number;
        stagnation_min_pnl_pct: number;
    };
    timing: { poll_interval_ms: number; wallet_scan_interval_ms: number; discovery_interval_ms: number };
}

export const COPYNIX_DEFAULTS: CopynixTomlConfig = {
    broker: { paper_trading: true },
    wallets: { tracked: [], max_tracked: 10, discovery_enabled: true, discovery_interval_hours: 24, scores: {} },
    consensus: { min_wallets_strong: 3, min_wallets_medium: 2, time_window_minutes: 15, cooldown_hours: 4 },
    capital: { max_position_size_usd: 50, max_capital_per_trade_pct: 0.20, min_order_value: 5.0, max_portfolio_exposure_pct: 0.20, max_risk_per_trade_pct: 0.02 },
    limits: { max_open_positions: 5, max_trades_per_day: 10 },
    risk: { min_confidence: 0.50, max_daily_loss_pct: 0.10, max_weekly_loss_pct: 0.20, max_consecutive_losses: 4 },
    safety: { min_token_age_hours: 24, min_liquidity_usd: 50_000, min_holders: 50, min_lp_burnt_pct: 50, require_immutable_supply: true },
    exits: {
        take_profit_pct: 25.0, rug_sl_pct: 15.0, rug_window_minutes: 2,
        standard_sl_pct: 25.0, wide_sl_pct: 35.0, wide_sl_after_minutes: 30,
        trailing_stop_pct: 12.0, trailing_activation_pct: 15.0,
        leader_exit_enabled: true, leader_exit_timeout_s: 60,
        stagnation_timeout_hours: 24, stagnation_min_pnl_pct: 3.0,
    },
    timing: { poll_interval_ms: 30_000, wallet_scan_interval_ms: 30_000, discovery_interval_ms: 604_800_000 },
};

export function loadCopynixConfig(filePath?: string): CopynixTomlConfig {
    const tomlPath = filePath ?? join(process.cwd(), 'copynix.toml');
    if (!existsSync(tomlPath)) return COPYNIX_DEFAULTS;
    try {
        const raw = readFileSync(tomlPath, 'utf-8');
        const parsed = parse(raw) as Partial<CopynixTomlConfig>;
        return {
            broker: { ...COPYNIX_DEFAULTS.broker, ...parsed.broker },
            wallets: { ...COPYNIX_DEFAULTS.wallets, ...parsed.wallets },
            consensus: { ...COPYNIX_DEFAULTS.consensus, ...parsed.consensus },
            capital: { ...COPYNIX_DEFAULTS.capital, ...parsed.capital },
            limits: { ...COPYNIX_DEFAULTS.limits, ...parsed.limits },
            risk: { ...COPYNIX_DEFAULTS.risk, ...parsed.risk },
            safety: { ...COPYNIX_DEFAULTS.safety, ...parsed.safety },
            exits: { ...COPYNIX_DEFAULTS.exits, ...parsed.exits },
            timing: { ...COPYNIX_DEFAULTS.timing, ...parsed.timing },
        };
    } catch {
        console.warn('[copynix] Failed to parse copynix.toml, using defaults');
        return COPYNIX_DEFAULTS;
    }
}
