#!/usr/bin/env npx tsx
/**
 * Psinix Backtest Runner — Run phase convergence backtests on real data.
 * Usage:
 *   npx tsx scripts/strategy-lab/psinix_backtest.ts --symbol BTC/USDC --days 30
 *   npx tsx scripts/strategy-lab/psinix_backtest.ts --symbol ETH/USDC --days 90 --json
 *   npx tsx scripts/strategy-lab/psinix_backtest.ts --symbol BTC/USDC --days 30 --tf 1h
 */

import { PsinixBacktester, type BacktestConfig, type SignalSnapshot } from '../../packages/agents/src/psinix/backtester';

async function main() {
    const args = process.argv.slice(2);
    const symbol = args[args.indexOf('--symbol') + 1] ?? 'BTC/USDC';
    const days = parseInt(args[args.indexOf('--days') + 1] ?? '30');
    const jsonOutput = args.includes('--json');
    const tfIdx = args.indexOf('--tf');
    const timeframe = tfIdx >= 0 ? args[tfIdx + 1] : '15m';

    console.log(`\n  Psinix Backtest — ${symbol} — ${days} days — ${timeframe}\n`);

    // Fetch OHLCV via ccxt (public, no auth)
    const ccxt = await import('ccxt');
    const Binance = (ccxt as any).binance ?? (ccxt as any).default?.binance;
    const exchange = new Binance({ enableRateLimit: true });

    const barsPerDay: Record<string, number> = { '5m': 288, '15m': 96, '1h': 24, '4h': 6, '1d': 1 };
    const limit = Math.min((barsPerDay[timeframe] ?? 96) * days, 1000);

    console.log(`  Fetching ${limit} candles...`);
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    const prices = ohlcv.map((c: any[]) => c[4]); // close prices

    console.log(`  Got ${prices.length} candles ($${prices[0]?.toFixed(2)} → $${prices[prices.length - 1]?.toFixed(2)})\n`);

    // Generate synthetic signals from price momentum/RSI for hypothesis testing
    const signals: SignalSnapshot[] = prices.map((_, i) => {
        if (i < 20) return { sources: [] };

        const window = prices.slice(i - 20, i);
        const sma5 = window.slice(-5).reduce((a: number, b: number) => a + b, 0) / 5;
        const sma20 = window.reduce((a: number, b: number) => a + b, 0) / 20;
        const momentumDir = sma5 > sma20 ? 0.7 : -0.7;

        const returns: number[] = [];
        for (let j = 1; j < window.length; j++) {
            returns.push((window[j] - window[j - 1]) / window[j - 1]);
        }
        const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
        const trendDir = avgRet > 0 ? 0.5 : -0.5;

        // RSI proxy
        const gains = returns.filter(r => r > 0);
        const allLosses = returns.filter(r => r < 0);
        const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0;
        const avgLoss = allLosses.length > 0 ? Math.abs(allLosses.reduce((a, b) => a + b, 0)) / 14 : 0.001;
        const rsi = 100 - 100 / (1 + avgGain / avgLoss);
        const rsiDir = rsi < 35 ? 0.8 : rsi > 65 ? -0.6 : 0;

        return {
            sources: [
                { id: 'momentum', direction: momentumDir, weight: 0.6 },
                { id: 'trend', direction: trendDir, weight: 0.5 },
                { id: 'rsi', direction: rsiDir, weight: 0.7 },
            ],
        };
    });

    const config: BacktestConfig = {
        phaseTransitionThreshold: 0.6,
        kellyFractionCap: 0.25,
        minPsiMagnitude: 0.05,
        maxPositionSizeUsd: 200,
        takeProfitPct: 5,
        stopLossPct: 3,
        trailingStopPct: 2,
        trailingActivationPct: 2.5,
        initialBalance: 1000,
        betaScale: 3.0,
    };

    const bt = new PsinixBacktester(config);
    const result = bt.run(prices, signals);

    if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log('  ═══════════════════════════════════════');
        console.log(`  Symbol:          ${symbol}`);
        console.log(`  Period:          ${days} days (${prices.length} bars)`);
        console.log(`  Total Trades:    ${result.trades.length}`);
        console.log(`  Win Rate:        ${(result.winRate * 100).toFixed(1)}% (${result.wins}W / ${result.losses}L)`);
        console.log(`  Total PnL:       $${result.totalPnl.toFixed(2)}`);
        console.log(`  Max Drawdown:    ${result.maxDrawdownPct.toFixed(2)}%`);
        console.log(`  Sharpe Ratio:    ${result.sharpeRatio.toFixed(3)}`);
        console.log(`  Avg |Psi| at Entry: ${result.avgPsiAtEntry.toFixed(4)}`);
        console.log(`  Avg C at Entry:  ${result.avgCoherenceAtEntry.toFixed(3)}`);
        console.log('  ═══════════════════════════════════════');

        if (result.trades.length > 0) {
            console.log('\n  Recent trades:');
            for (const t of result.trades.slice(-10)) {
                const marker = t.pnl >= 0 ? '+' : '-';
                console.log(`    ${marker} ${t.side} $${t.entryPrice.toFixed(2)} -> $${t.exitPrice.toFixed(2)} | ${t.reason} | PnL: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`);
            }
        }
    }
}

main().catch(err => { console.error('Backtest failed:', err); process.exit(1); });
