#!/usr/bin/env npx tsx
/**
 * Ψnix Parameter Sweep — Find optimal config by maximizing PnL.
 *
 * Sweeps: beta_scale, phase_threshold, TP/SL, max_position_size
 * Reports: Return %, PnL/trade, profit factor, total PnL
 *
 * Usage:
 *   npx tsx scripts/strategy-lab/psinix_sweep.ts --symbol BTC/USDC --days 30
 *   npx tsx scripts/strategy-lab/psinix_sweep.ts --symbol BTC/USDC --days 30 --tf 1h
 */

import { PsinixBacktester, type BacktestConfig, type SignalSnapshot } from '../../packages/agents/src/psinix/backtester';

interface SweepResult {
    label: string;
    trades: number;
    totalPnl: number;
    returnPct: number;
    pnlPerTrade: number;
    profitFactor: number;
    maxDD: number;
    sharpe: number;
    avgC: number;
}

function generateSignals(prices: number[]): SignalSnapshot[] {
    return prices.map((_, i) => {
        if (i < 20) return { sources: [] };
        const window = prices.slice(i - 20, i);
        const sma5 = window.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const sma20 = window.reduce((a, b) => a + b, 0) / 20;
        const momentumDir = sma5 > sma20 ? 0.7 : -0.7;

        const returns: number[] = [];
        for (let j = 1; j < window.length; j++) returns.push((window[j] - window[j - 1]) / window[j - 1]);
        const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
        const trendDir = avgRet > 0 ? 0.5 : -0.5;

        const gains = returns.filter(r => r > 0);
        const losses = returns.filter(r => r < 0);
        const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0;
        const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0)) / 14 : 0.001;
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
}

function runSweep(prices: number[], signals: SignalSnapshot[], label: string, overrides: Partial<BacktestConfig>): SweepResult {
    const config: BacktestConfig = {
        phaseTransitionThreshold: 0.6,
        kellyFractionCap: 0.25,
        minPsiMagnitude: 0.03,
        maxPositionSizeUsd: 200,
        takeProfitPct: 5,
        stopLossPct: 3,
        trailingStopPct: 2,
        trailingActivationPct: 2.5,
        initialBalance: 1000,
        betaScale: 3.0,
        ...overrides,
    };

    const bt = new PsinixBacktester(config);
    const result = bt.run(prices, signals);

    const grossProfit = result.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(result.trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    return {
        label,
        trades: result.trades.length,
        totalPnl: result.totalPnl,
        returnPct: (result.totalPnl / config.initialBalance) * 100,
        pnlPerTrade: result.trades.length > 0 ? result.totalPnl / result.trades.length : 0,
        profitFactor,
        maxDD: result.maxDrawdownPct,
        sharpe: result.sharpeRatio,
        avgC: result.avgCoherenceAtEntry,
    };
}

async function main() {
    const args = process.argv.slice(2);
    const symIdx = args.indexOf('--symbol');
    const symbol = symIdx >= 0 ? args[symIdx + 1] : 'BTC/USDC';
    const daysIdx = args.indexOf('--days');
    const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) : 30;
    const tfIdx = args.indexOf('--tf');
    const timeframe = tfIdx >= 0 ? args[tfIdx + 1] : '15m';

    console.log(`\n  Ψnix Parameter Sweep — ${symbol} — ${days}d — ${timeframe}`);
    console.log('  ═══════════════════════════════════════════════════════════\n');

    // Fetch data once
    const ccxt = await import('ccxt');
    const Binance = (ccxt as any).binance ?? (ccxt as any).default?.binance;
    const exchange = new Binance({ enableRateLimit: true });

    const barsPerDay: Record<string, number> = { '5m': 288, '15m': 96, '1h': 24, '4h': 6, '1d': 1 };
    const limit = Math.min((barsPerDay[timeframe] ?? 96) * days, 1000);

    console.log(`  Fetching ${limit} candles...`);
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    const prices = ohlcv.map((c: any[]) => c[4]);
    const signals = generateSignals(prices);
    const buyHold = ((prices[prices.length - 1] / prices[20]) - 1) * 100;

    console.log(`  ${prices.length} bars: $${prices[0]?.toFixed(0)} → $${prices[prices.length - 1]?.toFixed(0)} (B&H: ${buyHold >= 0 ? '+' : ''}${buyHold.toFixed(2)}%)\n`);

    const results: SweepResult[] = [];

    // ── Sweep 1: beta_scale ──
    console.log('  [1/5] Beta scale sweep...');
    for (const beta of [1.0, 2.0, 3.0, 5.0, 8.0]) {
        results.push(runSweep(prices, signals, `β=${beta}`, { betaScale: beta }));
    }

    // ── Sweep 2: phase threshold ──
    console.log('  [2/5] Phase threshold sweep...');
    for (const threshold of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
        results.push(runSweep(prices, signals, `C>${threshold}`, { phaseTransitionThreshold: threshold }));
    }

    // ── Sweep 3: TP/SL ratios ──
    console.log('  [3/5] TP/SL sweep...');
    for (const [tp, sl] of [[3, 2], [5, 3], [8, 3], [10, 5], [5, 1.5], [3, 1]]) {
        results.push(runSweep(prices, signals, `TP${tp}/SL${sl}`, {
            takeProfitPct: tp, stopLossPct: sl,
            trailingActivationPct: tp * 0.5, trailingStopPct: sl * 0.67,
        }));
    }

    // ── Sweep 4: Position size ──
    console.log('  [4/5] Position size sweep...');
    for (const maxPos of [100, 200, 400, 600]) {
        results.push(runSweep(prices, signals, `$${maxPos}max`, { maxPositionSizeUsd: maxPos }));
    }

    // ── Sweep 5: Combined best candidates ──
    console.log('  [5/5] Combined configs...');
    results.push(runSweep(prices, signals, 'aggressive', {
        betaScale: 5.0, phaseTransitionThreshold: 0.4,
        takeProfitPct: 8, stopLossPct: 3, maxPositionSizeUsd: 400,
        trailingActivationPct: 4, trailingStopPct: 2,
    }));
    results.push(runSweep(prices, signals, 'conservative', {
        betaScale: 2.0, phaseTransitionThreshold: 0.7,
        takeProfitPct: 3, stopLossPct: 1.5, maxPositionSizeUsd: 100,
        trailingActivationPct: 1.5, trailingStopPct: 1,
    }));
    results.push(runSweep(prices, signals, 'balanced', {
        betaScale: 3.0, phaseTransitionThreshold: 0.5,
        takeProfitPct: 5, stopLossPct: 2, maxPositionSizeUsd: 300,
        trailingActivationPct: 2.5, trailingStopPct: 1.5,
    }));
    results.push(runSweep(prices, signals, 'highfreq', {
        betaScale: 5.0, phaseTransitionThreshold: 0.3,
        takeProfitPct: 3, stopLossPct: 1.5, maxPositionSizeUsd: 200,
        minPsiMagnitude: 0.01,
        trailingActivationPct: 1.5, trailingStopPct: 1,
    }));

    // ── Print results sorted by total PnL ──
    results.sort((a, b) => b.totalPnl - a.totalPnl);

    console.log('\n  ═══════════════════════════════════════════════════════════════════════════════');
    const hdr = [
        'Config'.padEnd(16), 'Trades'.padStart(6), 'PnL'.padStart(10), 'Return%'.padStart(9),
        'PnL/Trade'.padStart(10), 'PF'.padStart(6), 'MaxDD%'.padStart(7), 'Sharpe'.padStart(7), 'AvgC'.padStart(6),
    ];
    console.log('  ' + hdr.join(' '));
    console.log('  ───────────────────────────────────────────────────────────────────────────────');

    for (const r of results) {
        const pnlStr = r.totalPnl >= 0 ? `+$${r.totalPnl.toFixed(2)}` : `-$${Math.abs(r.totalPnl).toFixed(2)}`;
        const retStr = r.returnPct >= 0 ? `+${r.returnPct.toFixed(2)}%` : `${r.returnPct.toFixed(2)}%`;
        const pptStr = r.pnlPerTrade >= 0 ? `+$${r.pnlPerTrade.toFixed(2)}` : `-$${Math.abs(r.pnlPerTrade).toFixed(2)}`;
        const pfStr = r.profitFactor >= 100 ? 'INF' : r.profitFactor.toFixed(2);

        const row = [
            r.label.padEnd(16), r.trades.toString().padStart(6), pnlStr.padStart(10), retStr.padStart(9),
            pptStr.padStart(10), pfStr.padStart(6), (r.maxDD.toFixed(2) + '%').padStart(7),
            r.sharpe.toFixed(3).padStart(7), r.avgC.toFixed(3).padStart(6),
        ];
        console.log('  ' + row.join(' '));
    }

    console.log('  ═══════════════════════════════════════════════════════════════════════════════');
    console.log(`  Buy & Hold:  ${buyHold >= 0 ? '+' : ''}${buyHold.toFixed(2)}%`);
    console.log(`  Best config: ${results[0]?.label} (${results[0]?.totalPnl >= 0 ? '+' : ''}$${results[0]?.totalPnl.toFixed(2)})\n`);
}

main().catch(err => { console.error('Sweep failed:', err); process.exit(1); });
