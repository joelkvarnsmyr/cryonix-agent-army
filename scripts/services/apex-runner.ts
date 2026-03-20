/**
 * APEX Agent Runner
 *
 * Starts the APEX meta-intelligence confluence trader.
 * Run with: npx tsx scripts/services/apex-runner.ts
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

import { ApexAgent } from '../../packages/agents/src/apex/apex-agent';
import { loadApexConfig } from '../../packages/agents/src/apex/config';

async function main() {
    console.log('===========================================');
    console.log('  APEX — Adaptive Profit EXtraction');
    console.log('  Meta-Intelligence Confluence Trader');
    console.log('===========================================\n');

    const config = loadApexConfig();
    console.log(`[APEX] Mode: ${config.general.mode}`);
    console.log(`[APEX] Capital: $${config.general.capital} ${config.general.currency}`);
    console.log(`[APEX] Scan interval: ${config.general.scan_interval_seconds}s`);
    console.log(`[APEX] Confluence thresholds: full=${config.confluence.min_score_full_kelly}, half=${config.confluence.min_score_half_kelly}`);
    console.log(`[APEX] Max positions: ${config.risk.max_concurrent_positions}`);
    console.log(`[APEX] Modes: venus_rx=${config.modes.venus_rx.enabled}, dip_sniper=${config.modes.dip_sniper.enabled}, confluence=${config.modes.confluence.enabled}`);
    console.log();

    const agent = new ApexAgent({
        id: 'apex',
        name: 'APEX',
    });

    const shutdown = async (signal: string) => {
        console.log(`\n[${signal}] Shutting down APEX...`);
        await agent.stop();
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await agent.initialize();
    await agent.start(); // blocking loop
}

main().catch((err) => {
    console.error('[APEX] Fatal error:', err);
    process.exit(1);
});
