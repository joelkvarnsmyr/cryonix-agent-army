/**
 * Copynix Agent Runner
 *
 * Starts the Solana copy-trading agent from the monorepo root.
 * Run with: npx tsx scripts/services/copynix-runner.ts
 *
 * Required env vars:
 *   HELIUS_API_KEY      — Helius API key for wallet monitoring
 *   KV_URL              — Redis URL for state publishing
 *
 * Optional env vars:
 *   BIRDEYE_API_KEY     — Birdeye API key for trader discovery
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { CopynixAgent } from '../../packages/agents/src/copynix/copynix-agent';
import { loadCopynixConfig } from '../../packages/agents/src/copynix/config';

async function main() {
    console.log('===========================================');
    console.log('  Copynix — Solana Copy Trading Agent');
    console.log('===========================================\n');

    const toml = loadCopynixConfig();

    console.log(`Paper trading:    ${toml.broker.paper_trading}`);
    console.log(`Tracked wallets:  ${toml.wallets.tracked.length}`);
    console.log(`Max positions:    ${toml.limits.max_open_positions}`);
    console.log(`Max pos size:     $${toml.capital.max_position_size_usd}`);
    console.log(`Consensus:        ${toml.consensus.min_wallets_medium}+ wallets (medium), ${toml.consensus.min_wallets_strong}+ (strong)`);
    console.log(`Safety:           age>${toml.safety.min_token_age_hours}h, liq>$${toml.safety.min_liquidity_usd}, holders>${toml.safety.min_holders}`);
    console.log(`Helius API key:   ${process.env.HELIUS_API_KEY ? 'set' : 'NOT SET (using RPC fallback)'}`);
    console.log('');

    if (toml.broker.paper_trading) {
        console.log('[PAPER MODE] Virtual USDC balance: $500');
        console.log('');
    }

    if (toml.wallets.tracked.length === 0) {
        console.log('WARNING: No tracked wallets configured in copynix.toml');
        console.log('Add wallet addresses to [wallets] tracked = [...] to start copy trading');
        console.log('');
    }

    const agent = new CopynixAgent({
        id: 'copynix' as any,
        name: 'Copynix',
        description: 'Solana copy-trading agent',
        enabled: true,
    });

    const shutdown = async (signal: string) => {
        console.log(`\n[${signal}] Shutting down Copynix agent...`);
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
