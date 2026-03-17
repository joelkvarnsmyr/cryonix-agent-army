/**
 * Ψ Engine Test Suite — Validates phase convergence trading function
 *
 * "en formel utan validering är bara poesi"
 *
 * Tests cover:
 *   1. Kuramoto order parameter correctness
 *   2. Phase transition behavior
 *   3. Entropy temperature scaling
 *   4. Kelly criterion bounds
 *   5. Edge cases (empty signals, extreme values)
 *   6. Position sizing from Ψ output
 */

import { PsiEngine, type PsiSignal } from './psi-engine';
import { SignalCollector } from './signal-collector';

function signal(dir: number, weight: number = 0.5, id: string = 'test'): PsiSignal {
    return { sourceId: id, direction: dir, weight, timestamp: Date.now() };
}

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
    // 1. KURAMOTO ORDER PARAMETER
    // ═══════════════════════════════════════════════════════════════

    test('Perfect consensus (all BUY) → C ≈ 1', () => {
        const signals = [signal(1), signal(1), signal(1), signal(1), signal(1)];
        const result = PsiEngine.compute(signals, 0.5);
        assertApprox(result.coherence, 1.0, 0.01, 'Coherence should be ~1');
        assert(result.phaseTransition, 'Should detect phase transition');
    });

    test('Perfect disagreement (half BUY, half SELL) → C ≈ 0', () => {
        const signals = [signal(1), signal(1), signal(-1), signal(-1)];
        const result = PsiEngine.compute(signals, 0.5);
        assertApprox(result.coherence, 0.0, 0.15, 'Coherence should be ~0');
        assert(!result.phaseTransition, 'Should NOT detect phase transition');
    });

    test('All SELL → C ≈ 1 and Ψ < 0', () => {
        const signals = [signal(-1), signal(-1), signal(-1)];
        const result = PsiEngine.compute(signals, 0.5, 0.6, 1.5); // Realistic WR for positive Kelly
        assertApprox(result.coherence, 1.0, 0.01, 'Coherence should be ~1');
        assert(result.psi < 0, `Ψ should be negative (got ${result.psi.toFixed(4)})`);
    });

    test('Mixed signals → C intermediate', () => {
        const signals = [signal(1), signal(0.5), signal(0.8), signal(-0.3)];
        const result = PsiEngine.compute(signals, 0.5);
        assert(result.coherence > 0.2 && result.coherence < 0.9, `C should be intermediate (got ${result.coherence.toFixed(3)})`);
    });

    // ═══════════════════════════════════════════════════════════════
    // 2. PHASE TRANSITION BEHAVIOR
    // ═══════════════════════════════════════════════════════════════

    test('Phase transition: adding aligned signal pushes C over threshold', () => {
        // Start with borderline coherence
        const signals3 = [signal(1), signal(0.8), signal(-0.5)];
        const r3 = PsiEngine.compute(signals3, 0.5);

        // Add another aligned signal
        const signals4 = [...signals3, signal(0.9)];
        const r4 = PsiEngine.compute(signals4, 0.5);

        assert(r4.coherence > r3.coherence, `Coherence should increase (${r3.coherence.toFixed(3)} → ${r4.coherence.toFixed(3)})`);
    });

    test('tanh creates S-curve: weak input → small output, strong → saturates', () => {
        const weak = [signal(0.2, 0.3), signal(0.1, 0.3)];
        const strong = [signal(1, 0.9), signal(1, 0.9), signal(1, 0.9)];

        const rWeak = PsiEngine.compute(weak, 0.5, 0.6, 1.5);
        const rStrong = PsiEngine.compute(strong, 0.3, 0.6, 1.5);

        assert(Math.abs(rStrong.psi) > Math.abs(rWeak.psi),
            `Strong |Ψ|=${Math.abs(rStrong.psi).toFixed(4)} should be > weak |Ψ|=${Math.abs(rWeak.psi).toFixed(4)}`);
    });

    // ═══════════════════════════════════════════════════════════════
    // 3. ENTROPY TEMPERATURE SCALING
    // ═══════════════════════════════════════════════════════════════

    test('Low entropy (ordered market) → sharper decisions', () => {
        const signals = [signal(0.7), signal(0.6), signal(0.5)];
        const rOrdered = PsiEngine.compute(signals, 0.2);  // Low entropy
        const rChaotic = PsiEngine.compute(signals, 0.9);  // High entropy

        assert(Math.abs(rOrdered.psi) >= Math.abs(rChaotic.psi),
            `Ordered market |Ψ|=${Math.abs(rOrdered.psi).toFixed(4)} ≥ chaotic |Ψ|=${Math.abs(rChaotic.psi).toFixed(4)}`);
        assert(rOrdered.beta > rChaotic.beta, `β ordered (${rOrdered.beta.toFixed(2)}) > β chaotic (${rChaotic.beta.toFixed(2)})`);
    });

    test('Entropy floor prevents division by zero', () => {
        const signals = [signal(1), signal(1)];
        const result = PsiEngine.compute(signals, 0); // Zero entropy
        assert(isFinite(result.beta), 'β should be finite');
        assert(isFinite(result.psi), 'Ψ should be finite');
    });

    // ═══════════════════════════════════════════════════════════════
    // 4. KELLY CRITERION + C² SCALING
    // ═══════════════════════════════════════════════════════════════

    test('C² scaling: half coherence → 25% position size', () => {
        // With C=0.5, C²=0.25 → only 25% of Kelly
        const signals = [signal(1), signal(0), signal(0)]; // Partial coherence
        const result = PsiEngine.compute(signals, 0.5, 0.6, 1.5);
        const maxPossible = result.kellyFraction * 100;
        assert(result.positionPct <= maxPossible * 0.5,
            `Position ${result.positionPct.toFixed(1)}% should be much less than Kelly max ${maxPossible.toFixed(1)}%`);
    });

    test('Kelly fraction capped at 25%', () => {
        const signals = [signal(1), signal(1), signal(1)];
        const result = PsiEngine.compute(signals, 0.3, 0.9, 3.0); // Very high WR
        assert(result.kellyFraction <= 0.25, `Kelly fraction ${result.kellyFraction} should be ≤ 0.25`);
    });

    test('Negative Kelly (bad WR) → zero position', () => {
        const signals = [signal(1), signal(1)];
        const result = PsiEngine.compute(signals, 0.5, 0.2, 0.5); // Terrible WR
        assert(result.kellyFraction === 0, 'Kelly should be 0 for negative edge');
        assertApprox(result.positionPct, 0, 0.01, 'Position should be 0%');
    });

    // ═══════════════════════════════════════════════════════════════
    // 5. EDGE CASES
    // ═══════════════════════════════════════════════════════════════

    test('Empty signals → neutral result', () => {
        const result = PsiEngine.compute([], 0.5);
        assertApprox(result.psi, 0, 0.001, 'Ψ should be 0');
        assertApprox(result.positionPct, 0, 0.001, 'Position should be 0%');
        assert(!result.phaseTransition, 'No phase transition');
    });

    test('Single signal → neutral (needs MIN_SIGNALS=2)', () => {
        const result = PsiEngine.compute([signal(1)], 0.5);
        assertApprox(result.psi, 0, 0.001, 'Single signal should give Ψ=0');
    });

    test('All zero signals → C should be ~1 (all pointing same way: neutral)', () => {
        const signals = [signal(0), signal(0), signal(0)];
        const result = PsiEngine.compute(signals, 0.5);
        // All at θ=π → coherent, but weighted signal = 0 → Ψ = 0
        assertApprox(result.psi, 0, 0.001, 'Neutral consensus → Ψ=0');
    });

    // ═══════════════════════════════════════════════════════════════
    // 6. MARKET ENTROPY COMPUTATION
    // ═══════════════════════════════════════════════════════════════

    test('Constant prices → low entropy', () => {
        const prices = Array(30).fill(100);
        const H = PsiEngine.computeMarketEntropy(prices);
        assertApprox(H, 0, 0.2, 'Constant prices should have low entropy');
    });

    test('Random prices → high entropy', () => {
        const prices = Array.from({ length: 30 }, () => 90 + Math.random() * 20);
        const H = PsiEngine.computeMarketEntropy(prices);
        assert(H > 0.3, `Random prices should have moderate-high entropy (got ${H.toFixed(3)})`);
    });

    test('Uniform returns → higher entropy than clustered', () => {
        // Clustered: mostly positive, few negative
        const clustered = [100, 101, 102, 101.5, 102.5, 103, 104, 103.5, 104.5, 105,
                           106, 107, 106.5, 107.5, 108, 109, 108.5, 109.5, 110, 111];
        // Wild: big swings both ways
        const wild = [100, 105, 95, 110, 88, 112, 85, 115, 80, 120,
                      75, 125, 90, 110, 95, 105, 85, 115, 90, 100];

        const hClustered = PsiEngine.computeMarketEntropy(clustered);
        const hWild = PsiEngine.computeMarketEntropy(wild);

        assert(hClustered < hWild,
            `Clustered entropy (${hClustered.toFixed(3)}) should be < wild (${hWild.toFixed(3)})`);
    });

    test('Too few prices → max entropy', () => {
        const H = PsiEngine.computeMarketEntropy([100]);
        assertApprox(H, 1.0, 0.01, 'Single price should give max entropy');
    });

    // ═══════════════════════════════════════════════════════════════
    // 7. WALLET TRADES → PSI SIGNALS CONVERSION
    // ═══════════════════════════════════════════════════════════════

    test('walletTradesToSignals: BUY → +1, SELL → -1', () => {
        const trades = [
            { walletAddress: 'w1', action: 'BUY' as const },
            { walletAddress: 'w2', action: 'SELL' as const },
        ];
        const scores = new Map([['w1', 90], ['w2', 60]]);
        const signals = PsiEngine.walletTradesToSignals(trades, scores);

        assert(signals.length === 2, '2 signals');
        const s1 = signals.find(s => s.sourceId === 'w1');
        const s2 = signals.find(s => s.sourceId === 'w2');
        assert(s1!.direction === 1, 'BUY → +1');
        assert(s2!.direction === -1, 'SELL → -1');
        assertApprox(s1!.weight, 0.9, 0.01, 'Score 90 → weight 0.9');
        assertApprox(s2!.weight, 0.6, 0.01, 'Score 60 → weight 0.6');
    });

    // ═══════════════════════════════════════════════════════════════
    // 8. SIGNAL COLLECTOR — parseTASignal
    // ═══════════════════════════════════════════════════════════════

    test('parseTASignal: converts trades:pending JSON to PsiSignal', () => {
        const raw = JSON.stringify({
            symbol: 'BTC/USDC', action: 'BUY', confidence: 82,
            patterns: ['dip_buy', 'rsi_oversold'], timestamp: Date.now(),
        });
        const signal = SignalCollector.parseTASignal(raw, 'BTC');
        assert(signal !== null, 'Should parse valid signal');
        assert(signal!.direction > 0, 'BUY → positive direction');
        assertApprox(signal!.direction, 0.64, 0.01, 'confidence 82 → (82-50)/50 = 0.64');
        assertApprox(signal!.weight, 0.7, 0.01, 'TA weight should be 0.7');
    });

    test('parseTASignal: SELL → negative direction', () => {
        const raw = JSON.stringify({ symbol: 'ETH/USDC', action: 'SELL', confidence: 90 });
        const signal = SignalCollector.parseTASignal(raw, 'ETH');
        assert(signal !== null, 'Should parse');
        assert(signal!.direction < 0, 'SELL → negative direction');
    });

    test('parseTASignal: filters by symbol base', () => {
        const raw = JSON.stringify({ symbol: 'SOL/USDC', action: 'BUY', confidence: 75 });
        const signal = SignalCollector.parseTASignal(raw, 'BTC');
        assert(signal === null, 'SOL signal should be null when filtering for BTC');
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
