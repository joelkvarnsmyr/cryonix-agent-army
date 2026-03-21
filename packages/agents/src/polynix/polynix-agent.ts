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
import { PolynixDbLogger } from './db-logger';
import { BayesianLearner } from './bayesian-learner';
import { MicroMarketScanner } from './micro-market-scanner';
import { PolynixExitMonitor } from './exit-monitor';
import { CopyTracker } from './copy-tracker';
import type { PolynixConfig, PolynixAccountState, CryptoMicroMarket } from './types';

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
    private dbLogger: PolynixDbLogger;
    private bayesian: BayesianLearner;
    private microScanner: MicroMarketScanner;
    private exitMonitor: PolynixExitMonitor;
    private copyTracker: CopyTracker;

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
        this.dbLogger = new PolynixDbLogger();
        this.bayesian = new BayesianLearner();
        this.microScanner = new MicroMarketScanner();
        this.exitMonitor = new PolynixExitMonitor();
        this.copyTracker = new CopyTracker(this.tomlConfig);

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
        this.log('info', 'Initializing Polynix Agent (Polymarket binary options)...');

        const kvUrl = process.env.KV_URL;
        if (kvUrl) {
            this.statePublisher = new StatePublisher(kvUrl, 'polynix');
            this.log('info', 'StatePublisher initialized (Redis).');
        } else {
            this.log('warn', 'KV_URL not set — state will not be published to Redis.');
        }

        // Connect to Postgres and restore persisted state
        await this.dbLogger.connect();
        await this.bayesian.connect();
        const restored = await this.dbLogger.loadState();
        if (restored) {
            // Restore open positions
            for (const pos of restored.openPositions) {
                this.positionTracker.restorePosition(pos);
            }
            // Restore account stats
            const startBal = this.tomlConfig.capital.starting_balance_usd;
            const openExposure = restored.openPositions.reduce((s, p) => s + p.costBasis, 0);
            this.accountState.totalPnl = restored.accountState.totalPnl ?? 0;
            this.accountState.tradesTotal = restored.accountState.tradesTotal ?? 0;
            this.accountState.wins = restored.accountState.wins ?? 0;
            this.accountState.losses = restored.accountState.losses ?? 0;
            this.accountState.openPositions = restored.openPositions.length;
            this.accountState.winRate = this.accountState.tradesTotal > 0
                ? (this.accountState.wins / this.accountState.tradesTotal) * 100 : 0;
            this.accountState.balance = startBal + this.accountState.totalPnl - openExposure;
            this.log('info', `Restored from DB: ${restored.openPositions.length} open positions, ${this.accountState.tradesTotal} settled, P&L $${this.accountState.totalPnl.toFixed(2)}, balance $${this.accountState.balance.toFixed(2)}`);
        }

        // Seed initial price data
        await this.directionalEngine.fetchPrices(this.tomlConfig);

        // Probe copy tracker API
        if (this.copyTracker.isEnabled()) {
            const probeOk = await this.copyTracker.probe();
            this.log('info', `CopyTracker: probe ${probeOk ? 'OK' : 'FAILED'}`);
        }

        this.setStatus('idle');
        this.log('info', `Paper mode: ${this.tomlConfig.broker.paper_trading}`);
        this.log('info', `Starting balance: $${this.tomlConfig.capital.starting_balance_usd}`);
        this.log('info', `Arb threshold: ${this.tomlConfig.strategy.arb_threshold} (net after ${(this.tomlConfig.risk.fee_rate * 200).toFixed(1)}% round-trip fees)`);
        this.log('info', `Min directional edge: ${this.tomlConfig.strategy.min_edge_pct}%`);
        this.log('info', `Scan interval: ${this.tomlConfig.timing.scan_interval_ms / 1000}s`);
        this.log('info', `Arb scan all markets: ${this.tomlConfig.strategy.scan_all_for_arb}`);
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

            const pollMs = this.tomlConfig.timing.scan_interval_ms;
            const tick = 500;
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
        await this.dbLogger.disconnect();
        await this.bayesian.disconnect();
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

            await this.dbLogger.logSettle(pos);
            await this.bayesian.recordOutcome({
                type: pos.type,
                asset: pos.market.asset,
                side: pos.side,
                edge: pos.type === 'arb'
                    ? (pos.size - pos.costBasis) / pos.size   // arb: actual gross edge
                    : pos.entryPrice > 0 ? Math.abs(0.5 - pos.entryPrice) : 0.05, // directional: distance from 50/50
                timeToExpirySec: (pos.expiresAt - pos.enteredAt) / 1000,
                won: pos.pnl >= 0,
            });
            const emoji = pos.pnl >= 0 ? 'WIN' : 'LOSS';
            this.log('info', `Settled [${pos.type}]: ${pos.market.title} -> ${emoji} $${pos.pnl.toFixed(2)} (balance: $${this.accountState.balance.toFixed(2)})`);
        }

        // 2. Fetch latest CEX prices
        await this.directionalEngine.fetchPrices(this.tomlConfig);

        let arbsFound = 0;
        let arbsExecuted = 0;
        let signalsFound = 0;
        let signalsExecuted = 0;

        // 2b. Scan 5-minute micro-markets (BTC/ETH/SOL up-or-down)
        const microConfig = this.tomlConfig.micro_markets ?? { enabled: false, min_time_to_expiry_s: 30, max_time_to_expiry_s: 300, max_bet_size_usd: 9 };
        if (microConfig.enabled) {
            try {
                const microMarkets = await this.microScanner.scan(microConfig);
                const microExposure = this.positionTracker.getMicroExposure();
                for (const market of microMarkets) {
                    // Dedup: skip if already holding this market
                    if (this.positionTracker.getOpen().some(p => p.market.conditionId === market.conditionId)) continue;

                    // Check directional on micro markets (uses micro budget pool)
                    const signal = await this.directionalEngine.evaluate(market, this.spreadDetector, this.tomlConfig);
                    if (signal && signal.edge > this.tomlConfig.strategy.min_edge_pct / 100) {
                        signalsFound++;
                        const risk = this.riskManager.check(
                            signal.edge, signal.confidence / 100, this.tomlConfig,
                            this.positionTracker.getOpenCount(), this.positionTracker.getExposure(),
                            'micro', microExposure,
                        );
                        if (risk.canTrade) {
                            const tokenId = signal.direction === 'YES' ? market.yesTokenId : market.noTokenId;
                            const price = signal.direction === 'YES' ? signal.polymarketProb : (1 - signal.polymarketProb);
                            const size = risk.suggestedSize;
                            const order = await this.orderManager.placeOrder(tokenId, 'BUY', price, size);
                            if (order.status === 'filled') {
                                const costBasis = price * size;
                                this.positionTracker.addPosition(market, 'directional', signal.direction, price, size, costBasis);
                                this.accountState.balance -= costBasis;
                                await this.dbLogger.logOpen(this.positionTracker.getLastAdded()!);
                                signalsExecuted++;
                                this.log('info', `MICRO ${signal.direction}: ${market.title} | edge=${(signal.edge * 100).toFixed(1)}% | ${market.timeToExpiry.toFixed(0)}s left | micro-budget`);
                            }
                        }
                    }
                }
                if (microMarkets.length > 0) {
                    this.log('info', `Micro-scan: ${microMarkets.length} 5-min markets found`);
                }
            } catch (err: any) {
                this.log('warn', `Micro-market scan error: ${err.message}`);
            }
        }

        // 3. Scan for markets (crypto + arb)
        const { cryptoMarkets, arbMarkets } = await this.scanner.scan(this.tomlConfig);

        // Deduplicate: arb markets that are also crypto markets
        const cryptoIds = new Set(cryptoMarkets.map(m => m.conditionId));
        const arbOnlyMarkets = arbMarkets.filter(m => !cryptoIds.has(m.conditionId));

        // Combine all unique markets for arb scanning
        const allMarketsForArb = [...cryptoMarkets, ...arbOnlyMarkets];

        // 4a. Check ALL markets for arb opportunities
        const arbBatchSize = 10;
        for (let i = 0; i < allMarketsForArb.length; i += arbBatchSize) {
            const batch = allMarketsForArb.slice(i, i + arbBatchSize);
            const results = await Promise.allSettled(
                batch.map(m => this.checkArb(m))
            );

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    arbsFound++;
                    if (result.value === 'executed') arbsExecuted++;
                }
            }

            // Rate limit between batches
            if (i + arbBatchSize < allMarketsForArb.length) {
                await this.sleep(200);
            }
        }

        // 4b. Check crypto markets for directional opportunities
        for (const market of cryptoMarkets) {
            // Dedup: skip markets we already hold
            const alreadyHolding = this.positionTracker.getOpen()
                .some(p => p.market.conditionId === market.conditionId);
            if (alreadyHolding) continue;

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
                        // Bayesian check: adjust confidence based on learned priors
                        const bayesAdj = this.bayesian.evaluate('directional', market.asset, signal.direction, signal.edge, market.timeToExpiry);
                        if (bayesAdj.veto) {
                            this.log('info', `DIRECTIONAL vetoed by Bayesian: ${market.title} ${signal.direction} (${bayesAdj.reasons.join(', ')})`);
                            continue;
                        }
                        if (bayesAdj.reasons.length > 0) {
                            this.log('info', `Bayesian adj: ${bayesAdj.reasons.join(', ')} → factor ${bayesAdj.factor.toFixed(2)}`);
                        }

                        const adjustedSize = risk.suggestedSize * bayesAdj.factor;
                        const tokenId = signal.direction === 'YES' ? market.yesTokenId : market.noTokenId;
                        const price = signal.direction === 'YES' ? signal.polymarketProb : (1 - signal.polymarketProb);
                        const order = await this.orderManager.placeOrder(tokenId, 'BUY', price, adjustedSize);

                        if (order.status === 'filled') {
                            const costBasis = price * adjustedSize;
                            this.positionTracker.addPosition(
                                market, 'directional', signal.direction,
                                price, adjustedSize, costBasis,
                            );
                            this.accountState.balance -= costBasis;
                            await this.dbLogger.logOpen(this.positionTracker.getLastAdded()!);
                            signalsExecuted++;
                            this.log('info', `DIRECTIONAL ${signal.direction}: ${market.title} | edge=${(signal.edge * 100).toFixed(2)}% | price=$${signal.currentPrice.toFixed(2)} | conf=${signal.confidence} | size=$${risk.suggestedSize.toFixed(2)}`);
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

        // 5. Refresh current prices on open positions + compute unrealized P&L
        await this.positionTracker.refreshPrices(this.spreadDetector);

        // 5b. Exit monitor — check directional positions for early exit
        const exitConfig = this.tomlConfig.exits ?? { enabled: false, take_profit_pct: 30, stop_loss_pct: 40, stagnation_hours: 48, min_hold_seconds: 300 };
        if (exitConfig.enabled) {
            const exitDecisions = this.exitMonitor.check(this.positionTracker.getOpen(), exitConfig);
            for (const exit of exitDecisions) {
                const pos = this.positionTracker.getOpen().find(p => p.id === exit.positionId);
                if (!pos) continue;

                // Sell at current midpoint price (paper mode: instant fill)
                const tokenId = pos.side === 'YES' ? pos.market.yesTokenId : pos.market.noTokenId;
                const order = await this.orderManager.placeOrder(tokenId, 'SELL', exit.currentPrice, pos.size);
                if (order.status === 'filled') {
                    const proceeds = exit.currentPrice * pos.size;
                    const pnl = proceeds - pos.costBasis;

                    pos.status = 'exited';
                    pos.exitReason = exit.reason;
                    pos.exitPrice = exit.currentPrice;
                    pos.pnl = pnl;

                    this.positionTracker.removePosition(pos.id);
                    this.accountState.balance += proceeds;
                    this.accountState.totalPnl += pnl;
                    this.accountState.tradesTotal++;
                    if (pnl >= 0) this.accountState.wins++;
                    else this.accountState.losses++;
                    this.accountState.winRate = this.accountState.tradesTotal > 0
                        ? (this.accountState.wins / this.accountState.tradesTotal) * 100 : 0;

                    this.riskManager.recordResult(pnl);
                    await this.dbLogger.logSettle(pos);
                    await this.bayesian.recordOutcome({
                        type: pos.type,
                        asset: pos.market.asset,
                        side: pos.side,
                        edge: pos.entryPrice > 0 ? Math.abs(0.5 - pos.entryPrice) : 0.05,
                        timeToExpirySec: (pos.expiresAt - pos.enteredAt) / 1000,
                        won: pnl >= 0,
                    });

                    const emoji = pnl >= 0 ? 'PROFIT' : 'LOSS';
                    this.log('info', `EXIT [${exit.reason}]: ${pos.market.title} → ${emoji} $${pnl.toFixed(2)} (${exit.pnlPct.toFixed(1)}%) bal=$${this.accountState.balance.toFixed(2)}`);
                }
            }
        }

        this.accountState.openPositions = this.positionTracker.getOpenCount();

        // 5c. Copy tracker poll
        if (this.copyTracker.isEnabled()) {
            await this.copyTracker.poll();
        }

        // 6. Publish state to Redis
        await this.publishState();

        // 7. Heartbeat log every 60s
        const now = Date.now();
        if (now - this.lastHeartbeatLog >= 60_000) {
            this.lastHeartbeatLog = now;
            this.log('info', [
                `Heartbeat #${this.scanCount}:`,
                `crypto=${cryptoMarkets.length}`,
                `arb_scan=${allMarketsForArb.length}`,
                `arbs=${arbsFound}(${arbsExecuted}x)`,
                `signals=${signalsFound}(${signalsExecuted}x)`,
                `open=${this.accountState.openPositions}`,
                `bal=$${this.accountState.balance.toFixed(2)}`,
                `pnl=$${this.accountState.totalPnl.toFixed(2)}`,
                `trades=${this.accountState.tradesTotal}`,
                `WR=${this.accountState.winRate.toFixed(0)}%`,
            ].join(' | '));
        }
    }

    /**
     * Check a single market for arb opportunity and execute if profitable.
     * Returns 'executed' if trade was placed, 'found' if opportunity exists but blocked, null otherwise.
     */
    private async checkArb(market: CryptoMicroMarket): Promise<'executed' | 'found' | null> {
        try {
            // Dedup: don't re-enter a market we already hold
            const alreadyHolding = this.positionTracker.getOpen()
                .some(p => p.market.conditionId === market.conditionId);
            if (alreadyHolding) return null;

            // Arb position cap: reserve slots for directional/micro
            const arbMaxPositions = this.tomlConfig.strategy.arb_max_positions ?? 30;
            if (this.positionTracker.getArbCount() >= arbMaxPositions) return null;

            // Arb exposure cap: max % of bankroll in arb
            const arbMaxExposurePct = this.tomlConfig.strategy.arb_max_exposure_pct ?? 50;
            const bankroll = this.tomlConfig.capital.starting_balance_usd;
            if (this.positionTracker.getArbExposure() >= bankroll * (arbMaxExposurePct / 100)) return null;

            // Arb expiry cap: skip long-duration arbs
            const arbMaxExpiry = this.tomlConfig.strategy.arb_max_expiry_s ?? 3 * 86400;
            if (market.timeToExpiry > arbMaxExpiry) return null;

            const arb = await this.spreadDetector.check(market, this.tomlConfig);
            if (!arb || arb.netEdge <= 0) return null;

            const risk = this.riskManager.check(
                arb.netEdge,
                0.99,
                this.tomlConfig,
                this.positionTracker.getOpenCount(),
                this.positionTracker.getExposure(),
            );

            if (risk.canTrade) {
                // Use arb-specific max bet size (smaller than directional)
                const arbMaxBet = this.tomlConfig.strategy.arb_max_bet_size_usd ?? 10;
                const size = Math.min(risk.suggestedSize, arb.maxSize, arbMaxBet);
                const orders = await this.orderManager.placeArbOrders(arb, size);

                if (orders.yesOrder.status === 'filled' && orders.noOrder.status === 'filled') {
                    const costBasis = arb.combinedCost * size;
                    this.positionTracker.addPosition(
                        market, 'arb', 'BOTH',
                        arb.combinedCost, size, costBasis,
                    );
                    this.accountState.balance -= costBasis;
                    await this.dbLogger.logOpen(this.positionTracker.getLastAdded()!);
                    this.log('info', `ARB ENTRY: ${market.title} | cost=$${arb.combinedCost.toFixed(4)} | net=${(arb.netEdge * 100).toFixed(2)}% | size=$${size.toFixed(2)} | liq=$${market.liquidity.toFixed(0)} | ttl=${(market.timeToExpiry / 3600).toFixed(0)}h`);
                    await this.logSignal('arb', market.title, arb.netEdge, 'BOTH', true);
                    return 'executed';
                }
            } else {
                this.log('info', `ARB blocked: ${market.title} (${risk.reason})`);
            }
            return 'found';
        } catch {
            return null;
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
            await this.statePublisher.set(
                'polynix:trades',
                JSON.stringify(this.positionTracker.getSettledTrades().slice(-50)),
            );
            await this.statePublisher.set(
                'polynix:priors',
                JSON.stringify(this.bayesian.getSummary()),
            );
            if (this.copyTracker.isEnabled()) {
                await this.statePublisher.set(
                    'polynix:copy_leaderboard',
                    JSON.stringify(this.copyTracker.getLeaderboard()),
                );
            }
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
            await this.statePublisher.set('polynix:last_signal', signal, 3600);
        } catch {
            // Non-critical
        }
    }
}
