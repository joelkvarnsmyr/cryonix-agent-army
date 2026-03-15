import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import { StatePublisher } from '../aktienix/state-publisher';
import { MarketScanner } from './market-scanner';
import { SpreadDetector } from './spread-detector';
import { DirectionalEngine } from './directional-engine';
import { PolynixRiskManager } from './risk-manager';
import { PositionTracker } from './position-tracker';
import { OrderManager } from './order-manager';
import { loadPolynixConfig } from './config';
import type { PolynixConfig, PolynixAccountState } from './types';

export class PolynixAgent extends BaseAgent {
    private isRunning = false;
    private tomlConfig: PolynixConfig;

    private scanner: MarketScanner;
    private spreadDetector: SpreadDetector;
    private directionalEngine: DirectionalEngine;
    private riskManager: PolynixRiskManager;
    private positionTracker: PositionTracker;
    private orderManager: OrderManager;
    private statePublisher: StatePublisher | null = null;

    private accountState: PolynixAccountState;
    private lastHeartbeatLog = 0;
    private scanCount = 0;

    constructor(agentConfig: AgentConfig) {
        super(agentConfig);
        this.tomlConfig = loadPolynixConfig();

        this.scanner = new MarketScanner(this.tomlConfig);
        this.spreadDetector = new SpreadDetector(this.tomlConfig);
        this.directionalEngine = new DirectionalEngine();
        this.riskManager = new PolynixRiskManager();
        this.positionTracker = new PositionTracker();
        this.orderManager = new OrderManager(this.tomlConfig);

        this.accountState = {
            balance: this.tomlConfig.capital.starting_balance_usd,
            totalPnl: 0,
            openPositions: 0,
            tradesTotal: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
        };
    }

    async initialize(): Promise<void> {
        this.log('info', 'Initializing Polynix Agent (Polymarket 5-min binary options)...');

        const kvUrl = process.env.KV_URL;
        if (kvUrl) {
            this.statePublisher = new StatePublisher(kvUrl, 'polynix');
            this.log('info', 'StatePublisher initialized (Redis).');
        } else {
            this.log('warn', 'KV_URL not set — state will not be published to Redis.');
        }

        // Seed initial price data
        await this.directionalEngine.fetchPrices(this.tomlConfig);

        this.setStatus('idle');
        this.log('info', `Paper mode: ${this.tomlConfig.broker.paper_trading}`);
        this.log('info', `Starting balance: $${this.tomlConfig.capital.starting_balance_usd}`);
        this.log('info', `Arb threshold: ${this.tomlConfig.strategy.arb_threshold} (net after ${(this.tomlConfig.risk.fee_rate * 200).toFixed(1)}% round-trip fees)`);
        this.log('info', `Min directional edge: ${this.tomlConfig.strategy.min_edge_pct}%`);
        this.log('info', 'Initialization complete.');
    }

    async start(): Promise<void> {
        this.log('info', 'Starting Polynix trading loop...');
        this.setStatus('running');
        this.isRunning = true;

        await this.statePublisher?.publishStatus('running');

        while (this.isRunning) {
            try {
                await this.runLoop();
            } catch (error: any) {
                this.log('error', `Loop error: ${error.message}`);
            }

            // Interruptible sleep
            const pollMs = this.tomlConfig.timing.scan_interval_ms;
            const tick = 250;
            for (let elapsed = 0; elapsed < pollMs && this.isRunning; elapsed += tick) {
                await this.sleep(Math.min(tick, pollMs - elapsed));
            }
        }

        this.log('info', 'Trading loop exited.');
    }

    async stop(): Promise<void> {
        this.log('info', 'Stopping Polynix Agent...');
        this.isRunning = false;
        await this.statePublisher?.publishStatus('stopped');
        await this.statePublisher?.disconnect();
        this.setStatus('paused');
    }

    async handleMessage(message: AgentMessage): Promise<void> {
        this.log('info', `Received message: ${message.message_type}`, message.data);
    }

    // -------------------------------------------------------------------------
    // Main loop
    // -------------------------------------------------------------------------

    private async runLoop(): Promise<void> {
        this.scanCount++;

        // 1. Settle any expired positions
        const settled = await this.positionTracker.settleExpired();
        for (const pos of settled) {
            this.riskManager.recordResult(pos.pnl);
            this.accountState.balance += pos.pnl;
            this.accountState.totalPnl += pos.pnl;
            this.accountState.tradesTotal++;
            if (pos.pnl >= 0) {
                this.accountState.wins++;
            } else {
                this.accountState.losses++;
            }
            this.accountState.winRate = this.accountState.tradesTotal > 0
                ? (this.accountState.wins / this.accountState.tradesTotal) * 100
                : 0;

            const emoji = pos.pnl >= 0 ? 'WIN' : 'LOSS';
            this.log('info', `Settled [${pos.type}]: ${pos.market.title} -> ${emoji} $${pos.pnl.toFixed(2)} (balance: $${this.accountState.balance.toFixed(2)})`);
        }

        // 2. Fetch latest CEX prices
        await this.directionalEngine.fetchPrices(this.tomlConfig);

        // 3. Scan for active markets
        const markets = await this.scanner.scan(this.tomlConfig);

        let arbsFound = 0;
        let signalsFound = 0;

        for (const market of markets) {
            // 4a. Check for arbitrage
            try {
                const arb = await this.spreadDetector.check(market, this.tomlConfig);
                if (arb && arb.netEdge > 0) {
                    arbsFound++;
                    const risk = this.riskManager.check(
                        arb.netEdge,
                        0.99, // 99% win probability for arb
                        this.tomlConfig,
                        this.positionTracker.getOpenCount(),
                        this.positionTracker.getExposure(),
                    );

                    if (risk.canTrade) {
                        const size = Math.min(risk.suggestedSize, arb.maxSize);
                        const orders = await this.orderManager.placeArbOrders(arb, size);

                        if (orders.yesOrder.status === 'filled' && orders.noOrder.status === 'filled') {
                            const costBasis = arb.combinedCost * size;
                            this.positionTracker.addPosition(
                                market, 'arb', 'BOTH',
                                arb.combinedCost, size, costBasis,
                            );
                            this.accountState.balance -= costBasis;
                            this.log('info', `ARB ENTRY: ${market.title} | cost=$${arb.combinedCost.toFixed(4)} | edge=${(arb.netEdge * 100).toFixed(2)}% | size=$${size.toFixed(2)} | expires=${market.timeToExpiry.toFixed(0)}s`);

                            await this.logSignal('arb', market.title, arb.netEdge, 'BOTH', true);
                        }
                    } else {
                        this.log('info', `ARB blocked: ${market.title} (${risk.reason})`);
                    }
                }
            } catch (err: any) {
                this.log('warn', `Arb check error for ${market.title}: ${err.message}`);
            }

            // 4b. Check for directional signal
            try {
                const signal = await this.directionalEngine.evaluate(market, this.spreadDetector, this.tomlConfig);
                if (signal && signal.edge > this.tomlConfig.strategy.min_edge_pct / 100) {
                    signalsFound++;
                    const risk = this.riskManager.check(
                        signal.edge,
                        signal.confidence / 100,
                        this.tomlConfig,
                        this.positionTracker.getOpenCount(),
                        this.positionTracker.getExposure(),
                    );

                    if (risk.canTrade) {
                        const tokenId = signal.direction === 'YES' ? market.yesTokenId : market.noTokenId;
                        const price = signal.direction === 'YES' ? signal.polymarketProb : (1 - signal.polymarketProb);
                        const order = await this.orderManager.placeOrder(tokenId, 'BUY', price, risk.suggestedSize);

                        if (order.status === 'filled') {
                            const costBasis = price * risk.suggestedSize;
                            this.positionTracker.addPosition(
                                market, 'directional', signal.direction,
                                price, risk.suggestedSize, costBasis,
                            );
                            this.accountState.balance -= costBasis;
                            this.log('info', `DIRECTIONAL ${signal.direction}: ${market.title} | edge=${(signal.edge * 100).toFixed(2)}% | momentum=${signal.priceChangePct.toFixed(3)}% | conf=${signal.confidence} | size=$${risk.suggestedSize.toFixed(2)}`);

                            await this.logSignal('directional', market.title, signal.edge, signal.direction, true);
                        }
                    } else {
                        this.log('info', `DIRECTIONAL blocked: ${market.title} ${signal.direction} (${risk.reason})`);
                    }
                }
            } catch (err: any) {
                this.log('warn', `Directional check error for ${market.title}: ${err.message}`);
            }
        }

        // 5. Update account state
        this.accountState.openPositions = this.positionTracker.getOpenCount();

        // 6. Publish state to Redis
        await this.publishState();

        // 7. Heartbeat log every 60s
        const now = Date.now();
        if (now - this.lastHeartbeatLog >= 60_000) {
            this.lastHeartbeatLog = now;
            this.log('info', [
                `Heartbeat #${this.scanCount}:`,
                `markets=${markets.length}`,
                `arbs=${arbsFound}`,
                `signals=${signalsFound}`,
                `open=${this.accountState.openPositions}`,
                `balance=$${this.accountState.balance.toFixed(2)}`,
                `pnl=$${this.accountState.totalPnl.toFixed(2)}`,
                `trades=${this.accountState.tradesTotal}`,
                `WR=${this.accountState.winRate.toFixed(0)}%`,
                `losses_streak=${this.riskManager.getConsecutiveLosses()}`,
            ].join(' | '));
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private async publishState(): Promise<void> {
        if (!this.statePublisher) return;

        try {
            await this.statePublisher.set(
                'polynix:account',
                JSON.stringify(this.accountState),
            );
            await this.statePublisher.set(
                'polynix:positions',
                JSON.stringify(this.positionTracker.getOpen()),
            );
            await this.statePublisher.set(
                'polynix:risk',
                JSON.stringify(this.riskManager.getState()),
            );
        } catch {
            // Non-critical
        }
    }

    private async logSignal(
        type: string,
        market: string,
        edge: number,
        direction: string,
        executed: boolean,
    ): Promise<void> {
        if (!this.statePublisher) return;
        try {
            const signal = JSON.stringify({
                timestamp: Date.now(),
                type,
                market,
                edge: (edge * 100).toFixed(2),
                direction,
                executed,
            });
            await this.statePublisher.set('polynix:last_signal', signal);
        } catch {
            // Non-critical
        }
    }
}
