import { describe, it, expect } from 'vitest';
import {
    calculateKellyFraction,
    calculateHalfKelly,
    calculateRiskRewardRatio,
    calculatePositionSize,
    calculatePositionUnits
} from '../kelly-criterion';

describe('Kelly Criterion', () => {
    describe('calculateKellyFraction', () => {
        it('should calculate correct fraction for standard inputs', () => {
            // Win Prob 50%, R:R 3:1
            // f = (3 * 0.5 - 0.5) / 3 = (1.5 - 0.5) / 3 = 1/3 = 0.333...
            const fraction = calculateKellyFraction(0.5, 3);
            expect(fraction).toBeCloseTo(0.3333, 4);
        });

        it('should return 0 for negative expected value', () => {
            // Win Prob 10%, R:R 1:1 -> EV Negative
            const fraction = calculateKellyFraction(0.1, 1);
            expect(fraction).toBe(0);
        });

        it('should throw error for invalid probability', () => {
            expect(() => calculateKellyFraction(1.5, 3)).toThrow();
            expect(() => calculateKellyFraction(-0.1, 3)).toThrow();
        });

        it('should throw error for invalid R:R', () => {
            expect(() => calculateKellyFraction(0.5, 0)).toThrow();
        });
    });

    describe('calculateHalfKelly', () => {
        it('should be exactly half of full kelly', () => {
            const full = calculateKellyFraction(0.6, 2);
            const half = calculateHalfKelly(0.6, 2);
            expect(half).toBe(full * 0.5);
        });
    });

    describe('calculateRiskRewardRatio', () => {
        it('should calculate correctly for LONG', () => {
            // Entry 100, Stop 90 (Risk 10), Target 130 (Reward 30) -> 3:1
            const rr = calculateRiskRewardRatio(100, 90, 130);
            expect(rr).toBe(3);
        });

        it('should calculate correctly for SHORT', () => {
            // Entry 100, Stop 110 (Risk 10), Target 70 (Reward 30) -> 3:1
            const rr = calculateRiskRewardRatio(100, 110, 70);
            expect(rr).toBe(3);
        });

        it('should throw if risk is zero', () => {
            expect(() => calculateRiskRewardRatio(100, 100, 110)).toThrow();
        });
    });

    describe('calculatePositionSize', () => {
        const defaultParams = {
            portfolioValue: 10000,
            kellyFraction: 0.1, // 10%
            maxRiskPercent: 0.02, // 2%
            maxPositionPercent: 0.30, // 30%
        };

        it('should use kelly size if within limits', () => {
            // Kelly suggests 10% ($1000). Max Risk 2% ($200).
            // Wait, Max Risk is usually "Risk per trade" (Entry-Stop).
            // But here `maxRiskPercent` seems to be used as a cap on TOTAL position value?
            // Code: if (positionSize > maxRiskAmount) ...
            // If maxRiskPercent logic in function is "Cap position size at X% of portfolio", then it conflicts with maxPositionPercent.

            // Let's check code:
            // const maxRiskAmount = portfolioValue * maxRiskPercent;
            // if (positionSize > maxRiskAmount) positionSize = maxRiskAmount;

            // In `risk-manager-agent.ts`, `maxRiskPercent` passed into `calculatePositionSize` params comes from `maxPositionRisk` (0.02).
            // So if maxPositionRisk is 2%, then the function caps position size to 2% of portfolio!
            // This implies we are only risking 2% of equity on the *position value*, which is extremely conservative if it means total size.
            // Usually "2% risk" means "I can lose 2% of portfolio if stop is hit".

            // But `calculatePositionSize` returns USD amount to invest.
            // If `maxRiskPercent` behaves like a hard cap on Principal, then yes.

            const size = calculatePositionSize({
                ...defaultParams,
                kellyFraction: 0.01, // 1% ($100)
                maxRiskPercent: 0.02, // $200
            });
            expect(size).toBe(100);
        });

        it('should cap at maxRiskPercent', () => {
            // Kelly suggests 10% ($1000). Max Risk Limit 2% ($200).
            const size = calculatePositionSize({
                ...defaultParams,
                kellyFraction: 0.1,
                maxRiskPercent: 0.02,
            });
            expect(size).toBe(200);
        });

        it('should cap at maxPositionPercent', () => {
            // Kelly suggests 50% ($5000). Max Risk 100% (ignore). Max Position 30% ($3000).
            const size = calculatePositionSize({
                portfolioValue: 10000,
                kellyFraction: 0.5,
                maxRiskPercent: 1.0,
                maxPositionPercent: 0.30,
            });
            expect(size).toBe(3000);
        });
    });

    describe('calculatePositionUnits', () => {
        it('should return correct units', () => {
            // Risking $100. Entry 100, Stop 90. Risk/Unit = 10.
            // Units = 100 / 10 = 10 units.
            const units = calculatePositionUnits(100, 100, 90);
            expect(units).toBe(10);
        });
    });
});
