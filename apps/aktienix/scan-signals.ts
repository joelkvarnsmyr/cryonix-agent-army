/**
 * Live signal scan — runs StockSignalGenerator against Alpaca paper data.
 * Run with: npx tsx apps/aktienix/scan-signals.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '.env') });

import Alpaca from '@alpacahq/alpaca-trade-api';
import { StockSignalGenerator } from '../../packages/agents/src/aktienix/signals/stock-signal-generator';

async function main() {
    console.log('===========================================');
    console.log('  Aktienix — Live Signal Scan');
    console.log('===========================================\n');

    const alpaca = new (Alpaca as any)({
        keyId: process.env.ALPACA_PAPER_API_KEY,
        secretKey: process.env.ALPACA_PAPER_API_SECRET,
        paper: true,
    });

    // Check market clock
    const clock = await alpaca.getClock();
    console.log(`🕐 Market: ${clock.is_open ? '🟢 OPEN' : '🔴 CLOSED'}`);
    if (!clock.is_open) {
        console.log(`   Next open: ${new Date(clock.next_open).toLocaleString('sv-SE', { timeZone: 'America/New_York' })} ET`);
    }
    console.log('');

    const logger = {
        info: (msg: string) => console.log(`   ${msg}`),
        warn: (msg: string) => console.log(`   ⚠️  ${msg}`),
        error: (msg: string) => console.log(`   ❌ ${msg}`),
        debug: (_msg: string) => {},
    };

    const generator = new StockSignalGenerator(alpaca, logger as any, {
        symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'SPY', 'QQQ', 'JPM', 'JNJ'],
        timeframe: '1Day',
        barsCount: 220, // 200 required by calculateTechnicalIndicators + buffer for weekends
    });

    console.log('📡 Scanning 11 symbols for signals...\n');
    const signals = await generator.scan();

    if (signals.length === 0) {
        console.log('📭 No actionable signals at this time (all WAIT).\n');
    } else {
        console.log(`\n🎯 ${signals.length} actionable signal(s) found:\n`);
        for (const s of signals) {
            const confPct = (s.confidence * 100).toFixed(0);
            const action = s.action === 'BUY' ? '🟢 BUY ' : '🔴 SELL';
            console.log(`${action}  ${s.symbol.padEnd(6)} conf=${confPct}%  price=$${s.currentPrice.toFixed(2)}`);
            console.log(`         Reasons: ${s.reasoning.join(' | ')}`);
            console.log(`         RSI=${s.indicators.rsi.toFixed(1)}  MACD=${s.indicators.macd.toFixed(3)}  BB=${s.indicators.bollingerPosition}  Trend=${s.indicators.trend}(${(s.indicators.trendStrength*100).toFixed(0)}%)  Vol=${s.indicators.volumeState}`);
            console.log('');
        }
    }

    console.log('✅ Scan complete.');
}

main().catch(console.error);
