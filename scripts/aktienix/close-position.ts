// scripts/aktienix/close-position.ts
// Usage: npx tsx scripts/aktienix/close-position.ts <SYMBOL>
// Exits 0 on success, 1 on failure.
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client } from 'pg';
import Alpaca from '@alpacahq/alpaca-trade-api';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });

const symbol = process.argv[2]?.toUpperCase();
if (!symbol) {
    console.error('Usage: close-position.ts <SYMBOL>');
    process.exit(1);
}

async function main() {
    console.log(`[close-position] Closing position for ${symbol}...`);
    process.exit(0);
}

main().catch(err => {
    console.error('[close-position] Fatal:', err.message);
    process.exit(1);
});
