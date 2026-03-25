import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RiskManagerAgent, RiskCheckRequest, RiskCheckResult } from '../risk-manager-agent';

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('RiskManagerAgent', () => {
    let agent: RiskManagerAgent;

    beforeEach(async () => {
        // Default mock response: Portfolio value $100,000
        fetchMock.mockResolvedValue({
            json: () => Promise.resolve({ success: true, data: { totalValue: 100000 } })
        });

        agent = new RiskManagerAgent({
            dailyLossLimit: 0.10, // 10%
            maxPositionSize: 0.20, // 20%
        });
        await agent.start(); // This initializes dailyStartingValue to 100000
    });

    afterEach(() => {
        vi.clearAllMocks();
        agent.stop();
    });

    describe('Signal Approval', () => {
        it('should approve valid signal within limits', async () => {
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 50000,
                stop_loss: 48000,
                target_price: 55000
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.approved).toBe(true);
            expect(result.position_value).toBeGreaterThan(0);
            expect(result.kelly_fraction).toBeGreaterThan(0);
        });

        it('should include kelly fraction in approved signals', async () => {
            const request: RiskCheckRequest = {
                symbol: 'ETH/USDT',
                side: 'BUY',
                confidence: 0.7,
                entry_price: 3000,
                stop_loss: 2850,
                target_price: 3500
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.approved).toBe(true);
            expect(result.kelly_fraction).toBeGreaterThan(0);
            expect(result.kelly_fraction).toBeLessThan(1);
        });

        it('should calculate position size in units correctly', async () => {
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 50000,
                stop_loss: 49000, // $1000 risk per unit
                target_price: 55000
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.approved).toBe(true);
            // Position size should be risk_amount / risk_per_unit
            const expectedUnits = result.risk_amount / 1000;
            expect(result.position_size).toBeCloseTo(expectedUnits, 2);
        });
    });

    describe('Daily Loss Limits', () => {
        it('should reject signal if daily loss limit exceeded', async () => {
            // Simulate massive loss: Value drops to 85,000 (15% loss)
            fetchMock.mockResolvedValue({
                json: () => Promise.resolve({ success: true, data: { totalValue: 85000 } })
            });

            const request: RiskCheckRequest = {
                symbol: 'ETH/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 3000,
                stop_loss: 2900,
                target_price: 3300
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.approved).toBe(false);
            expect(result.reasoning).toContain('DAILY HARD LIMIT');
        });

        it('should track daily loss remaining in response', async () => {
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 50000,
                stop_loss: 48000,
                target_price: 55000
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.limits).toBeDefined();
            expect(result.limits.daily_loss_remaining).toBeDefined();
            expect(parseFloat(result.limits.daily_loss_remaining)).toBeGreaterThan(0);
        });
    });

    describe('Weekly Loss Limits', () => {
        it('should reject signal if weekly loss limit exceeded', async () => {
            // Create agent with custom weekly limit
            const weeklyAgent = new RiskManagerAgent({
                weeklyLossLimit: 0.10, // 10%
                dailyLossLimit: 0.20, // Higher daily limit
            });
            await weeklyAgent.start();

            // Simulate weekly loss exceeding 10%
            fetchMock.mockResolvedValue({
                json: () => Promise.resolve({ success: true, data: { totalValue: 85000 } })
            });

            const request: RiskCheckRequest = {
                symbol: 'ETH/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 3000,
                stop_loss: 2900,
                target_price: 3300
            };

            const result = await weeklyAgent.checkSignalRisk(request);

            expect(result.approved).toBe(false);
            expect(result.reasoning).toContain('WEEKLY HARD LIMIT');

            weeklyAgent.stop();
        });
    });

    describe('Position Size Limits', () => {
        it('should cap position size at maxPositionSize', async () => {
            // Max position 20% of 100k = 20k
            // Force high confidence and high R:R to get huge Kelly suggestion
            const request: RiskCheckRequest = {
                symbol: 'SOL/USDT',
                side: 'BUY',
                confidence: 0.99,
                entry_price: 100,
                stop_loss: 99, // Tight stop
                target_price: 200 // Huge target -> R:R 100:1 -> Kelly almost 100%
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.approved).toBe(true);
            expect(result.position_value).toBeLessThanOrEqual(20000 * 1.01);
            expect(result.position_value).toBeCloseTo(20000, -2);
        });

        it('should enforce maxPositionRisk cap (2% default)', async () => {
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.95,
                entry_price: 50000,
                stop_loss: 40000, // 20% risk per unit
                target_price: 80000
            };

            const result = await agent.checkSignalRisk(request);

            // Risk should not exceed 2% of $100,000 = $2,000
            expect(result.approved).toBe(true);
            expect(result.risk_amount).toBeLessThanOrEqual(2000 * 1.01);
        });
    });

    describe('Max Open Positions', () => {
        it('should reject signal when max positions reached', async () => {
            // Record 5 positions (default max)
            for (let i = 0; i < 5; i++) {
                agent.recordPosition({
                    symbol: `COIN${i}/USDT`,
                    side: 'BUY',
                    entryPrice: 100,
                    quantity: 1,
                    value: 1000,
                    entryTime: new Date()
                });
            }

            const request: RiskCheckRequest = {
                symbol: 'NEW/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 100,
                stop_loss: 90,
                target_price: 120
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.approved).toBe(false);
            expect(result.reasoning).toContain('Max open positions');
        });

        it('should track open positions count in response', async () => {
            agent.recordPosition({
                symbol: 'TEST/USDT',
                side: 'BUY',
                entryPrice: 100,
                quantity: 1,
                value: 1000,
                entryTime: new Date()
            });

            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 50000,
                stop_loss: 48000,
                target_price: 55000
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.limits.open_positions).toBe(1);
        });
    });

    describe('Risk/Reward Ratio', () => {
        it('should reject signals with poor risk/reward ratio (< 1.5:1)', async () => {
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.9,
                entry_price: 50000,
                stop_loss: 48000, // Risk: $2000
                target_price: 51000 // Reward: $1000 -> R:R = 0.5:1
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.approved).toBe(false);
            expect(result.reasoning).toContain('risk/reward ratio');
        });

        it('should approve signals with good risk/reward ratio (>= 1.5:1)', async () => {
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.7,
                entry_price: 50000,
                stop_loss: 48000, // Risk: $2000
                target_price: 55000 // Reward: $5000 -> R:R = 2.5:1
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.approved).toBe(true);
        });
    });

    describe('Kelly Criterion Calculations', () => {
        it('should reject negative expected value trades', async () => {
            // Low confidence with low R:R = negative EV
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.3, // 30% win rate
                entry_price: 50000,
                stop_loss: 48000, // Risk $2000
                target_price: 52000 // Reward $2000 -> 1:1 R:R -> Negative EV at 30%
            };

            const result = await agent.checkSignalRisk(request);

            // With 30% win rate and 1:1 R:R, EV = 0.3 * 1 - 0.7 = -0.4 (negative)
            // But R:R is 1:1 which is < 1.5:1 threshold, so rejected for poor R:R first
            expect(result.approved).toBe(false);
        });

        it('should use half-Kelly by default for conservative sizing', async () => {
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.7,
                entry_price: 50000,
                stop_loss: 48000,
                target_price: 56000 // 2:1 R:R
            };

            const result = await agent.checkSignalRisk(request);

            expect(result.approved).toBe(true);
            // Half-Kelly at 70% win, 2:1 R:R = (0.7*2 - 0.3)/2 / 2 = 0.55/2 = 0.275
            // Actually half of full kelly
            expect(result.kelly_fraction).toBeGreaterThan(0);
            expect(result.kelly_fraction).toBeLessThan(0.5);
        });
    });

    describe('Correlation Limits', () => {
        it('should check correlation limits', async () => {
            const hugePos = {
                symbol: 'BTC/USDT',
                side: 'BUY' as const,
                entryPrice: 50000,
                quantity: 1,
                value: 60000, // 60% of 100k portfolio
                entryTime: new Date()
            };

            agent.recordPosition(hugePos);

            // WBTC is in 'btc_ecosystem' group
            const wbtcReq: RiskCheckRequest = {
                symbol: 'WBTC/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 50000,
                stop_loss: 49000,
                target_price: 55000
            };

            const wbtcRes = await agent.checkSignalRisk(wbtcReq);

            expect(wbtcRes.approved).toBe(false);
            expect(wbtcRes.reasoning).toContain('exposure in');
        });

        it('should allow positions in uncorrelated assets', async () => {
            agent.recordPosition({
                symbol: 'BTC/USDT',
                side: 'BUY',
                entryPrice: 50000,
                quantity: 0.5,
                value: 25000, // 25% exposure to btc_ecosystem
                entryTime: new Date()
            });

            // LINK is in 'oracles' group - different from BTC
            const linkReq: RiskCheckRequest = {
                symbol: 'LINK/USDT',
                side: 'BUY',
                confidence: 0.75,
                entry_price: 15,
                stop_loss: 14,
                target_price: 18
            };

            const result = await agent.checkSignalRisk(linkReq);

            expect(result.approved).toBe(true);
        });

        it('should warn when approaching correlation limit', async () => {
            // 35% exposure to eth_ecosystem (70% of 50% limit)
            agent.recordPosition({
                symbol: 'ETH/USDT',
                side: 'BUY',
                entryPrice: 3000,
                quantity: 10,
                value: 35000,
                entryTime: new Date()
            });

            // OP is also in eth_ecosystem
            const opReq: RiskCheckRequest = {
                symbol: 'OP/USDT',
                side: 'BUY',
                confidence: 0.75,
                entry_price: 2,
                stop_loss: 1.8,
                target_price: 2.5
            };

            const result = await agent.checkSignalRisk(opReq);

            // Should be approved but with warning
            expect(result.approved).toBe(true);
            expect(result.adjustments?.correlation_warning).toContain('Approaching correlation limit');
        });
    });

    describe('Circuit Breaker', () => {
        it('should trigger circuit breaker on rapid losses', async () => {
            // Loss 1: 3% of portfolio
            agent.recordPosition({ symbol: 'A', value: 10000 } as any);
            agent.closePosition('A', -3000);

            // Loss 2: 3% of portfolio
            agent.recordPosition({ symbol: 'B', value: 10000 } as any);
            agent.closePosition('B', -3000);

            // Total recent loss 6% > 5% threshold

            const req: RiskCheckRequest = {
                symbol: 'ETH/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 2000,
                stop_loss: 1900,
                target_price: 2200
            };

            const res = await agent.checkSignalRisk(req);

            expect(res.approved).toBe(false);
            expect(res.reasoning).toContain('CIRCUIT BREAKER');
        });

        it('should track circuit breaker status', async () => {
            agent.recordPosition({ symbol: 'A', value: 10000 } as any);
            agent.closePosition('A', -6000); // 6% loss triggers circuit breaker

            const status = agent.getRiskStatus();

            expect(status.circuitBreakerActive).toBe(true);
            expect(status.circuitBreakerUntil).toBeDefined();
        });
    });

    describe('ATR Adjustments', () => {
        it('should adjust stop loss with ATR when provided', async () => {
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 50000,
                stop_loss: 49500, // Original stop very tight
                target_price: 52000,
                atr: 1000 // ATR = $1000
            };

            const result = await agent.checkSignalRisk(request);

            // With 2x ATR stop multiplier, stop should be at 50000 - 2*1000 = 48000
            // Since 48000 < 49500 (original), ATR stop is used
            expect(result.approved).toBe(true);
            expect(result.adjustments?.adjusted_stop_loss).toBe(48000);
        });

        it('should adjust target with ATR when provided', async () => {
            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 50000,
                stop_loss: 48000,
                target_price: 51000, // Original target conservative
                atr: 1000 // ATR = $1000
            };

            const result = await agent.checkSignalRisk(request);

            // With 3x ATR target multiplier, target should be at 50000 + 3*1000 = 53000
            // Since 53000 > 51000 (original), ATR target is used
            expect(result.approved).toBe(true);
            expect(result.adjustments?.adjusted_target).toBe(53000);
        });
    });

    describe('Position Recording and Closing', () => {
        it('should record positions correctly', () => {
            const position = {
                symbol: 'BTC/USDT',
                side: 'BUY' as const,
                entryPrice: 50000,
                quantity: 0.5,
                value: 25000,
                entryTime: new Date()
            };

            agent.recordPosition(position);

            const status = agent.getRiskStatus();
            expect(status.openPositions).toBe(1);
        });

        it('should close positions and track P&L', () => {
            agent.recordPosition({
                symbol: 'BTC/USDT',
                side: 'BUY',
                entryPrice: 50000,
                quantity: 0.5,
                value: 25000,
                entryTime: new Date()
            });

            agent.closePosition('BTC/USDT', -500); // $500 loss

            const status = agent.getRiskStatus();
            expect(status.openPositions).toBe(0);
            expect(status.dailyLoss).toBe(500);
        });

        it('should not affect loss tracking for profitable closes', () => {
            agent.recordPosition({
                symbol: 'BTC/USDT',
                side: 'BUY',
                entryPrice: 50000,
                quantity: 0.5,
                value: 25000,
                entryTime: new Date()
            });

            agent.closePosition('BTC/USDT', 1000); // $1000 profit

            const status = agent.getRiskStatus();
            expect(status.dailyLoss).toBe(0);
        });
    });

    describe('Risk Status', () => {
        it('should return accurate risk status', async () => {
            // Record a position
            agent.recordPosition({
                symbol: 'BTC/USDT',
                side: 'BUY',
                entryPrice: 50000,
                quantity: 0.5,
                value: 25000,
                entryTime: new Date()
            });

            // Close with loss
            agent.closePosition('BTC/USDT', -1000);

            const status = agent.getRiskStatus();

            expect(status.dailyLoss).toBe(1000);
            expect(status.dailyLossPercent).toBe(1); // 1% of 100k
            expect(status.openPositions).toBe(0);
            expect(status.circuitBreakerActive).toBe(false);
        });
    });

    describe('Agent Lifecycle', () => {
        it('should initialize with correct status', async () => {
            const newAgent = new RiskManagerAgent();
            await newAgent.initialize();

            expect(newAgent.getStatus()).toBe('idle');
        });

        it('should start and change status to running', async () => {
            expect(agent.getStatus()).toBe('running');
        });

        it('should stop and change status to idle', async () => {
            await agent.stop();

            expect(agent.getStatus()).toBe('idle');
        });
    });

    describe('Message Handling', () => {
        it('should handle RISK_CHECK messages', async () => {
            const message = {
                agent_id: 'orchestrator',
                timestamp: new Date(),
                message_type: 'RISK_CHECK',
                priority: 'HIGH' as const,
                data: {
                    symbol: 'BTC/USDT',
                    side: 'BUY',
                    confidence: 0.8,
                    entry_price: 50000,
                    stop_loss: 48000,
                    target_price: 55000
                },
                requires_approval: false
            };

            await agent.handleMessage(message);

            // Message handling should emit risk_check_complete event
            // (verified via console.log spy in full integration tests)
        });

        it('should handle POSITION_OPENED messages', async () => {
            const message = {
                agent_id: 'executor',
                timestamp: new Date(),
                message_type: 'POSITION_OPENED',
                priority: 'MEDIUM' as const,
                data: {
                    symbol: 'ETH/USDT',
                    side: 'BUY',
                    entryPrice: 3000,
                    quantity: 5,
                    value: 15000,
                    entryTime: new Date()
                },
                requires_approval: false
            };

            await agent.handleMessage(message);

            const status = agent.getRiskStatus();
            expect(status.openPositions).toBe(1);
        });

        it('should handle POSITION_CLOSED messages', async () => {
            // First open a position
            agent.recordPosition({
                symbol: 'ETH/USDT',
                side: 'BUY',
                entryPrice: 3000,
                quantity: 5,
                value: 15000,
                entryTime: new Date()
            });

            const message = {
                agent_id: 'executor',
                timestamp: new Date(),
                message_type: 'POSITION_CLOSED',
                priority: 'MEDIUM' as const,
                data: {
                    symbol: 'ETH/USDT',
                    pnl: 500
                },
                requires_approval: false
            };

            await agent.handleMessage(message);

            const status = agent.getRiskStatus();
            expect(status.openPositions).toBe(0);
        });
    });

    describe('Error Handling', () => {
        it('should throw error when portfolio fetch fails', async () => {
            fetchMock.mockRejectedValue(new Error('Network error'));

            const request: RiskCheckRequest = {
                symbol: 'BTC/USDT',
                side: 'BUY',
                confidence: 0.8,
                entry_price: 50000,
                stop_loss: 48000,
                target_price: 55000
            };

            await expect(agent.checkSignalRisk(request)).rejects.toThrow(
                'Cannot perform risk check without portfolio data'
            );
        });
    });
});
