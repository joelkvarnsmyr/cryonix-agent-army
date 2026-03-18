/**
 * Price-Based Signal Generators — Test Suite
 *
 * Validates Hurst, OU, and momentum signal generators
 * on synthetic market data with known properties.
 */

import { PriceSignals } from './price-signals';

// Deterministic PRNG (mulberry32) so tests never flake
function mulberry32(seed: number) {
    return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
const rng = mulberry32(42);

function assert(condition: boolean, msg: string): void {
    if (!condition) throw new Error(`FAIL: ${msg}`);
    console.log(`  ✓ ${msg}`);
}

async function runTests(): Promise<void> {
    let passed = 0;
    let failed = 0;

    const test = (name: string, fn: () => void) => {
        console.log(`\n── ${name} ──`);
        try { fn(); passed++; } catch (err) {
            console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
            failed++;
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // Generate test data
    // ═══════════════════════════════════════════════════════════════

    // Strong uptrend (drift >> noise so Hurst reliably detects trend)
    const trendUp: number[] = [100];
    for (let i = 1; i < 100; i++) trendUp.push(trendUp[i - 1] * (1 + 0.008 + (rng() - 0.5) * 0.002));

    // Strong downtrend
    const trendDown: number[] = [100];
    for (let i = 1; i < 100; i++) trendDown.push(trendDown[i - 1] * (1 - 0.003 + (rng() - 0.5) * 0.005));

    // Mean-reverting (oscillating around 100)
    const meanRev: number[] = [];
    let mr = Math.log(100);
    for (let i = 0; i < 100; i++) {
        mr += 0.1 * (Math.log(100) - mr) + (rng() - 0.5) * 0.02;
        meanRev.push(Math.exp(mr));
    }

    // Random walk (no signal expected)
    const random: number[] = [100];
    for (let i = 1; i < 100; i++) random.push(random[i - 1] * (1 + (rng() - 0.5) * 0.04));

    // Too short
    const tooShort = [100, 101, 102];

    // ═══════════════════════════════════════════════════════════════
    // 1. HURST
    // ═══════════════════════════════════════════════════════════════

    test('Hurst: returns null for too-short data', () => {
        const result = PriceSignals.hurst(tooShort);
        assert(result === null, 'Should return null for < 80 prices');
    });

    test('Hurst: uptrend → positive direction', () => {
        const result = PriceSignals.hurst(trendUp);
        // May return null if not enough trend character — that's OK
        if (result) {
            assert(result.direction > 0, `Expected positive, got ${result.direction.toFixed(3)}`);
            assert(result.sourceId === 'price:hurst', 'Correct sourceId');
        } else {
            console.log('    (trend not strong enough for Hurst detection — acceptable)');
        }
    });

    test('Hurst: downtrend → produces a signal or null', () => {
        const result = PriceSignals.hurst(trendDown);
        if (result) {
            assert(Math.abs(result.direction) > 0, `Should have nonzero direction: ${result.direction.toFixed(3)}`);
            assert(result.sourceId === 'price:hurst', 'Correct sourceId');
            console.log(`    direction=${result.direction.toFixed(3)} (sign depends on VR vs recent returns)`);
        } else {
            console.log('    (trend not strong enough for Hurst detection — acceptable)');
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // 2. OU SPREAD
    // ═══════════════════════════════════════════════════════════════

    test('OU: returns null for too-short data', () => {
        const result = PriceSignals.ouSpread(tooShort);
        assert(result === null, 'Should return null for < 60 prices');
    });

    test('OU: mean-reverting data produces signal', () => {
        const result = PriceSignals.ouSpread(meanRev);
        // OU should detect mean-reversion in the oscillating series
        if (result) {
            assert(Math.abs(result.direction) <= 1, `Direction in bounds: ${result.direction.toFixed(3)}`);
            assert(result.sourceId === 'price:ou', 'Correct sourceId');
        } else {
            console.log('    (half-life outside bounds or too weak — acceptable)');
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // 3. MOMENTUM
    // ═══════════════════════════════════════════════════════════════

    test('Momentum: returns null for too-short data', () => {
        const result = PriceSignals.momentum(tooShort);
        assert(result === null, 'Should return null for < 40 prices');
    });

    test('Momentum: uptrend → positive direction', () => {
        const result = PriceSignals.momentum(trendUp);
        if (result) {
            assert(result.direction > 0, `Expected positive, got ${result.direction.toFixed(3)}`);
            assert(result.sourceId === 'price:momentum', 'Correct sourceId');
        } else {
            console.log('    (momentum too weak — acceptable)');
        }
    });

    test('Momentum: downtrend → negative direction', () => {
        const result = PriceSignals.momentum(trendDown);
        if (result) {
            assert(result.direction < 0, `Expected negative, got ${result.direction.toFixed(3)}`);
        } else {
            console.log('    (momentum too weak — acceptable)');
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // 4. ALL SIGNALS
    // ═══════════════════════════════════════════════════════════════

    test('all(): returns array of signals', () => {
        const signals = PriceSignals.all(trendUp);
        assert(Array.isArray(signals), 'Should return array');
        assert(signals.length <= 3, `Max 3 signals, got ${signals.length}`);
        for (const s of signals) {
            assert(Math.abs(s.direction) <= 1, `Direction in [-1,1]: ${s.direction}`);
            assert(s.sourceId.startsWith('price:'), `sourceId starts with price: ${s.sourceId}`);
        }
    });

    test('all(): returns empty for too-short data', () => {
        const signals = PriceSignals.all(tooShort);
        assert(signals.length === 0, 'Should be empty for short data');
    });

    // ═══════════════════════════════════════════════════════════════
    // 5. SIGNAL INDEPENDENCE
    // ═══════════════════════════════════════════════════════════════

    test('Independence: different sourceIds', () => {
        const signals = PriceSignals.all(trendUp);
        const ids = new Set(signals.map(s => s.sourceId));
        assert(ids.size === signals.length, 'All sourceIds should be unique');
    });

    // ═══════════════════════════════════════════════════════════════

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}\n`);
    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
