#!/usr/bin/env npx tsx
/**
 * Huntrix Backtest Runner — Validate manipulation signal quality + exit logic.
 * Usage:
 *   npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol BTC/USDC --days 30
 *   npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol ETH/USDC --days 7 --exchange mexc --json
 *   npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol SOL/USDC --days 14 --pump-history profiles.json
 */

import { readFileSync } from 'fs';
import { HuntrixBacktester } from '../../packages/agents/src/huntrix/backtester';
import { SyntheticSignalGenerator } from '../../packages/agents/src/huntrix/synthetic-signal-generator';
import { loadHuntrixConfig } from '../../packages/agents/src/huntrix/config';
import type { OhlcvData } from '../../packages/agents/src/market-scout/pattern-detectors/pattern-detector.interface';
import type { PumpProfile } from '../../packages/agents/src/huntrix/types';

async function fetchOHLCV(exchange: any, symbol: string, timeframe: string, days: number): Promise<OhlcvData[]> {
    const barsPerDay: Record<string, number> = { '1m': 1440, '5m': 288, '15m': 96, '1h': 24 };
    const totalBars = (barsPerDay[timeframe] ?? 96) * days;
    const allCandles: OhlcvData[] = [];
    let since: number | undefined = Date.now() - days * 24 * 60 * 60 * 1000;

    console.log(`  Fetching ${totalBars} ${timeframe} candles for ${symbol}...`);

    while (allCandles.length < totalBars) {
        const batch = await exchange.fetchOHLCV(symbol, timeframe, since, 1000);
        if (!batch || batch.length === 0) break;

        for (const c of batch) {
            allCandles.push({
                timestamp: c[0],
                open: c[1],
                high: c[2],
                low: c[3],
                close: c[4],
                volume: c[5],
            });
        }

        since = batch[batch.length - 1][0] + 1;
        if (batch.length < 1000) break;
    }

    console.log(`  Got ${allCandles.length} candles`);
    return allCandles;
}

async function main() {
    const args = process.argv.slice(2);
    const getArg = (flag: string, def: string) => {
        const idx = args.indexOf(flag);
        return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
    };

    const symbols = getArg('--symbol', 'BTC/USDC').split(',');
    const days = parseInt(getArg('--days', '30'));
    const exchangeId = getArg('--exchange', 'binance');
    const configPath = getArg('--config', undefined as any);
    const pumpHistoryPath = args.includes('--pump-history') ? getArg('--pump-history', '') : null;
    const jsonOutput = args.includes('--json');

    console.log(`\n  Huntrix Backtest — ${symbols.join(', ')} — ${days} days — ${exchangeId}\n`);

    // Load config
    const config = loadHuntrixConfig(configPath);

    // Load pump history if provided
    let pumpProfiles: PumpProfile[] | undefined;
    if (pumpHistoryPath) {
        try {
            pumpProfiles = JSON.parse(readFileSync(pumpHistoryPath, 'utf-8'));
            console.log(`  Loaded ${pumpProfiles!.length} pump profiles for calibration`);
        } catch (err) {
            console.warn(`  Warning: Could not load pump history: ${err}`);
        }
    }

    // Init CCXT exchange
    const ccxt = await import('ccxt');
    const ExchangeClass = (ccxt as any)[exchangeId] ?? (ccxt as any).default?.[exchangeId];
    if (!ExchangeClass) {
        console.error(`  Exchange "${exchangeId}" not found in CCXT`);
        process.exit(1);
    }
    const exchange = new ExchangeClass({ enableRateLimit: true });

    const gen = new SyntheticSignalGenerator(config.detection, config.timing.velocity_window_seconds);
    const bt = new HuntrixBacktester(config);

    for (const symbol of symbols) {
        console.log(`\n  ── ${symbol} ──────────────────────────────────`);

        // Fetch data
        const candles1m = await fetchOHLCV(exchange, symbol, '1m', days);
        const candles15m = await fetchOHLCV(exchange, symbol, '15m', days);

        if (candles1m.length < 100) {
            console.log('  Not enough 1m data — skipping');
            continue;
        }

        // Slide 15m window and generate signals
        const allSignals = [];
        const WINDOW_15M = 25;
        for (let i = WINDOW_15M; i < candles15m.length; i++) {
            const window15m = candles15m.slice(i - WINDOW_15M, i + 1);

            // Find corresponding 1m window (last 100 candles before this 15m bar)
            const end15mTs = candles15m[i].timestamp;
            const start1mIdx = candles1m.findIndex(c => c.timestamp >= end15mTs - 100 * 60_000);
            const end1mIdx = candles1m.findIndex(c => c.timestamp >= end15mTs);
            if (start1mIdx < 0 || end1mIdx < 0) continue;

            const window1m = candles1m.slice(start1mIdx, end1mIdx + 1);
            if (window1m.length < 10) continue;

            const signals = gen.scan(window15m, window1m, symbol);
            for (const s of signals) {
                allSignals.push({ signal: s, entryIdx: end1mIdx });
            }
        }

        console.log(`  Generated ${allSignals.length} synthetic signals`);

        if (allSignals.length === 0) {
            console.log('  No signals found — try more days or a more volatile pair');
            continue;
        }

        // Run backtest per signal (each with its own entry point)
        const approved = bt.filterSignals(allSignals.map(s => s.signal));
        console.log(`  Approved ${approved.length}/${allSignals.length} signals`);

        const allTrades = [];
        for (const { signal, entryIdx } of allSignals) {
            if (!approved.find(a => a.id === signal.id)) continue;
            const trades = bt.simulateExits([signal], candles1m, entryIdx);
            allTrades.push(...trades);
        }

        // Compute metrics from per-signal trades (correct entry offsets)
        const result = bt.computeMetrics(allTrades, allSignals.length, approved.length, pumpProfiles);

        if (jsonOutput) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log('  ═══════════════════════════════════════');
            console.log(`  Symbol:          ${symbol}`);
            console.log(`  Period:          ${days} days`);
            console.log(`  Signals:         ${allSignals.length} generated → ${approved.length} approved`);
            console.log(`  Total Trades:    ${allTrades.length}`);
            console.log(`  Win Rate:        ${(result.winRate * 100).toFixed(1)}% (${result.wins}W / ${result.losses}L)`);
            console.log(`  Total PnL:       $${result.totalPnl.toFixed(2)}`);
            console.log(`  Max Drawdown:    ${result.maxDrawdownPct.toFixed(2)}%`);
            console.log(`  Sharpe Ratio:    ${result.sharpeRatio.toFixed(3)}`);
            console.log(`  Avg Hold:        ${result.avgHoldMinutes.toFixed(1)} min`);
            console.log(`  Exit Breakdown:  ${JSON.stringify(result.exitBreakdown)}`);

            if (result.calibration) {
                console.log(`  Calibration:     P=${(result.calibration.precision * 100).toFixed(0)}% R=${(result.calibration.recall * 100).toFixed(0)}%`);
            }
            console.log('  ═══════════════════════════════════════');

            if (allTrades.length > 0) {
                console.log('\n  Recent trades:');
                for (const t of allTrades.slice(-10)) {
                    const marker = t.pnl >= 0 ? '+' : '-';
                    console.log(`    ${marker} $${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${t.exitReason} | ${t.holdMinutes.toFixed(0)}min | PnL: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%)`);
                }
            }
        }
    }
}

main().catch(err => { console.error('Backtest failed:', err); process.exit(1); });
