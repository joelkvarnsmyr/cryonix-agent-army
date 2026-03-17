/**
 * Ψnix Agent Runner — Phase Convergence Trading
 *
 * Run with: npx tsx scripts/services/psinix-runner.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { PsinixAgent } from '../../packages/agents/src/psinix/psinix-agent';

async function main() {
    console.log('===========================================');
    console.log('  Ψnix — Phase Convergence Trading Agent');
    console.log('===========================================');
    console.log('');
    console.log('  Ψ(t) = tanh(β·C·Σwᵢσᵢ) × Kelly × C²');
    console.log('');
    console.log('  Kuramoto order parameter + Shannon entropy');
    console.log('  + Bayesian posteriors = phase transition trading');
    console.log('');

    const agent = new PsinixAgent();

    const shutdown = async (signal: string) => {
        console.log(`\n[${signal}] Shutting down Ψnix agent...`);
        await agent.stop();
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await agent.initialize();
    await agent.start();
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
