/**
 * Aktienix Agent Runner
 *
 * Starts the stock trading agent from the monorepo root.
 * Run with: npx tsx scripts/services/aktienix-runner.ts
 *
 * Required env vars:
 *   ALPACA_PAPER_API_KEY / ALPACA_PAPER_API_SECRET  (paper trading)
 *   ALPACA_API_KEY / ALPACA_API_SECRET               (live trading)
 *   KV_URL=redis://...                               (state publishing)
 *   XAI_API_KEY=xai-...                              (macro intelligence, optional)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load root .env first, then apps/aktienix/.env as override
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });

import { AktienixAgent } from '../../packages/agents/src/aktienix/aktienix-agent';
import { loadAktienixConfig } from '../../packages/agents/src/aktienix/config';

async function main() {
    console.log('===========================================');
    console.log('  Aktienix — Stock Trading Agent');
    console.log('===========================================\n');

    const toml = loadAktienixConfig();

    console.log(`Broker:        ${toml.broker.provider}`);
    console.log(`Paper trading: ${toml.broker.paper_trading}`);
    console.log(`Account type:  ${toml.broker.account_type}`);
    console.log(`Watchlist:     ${toml.watchlist.symbols.join(', ')}`);
    console.log(`Intelligence:  ${toml.intelligence.enabled ? 'enabled' : 'disabled'}`);
    console.log('');

    const agent = new AktienixAgent({
        id: 'aktienix' as any,
        name: 'Aktienix',
        description: 'US stock trading agent',
        enabled: true,
        tradingConfig: {
            broker: toml.broker.provider,
            paperTrading: toml.broker.paper_trading,
            accountType: toml.broker.account_type,
            maxPositionSizeUsd: toml.capital.max_position_size_usd,
            intelligence: toml.intelligence,
        },
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
        console.log(`\n[${signal}] Shutting down Aktienix agent...`);
        await agent.stop();
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    await agent.initialize();
    await agent.start(); // blocking loop
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
