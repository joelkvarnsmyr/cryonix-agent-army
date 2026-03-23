/**
 * Alphanix Agent Runner
 *
 * Starts the multi-asset AI trading army from the monorepo root.
 * Run with: npx tsx scripts/services/alphanix-runner.ts
 *
 * Required env vars:
 *   BINANCE_API_KEY / BINANCE_API_SECRET  (crypto trading)
 *   KV_URL=redis://...                    (state + coordination)
 *   POSTGRES_URL=postgres://...           (trade history)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { AlphanixAgent } from '../../packages/agents/src/alphanix/alphanix-agent';
import { loadAlphanixConfig } from '../../packages/agents/src/alphanix/config';

async function main() {
  console.log('===========================================');
  console.log('  Alphanix — Multi-Asset AI Trading Army');
  console.log('===========================================\n');

  const toml = loadAlphanixConfig();
  const enabledPods = Object.entries(toml.pods).filter(([, p]) => p.enabled);

  console.log(`Capital:     $${toml.orchestrator.capital_total_usd}`);
  console.log(`Max pods:    ${toml.orchestrator.max_pods}`);
  console.log(`Active pods: ${enabledPods.map(([id]) => id).join(', ') || 'none'}`);
  console.log(`Swarm limit: ${toml.swarms.max_concurrent_workers} workers`);
  console.log('');

  const agent = new AlphanixAgent({
    id: 'orchestrator' as any,
    name: 'Alphanix',
    description: 'Multi-asset AI trading army',
    enabled: true,
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down Alphanix...`);
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
