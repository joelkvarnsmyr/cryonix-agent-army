/**
 * Huntrix Agent Runner
 *
 * Starts the Huntrix manipulation detection & ride trader.
 * Run with: npx tsx scripts/services/huntrix-runner.ts
 *
 * Required env vars:
 *   KV_URL              — Redis URL for state management
 *   BINANCE_API_KEY     — Binance API key (for price data)
 *   BINANCE_API_SECRET  — Binance API secret
 *   XAI_API_KEY         — Grok API key for AI validation
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { HuntrixAgent } from '../../packages/agents/src/huntrix/huntrix-agent';
import { loadHuntrixConfig } from '../../packages/agents/src/huntrix/config';

async function main() {
    console.log('===========================================');
    console.log('  HUNTRIX — Manipulation Detection & Ride Trader');
    console.log('===========================================\n');

    const config = loadHuntrixConfig();
    console.log(`[HUNTRIX] Mode: ${config.general.mode}`);
    console.log(`[HUNTRIX] Capital: $${config.general.capital} ${config.general.currency}`);
    console.log(`[HUNTRIX] Max position: $${config.capital.max_position_size_usd}`);
    console.log(`[HUNTRIX] Max positions: ${config.limits.max_open_positions}`);
    console.log(`[HUNTRIX] Scan interval: ${config.timing.scan_interval_ms}ms`);
    console.log(`[HUNTRIX] Grok model: ${config.scanner.grok_model}`);
    console.log(`[HUNTRIX] SL: ${config.exits.stop_loss_pct}% / TP: ${config.exits.take_profit_pct}%`);
    console.log(`[HUNTRIX] Dump velocity exit: ${config.exits.dump_velocity_exit_pct_per_min}%/min`);
    console.log(`[HUNTRIX] Max hold: ${config.exits.max_hold_minutes}min`);
    console.log();

    const agent = new HuntrixAgent({
        id: 'huntrix',
        name: 'Huntrix',
    });

    const shutdown = async (signal: string) => {
        console.log(`\n[${signal}] Shutting down Huntrix...`);
        await agent.stop();
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await agent.initialize();
    await agent.start(); // blocking loop
}

main().catch((err) => {
    console.error('[HUNTRIX] Fatal error:', err);
    process.exit(1);
});
