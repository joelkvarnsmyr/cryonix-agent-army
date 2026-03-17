/**
 * Psinix Backtester Test Suite
 *
 * Validates the backtesting engine: result structure, signal agreement/disagreement,
 * equity curve initialization, and drawdown bounds.
 */

import { PsinixBacktester, type BacktestConfig, type SignalSnapshot } from './backtester';

function assert(condition: boolean, msg: string): void {
    if (!condition) throw new Error(`FAIL: ${msg}`);
    console.log(`  \u2713 ${msg}`);
}

const DEFAULT_CONFIG: BacktestConfig = {
    phaseTransitionThreshold: 0.6,
    kellyFractionCap: 0.25,
    minPsiMagnitude: 0.001,
    maxPositionSizeUsd: 200,
    takeProfitPct: 5,
    stopLossPct: 3,
    trailingStopPct: 2,
    trailingActivationPct: 3,
    initialBalance: 1000,
    betaScale: 3.0,
};

// ── Price generators ────────────────────────────────────────────────

function makeTrendUp(len: number = 200): number[] {
    const prices: number[] = [];
    for (let i = 0; i < len; i++) {
        prices.push(100 + i * 0.5 + (Math.random() - 0.5) * 2);
    }
    return prices;
}

function makeChoppy(len: number = 200): number[] {
    const prices: number[] = [];
    for (let i = 0; i < len; i++) {
        prices.push(100 + Math.sin(i * 0.3) * 5 + (Math.random() - 0.5) * 3);
    }
    return prices;
}

// ── Signal generators ───────────────────────────────────────────────

function bullishSignals(len: number): SignalSnapshot[] {
    return Array.from({ length: len }, () => ({
        sources: [
            { id: 'w1', direction: 1, weight: 0.8 },
            { id: 'w2', direction: 1, weight: 0.7 },
            { id: 'w3', direction: 1, weight: 0.6 },
        ],
    }));
}

function disagreeingSignals(len: number): SignalSnapshot[] {
    return Array.from({ length: len }, (_, i) => ({
        sources: [
            { id: 'w1', direction: i % 2 === 0 ? 1 : -1, weight: 0.7 },
            { id: 'w2', direction: i % 2 === 0 ? -1 : 1, weight: 0.7 },
        ],
    }));
}

function emptySignals(len: number): SignalSnapshot[] {
    return Array.from({ length: len }, () => ({ sources: [] }));
}

// ── Test runner ─────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    let passed = 0;
    let failed = 0;

    const test = (name: string, fn: () => void) => {
        console.log(`\n\u2500\u2500 ${name} \u2500\u2500`);
        try {
            fn();
            passed++;
        } catch (err) {
            console.error(`  \u2717 ${err instanceof Error ? err.message : String(err)}`);
            failed++;
        }
    };

    // ═════════════════════════════════════════════════════════════════
    // 1. RESULT STRUCTURE
    // ═════════════════════════════════════════════════════════════════

    test('Returns valid result structure', () => {
        const bt = new PsinixBacktester(DEFAULT_CONFIG);
        const prices = makeTrendUp();
        const result = bt.run(prices, emptySignals(prices.length));

        assert(Array.isArray(result.trades), 'trades is an array');
        assert(typeof result.totalPnl === 'number', 'totalPnl is a number');
        assert(typeof result.winRate === 'number', 'winRate is a number');
        assert(typeof result.wins === 'number', 'wins is a number');
        assert(typeof result.losses === 'number', 'losses is a number');
        assert(typeof result.maxDrawdownPct === 'number', 'maxDrawdownPct is a number');
        assert(typeof result.sharpeRatio === 'number', 'sharpeRatio is a number');
        assert(Array.isArray(result.equityCurve), 'equityCurve is an array');
        assert(result.equityCurve.length === prices.length, 'equityCurve length matches prices');
        assert(typeof result.avgCoherenceAtEntry === 'number', 'avgCoherenceAtEntry is a number');
        assert(typeof result.avgPsiAtEntry === 'number', 'avgPsiAtEntry is a number');
        assert(result.totalBars === prices.length, 'totalBars matches prices length');
    });

    // ═════════════════════════════════════════════════════════════════
    // 2. NO TRADES WHEN SIGNALS DISAGREE
    // ═════════════════════════════════════════════════════════════════

    test('No trades when signals disagree (C ~ 0)', () => {
        const bt = new PsinixBacktester(DEFAULT_CONFIG);
        const prices = makeTrendUp();
        const result = bt.run(prices, disagreeingSignals(prices.length));

        assert(result.trades.length === 0,
            `Expected 0 trades with disagreeing signals, got ${result.trades.length}`);
    });

    // ═════════════════════════════════════════════════════════════════
    // 3. TRADES OCCUR WHEN SIGNALS AGREE
    // ═════════════════════════════════════════════════════════════════

    test('Trades occur when signals agree (C ~ 1)', () => {
        const bt = new PsinixBacktester(DEFAULT_CONFIG);
        const prices = makeTrendUp();
        const result = bt.run(prices, bullishSignals(prices.length));

        assert(result.trades.length > 0,
            `Expected > 0 trades with bullish consensus, got ${result.trades.length}`);
    });

    // ═════════════════════════════════════════════════════════════════
    // 4. EQUITY CURVE STARTS AT INITIAL BALANCE
    // ═════════════════════════════════════════════════════════════════

    test('Equity curve starts at initial balance', () => {
        const bt = new PsinixBacktester(DEFAULT_CONFIG);
        const prices = makeTrendUp();
        const result = bt.run(prices, emptySignals(prices.length));

        assert(result.equityCurve[0] === 1000,
            `First equity value should be 1000, got ${result.equityCurve[0]}`);
    });

    // ═════════════════════════════════════════════════════════════════
    // 5. MAX DRAWDOWN IS NON-NEGATIVE
    // ═════════════════════════════════════════════════════════════════

    test('Max drawdown is non-negative', () => {
        const bt = new PsinixBacktester(DEFAULT_CONFIG);

        // Test with trending prices + bullish signals
        const r1 = bt.run(makeTrendUp(), bullishSignals(200));
        assert(r1.maxDrawdownPct >= 0,
            `maxDrawdownPct should be >= 0 (trending), got ${r1.maxDrawdownPct}`);

        // Test with choppy prices + bullish signals
        const r2 = bt.run(makeChoppy(), bullishSignals(200));
        assert(r2.maxDrawdownPct >= 0,
            `maxDrawdownPct should be >= 0 (choppy), got ${r2.maxDrawdownPct}`);

        // Test with no trades
        const r3 = bt.run(makeTrendUp(), emptySignals(200));
        assert(r3.maxDrawdownPct >= 0,
            `maxDrawdownPct should be >= 0 (no trades), got ${r3.maxDrawdownPct}`);
    });

    // ═════════════════════════════════════════════════════════════════
    // RESULTS
    // ═════════════════════════════════════════════════════════════════

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(50)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
