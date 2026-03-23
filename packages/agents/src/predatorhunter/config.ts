import { readFileSync, existsSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';
import type { PredatorHunterConfig } from './types';

export const PREDATORHUNTER_DEFAULTS: PredatorHunterConfig = {
    broker: { paper_trading: true },
    scanner: {
        model: 'grok-4-1-fast-non-reasoning',
        temperature: 0.2,
        max_tokens: 1200,
        scan_interval_ms: 300_000,
        min_shill_accounts: 5,
        min_coordinated_mentions: 8,
        coordination_window_minutes: 15,
        pump_keywords: [
            '1000x', 'moonshot', 'undervalued gem', 'next 100x',
            'buy now before', 'get in early', 'easy money',
            'whale alert', 'insider info', 'about to pump',
        ],
        known_pump_channels: [],
    },
    detection: {
        min_volume_spike_ratio: 3.0,
        min_price_velocity: 1.0,
        max_price_velocity: 10.0,
        max_already_pumped_pct: 20.0,
        min_pnd_confidence: 70,
        min_shill_confidence: 65,
        min_whale_confidence: 75,
        max_cmc_rank: 500,
        max_spread_pct: 0.5,
    },
    capital: {
        virtual_balance: 100,
        max_position_size_usd: 25,
        max_capital_per_trade_pct: 0.25,
        min_order_value: 5.0,
    },
    limits: {
        max_open_positions: 2,
        max_trades_per_day: 5,
        cooldown_after_loss_minutes: 30,
    },
    risk: {
        max_daily_loss_pct: 0.15,
        max_weekly_loss_pct: 0.25,
        max_consecutive_losses: 3,
    },
    exits: {
        sl_pct: 5.0,
        tp_pct: 20.0,
        trailing_stop_pct: 5.0,
        trailing_activation_pct: 8.0,
        dump_velocity_pct: 3.0,
        dump_velocity_window_seconds: 60,
        volume_reversal_checks: 3,
        max_hold_minutes: 30,
        shill_drop_threshold_pct: 50.0,
        shill_drop_trailing_pct: 3.0,
    },
    timing: {
        position_check_ms: 5_000,
        api_timeout_ms: 10_000,
        symbol_cooldown_minutes: 60,
    },
};

export function loadPredatorHunterConfig(filePath?: string): PredatorHunterConfig {
    const tomlPath = filePath ?? join(process.cwd(), 'predatorhunter.toml');
    if (!existsSync(tomlPath)) return PREDATORHUNTER_DEFAULTS;
    try {
        const raw = readFileSync(tomlPath, 'utf-8');
        const parsed = parse(raw) as Partial<PredatorHunterConfig>;
        return {
            broker: { ...PREDATORHUNTER_DEFAULTS.broker, ...parsed.broker },
            scanner: { ...PREDATORHUNTER_DEFAULTS.scanner, ...parsed.scanner },
            detection: { ...PREDATORHUNTER_DEFAULTS.detection, ...parsed.detection },
            capital: { ...PREDATORHUNTER_DEFAULTS.capital, ...parsed.capital },
            limits: { ...PREDATORHUNTER_DEFAULTS.limits, ...parsed.limits },
            risk: { ...PREDATORHUNTER_DEFAULTS.risk, ...parsed.risk },
            exits: { ...PREDATORHUNTER_DEFAULTS.exits, ...parsed.exits },
            timing: { ...PREDATORHUNTER_DEFAULTS.timing, ...parsed.timing },
        };
    } catch {
        console.warn('[predatorhunter] Failed to parse predatorhunter.toml, using defaults');
        return PREDATORHUNTER_DEFAULTS;
    }
}
