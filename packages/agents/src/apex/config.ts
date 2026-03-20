import { readFileSync, existsSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';

export interface ApexModeConfig {
    enabled: boolean;
    sizing_pct: number;
    tp_pct: number;
    sl_pct: number;
    trailing_pct: number;
    trailing_activation_pct: number;
    max_hold_hours: number;
}

export interface ApexTomlConfig {
    general: {
        name: string;
        description: string;
        mode: 'paper' | 'live';
        capital: number;
        currency: string;
        scan_interval_seconds: number;
    };
    confluence: {
        min_score_full_kelly: number;
        min_score_half_kelly: number;
        weights: {
            vedic_venus_rx: number;
            cryonix_deep_value: number;
            cryonix_dip_buy: number;
            copynix_single_whale: number;
            polymarket_sentiment_shift: number;
            cmc_extreme_fear: number;
            psinix_coherence: number;
            solanix_volume_spike: number;
            aktienix_macro_bullish: number;
            cmc_btc_dom_falling: number;
            // Bearish weights
            cryonix_rsi_overbought: number;
            cryonix_macd_bearish: number;
            polymarket_sentiment_falling: number;
            cmc_fear_greed_dropping: number;
            cmc_btc_dom_rising: number;
        };
        thresholds: {
            cryonix_min_confidence: number;
            copynix_min_whale_score: number;
            polymarket_min_delta: number;
            cmc_max_fear_greed: number;
            psinix_min_coherence: number;
            confluence_window_seconds: number;
        };
    };
    risk: {
        kelly_fraction: number;
        max_drawdown_pct: number;
        daily_loss_limit_pct: number;
        max_consecutive_losses: number;
        loss_reduction_factor: number;
        loss_reduction_trades: number;
        max_concurrent_positions: number;
        cash_reserve_pct: number;
    };
    modes: {
        venus_rx: ApexModeConfig & { leverage: number; max_leverage: number; symbols: string[] };
        dip_sniper: ApexModeConfig;
        confluence: ApexModeConfig;
    };
    telegram: {
        enabled: boolean;
        alert_on_entry: boolean;
        alert_on_exit: boolean;
        alert_on_circuit_breaker: boolean;
    };
}

export const APEX_DEFAULTS: ApexTomlConfig = {
    general: {
        name: 'APEX',
        description: 'Adaptive Profit EXtraction — Meta-Intelligence Trader',
        mode: 'paper',
        capital: 950.0,
        currency: 'USDC',
        scan_interval_seconds: 15,
    },
    confluence: {
        min_score_full_kelly: 60,
        min_score_half_kelly: 40,
        weights: {
            vedic_venus_rx: 40,
            cryonix_deep_value: 30,
            cryonix_dip_buy: 25,
            copynix_single_whale: 25,
            polymarket_sentiment_shift: 15,
            cmc_extreme_fear: 15,
            psinix_coherence: 10,
            solanix_volume_spike: 10,
            aktienix_macro_bullish: 5,
            cmc_btc_dom_falling: 5,
            cryonix_rsi_overbought: 20,
            cryonix_macd_bearish: 20,
            polymarket_sentiment_falling: 15,
            cmc_fear_greed_dropping: 10,
            cmc_btc_dom_rising: 10,
        },
        thresholds: {
            cryonix_min_confidence: 70,
            copynix_min_whale_score: 80,
            polymarket_min_delta: 20,
            cmc_max_fear_greed: 25,
            psinix_min_coherence: 0.7,
            confluence_window_seconds: 300,
        },
    },
    risk: {
        kelly_fraction: 0.25,
        max_drawdown_pct: 10.0,
        daily_loss_limit_pct: 5.0,
        max_consecutive_losses: 3,
        loss_reduction_factor: 0.5,
        loss_reduction_trades: 5,
        max_concurrent_positions: 3,
        cash_reserve_pct: 20.0,
    },
    modes: {
        venus_rx: {
            enabled: true,
            leverage: 2,
            max_leverage: 3,
            symbols: ['BTC/USDC', 'ETH/USDC', 'SOL/USDC', 'BNB/USDC'],
            sizing_pct: 24.0,
            tp_pct: 8.0,
            sl_pct: 3.0,
            trailing_pct: 3.0,
            trailing_activation_pct: 4.0,
            max_hold_hours: 360,
        },
        dip_sniper: {
            enabled: true,
            sizing_pct: 20.0,
            tp_pct: 5.0,
            sl_pct: 2.5,
            trailing_pct: 2.0,
            trailing_activation_pct: 2.5,
            max_hold_hours: 48,
        },
        confluence: {
            enabled: true,
            sizing_pct: 15.0,
            tp_pct: 6.0,
            sl_pct: 3.0,
            trailing_pct: 2.5,
            trailing_activation_pct: 3.0,
            max_hold_hours: 72,
        },
    },
    telegram: {
        enabled: true,
        alert_on_entry: true,
        alert_on_exit: true,
        alert_on_circuit_breaker: true,
    },
};

export function loadApexConfig(filePath?: string): ApexTomlConfig {
    const tomlPath = filePath ?? join(process.cwd(), 'apex.toml');
    if (!existsSync(tomlPath)) return APEX_DEFAULTS;
    try {
        const raw = readFileSync(tomlPath, 'utf-8');
        const parsed = parse(raw) as Partial<ApexTomlConfig>;
        return {
            general: { ...APEX_DEFAULTS.general, ...parsed.general },
            confluence: {
                ...APEX_DEFAULTS.confluence,
                ...parsed.confluence,
                weights: { ...APEX_DEFAULTS.confluence.weights, ...parsed.confluence?.weights },
                thresholds: { ...APEX_DEFAULTS.confluence.thresholds, ...parsed.confluence?.thresholds },
            },
            risk: { ...APEX_DEFAULTS.risk, ...parsed.risk },
            modes: {
                venus_rx: { ...APEX_DEFAULTS.modes.venus_rx, ...parsed.modes?.venus_rx },
                dip_sniper: { ...APEX_DEFAULTS.modes.dip_sniper, ...parsed.modes?.dip_sniper },
                confluence: { ...APEX_DEFAULTS.modes.confluence, ...parsed.modes?.confluence },
            },
            telegram: { ...APEX_DEFAULTS.telegram, ...parsed.telegram },
        };
    } catch {
        console.warn('[apex] Failed to parse apex.toml, using defaults');
        return APEX_DEFAULTS;
    }
}
