/**
 * Predator Hunter Agent Runner
 *
 * Starts the counter-exploitation trading agent from the monorepo root.
 * Run with: npx tsx scripts/services/predatorhunter-runner.ts
 *
 * Required env vars:
 *   XAI_API_KEY         — xAI/Grok API key (for manipulation scanning)
 *   KV_URL              — Redis URL for state publishing
 *
 * Optional env vars (live trading only):
 *   BINANCE_API_KEY     — Binance API key
 *   BINANCE_API_SECRET  — Binance API secret
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { PredatorHunterAgent } from '../../packages/agents/src/predatorhunter/predatorhunter-agent';
import { loadPredatorHunterConfig } from '../../packages/agents/src/predatorhunter/config';

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  🎯 Predator Hunter — Counter-Exploitation');
    console.log('  Detects P&D campaigns and rides the wave');
    console.log('═══════════════════════════════════════════\n');

    const toml = loadPredatorHunterConfig();

    console.log(`Paper trading:    ${toml.broker.paper_trading}`);
    console.log(`Virtual balance:  $${toml.capital.virtual_balance}`);
    console.log(`Max position:     $${toml.capital.max_position_size_usd}`);
    console.log(`Max positions:    ${toml.limits.max_open_positions}`);
    console.log(`Scan interval:    ${toml.scanner.scan_interval_ms / 1000}s`);
    console.log(`Scanner model:    ${toml.scanner.model}`);
    console.log(`SL / TP:          ${toml.exits.sl_pct}% / ${toml.exits.tp_pct}%`);
    console.log(`Dump velocity:    ${toml.exits.dump_velocity_pct}% in ${toml.exits.dump_velocity_window_seconds}s`);
    console.log(`Max hold:         ${toml.exits.max_hold_minutes} min`);
    console.log('');

    if (toml.broker.paper_trading) {
        console.log('📝 PAPER MODE — no real trades will be executed');
        console.log('');
    }

    const agent = new PredatorHunterAgent({
        id: 'predatorhunter' as any,
        name: 'Predator Hunter',
        description: 'Counter-exploitation agent — detects and profits from manipulation campaigns',
        enabled: true,
    });

    const shutdown = async (signal: string) => {
        console.log(`\n[${signal}] Shutting down Predator Hunter...`);
        await agent.stop();
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await agent.initialize();
    await agent.start(); // blocking loop
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
