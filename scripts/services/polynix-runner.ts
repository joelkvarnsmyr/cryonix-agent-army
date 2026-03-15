/**
 * Polynix Agent Runner
 *
 * Starts the Polymarket 5-minute binary options trading agent.
 * Run with: npx tsx scripts/services/polynix-runner.ts
 *
 * Required env vars:
 *   KV_URL — Redis URL for state publishing (optional but recommended)
 *
 * No API keys needed for Phase 1 (paper trading, public APIs only).
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { PolynixAgent } from '../../packages/agents/src/polynix/polynix-agent';
import { loadPolynixConfig } from '../../packages/agents/src/polynix/config';

async function main() {
    console.log('===========================================');
    console.log('  Polynix — Polymarket Binary Options Agent');
    console.log('===========================================\n');

    const config = loadPolynixConfig();

    console.log(`Paper trading:    ${config.broker.paper_trading}`);
    console.log(`Starting balance: $${config.capital.starting_balance_usd}`);
    console.log(`Max bet size:     $${config.capital.max_bet_size_usd}`);
    console.log(`Max positions:    ${config.capital.max_concurrent_positions}`);
    console.log(`Arb threshold:    ${config.strategy.arb_threshold}`);
    console.log(`Min edge:         ${config.strategy.min_edge_pct}%`);
    console.log(`Scan interval:    ${config.timing.scan_interval_ms}ms`);
    console.log(`Fee rate:         ${(config.risk.fee_rate * 100).toFixed(2)}%`);
    console.log(`Binance symbols:  ${config.data_sources.binance_symbols.join(', ')}`);
    console.log('');

    if (config.broker.paper_trading) {
        console.log('[PAPER MODE] All trades are simulated. No real capital at risk.');
        console.log('');
    }

    const agent = new PolynixAgent({
        id: 'polynix' as any,
        name: 'Polynix',
        description: 'Polymarket 5-min binary options agent',
        enabled: true,
    });

    const shutdown = async (signal: string) => {
        console.log(`\n[${signal}] Shutting down Polynix agent...`);
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
