# Huntrix Backtester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a backtester that validates Huntrix signal quality and exit logic against historical OHLCV data, with optional calibration against real pump profiles.

**Architecture:** CLI runner fetches OHLCV via CCXT, passes data to `HuntrixBacktester` which orchestrates three stages: `SyntheticSignalGenerator` (detect volume/velocity anomalies), `EntrySimulator` (filter signals), and `ExitSimulator` (replay exits through `DumpDetector`). Optional `Calibrator` matches results against saved `PumpProfile[]`.

**Tech Stack:** CCXT 4.x (public endpoints), vitest, existing `DumpDetector`, `VolumeSpikeDetector`, `calculateSMA`

**Spec:** `docs/superpowers/specs/2026-03-22-huntrix-backtest-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/agents/src/huntrix/backtester.ts` | `HuntrixBacktester` class — orchestrates signal generation, entry filtering, exit simulation, calibration, metrics |
| `packages/agents/src/huntrix/synthetic-signal-generator.ts` | Generates `ManipulationSignal[]` from OHLCV anomalies (volume spikes + price velocity) |
| `packages/agents/src/huntrix/__tests__/backtester.test.ts` | Unit tests for all backtester components |
| `scripts/strategy-lab/huntrix_backtest.ts` | CLI runner with OHLCV pagination, arg parsing, formatted output |

### Reused Files (no modifications)

| File | What We Import |
|------|---------------|
| `packages/agents/src/huntrix/dump-detector.ts` | `DumpDetector`, `ExitSignal` — exit logic (skip `recheckShillActivity`, handle `checkMaxHoldTime` ourselves) |
| `packages/agents/src/huntrix/types.ts` | `ManipulationSignal`, `HunterPosition`, `PriceTick`, `ExitReason`, `PumpProfile`, `HuntrixConfig` |
| `packages/agents/src/huntrix/config.ts` | `loadHuntrixConfig`, `HUNTRIX_DEFAULTS` |
| `packages/agents/src/market-scout/pattern-detectors/volume-spike.ts` | `VolumeSpikeDetector` |
| `packages/agents/src/market-scout/pattern-detectors/pattern-detector.interface.ts` | `OhlcvData`, `calculateSMA` |

---

### Task 1: SyntheticSignalGenerator — types + tests

**Files:**
- Create: `packages/agents/src/huntrix/synthetic-signal-generator.ts`
- Create: `packages/agents/src/huntrix/__tests__/backtester.test.ts`

- [ ] **Step 1: Write tests for SyntheticSignalGenerator**

```typescript
// packages/agents/src/huntrix/__tests__/backtester.test.ts
import { describe, it, expect } from 'vitest';
import { SyntheticSignalGenerator } from '../synthetic-signal-generator';
import { HUNTRIX_DEFAULTS } from '../config';
import type { OhlcvData } from '../../market-scout/pattern-detectors/pattern-detector.interface';

function makeCandles(count: number, basePrice = 100, baseVolume = 1000): OhlcvData[] {
    return Array.from({ length: count }, (_, i) => ({
        timestamp: Date.now() - (count - i) * 60_000,
        open: basePrice,
        high: basePrice * 1.001,
        low: basePrice * 0.999,
        close: basePrice,
        volume: baseVolume,
    }));
}

describe('SyntheticSignalGenerator', () => {
    const gen = new SyntheticSignalGenerator(HUNTRIX_DEFAULTS.detection);

    it('should detect a volume spike with price velocity', () => {
        const candles15m = makeCandles(25, 100, 1000);
        // Inject spike: last candle has 5x volume and 2% price jump
        candles15m[candles15m.length - 1] = {
            ...candles15m[candles15m.length - 1],
            close: 102,
            high: 102.5,
            volume: 5000,
        };

        const candles1m = makeCandles(100, 100);
        // Inject price velocity in last few 1m candles (2%/min over 5 min window)
        for (let i = 95; i < 100; i++) {
            candles1m[i] = {
                ...candles1m[i],
                close: 100 + (i - 94) * 2,
                high: 100 + (i - 94) * 2 + 0.5,
                volume: 3000,
            };
        }

        const signals = gen.scan(candles15m, candles1m, 'BTC/USDC');
        expect(signals.length).toBeGreaterThan(0);
        expect(signals[0].type).toBe('wash_trading_pump');
        expect(signals[0].source).toBe('trending_anomaly');
        expect(signals[0].exchange).toBe('backtest');
        expect(signals[0].symbol).toBe('BTC/USDC');
    });

    it('should not generate signals from flat data', () => {
        const candles15m = makeCandles(25, 100, 1000);
        const candles1m = makeCandles(100, 100, 1000);
        const signals = gen.scan(candles15m, candles1m, 'TEST/USDC');
        expect(signals.length).toBe(0);
    });

    it('should reject already-pumped signals', () => {
        const candles15m = makeCandles(25, 100, 1000);
        // Price already up 25% from 24 candles ago
        candles15m[0] = { ...candles15m[0], close: 80 };
        candles15m[candles15m.length - 1] = {
            ...candles15m[candles15m.length - 1],
            close: 102,
            volume: 5000,
        };

        const candles1m = makeCandles(100, 100);
        for (let i = 95; i < 100; i++) {
            candles1m[i] = { ...candles1m[i], close: 100 + (i - 94) * 2, volume: 3000 };
        }

        const signals = gen.scan(candles15m, candles1m, 'TEST/USDC');
        // Should be filtered out because already pumped >20%
        expect(signals.length).toBe(0);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/backtester.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SyntheticSignalGenerator**

```typescript
// packages/agents/src/huntrix/synthetic-signal-generator.ts
import type { ManipulationSignal, HuntrixConfig } from './types';
import { VolumeSpikeDetector } from '../market-scout/pattern-detectors/volume-spike';
import type { OhlcvData } from '../market-scout/pattern-detectors/pattern-detector.interface';

type DetectionConfig = HuntrixConfig['detection'];

export class SyntheticSignalGenerator {
    private detection: DetectionConfig;
    private velocityWindowMinutes: number;
    private volumeDetector = new VolumeSpikeDetector();

    constructor(detection: DetectionConfig, velocityWindowSeconds?: number) {
        this.detection = detection;
        // Use velocity_window_seconds from config (default 300s = 5 min)
        this.velocityWindowMinutes = (velocityWindowSeconds ?? 300) / 60;
    }

    /**
     * Scan a window of candles for manipulation signals.
     * Called per sliding window — returns at most 1 signal per call.
     * @param symbol - trading pair (e.g. 'BTC/USDC')
     */
    scan(candles15m: OhlcvData[], candles1m: OhlcvData[], symbol: string = 'BACKTEST'): ManipulationSignal[] {
        const signals: ManipulationSignal[] = [];

        // 1. Volume spike detection on 15m candles
        const spikeResult = this.volumeDetector.detect(candles15m, symbol);
        if (!spikeResult) return signals;

        // 2. Price velocity check on 1m candles (using config velocity_window_seconds)
        const velocity = this.computeVelocity(candles1m);
        if (velocity === null) return signals;
        if (velocity < this.detection.min_entry_velocity_pct_per_min) return signals;
        if (velocity > this.detection.max_entry_velocity_pct_per_min) return signals;

        // 3. Already-pumped guard on 15m candles
        if (candles15m.length >= 2) {
            const oldest = candles15m[0].close;
            const newest = candles15m[candles15m.length - 1].close;
            if (oldest > 0) {
                const changePct = ((newest - oldest) / oldest) * 100;
                if (changePct > this.detection.max_already_pumped_pct) return signals;
            }
        }

        // 4. Phase classification
        const recentChange = candles1m.length >= 20
            ? ((candles1m[candles1m.length - 1].close - candles1m[candles1m.length - 20].close) / candles1m[candles1m.length - 20].close) * 100
            : 0;
        const phase = recentChange < 5 ? 'early_pump' : 'mid_pump';

        const lastCandle = candles1m[candles1m.length - 1];
        const confidence = Math.min(85, 55 + velocity * 5);

        signals.push({
            id: `synth-${lastCandle.timestamp}`,
            type: 'wash_trading_pump',
            symbol,
            exchange: 'backtest',
            confidence,
            phase: phase as any,
            shill_activity: [],
            total_shill_accounts: 0,
            price_at_detection: lastCandle.close,
            volume_24h: lastCandle.volume,
            volume_spike_ratio: spikeResult.metadata?.volumeRatio ?? 0,
            price_velocity: velocity,
            reasoning: `Synthetic: volume ${(spikeResult.metadata?.volumeRatio ?? 0).toFixed(1)}x avg, velocity ${velocity.toFixed(2)}%/min`,
            estimated_peak_minutes: null,
            detected_at: new Date(lastCandle.timestamp).toISOString(),
            source: 'trending_anomaly',
        });

        return signals;
    }

    private computeVelocity(candles1m: OhlcvData[]): number | null {
        const windowCandles = Math.ceil(this.velocityWindowMinutes) + 1;
        if (candles1m.length < windowCandles) return null;
        const len = candles1m.length;
        const startPrice = candles1m[len - windowCandles].close;
        const currentPrice = candles1m[len - 1].close;
        if (startPrice <= 0) return null;
        const priceDiff = ((currentPrice - startPrice) / startPrice) * 100;
        return priceDiff / this.velocityWindowMinutes;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/backtester.test.ts 2>&1 | tail -10`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/huntrix/synthetic-signal-generator.ts packages/agents/src/huntrix/__tests__/backtester.test.ts
git commit -m "feat(huntrix): add SyntheticSignalGenerator with tests"
```

---

### Task 2: HuntrixBacktester — ExitSimulator + EntrySimulator + metrics

**Files:**
- Create: `packages/agents/src/huntrix/backtester.ts`
- Modify: `packages/agents/src/huntrix/__tests__/backtester.test.ts`

- [ ] **Step 1: Add ExitSimulator and EntrySimulator tests**

Append to `backtester.test.ts`:

```typescript
import { HuntrixBacktester, type HuntrixBTTrade } from '../backtester';
import type { ManipulationSignal, PriceTick } from '../types';

function makeSignal(overrides: Partial<ManipulationSignal> = {}): ManipulationSignal {
    return {
        id: 'test-1',
        type: 'wash_trading_pump',
        symbol: 'TEST/USDC',
        exchange: 'backtest',
        confidence: 75,
        phase: 'early_pump',
        shill_activity: [],
        total_shill_accounts: 0,
        price_at_detection: 100,
        volume_24h: 10000,
        volume_spike_ratio: 3,
        price_velocity: 2,
        reasoning: 'test',
        estimated_peak_minutes: null,
        detected_at: new Date().toISOString(),
        source: 'trending_anomaly',
        ...overrides,
    };
}

describe('HuntrixBacktester', () => {
    const bt = new HuntrixBacktester(HUNTRIX_DEFAULTS);

    it('should filter out peak/dump phase signals', () => {
        const signals = [
            makeSignal({ phase: 'early_pump', confidence: 75 }),
            makeSignal({ id: 'test-2', phase: 'peak', confidence: 80 }),
            makeSignal({ id: 'test-3', phase: 'dump', confidence: 90 }),
        ];
        const approved = bt.filterSignals(signals);
        expect(approved.length).toBe(1);
        expect(approved[0].phase).toBe('early_pump');
    });

    it('should filter out low confidence signals', () => {
        const signals = [
            makeSignal({ confidence: 75 }),  // pump_and_dump needs 70 — pass
            makeSignal({ id: 'test-2', confidence: 50 }),  // below 70 — fail
        ];
        const approved = bt.filterSignals(signals);
        expect(approved.length).toBe(1);
    });

    it('should simulate exits with stop loss', () => {
        const signal = makeSignal({ price_at_detection: 100 });
        // Price drops 4% — should trigger SL at 3%
        const candles: OhlcvData[] = Array.from({ length: 10 }, (_, i) => ({
            timestamp: Date.now() + i * 60_000,
            open: 100 - i * 0.5,
            high: 100 - i * 0.5 + 0.1,
            low: 100 - i * 0.5 - 0.1,
            close: 100 - i * 0.5,
            volume: 1000,
        }));

        const trades = bt.simulateExits([signal], candles, 0);
        expect(trades.length).toBe(1);
        expect(trades[0].exitReason).toBe('stop_loss');
        expect(trades[0].pnlPct).toBeLessThan(0);
    });

    it('should simulate exits with take profit', () => {
        const signal = makeSignal({ price_at_detection: 100 });
        // Price rises 16% — should trigger TP at 15%
        const candles: OhlcvData[] = Array.from({ length: 20 }, (_, i) => ({
            timestamp: Date.now() + i * 60_000,
            open: 100 + i * 1,
            high: 100 + i * 1 + 0.5,
            low: 100 + i * 1 - 0.5,
            close: 100 + i * 1,
            volume: 1000,
        }));

        const trades = bt.simulateExits([signal], candles, 0);
        expect(trades.length).toBe(1);
        expect(trades[0].exitReason).toBe('take_profit');
        expect(trades[0].pnlPct).toBeGreaterThan(0);
    });

    it('should compute metrics from trades', () => {
        const signal = makeSignal({ price_at_detection: 100 });
        const candles: OhlcvData[] = Array.from({ length: 10 }, (_, i) => ({
            timestamp: Date.now() + i * 60_000,
            open: 100 - i * 0.5,
            high: 100 - i * 0.5 + 0.1,
            low: 100 - i * 0.5 - 0.1,
            close: 100 - i * 0.5,
            volume: 1000,
        }));

        const trades = bt.simulateExits([signal], candles, 0);
        const result = bt.computeMetrics(trades, 1, 1);
        expect(result.trades.length).toBe(1);
        expect(result.winRate).toBeDefined();
        expect(result.totalPnl).toBeDefined();
        expect(result.equityCurve.length).toBeGreaterThan(0);
        expect(result.equityCurve[0]).toHaveProperty('equity');
        expect(result.equityCurve[0]).toHaveProperty('drawdown');
        expect(result.exitBreakdown).toBeDefined();
    });

    it('should calibrate against pump profiles', () => {
        const now = Date.now();
        const trades: HuntrixBTTrade[] = [{
            symbol: 'BTC/USDC', exchange: 'backtest',
            entryIdx: 0, exitIdx: 5, entryPrice: 100, exitPrice: 103,
            entryTimestamp: now, pnl: 3, pnlPct: 3,
            holdMinutes: 5, exitReason: 'take_profit',
            signalType: 'wash_trading_pump', signalConfidence: 75, phase: 'early_pump',
        }];
        const profiles = [
            { id: 'p1', symbol: 'BTC/USDC', detected_at: new Date(now + 60_000).toISOString() },
            { id: 'p2', symbol: 'ETH/USDC', detected_at: new Date(now).toISOString() },
        ] as any;

        const result = bt.computeMetrics(trades, 1, 1, profiles);
        expect(result.calibration).not.toBeNull();
        expect(result.calibration!.matchedProfiles).toBe(1);
        expect(result.calibration!.precision).toBe(1);  // 1/1 trades matched
        expect(result.calibration!.recall).toBe(0.5);    // 1/2 profiles matched
        expect(result.calibration!.unmatchedProfiles).toBe(1);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/backtester.test.ts 2>&1 | tail -10`
Expected: FAIL — backtester module not found

- [ ] **Step 3: Implement HuntrixBacktester**

```typescript
// packages/agents/src/huntrix/backtester.ts
import type {
    ManipulationSignal, HunterPosition, PriceTick,
    ExitReason, HuntrixConfig, PumpProfile,
} from './types';
import type { OhlcvData } from '../market-scout/pattern-detectors/pattern-detector.interface';
import type { EquityPoint } from '@cryonix/types';
import { DumpDetector } from './dump-detector';

export interface HuntrixBTTrade {
    symbol: string;
    exchange: string;
    entryIdx: number;
    exitIdx: number;
    entryPrice: number;
    exitPrice: number;
    entryTimestamp: number;
    pnl: number;
    pnlPct: number;
    holdMinutes: number;
    exitReason: string;
    signalType: string;
    signalConfidence: number;
    phase: string;
}

export interface CalibrationResult {
    precision: number;
    recall: number;
    matchedProfiles: number;
    unmatchedProfiles: number;
    falsePositives: number;
}

export interface HuntrixBacktestResult {
    trades: HuntrixBTTrade[];
    totalPnl: number;
    winRate: number;
    wins: number;
    losses: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    equityCurve: EquityPoint[];
    avgHoldMinutes: number;
    exitBreakdown: Record<string, number>;
    signalsGenerated: number;
    signalsApproved: number;
    approvalRate: number;
    calibration: CalibrationResult | null;
}

export class HuntrixBacktester {
    private config: HuntrixConfig;

    constructor(config: HuntrixConfig) {
        this.config = config;
    }

    /**
     * Filter signals through entry validation (no live exchange calls).
     */
    filterSignals(signals: ManipulationSignal[]): ManipulationSignal[] {
        return signals.filter(s => {
            // Phase check
            if (s.phase === 'peak' || s.phase === 'dump' || s.phase === 'post_dump' || s.phase === 'pre_pump') {
                return false;
            }
            // Confidence check
            const minConf = this.getMinConfidence(s.type);
            if (s.confidence < minConf) return false;
            return true;
        });
    }

    /**
     * Simulate exits for approved signals against 1m candle data.
     * entryOffset is the candle index where signals were generated.
     */
    simulateExits(signals: ManipulationSignal[], candles1m: OhlcvData[], entryOffset: number): HuntrixBTTrade[] {
        const trades: HuntrixBTTrade[] = [];
        const detector = new DumpDetector(this.config);

        for (const signal of signals) {
            const entryIdx = entryOffset;
            const entryPrice = signal.price_at_detection;
            if (entryIdx >= candles1m.length - 1) continue;

            const entryTimestamp = candles1m[entryIdx].timestamp;
            const positionId = signal.id;

            // Build synthetic HunterPosition
            const position: HunterPosition = {
                id: positionId,
                symbol: signal.symbol,
                exchange: signal.exchange,
                entry_price: entryPrice,
                current_price: entryPrice,
                size_usd: 25,
                quantity: 25 / entryPrice,
                unrealized_pnl: 0,
                unrealized_pnl_pct: 0,
                signal,
                price_history: [],
                trailing_high: entryPrice,
                trailing_active: false,
                entered_at: new Date(entryTimestamp).toISOString(),
                exit_reason: null,
                exit_price: null,
                exited_at: null,
            };

            let exitIdx = -1;
            let exitReason: ExitReason = 'max_hold_time';
            let exitPrice = entryPrice;

            // Replay candles from entry+1
            for (let i = entryIdx + 1; i < candles1m.length; i++) {
                const candle = candles1m[i];

                // Update position state
                position.current_price = candle.close;
                position.unrealized_pnl = (candle.close - entryPrice) * position.quantity;
                position.unrealized_pnl_pct = ((candle.close - entryPrice) / entryPrice) * 100;
                position.price_history.push({
                    price: candle.close,
                    timestamp: candle.timestamp,
                    volume: candle.volume,
                });

                // Update trailing stop
                detector.updateTrailing(position);

                // Check max hold time ourselves (DumpDetector uses Date.now())
                const holdMinutes = (candle.timestamp - entryTimestamp) / 60_000;
                if (holdMinutes >= this.config.exits.max_hold_minutes) {
                    exitIdx = i;
                    exitReason = 'max_hold_time';
                    exitPrice = candle.close;
                    break;
                }

                // Check other exits via DumpDetector (SL/TP/trailing/velocity/volume)
                const exitSignal = detector.check(position);
                if (exitSignal && exitSignal.should_exit && exitSignal.reason !== 'max_hold_time') {
                    exitIdx = i;
                    exitReason = exitSignal.reason;
                    exitPrice = candle.close;
                    break;
                }
            }

            // If no exit triggered, exit at last candle
            if (exitIdx === -1) {
                exitIdx = candles1m.length - 1;
                exitPrice = candles1m[exitIdx].close;
            }

            const pnl = exitPrice - entryPrice;
            const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
            const holdMinutes = (candles1m[exitIdx].timestamp - entryTimestamp) / 60_000;

            trades.push({
                symbol: signal.symbol,
                exchange: signal.exchange,
                entryIdx,
                exitIdx,
                entryPrice,
                exitPrice,
                entryTimestamp,
                pnl,
                pnlPct,
                holdMinutes,
                exitReason,
                signalType: signal.type,
                signalConfidence: signal.confidence,
                phase: signal.phase,
            });

            detector.cleanup(positionId);
        }

        return trades;
    }

    /**
     * Compute metrics from pre-computed trades.
     * Use this when trades come from per-signal exit simulation (different entry offsets).
     */
    computeMetrics(
        trades: HuntrixBTTrade[],
        signalsGenerated: number,
        signalsApproved: number,
        pumpProfiles?: PumpProfile[],
    ): HuntrixBacktestResult {
        const wins = trades.filter(t => t.pnl > 0).length;
        const losses = trades.filter(t => t.pnl <= 0).length;
        const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
        const winRate = trades.length > 0 ? wins / trades.length : 0;
        const avgHoldMinutes = trades.length > 0
            ? trades.reduce((sum, t) => sum + t.holdMinutes, 0) / trades.length
            : 0;

        // Exit breakdown
        const exitBreakdown: Record<string, number> = {};
        for (const t of trades) {
            exitBreakdown[t.exitReason] = (exitBreakdown[t.exitReason] ?? 0) + 1;
        }

        // Equity curve (EquityPoint[] for dashboard compatibility)
        let equity = 100;
        let peak = equity;
        let maxDrawdown = 0;
        const equityCurve: EquityPoint[] = [{ date: new Date(trades[0]?.entryTimestamp ?? Date.now()), equity, drawdown: 0 }];

        for (const t of trades) {
            equity += t.pnl;
            if (equity > peak) peak = equity;
            const dd = ((peak - equity) / peak) * 100;
            if (dd > maxDrawdown) maxDrawdown = dd;
            equityCurve.push({ date: new Date(t.entryTimestamp), equity, drawdown: dd });
        }

        // Sharpe ratio (annualized from per-trade returns)
        let sharpe = 0;
        if (trades.length > 1) {
            const returns = trades.map(t => t.pnlPct / 100);
            const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / (returns.length - 1);
            const stdDev = Math.sqrt(variance);
            sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
        }

        // Calibration
        let calibration: CalibrationResult | null = null;
        if (pumpProfiles && pumpProfiles.length > 0) {
            calibration = this.calibrate(trades, pumpProfiles);
        }

        return {
            trades,
            totalPnl,
            winRate,
            wins,
            losses,
            maxDrawdownPct: maxDrawdown,
            sharpeRatio: sharpe,
            equityCurve,
            avgHoldMinutes,
            exitBreakdown,
            signalsGenerated,
            signalsApproved,
            approvalRate: signalsGenerated > 0 ? signalsApproved / signalsGenerated : 0,
            calibration,
        };
    }

    /**
     * Calibrate against real pump profiles.
     * Matches by symbol + ±5 minute time window.
     */
    private calibrate(trades: HuntrixBTTrade[], profiles: PumpProfile[]): CalibrationResult {
        const WINDOW_MS = 5 * 60_000; // ±5 minutes
        let matched = 0;

        const matchedProfileIds = new Set<string>();

        for (const trade of trades) {
            const tradeTime = trade.entryTimestamp;
            for (const profile of profiles) {
                if (matchedProfileIds.has(profile.id)) continue;
                const baseSymbol = trade.symbol.split('/')[0];
                if (!profile.symbol.includes(baseSymbol)) continue;

                // Time window match: ±5 minutes
                const profileTime = new Date(profile.detected_at).getTime();
                if (Math.abs(tradeTime - profileTime) <= WINDOW_MS) {
                    matchedProfileIds.add(profile.id);
                    matched++;
                    break;
                }
            }
        }

        const falsePositives = trades.length - matched;
        const unmatchedProfiles = profiles.length - matchedProfileIds.size;

        return {
            precision: trades.length > 0 ? matched / trades.length : 0,
            recall: profiles.length > 0 ? matchedProfileIds.size / profiles.length : 0,
            matchedProfiles: matched,
            unmatchedProfiles,
            falsePositives,
        };
    }

    private getMinConfidence(type: string): number {
        switch (type) {
            case 'pump_and_dump': return 70;
            case 'coordinated_shill':
            case 'influencer_pump': return 65;
            case 'whale_accumulation': return 75;
            default: return 70;
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/backtester.test.ts 2>&1 | tail -15`
Expected: All 9 tests pass (3 signal generator + 6 backtester)

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/huntrix/backtester.ts packages/agents/src/huntrix/__tests__/backtester.test.ts
git commit -m "feat(huntrix): add HuntrixBacktester with entry/exit simulation"
```

---

### Task 3: CLI Runner — huntrix_backtest.ts

**Files:**
- Create: `scripts/strategy-lab/huntrix_backtest.ts`

- [ ] **Step 1: Implement CLI runner**

```typescript
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
```

- [ ] **Step 2: Verify script parses**

Run: `npx tsx -e "require('./scripts/strategy-lab/huntrix_backtest.ts')" 2>&1 | head -5`
Expected: Script starts (will fail at missing --symbol but proves no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add scripts/strategy-lab/huntrix_backtest.ts
git commit -m "feat(huntrix): add backtest CLI runner with OHLCV pagination"
```

---

### Task 4: Integration test — run a real backtest

**Files:**
- No new files — runs the CLI

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run packages/agents/src/huntrix/ 2>&1 | tail -15`
Expected: All tests pass (existing 34 + new 8 = 42)

- [ ] **Step 2: Run a real backtest (7 days, small dataset)**

Run: `npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol BTC/USDC --days 7 2>&1`
Expected: Output shows signal generation, trade results, and metrics. May show 0 signals if BTC hasn't had volume spikes — that's OK, it validates the pipeline runs end-to-end.

- [ ] **Step 3: Run with a more volatile pair**

Run: `npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol DOGE/USDC --days 14 2>&1`
Expected: Should find more signals on a meme coin. Validates the synthetic signal generator works with real volatile data.

- [ ] **Step 4: Run with JSON output**

Run: `npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol BTC/USDC --days 7 --json 2>&1 | tail -20`
Expected: Valid JSON output with all HuntrixBacktestResult fields.

- [ ] **Step 5: Commit any fixes discovered during integration testing**

If any issues found, fix and commit. Otherwise skip.

---

### Task 5: Full verification

**Files:**
- All modified files

- [ ] **Step 1: Run all huntrix tests**

Run: `npx vitest run packages/agents/src/huntrix/ 2>&1 | tail -15`
Expected: All tests pass

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit 2>&1 | grep -i huntrix | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(huntrix): complete backtester with signal generation and exit replay"
```
