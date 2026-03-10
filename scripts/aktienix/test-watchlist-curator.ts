// scripts/aktienix/test-watchlist-curator.ts
// Run: npx tsx scripts/aktienix/test-watchlist-curator.ts
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });

import Alpaca from '@alpacahq/alpaca-trade-api';
import { WatchlistCurator } from '../../packages/agents/src/aktienix/watchlist-curator';

const FALLBACK = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA'];

async function main() {
    console.log('=== WatchlistCurator Smoke Test ===\n');

    const alpaca = new (Alpaca as any)({
        keyId: process.env.ALPACA_PAPER_API_KEY,
        secretKey: process.env.ALPACA_PAPER_API_SECRET,
        paper: true,
    });

    const curator = new WatchlistCurator(
        alpaca,
        process.env.XAI_API_KEY ?? null,
        FALLBACK,
        { info: (msg: string) => console.log(msg) },
    );

    console.log('Running curate() with empty macro signals...\n');
    const symbols = await curator.curate([]);

    console.log(`\nResult: ${symbols.length} symbols`);
    console.log(symbols.join(', '));
    console.log('\nneedsRefresh() after curate:', curator.needsRefresh());
}

main().catch(console.error);
