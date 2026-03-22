/**
 * TOML Config Validator — checks cryonix.toml, aktienix.toml, copynix.toml, apex.toml
 * for required sections, keys, and value ranges.
 *
 * Usage: npx tsx scripts/validate-toml.ts [file...]
 * If no files given, validates all known TOML configs.
 *
 * Exit code 0 = all valid, 1 = errors found.
 */

import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { join, basename as pathBasename } from 'path';

// Resolve @iarna/toml from apps/web where it's installed
const require = createRequire(join(process.cwd(), 'apps/web/node_modules/.pnpm/placeholder'));
const { parse } = require('@iarna/toml') as { parse: (s: string) => any };

interface Rule {
    path: string;        // dot-separated path: "risk.min_risk_reward"
    type: 'number' | 'string' | 'boolean' | 'array';
    min?: number;
    max?: number;
    required?: boolean;
}

// ── Cryonix rules ──────────────────────────────────────────
// Note: position/trade limits are under [limits], not [risk]
// Capital values are fractions (0-1), not percentages (0-100)
const CRYONIX_RULES: Rule[] = [
    { path: 'risk.min_confidence', type: 'number', min: 0.1, max: 1.0, required: true },
    { path: 'risk.min_risk_reward', type: 'number', min: 0.5, max: 5.0, required: true },
    { path: 'limits.max_open_positions', type: 'number', min: 1, max: 20, required: true },
    { path: 'limits.max_trades_per_day', type: 'number', min: 1, max: 50, required: true },
    { path: 'risk.max_daily_loss_pct', type: 'number', min: 0.01, max: 0.5, required: true },
    { path: 'exits.sl_atr_multiplier', type: 'number', min: 1.0, max: 20.0 },
    { path: 'exits.tp_atr_multiplier', type: 'number', min: 1.0, max: 30.0 },
    { path: 'exits.stagnation_timeout_hours', type: 'number', min: 1, max: 168 },
    { path: 'capital.signal_pool_pct', type: 'number', min: 0, max: 1.0 },
    { path: 'capital.reserve_pct', type: 'number', min: 0, max: 1.0 },
    { path: 'patterns.dip_focus_mode', type: 'boolean' },
    { path: 'coinmarketcap.enabled', type: 'boolean' },
];

// ── Aktienix rules ─────────────────────────────────────────
// Note: min_confidence is under [risk], not [signals]
const AKTIENIX_RULES: Rule[] = [
    { path: 'signals.min_signal_score', type: 'number', min: 0.05, max: 1.0, required: true },
    { path: 'risk.min_confidence', type: 'number', min: 0.1, max: 1.0, required: true },
    { path: 'exits.stop_loss_pct', type: 'number', min: 1.0, max: 20.0, required: true },
    { path: 'exits.take_profit_pct', type: 'number', min: 1.0, max: 50.0, required: true },
    { path: 'capital.max_position_size_usd', type: 'number', min: 100, max: 50000 },
    { path: 'watchlist.symbols', type: 'array', required: true },
];

// ── Apex rules ─────────────────────────────────────────────
const APEX_RULES: Rule[] = [
    { path: 'general.capital', type: 'number', min: 1, max: 100000, required: true },
    { path: 'general.scan_interval_seconds', type: 'number', min: 5, max: 300 },
    { path: 'confluence.min_score_full_kelly', type: 'number', min: 10, max: 100 },
    { path: 'confluence.min_score_half_kelly', type: 'number', min: 5, max: 100 },
    { path: 'risk.kelly_fraction', type: 'number', min: 0.01, max: 1.0, required: true },
    { path: 'risk.max_drawdown_pct', type: 'number', min: 1, max: 50 },
];

// ── Copynix rules ──────────────────────────────────────────
const COPYNIX_RULES: Rule[] = [
    { path: 'safety.min_token_age_hours', type: 'number', min: 0, max: 168 },
    { path: 'safety.min_liquidity_usd', type: 'number', min: 0, max: 1000000 },
    { path: 'safety.min_holders', type: 'number', min: 0, max: 10000 },
];

const CONFIG_MAP: Record<string, Rule[]> = {
    'cryonix.toml': CRYONIX_RULES,
    'aktienix.toml': AKTIENIX_RULES,
    'apex.toml': APEX_RULES,
    'copynix.toml': COPYNIX_RULES,
};

function getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((o, k) => o?.[k], obj);
}

function validate(filePath: string, rules: Rule[]): string[] {
    const errors: string[] = [];
    if (!existsSync(filePath)) {
        errors.push(`File not found: ${filePath}`);
        return errors;
    }

    let config: any;
    try {
        config = parse(readFileSync(filePath, 'utf-8'));
    } catch (e) {
        errors.push(`Parse error in ${filePath}: ${e instanceof Error ? e.message : e}`);
        return errors;
    }

    for (const rule of rules) {
        const val = getNestedValue(config, rule.path);

        if (val === undefined || val === null) {
            if (rule.required) errors.push(`${filePath}: missing required key "${rule.path}"`);
            continue;
        }

        if (rule.type === 'number' && typeof val === 'number') {
            if (rule.min !== undefined && val < rule.min)
                errors.push(`${filePath}: "${rule.path}" = ${val} is below minimum ${rule.min}`);
            if (rule.max !== undefined && val > rule.max)
                errors.push(`${filePath}: "${rule.path}" = ${val} exceeds maximum ${rule.max}`);
        } else if (rule.type === 'boolean' && typeof val !== 'boolean') {
            errors.push(`${filePath}: "${rule.path}" should be boolean, got ${typeof val}`);
        } else if (rule.type === 'array' && !Array.isArray(val)) {
            errors.push(`${filePath}: "${rule.path}" should be array, got ${typeof val}`);
        } else if (rule.type === 'string' && typeof val !== 'string') {
            errors.push(`${filePath}: "${rule.path}" should be string, got ${typeof val}`);
        }
    }

    return errors;
}

// ── Main ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const files = args.length > 0
    ? args
    : Object.keys(CONFIG_MAP).map(f => join(process.cwd(), f));

let totalErrors = 0;

for (const file of files) {
    const basename = pathBasename(file);
    const rules = CONFIG_MAP[basename];
    if (!rules) {
        console.warn(`  No rules defined for ${basename}, skipping`);
        continue;
    }

    const errors = validate(file, rules);
    if (errors.length === 0) {
        console.log(`  ${basename} -- valid`);
    } else {
        console.log(`  ${basename} -- ${errors.length} error(s):`);
        for (const err of errors) console.log(`   ${err}`);
        totalErrors += errors.length;
    }
}

process.exit(totalErrors > 0 ? 1 : 0);
