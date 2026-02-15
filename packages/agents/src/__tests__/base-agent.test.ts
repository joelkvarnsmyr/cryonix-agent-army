import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseAgent, AgentConfig } from '../base-agent';
import type { AgentMessage, AgentStatus } from '@cryonix/types';

/**
 * Concrete implementation of BaseAgent for testing
 * BaseAgent is abstract, so we need a concrete class to test it
 */
class TestAgent extends BaseAgent {
    public initializeCalled = false;
    public startCalled = false;
    public stopCalled = false;
    public lastMessage: AgentMessage | null = null;
    public shouldThrowOnInit = false;
    public shouldThrowOnStart = false;

    constructor(config?: Partial<AgentConfig>) {
        super({
            id: 'test_agent' as any,
            name: 'Test Agent',
            description: 'Agent for testing purposes',
            enabled: true,
            ...config,
        });
    }

    async initialize(): Promise<void> {
        if (this.shouldThrowOnInit) {
            throw new Error('Initialization failed');
        }
        this.initializeCalled = true;
        this.setStatus('idle');
    }

    async start(): Promise<void> {
        if (this.shouldThrowOnStart) {
            throw new Error('Start failed');
        }
        this.startCalled = true;
        this.setStatus('running');
    }

    async stop(): Promise<void> {
        this.stopCalled = true;
        this.setStatus('idle');
    }

    async handleMessage(message: AgentMessage): Promise<void> {
        this.lastMessage = message;
    }

    // Expose protected methods for testing
    public testEmit(event: string, data: any): void {
        this.emit(event, data);
    }

    public testLog(level: 'info' | 'warn' | 'error', message: string, data?: any): void {
        this.log(level, message, data);
    }

    public async testSleep(ms: number): Promise<void> {
        return this.sleep(ms);
    }

    public getMessageQueue(): AgentMessage[] {
        return this.messageQueue;
    }
}

describe('BaseAgent', () => {
    let agent: TestAgent;
    let consoleSpy: {
        log: ReturnType<typeof vi.spyOn>;
        info: ReturnType<typeof vi.spyOn>;
        warn: ReturnType<typeof vi.spyOn>;
        error: ReturnType<typeof vi.spyOn>;
    };

    beforeEach(() => {
        agent = new TestAgent();
        consoleSpy = {
            log: vi.spyOn(console, 'log').mockImplementation(() => {}),
            info: vi.spyOn(console, 'info').mockImplementation(() => {}),
            warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
            error: vi.spyOn(console, 'error').mockImplementation(() => {}),
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('Lifecycle', () => {
        describe('initialize()', () => {
            it('should call initialize and set status to idle', async () => {
                await agent.initialize();

                expect(agent.initializeCalled).toBe(true);
                expect(agent.getStatus()).toBe('idle');
            });

            it('should throw error when initialization fails', async () => {
                agent.shouldThrowOnInit = true;

                await expect(agent.initialize()).rejects.toThrow('Initialization failed');
            });
        });

        describe('start()', () => {
            it('should call start and set status to running', async () => {
                await agent.start();

                expect(agent.startCalled).toBe(true);
                expect(agent.getStatus()).toBe('running');
            });

            it('should throw error when start fails', async () => {
                agent.shouldThrowOnStart = true;

                await expect(agent.start()).rejects.toThrow('Start failed');
            });
        });

        describe('stop()', () => {
            it('should call stop and set status to idle', async () => {
                await agent.start();
                await agent.stop();

                expect(agent.stopCalled).toBe(true);
                expect(agent.getStatus()).toBe('idle');
            });

            it('should be able to stop even if not started', async () => {
                await agent.stop();

                expect(agent.stopCalled).toBe(true);
                expect(agent.getStatus()).toBe('idle');
            });
        });

        describe('full lifecycle', () => {
            it('should transition through all states correctly', async () => {
                // Initial state
                expect(agent.getStatus()).toBe('idle');

                // Initialize
                await agent.initialize();
                expect(agent.getStatus()).toBe('idle');

                // Start
                await agent.start();
                expect(agent.getStatus()).toBe('running');

                // Stop
                await agent.stop();
                expect(agent.getStatus()).toBe('idle');
            });

            it('should allow restart after stop', async () => {
                await agent.initialize();
                await agent.start();
                await agent.stop();

                // Reset flags
                agent.startCalled = false;

                await agent.start();

                expect(agent.startCalled).toBe(true);
                expect(agent.getStatus()).toBe('running');
            });
        });
    });

    describe('Status Management', () => {
        it('should return current status via getStatus()', () => {
            expect(agent.getStatus()).toBe('idle');
        });

        it('should set status and emit event via setStatus()', () => {
            agent.setStatus('running');

            expect(agent.getStatus()).toBe('running');
            expect(consoleSpy.log).toHaveBeenCalledWith(
                expect.stringContaining('[test_agent]'),
                expect.stringContaining('status_change'),
                expect.objectContaining({ agent_id: 'test_agent', status: 'running' })
            );
        });

        it('should handle all valid status values', () => {
            const statuses: AgentStatus[] = ['idle', 'running', 'paused', 'error'];

            for (const status of statuses) {
                agent.setStatus(status);
                expect(agent.getStatus()).toBe(status);
            }
        });
    });

    describe('Message Handling', () => {
        it('should handle messages via handleMessage()', async () => {
            const message: AgentMessage = {
                agent_id: 'orchestrator',
                timestamp: new Date(),
                message_type: 'TEST_MESSAGE',
                priority: 'MEDIUM',
                data: { test: 'data' },
                requires_approval: false,
            };

            await agent.handleMessage(message);

            expect(agent.lastMessage).toEqual(message);
        });

        it('should handle high priority messages', async () => {
            const message: AgentMessage = {
                agent_id: 'orchestrator',
                timestamp: new Date(),
                message_type: 'EMERGENCY',
                priority: 'CRITICAL',
                data: { action: 'stop_trading' },
                requires_approval: true,
            };

            await agent.handleMessage(message);

            expect(agent.lastMessage).toEqual(message);
            expect(agent.lastMessage?.priority).toBe('CRITICAL');
        });

        it('should process messages with different types', async () => {
            const messageTypes = ['RISK_CHECK', 'POSITION_OPENED', 'POSITION_CLOSED', 'SIGNAL'];

            for (const messageType of messageTypes) {
                const message: AgentMessage = {
                    agent_id: 'test',
                    timestamp: new Date(),
                    message_type: messageType,
                    priority: 'MEDIUM',
                    data: {},
                    requires_approval: false,
                };

                await agent.handleMessage(message);
                expect(agent.lastMessage?.message_type).toBe(messageType);
            }
        });
    });

    describe('Configuration', () => {
        it('should return agent ID via getId()', () => {
            expect(agent.getId()).toBe('test_agent');
        });

        it('should return agent name via getName()', () => {
            expect(agent.getName()).toBe('Test Agent');
        });

        it('should accept custom configuration', () => {
            const customAgent = new TestAgent({
                id: 'custom_agent' as any,
                name: 'Custom Agent',
                description: 'A custom agent',
                enabled: false,
            });

            expect(customAgent.getId()).toBe('custom_agent');
            expect(customAgent.getName()).toBe('Custom Agent');
        });
    });

    describe('Event Emission', () => {
        it('should emit events with correct format', () => {
            agent.testEmit('test_event', { value: 123 });

            expect(consoleSpy.log).toHaveBeenCalledWith(
                expect.stringContaining('[test_agent]'),
                expect.stringContaining('test_event'),
                expect.objectContaining({ value: 123 })
            );
        });

        it('should emit events with complex data', () => {
            const complexData = {
                nested: { deep: { value: 'test' } },
                array: [1, 2, 3],
                date: new Date().toISOString(),
            };

            agent.testEmit('complex_event', complexData);

            expect(consoleSpy.log).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),
                expect.objectContaining(complexData)
            );
        });
    });

    describe('Logging', () => {
        it('should log info messages', () => {
            agent.testLog('info', 'Test info message', { extra: 'data' });

            expect(consoleSpy.info).toHaveBeenCalledWith(
                expect.stringMatching(/\[\d{4}-\d{2}-\d{2}.*\] \[test_agent\] Test info message/),
                expect.objectContaining({ extra: 'data' })
            );
        });

        it('should log warning messages', () => {
            agent.testLog('warn', 'Test warning message');

            expect(consoleSpy.warn).toHaveBeenCalledWith(
                expect.stringMatching(/\[\d{4}-\d{2}-\d{2}.*\] \[test_agent\] Test warning message/),
                ''
            );
        });

        it('should log error messages', () => {
            agent.testLog('error', 'Test error message', { error: 'details' });

            expect(consoleSpy.error).toHaveBeenCalledWith(
                expect.stringMatching(/\[\d{4}-\d{2}-\d{2}.*\] \[test_agent\] Test error message/),
                expect.objectContaining({ error: 'details' })
            );
        });

        it('should include timestamp in logs', () => {
            agent.testLog('info', 'Timestamp test');

            expect(consoleSpy.info).toHaveBeenCalledWith(
                expect.stringMatching(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
                ''
            );
        });
    });

    describe('Utility Methods', () => {
        describe('sleep()', () => {
            it('should delay for specified milliseconds', async () => {
                const start = Date.now();
                await agent.testSleep(50);
                const elapsed = Date.now() - start;

                // Allow some tolerance for timing
                expect(elapsed).toBeGreaterThanOrEqual(45);
                expect(elapsed).toBeLessThan(150);
            });

            it('should resolve after delay', async () => {
                const result = await agent.testSleep(10);
                expect(result).toBeUndefined();
            });
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty message data', async () => {
            const message: AgentMessage = {
                agent_id: 'test',
                timestamp: new Date(),
                message_type: 'EMPTY',
                priority: 'LOW',
                data: null,
                requires_approval: false,
            };

            await agent.handleMessage(message);
            expect(agent.lastMessage?.data).toBeNull();
        });

        it('should handle rapid status changes', () => {
            const statuses: AgentStatus[] = ['running', 'paused', 'running', 'error', 'idle'];

            for (const status of statuses) {
                agent.setStatus(status);
            }

            expect(agent.getStatus()).toBe('idle');
        });

        it('should handle initialization timeout (mock)', async () => {
            const slowAgent = new TestAgent();
            const originalInit = slowAgent.initialize;

            slowAgent.initialize = async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
                await originalInit.call(slowAgent);
            };

            const startTime = Date.now();
            await slowAgent.initialize();
            const elapsed = Date.now() - startTime;

            expect(elapsed).toBeGreaterThanOrEqual(90);
            expect(slowAgent.initializeCalled).toBe(true);
        });
    });
});
