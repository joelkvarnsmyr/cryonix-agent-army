import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PREDATORHUNTER_DEFAULTS } from '../predatorhunter/config';
import { EntryValidator } from '../predatorhunter/entry-validator';
import { DumpDetector } from '../predatorhunter/dump-detector';
import type { ManipulationSignal, HunterPosition, PredatorHunterConfig } from '../predatorhunter/types';

describe('Predator Hunter', () => {
    let baseConfig: PredatorHunterConfig;

    beforeEach(() => {
        // Deep copy defaults to avoid test cross-contamination
        baseConfig = JSON.parse(JSON.stringify(PREDATORHUNTER_DEFAULTS));
    });

    describe('Config', () => {
        it('should have valid defaults for paper trading', () => {
            expect(baseConfig.broker.paper_trading).toBe(true);
            expect(baseConfig.capital.virtual_balance).toBe(100);
            expect(baseConfig.capital.max_position_size_usd).toBe(25);
        });

        it('should have ultra-tight exit defaults', () => {
            expect(baseConfig.exits.sl_pct).toBe(5.0);
            expect(baseConfig.exits.dump_velocity_pct).toBe(3.0);
            expect(baseConfig.exits.dump_velocity_window_seconds).toBe(60);
        });
    });

    describe('EntryValidator', () => {
        let mockExchange: any;

        beforeEach(() => {
            mockExchange = {
                fetchTicker: vi.fn().mockResolvedValue({
                    last: 1.0, bid: 0.99, ask: 1.01, quoteVolume: 10000, percentage: 5.0
                }),
                _redis: { get: vi.fn() }
            };
        });

        it('should reject late pump phases', async () => {
            const mockRedis = { get: async () => null };
            const validator = new EntryValidator(baseConfig, mockExchange, mockRedis as any);
            const signal: ManipulationSignal = {
                id: '1', type: 'pump_and_dump', symbol: 'TEST/USDC', phase: 'peak',
                confidence: 90, shill_activity: [], total_shill_accounts: 10,
                price_at_detection: 1, volume_24h: 1000, volume_spike_ratio: 5,
                price_velocity: 5, reasoning: '', estimated_peak_minutes: null,
                detected_at: new Date().toISOString(), source: 'x_scan'
            };

            const result = await validator.validate(signal);
            expect(result.approved).toBe(false);
            expect(result.reasons.some(r => r.includes('Phase "peak"'))).toBe(true);
        });

        it('should reject low confidence signals', async () => {
            const mockRedis = { get: async () => null };
            const validator = new EntryValidator(baseConfig, mockExchange, mockRedis as any);
            const signal: ManipulationSignal = {
                id: '1', type: 'pump_and_dump', symbol: 'TEST/USDC', phase: 'early_pump',
                confidence: 40, // Below default 70
                shill_activity: [], total_shill_accounts: 10, price_at_detection: 1,
                volume_24h: 1000, volume_spike_ratio: 5, price_velocity: 5,
                reasoning: '', estimated_peak_minutes: null, detected_at: new Date().toISOString(), source: 'x_scan'
            };

            const result = await validator.validate(signal);
            expect(result.approved).toBe(false);
            expect(result.reasons.some(r => r.includes('< required'))).toBe(true);
        });

        it('should reject if already pumped too much', async () => {
            mockExchange.fetchTicker.mockResolvedValue({
                last: 1.5, bid: 1.49, ask: 1.51, quoteVolume: 10000,
                percentage: 25.0 // BaseConfig max is 20.0
            });

            const mockRedis = { get: async () => null };
            const validator = new EntryValidator(baseConfig, mockExchange, mockRedis as any);
            const signal: ManipulationSignal = {
                id: '1', type: 'pump_and_dump', symbol: 'TEST/USDC', phase: 'early_pump',
                confidence: 80, shill_activity: [], total_shill_accounts: 10,
                price_at_detection: 1, volume_24h: 1000, volume_spike_ratio: 5,
                price_velocity: 5, reasoning: '', estimated_peak_minutes: null,
                detected_at: new Date().toISOString(), source: 'x_scan'
            };

            const result = await validator.validate(signal);
            expect(result.approved).toBe(false);
            expect(result.reasons.some(r => r.includes('Already pumped'))).toBe(true);
        });

        it('should approve valid early phase pumps', async () => {
            mockExchange.fetchTicker.mockResolvedValue({
                last: 1.1, bid: 1.099, ask: 1.101, quoteVolume: 10000,
                percentage: 10.0
            });

            const mockRedis = { get: async () => null };
            const validator = new EntryValidator(baseConfig, mockExchange, mockRedis as any);
            const signal: ManipulationSignal = {
                id: '1', type: 'pump_and_dump', symbol: 'TEST/USDC', phase: 'early_pump',
                confidence: 80, shill_activity: [], total_shill_accounts: 10,
                price_at_detection: 1, volume_24h: 1000, volume_spike_ratio: 5,
                price_velocity: 5, reasoning: '', estimated_peak_minutes: null,
                detected_at: new Date().toISOString(), source: 'x_scan'
            };

            const result = await validator.validate(signal);
            expect(result.approved).toBe(true);
        });
    });

    describe('DumpDetector', () => {
        it('should trigger dump_velocity exit on rapid price drop', () => {
            const detector = new DumpDetector(baseConfig); // 3% drop in 60s
            
            const now = Date.now();
            const position: HunterPosition = {
                id: 'pos1', symbol: 'TEST/USDC', entry_price: 100, current_price: 96,
                size_usd: 100, quantity: 1, unrealized_pnl: -4, unrealized_pnl_pct: -4,
                signal: {} as any, entered_at: new Date().toISOString(),
                exit_reason: null, exit_price: null, exited_at: null,
                trailing_active: false, trailing_high: 100,
                price_history: [
                    { price: 100, timestamp: now - 30000, volume: 100 }, // 30s ago price was 100
                    { price: 96, timestamp: now, volume: 500 }           // Now price is 96 (4% drop in 30s)
                ]
            };

            const signal = detector.check(position);
            expect(signal).not.toBeNull();
            expect(signal?.should_exit).toBe(true);
            expect(signal?.reason).toBe('dump_velocity');
            expect(signal?.urgency).toBe('immediate');
        });

        it('should trigger trailing stop when active and drop exceeds pct', () => {
            const trailingConfig = { ...baseConfig };
            trailingConfig.exits.dump_velocity_pct = 100.0; // Disable dump velocity to isolate trailing stop
            const detector = new DumpDetector(trailingConfig); // 5% trailing stop
            
            const position: HunterPosition = {
                id: 'pos1', symbol: 'TEST/USDC', entry_price: 50, current_price: 94,
                size_usd: 100, quantity: 1, unrealized_pnl: 44, unrealized_pnl_pct: 88,
                signal: {} as any, entered_at: new Date().toISOString(),
                exit_reason: null, exit_price: null, exited_at: null,
                trailing_active: true, trailing_high: 100, // Dropped 6% from high (94/100)
                price_history: [
                    { price: 100, timestamp: Date.now() - 5000, volume: 100 },
                    { price: 94, timestamp: Date.now(), volume: 100 }
                ]
            };

            const signal = detector.check(position);
            expect(signal).not.toBeNull();
            expect(signal?.reason).toBe('trailing_stop');
        });

        it('should trigger volume reversal after 3 sell-heavy ticks', () => {
            const detector = new DumpDetector(baseConfig);
            
            const posBase = {
                id: 'pos2', symbol: 'TEST/USDC', entry_price: 100, current_price: 100,
                size_usd: 100, quantity: 1, unrealized_pnl: 0, unrealized_pnl_pct: 0,
                signal: {} as any, entered_at: new Date().toISOString(),
                exit_reason: null, exit_price: null, exited_at: null,
                trailing_active: false, trailing_high: 100
            };

            const now = Date.now();
            
            // Check 1: Price drops, volume > 0 -> Sell heavy 1
            const signal1 = detector.check({
                ...posBase,
                price_history: [
                    { price: 106, timestamp: now - 15000, volume: 100 },
                    { price: 105, timestamp: now - 10000, volume: 100 },
                    { price: 104, timestamp: now - 5000, volume: 500 }
                ]
            } as HunterPosition);
            expect(signal1).toBeNull();

            // Check 2: Price drops again -> Sell heavy 2
            const signal2 = detector.check({
                ...posBase,
                price_history: [
                    { price: 105, timestamp: now - 10000, volume: 100 },
                    { price: 104, timestamp: now - 5000, volume: 500 },
                    { price: 103, timestamp: now, volume: 600 }
                ]
            } as HunterPosition);
            expect(signal2).toBeNull();

            // Check 3: Price drops again -> Sell heavy 3! Should trigger exit
            const signal3 = detector.check({
                ...posBase,
                price_history: [
                    { price: 104, timestamp: now - 5000, volume: 500 },
                    { price: 103, timestamp: now, volume: 600 },
                    { price: 102, timestamp: now + 5000, volume: 700 }
                ]
            } as HunterPosition);
            
            expect(signal3).not.toBeNull();
            expect(signal3?.reason).toBe('volume_reversal');
        });
    });
});
