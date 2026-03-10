import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AktienixAgent, type AktienixAgentConfig } from '../aktienix-agent';

describe('AktienixAgent', () => {
    let agent: AktienixAgent;

    const mockConfig: AktienixAgentConfig = {
        id: 'orchestrator', // Must be a valid AgentId from @cryonix/types
        name: 'Aktienix Test Agent',
        description: 'Test stock agent',
        enabled: true,
        tradingConfig: {
            broker: 'mock',
            paperTrading: true,
            maxPositionSizeUsd: 100,
            accountType: 'cash',
        },
    };

    beforeEach(() => {
        agent = new AktienixAgent(mockConfig);
    });

    it('should initialize correctly with mock broker', async () => {
        await agent.initialize();
        expect(agent.getStatus()).toBe('idle');
    });

    it('should transition to running state on start', async () => {
        await agent.initialize();

        // start() runs an infinite loop, so we stop it after a short delay
        const startPromise = agent.start();
        await new Promise(resolve => setTimeout(resolve, 100));
        await agent.stop();
        await startPromise;

        // After stop, status should be 'paused'
        expect(agent.getStatus()).toBe('paused');
    });

    it('should transition to paused state on stop', async () => {
        await agent.initialize();
        await agent.stop();
        expect(agent.getStatus()).toBe('paused');
    });

    it('should handle TRADE_SIGNAL message', async () => {
        const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => { });

        await agent.initialize();

        await agent.handleMessage({
            agent_id: 'orchestrator',
            timestamp: new Date(),
            message_type: 'TRADE_SIGNAL',
            priority: 'HIGH',
            requires_approval: false,
            data: {
                symbol: 'AAPL',
                action: 'BUY',
                confidence: 0.85,
            },
        });

        // With mock broker (no brokerClient), we expect the "No broker client" warning
        // But the signal evaluation should still log the evaluation message
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Evaluating signal to BUY AAPL'),
            expect.anything()
        );

        consoleSpy.mockRestore();
    });

    it('should reject low-confidence signals', async () => {
        const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => { });

        await agent.initialize();

        await agent.handleMessage({
            agent_id: 'orchestrator',
            timestamp: new Date(),
            message_type: 'TRADE_SIGNAL',
            priority: 'LOW',
            requires_approval: false,
            data: {
                symbol: 'AAPL',
                action: 'BUY',
                confidence: 0.3, // Below 0.6 threshold
            },
        });

        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('below threshold'),
            expect.anything()
        );

        consoleSpy.mockRestore();
    });

    // --- Phase 4: Geopolitical Intelligence Layer ---

    it('should boost confidence on bullish macro event', async () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => { });

        const macroAgent = new AktienixAgent({
            id: 'orchestrator',
            name: 'Aktienix Macro Test Agent',
            description: 'Test macro boost',
            enabled: true,
            tradingConfig: {
                broker: 'mock',
                paperTrading: true,
                maxPositionSizeUsd: 100,
                accountType: 'cash',
                intelligence: {
                    enabled: true,
                    news_scan_interval_ms: 900_000,
                    macro_confidence_boost: 0.15,
                    macro_bearish_block: true,
                },
            },
        });

        // Mock XAI_API_KEY so StockNewsScanner does not warn about missing key
        process.env.XAI_API_KEY = 'mock-xai-key';
        await macroAgent.initialize();
        delete process.env.XAI_API_KEY;

        // Inject a bullish macro signal directly (bypasses live scan)
        macroAgent['activeMacroSignals'] = [
            {
                event: 'fed_rate_cut',
                impact: 'bullish',
                tickers: ['QQQ'],
                sectors: ['technology'],
                confidence: 0.9,
                reasoning: 'Fed pivot',
            },
        ];

        await macroAgent.handleMessage({
            agent_id: 'orchestrator',
            timestamp: new Date(),
            message_type: 'TRADE_SIGNAL',
            priority: 'HIGH',
            requires_approval: false,
            data: {
                symbol: 'QQQ',
                action: 'BUY',
                confidence: 0.5,
            },
        });

        expect(infoSpy).toHaveBeenCalledWith(
            expect.stringContaining('MACRO BOOST'),
            expect.anything()
        );

        infoSpy.mockRestore();
    });

    it('should block buy on bearish macro event', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

        const macroAgent = new AktienixAgent({
            id: 'orchestrator',
            name: 'Aktienix Macro Block Test Agent',
            description: 'Test macro block',
            enabled: true,
            tradingConfig: {
                broker: 'mock',
                paperTrading: true,
                maxPositionSizeUsd: 100,
                accountType: 'cash',
                intelligence: {
                    enabled: true,
                    news_scan_interval_ms: 900_000,
                    macro_confidence_boost: 0.15,
                    macro_bearish_block: true,
                },
            },
        });

        process.env.XAI_API_KEY = 'mock-xai-key';
        await macroAgent.initialize();
        delete process.env.XAI_API_KEY;

        macroAgent['activeMacroSignals'] = [
            {
                event: 'fed_rate_hike',
                impact: 'bearish',
                tickers: ['QQQ'],
                sectors: ['technology'],
                confidence: 0.9,
                reasoning: 'Rate hike',
            },
        ];

        await macroAgent.handleMessage({
            agent_id: 'orchestrator',
            timestamp: new Date(),
            message_type: 'TRADE_SIGNAL',
            priority: 'HIGH',
            requires_approval: false,
            data: {
                symbol: 'QQQ',
                action: 'BUY',
                confidence: 0.75,
            },
        });

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('MACRO BLOCK'),
            expect.anything()
        );

        warnSpy.mockRestore();
    });

    it('should not block sell on bearish macro event', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

        const macroAgent = new AktienixAgent({
            id: 'orchestrator',
            name: 'Aktienix Macro Sell Test Agent',
            description: 'Test macro no block on sell',
            enabled: true,
            tradingConfig: {
                broker: 'mock',
                paperTrading: true,
                maxPositionSizeUsd: 100,
                accountType: 'cash',
                intelligence: {
                    enabled: true,
                    news_scan_interval_ms: 900_000,
                    macro_confidence_boost: 0.15,
                    macro_bearish_block: true,
                },
            },
        });

        process.env.XAI_API_KEY = 'mock-xai-key';
        await macroAgent.initialize();
        delete process.env.XAI_API_KEY;

        macroAgent['activeMacroSignals'] = [
            {
                event: 'fed_rate_hike',
                impact: 'bearish',
                tickers: ['QQQ'],
                sectors: ['technology'],
                confidence: 0.9,
                reasoning: 'Rate hike',
            },
        ];

        await macroAgent.handleMessage({
            agent_id: 'orchestrator',
            timestamp: new Date(),
            message_type: 'TRADE_SIGNAL',
            priority: 'HIGH',
            requires_approval: false,
            data: {
                symbol: 'QQQ',
                action: 'SELL',
                confidence: 0.75,
            },
        });

        // MACRO BLOCK must NOT appear — the block only applies to BUY orders
        expect(warnSpy).not.toHaveBeenCalledWith(
            expect.stringContaining('MACRO BLOCK'),
            expect.anything()
        );

        warnSpy.mockRestore();
    });
});
