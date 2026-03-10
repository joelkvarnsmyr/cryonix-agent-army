/**
 * Smoke Test: Verify Alpaca Paper Trading Connection
 * 
 * Run with: npx tsx apps/aktienix/test-alpaca.ts
 * 
 * This script:
 * 1. Loads .env from apps/aktienix/.env
 * 2. Connects to Alpaca paper account
 * 3. Prints account state and positions
 * 4. Optionally places a tiny test order ($1 fractional AAPL)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment from apps/aktienix/.env
dotenv.config({ path: path.resolve(__dirname, '.env') });

import Alpaca from '@alpacahq/alpaca-trade-api';

async function main() {
    console.log('===========================================');
    console.log('  Aktienix – Alpaca Paper Account Smoke Test');
    console.log('===========================================\n');

    const apiKey = process.env.ALPACA_PAPER_API_KEY;
    const apiSecret = process.env.ALPACA_PAPER_API_SECRET;

    if (!apiKey || !apiSecret) {
        console.error('❌ ALPACA_PAPER_API_KEY and ALPACA_PAPER_API_SECRET must be set in apps/aktienix/.env');
        process.exit(1);
    }

    const alpaca = new (Alpaca as any)({
        keyId: apiKey,
        secretKey: apiSecret,
        paper: true,
    });

    // 1. Account Info
    console.log('📡 Fetching account info...');
    try {
        const account = await alpaca.getAccount();
        console.log(`✅ Account Status: ${account.status}`);
        console.log(`   Account ID:     ${account.id}`);
        console.log(`   Portfolio Value: $${parseFloat(account.portfolio_value).toFixed(2)}`);
        console.log(`   Buying Power:    $${parseFloat(account.buying_power).toFixed(2)}`);
        console.log(`   Cash:            $${parseFloat(account.cash).toFixed(2)}`);
        console.log(`   PDT Flag:        ${account.pattern_day_trader}`);
        console.log('');
    } catch (error: any) {
        console.error(`❌ Failed to fetch account: ${error.message}`);
        process.exit(1);
    }

    // 2. Positions
    console.log('📊 Fetching positions...');
    try {
        const positions = await alpaca.getPositions();
        if (positions.length === 0) {
            console.log('   (No open positions)');
        } else {
            for (const pos of positions) {
                console.log(`   📈 ${pos.symbol}: ${pos.qty} shares @ $${parseFloat(pos.avg_entry_price).toFixed(2)} | P/L: $${parseFloat(pos.unrealized_pl).toFixed(2)}`);
            }
        }
        console.log('');
    } catch (error: any) {
        console.error(`❌ Failed to fetch positions: ${error.message}`);
    }

    // 3. Test Order (Optional – uncomment to test)
    const PLACE_TEST_ORDER = process.argv.includes('--order');

    if (PLACE_TEST_ORDER) {
        console.log('🛒 Placing test order: BUY 1 share AAPL (market)...');
        try {
            const order = await alpaca.createOrder({
                symbol: 'AAPL',
                qty: 1,
                side: 'buy',
                type: 'market',
                time_in_force: 'day',
            });
            console.log(`✅ Order placed: ${order.id} — Status: ${order.status}`);
        } catch (error: any) {
            console.error(`❌ Order failed: ${error.message}`);
        }
    } else {
        console.log('💡 To place a test order, run: npx tsx apps/aktienix/test-alpaca.ts --order');
    }

    console.log('\n✅ Smoke test complete.');
}

main().catch(console.error);
