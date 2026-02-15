import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutorAgent, ExecuteOrderRequest } from '../executor-agent';
import { MockExchange } from '../../__tests__/utils/mock-exchange';

// Mock CCXT
vi.mock('ccxt', async () => {
    // Import Actual MockExchange class from utils
    // Using relative path from this test file
    const mod = await vi.importActual<any>('../../__tests__/utils/mock-exchange');
    return {
        default: {
            binance: mod.MockExchange
        }
    };
});

describe('ExecutorAgent', () => {
    let agent: ExecutorAgent;
    let mockExchange: MockExchange; // We can access the instance via the agent if we cast it

    beforeEach(async () => {
        agent = new ExecutorAgent({
            exchange: 'binance_testnet',
            maxSlippagePercent: 1.0,
            retryAttempts: 1, // Faster tests
            positionMonitorIntervalMs: 100 // Fast monitoring
        });
        await agent.initialize();
        await agent.start();

        // Access the internal exchange instance
        mockExchange = (agent as any).exchange as MockExchange;
        mockExchange.reset();
    });

    afterEach(async () => {
        await agent.stop();
        vi.clearAllMocks();
    });

    it('should initialize and connect to exchange', () => {
        expect(mockExchange).toBeDefined();
        expect(mockExchange.id).toBe('mock');
    });

    it('should execute market order successfully', async () => {
        const request: ExecuteOrderRequest = {
            signalId: 'sig1',
            symbol: 'BTC/USDT',
            side: 'BUY',
            quantity: 0.1,
            entryPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            orderType: 'market',
            confidence: 0.9,
            pattern: 'TestPattern'
        };

        const result = await agent.executeOrder(request);

        expect(result.success).toBe(true);
        expect(result.status).toBe('filled');
        expect(result.executedQuantity).toBe(0.1);

        // Verify position created
        const positions = agent.getOpenPositions();
        expect(positions.length).toBe(1);
        expect(positions[0].symbol).toBe('BTC/USDT');
    });

    it('should block order if slippage is too high', async () => {
        // Force ticker to return higher price
        // We can spy on fetchTicker of the mock instance
        vi.spyOn(mockExchange, 'fetchTicker').mockResolvedValue({
            last: 55000, // 10% higher than entry 50000
        } as any);

        const request: ExecuteOrderRequest = {
            signalId: 'sig2',
            symbol: 'BTC/USDT',
            side: 'BUY',
            quantity: 0.1,
            entryPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            orderType: 'market',
            confidence: 0.9,
            pattern: 'TestPattern'
        };

        // Suppress console.warn during test
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

        const result = await agent.executeOrder(request);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Slippage too high');

        consoleSpy.mockRestore();
    });

    it('should place protective orders after execution', async () => {
        const request: ExecuteOrderRequest = {
            signalId: 'sig3',
            symbol: 'ETH/USDT',
            side: 'BUY',
            quantity: 1,
            entryPrice: 3000,
            stopLoss: 2900,
            takeProfit: 3200,
            orderType: 'market',
            confidence: 0.9,
            pattern: 'TestPattern'
        };

        const result = await agent.executeOrder(request);
        expect(result.success).toBe(true);

        // Verify orders in mock exchange
        // Should have 1 market buy (filled), 1 stop loss, 1 limit sell (TP)
        expect(mockExchange.orders.size).toBe(3);

        // Find the stop loss order
        const orders = Array.from(mockExchange.orders.values());
        const slOrder = orders.find(o => o.type === 'stop_loss_limit' || (o.type === 'limit' && o.side === 'sell' && o.price === 2900));
        // MockExchange creates stop_loss_limit
        // But let's just check ids on position
        const pos = agent.getOpenPositions()[0];
        expect(pos.stopLossOrderId).toBeDefined();
        expect(pos.takeProfitOrderId).toBeDefined();
    });

    it('should close position on stop loss via monitoring', async () => {
        // 1. Open Position
        const request: ExecuteOrderRequest = {
            signalId: 'sig4',
            symbol: 'BNB/USDT',
            side: 'BUY',
            quantity: 10,
            entryPrice: 400,
            stopLoss: 390, // Stop at 390
            takeProfit: 420,
            orderType: 'market',
            confidence: 0.9,
            pattern: 'TestPattern'
        };
        await agent.executeOrder(request);
        expect(agent.getOpenPositions().length).toBe(1);

        // 2. Mock Order Fill (since protective orders are placed)
        // Find the SL order in mock exchange
        const orders = Array.from(mockExchange.orders.values());
        const slOrder = orders.find(o => o.side === 'sell' && (o.type === 'stop_loss_limit' || o.type === 'limit'));

        if (slOrder) {
            mockExchange.fillOrder(slOrder.id, 390); // Fill at stop price
        } else {
            // If no order found, maybe failed to place? Check logs/implementation
            throw new Error('Stop loss order not found in mock exchange');
        }

        // 3. Trigger monitoring
        await (agent as any).monitorPositions();

        // 4. Verify position closed
        expect(agent.getOpenPositions().length).toBe(0);
        const closed = agent.getClosedPositions();
        expect(closed.length).toBe(1);
        expect(closed[0].exitReason).toBe('stop_loss');
        expect(closed[0].realizedPnl).toBeLessThan(0);
    });
});
