/**
 * Solanix Agent Runner
 *
 * Starts the Solana DEX trading agent from the monorepo root.
 * Run with: npx tsx scripts/services/solanix-runner.ts
 *
 * Required env vars:
 *   HELIUS_API_KEY      — Helius RPC API key
 *   SOLANA_RPC_URL      — Full RPC URL (auto-built from HELIUS_API_KEY if omitted)
 *   SOLANA_PRIVATE_KEY  — Base64 keypair (only needed for live mode)
 *   KV_URL              — Redis URL for state publishing
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { SolanaAgent } from '../../packages/agents/src/solanix/solanix-agent';
import { loadSolanixConfig } from '../../packages/agents/src/solanix/config';

async function main() {
    console.log('===========================================');
    console.log('  Solanix — Solana DEX Trading Agent');
    console.log('===========================================\n');

    const toml = loadSolanixConfig();

    console.log(`Paper trading: ${toml.broker.paper_trading}`);
    console.log(`Watchlist:     ${toml.watchlist.symbols.join(', ')}`);
    console.log(`Max positions: ${toml.limits.max_open_positions}`);
    console.log(`Max pos size:  $${toml.capital.max_position_size_usd}`);
    console.log(`DexScreener:   ${toml.signals.dexscreener_enabled ? 'enabled' : 'disabled'}`);
    console.log(`RPC URL:       ${process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'}`);
    console.log('');

    if (toml.broker.paper_trading) {
        const virtualCapital = toml.capital.max_position_size_usd * toml.limits.max_open_positions;
        console.log(`[PAPER MODE] Virtual USDC balance: $${virtualCapital}`);
        console.log('');
    }

    const agent = new SolanaAgent({
        id: 'solanix' as any,
        name: 'Solanix',
        description: 'Solana DEX trading agent',
        enabled: true,
    });

    const shutdown = async (signal: string) => {
        console.log(`\n[${signal}] Shutting down Solanix agent...`);
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
