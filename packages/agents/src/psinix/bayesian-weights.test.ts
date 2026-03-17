/**
 * BayesianWeightTracker Test Suite — Validates adaptive signal weighting
 *
 * Tests cover:
 *   1. Prior initialization
 *   2. Correct prediction boost
 *   3. Wrong prediction penalty
 *   4. Weight bounds [0.1, 0.95]
 *   5. Serialization roundtrip
 *   6. Decay behavior
 */

import { BayesianWeightTracker } from './bayesian-weights';

function assert(condition: boolean, msg: string): void {
    if (!condition) throw new Error(`FAIL: ${msg}`);
    console.log(`  ✓ ${msg}`);
}

function assertApprox(a: number, b: number, epsilon: number, msg: string): void {
    if (Math.abs(a - b) > epsilon) throw new Error(`FAIL: ${msg} — got ${a}, expected ~${b}`);
    console.log(`  ✓ ${msg} (${a.toFixed(4)} ≈ ${b.toFixed(4)})`);
}

async function runTests(): Promise<void> {
    let passed = 0;
    let failed = 0;

    const test = (name: string, fn: () => void) => {
        console.log(`\n── ${name} ──`);
        try {
            fn();
            passed++;
        } catch (err) {
            console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
            failed++;
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // 1. PRIOR INITIALIZATION
    // ═══════════════════════════════════════════════════════════════

    test('Initial weight is prior (0.5)', () => {
        const tracker = new BayesianWeightTracker();
        assertApprox(tracker.getWeight('unknown_source'), 0.5, 0.001, 'Unknown source returns prior');
        assertApprox(tracker.getWeight('another'), 0.5, 0.001, 'Any unknown source returns prior');
    });

    // ═══════════════════════════════════════════════════════════════
    // 2. CORRECT PREDICTION BOOST
    // ═══════════════════════════════════════════════════════════════

    test('Correct prediction increases weight', () => {
        const tracker = new BayesianWeightTracker();
        tracker.update('good_source', 1.0, true);
        const w = tracker.getWeight('good_source');
        assert(w > 0.5, `Weight after correct prediction should be > 0.5 (got ${w.toFixed(4)})`);
    });

    // ═══════════════════════════════════════════════════════════════
    // 3. WRONG PREDICTION PENALTY
    // ═══════════════════════════════════════════════════════════════

    test('Wrong prediction decreases weight', () => {
        const tracker = new BayesianWeightTracker();
        tracker.update('bad_source', 1.0, false);
        const w = tracker.getWeight('bad_source');
        assert(w < 0.5, `Weight after wrong prediction should be < 0.5 (got ${w.toFixed(4)})`);
    });

    // ═══════════════════════════════════════════════════════════════
    // 4. WEIGHT BOUNDS
    // ═══════════════════════════════════════════════════════════════

    test('Weight bounded [0.1, 0.95]', () => {
        const tracker = new BayesianWeightTracker();

        // 100 correct updates — should not exceed 0.95
        for (let i = 0; i < 100; i++) {
            tracker.update('star', 1.0, true);
        }
        const high = tracker.getWeight('star');
        assert(high <= 0.95, `After 100 wins, weight should be <= 0.95 (got ${high.toFixed(4)})`);
        assert(high > 0.8, `After 100 wins, weight should be high (got ${high.toFixed(4)})`);

        // 100 wrong updates — should not go below 0.1
        for (let i = 0; i < 100; i++) {
            tracker.update('loser', 1.0, false);
        }
        const low = tracker.getWeight('loser');
        assert(low >= 0.1, `After 100 losses, weight should be >= 0.1 (got ${low.toFixed(4)})`);
        assert(low < 0.2, `After 100 losses, weight should be low (got ${low.toFixed(4)})`);
    });

    // ═══════════════════════════════════════════════════════════════
    // 5. SERIALIZATION ROUNDTRIP
    // ═══════════════════════════════════════════════════════════════

    test('Serialization roundtrip', () => {
        const tracker = new BayesianWeightTracker(0.92);
        tracker.update('src_a', 1.0, true);
        tracker.update('src_a', 1.0, true);
        tracker.update('src_b', 1.0, false);

        const json = tracker.serialize();
        const restored = BayesianWeightTracker.deserialize(json, 0.92);

        assertApprox(restored.getWeight('src_a'), tracker.getWeight('src_a'), 0.0001, 'src_a weight preserved');
        assertApprox(restored.getWeight('src_b'), tracker.getWeight('src_b'), 0.0001, 'src_b weight preserved');
    });

    // ═══════════════════════════════════════════════════════════════
    // 6. DECAY BEHAVIOR
    // ═══════════════════════════════════════════════════════════════

    test('Decay: old observations fade', () => {
        const tracker = new BayesianWeightTracker(0.92);

        // Build up high weight with correct predictions
        for (let i = 0; i < 10; i++) {
            tracker.update('fading', 1.0, true);
        }
        const peakWeight = tracker.getWeight('fading');

        // Now feed wrong predictions — weight should decrease
        for (let i = 0; i < 10; i++) {
            tracker.update('fading', 1.0, false);
        }
        const decayedWeight = tracker.getWeight('fading');

        assert(decayedWeight < peakWeight,
            `Weight should decrease after wrong predictions: ${peakWeight.toFixed(4)} → ${decayedWeight.toFixed(4)}`);
    });

    // ═══════════════════════════════════════════════════════════════
    // RESULTS
    // ═══════════════════════════════════════════════════════════════

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
