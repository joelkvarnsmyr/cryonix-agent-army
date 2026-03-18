import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import type { AktienixConfig, AccountState, StockPosition } from './types';
import type { BrokerClient } from './brokers/types';
import { IbkrClient } from './brokers/ibkr/ibkr-client';
import { AlpacaClient } from './brokers/alpaca/alpaca-client';
import { StockSignalGenerator } from './signals/stock-signal-generator';
import { StockNewsScanner, type MacroSignal } from './intelligence/news-scanner';
import { MacroIntelligence } from './intelligence/macro-intelligence';
import { MarketSentimentScanner } from './intelligence/market-sentiment';
import { loadAktienixConfig } from './config';
import { MarketHours } from './market-hours';
import { PositionSizer } from './position-sizer';
import { ExitMonitor } from './exit-monitor';
import { RiskManager } from './risk-manager';
import { StatePublisher } from './state-publisher';
import { WatchlistCurator } from './watchlist-curator';
import { Client as PgClient } from 'pg';

// ── Trade Logger — persist all trades to Postgres ─────────────────────────
class TradeLogger {
    private pg: PgClient | null = null;

    async connect(): Promise<void> {
        const url = process.env.POSTGRES_URL;
        if (!url) return;
        try {
            this.pg = new PgClient({ connectionString: url });
            await this.pg.connect();
        } catch (err: any) {
            console.warn('[TradeLogger] Postgres connect failed (non-fatal):', err.message);
            this.pg = null;
        }
    }

    async logTrade(params: {
        symbol: string;
        side: 'BUY' | 'SELL';
        qty: number;
        fillPrice: number;
        dollarAmount: number;
        realizedPnl?: number;
        confidence?: number;
        reasoning?: string;
        exitReason?: string;
        orderId?: string;
        metadata?: string;
    }): Promise<void> {
        if (!this.pg) return;
        try {
            await this.pg.query(
                `INSERT INTO aktienix_trades (timestamp, symbol, side, qty, fill_price, dollar_amount, realized_pnl, confidence, reasoning, exit_reason, broker, paper_trading, is_day_trade, order_id, metadata)
                 VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'alpaca', true, false, $10, $11)`,
                [
                    params.symbol, params.side, params.qty, params.fillPrice,
                    params.dollarAmount, params.realizedPnl ?? null,
                    params.confidence ?? null, params.reasoning ?? null,
                    params.exitReason ?? null, params.orderId ?? null,
                    params.metadata ?? null,
                ],
            );
        } catch (err: any) {
            console.warn('[TradeLogger] Insert failed (non-fatal):', err.message);
        }
    }

    async close(): Promise<void> {
        try { await this.pg?.end(); } catch { }
    }
}

// ── Bayesian Updater — learns from every trade outcome ──────────────────────
class BayesianUpdater {
    private redis: any = null;
    private readonly TTL = 7 * 24 * 60 * 60; // 7 days

    async connect(redisUrl: string): Promise<void> {
        try {
            const Redis = (await import('ioredis')).default;
            this.redis = new Redis(redisUrl);
        } catch (err: any) {
            console.warn('[BayesianUpdater] Redis connect failed (non-fatal):', err.message);
        }
    }

    async updatePosterior(params: {
        pattern: string;
        symbol: string;
        pnlPct: number;
        exitReason?: string;
    }): Promise<void> {
        if (!this.redis) return;
        const isWin = params.pnlPct > 0;
        const dimensions: [string, string][] = [
            ['pattern', params.pattern],
            ['symbol', params.symbol],
            ['hour', String(new Date().getUTCHours())],
            ['combo', `${params.pattern}:${params.symbol}`],
        ];
        if (params.exitReason) dimensions.push(['exit', params.exitReason]);

        for (const [dim, key] of dimensions) {
            const redisKey = `bayes:aktienix:${dim}:${key}`;
            try {
                const raw = await this.redis.get(redisKey);
                const prior = raw ? JSON.parse(raw) : { alpha: 1.5, beta: 1.5, n: 0, totalPnl: 0, avgWin: 0, avgLoss: 0 };

                if (isWin) {
                    const wins = Math.max(1, prior.alpha - 1.5 + 1);
                    prior.avgWin = prior.n > 0 && (prior.alpha - 1.5) > 0
                        ? (prior.avgWin * (prior.alpha - 1.5) + params.pnlPct) / wins
                        : params.pnlPct;
                    prior.alpha += 1;
                } else {
                    const losses = Math.max(1, prior.beta - 1.5 + 1);
                    prior.avgLoss = prior.n > 0 && (prior.beta - 1.5) > 0
                        ? (prior.avgLoss * (prior.beta - 1.5) + params.pnlPct) / losses
                        : params.pnlPct;
                    prior.beta += 1;
                }
                prior.n += 1;
                prior.totalPnl += params.pnlPct;
                prior.lastUpdated = new Date().toISOString();

                await this.redis.set(redisKey, JSON.stringify(prior), 'EX', this.TTL);
            } catch { /* skip single dimension failure */ }
        }

        console.log(`[BAYES] aktienix: ${params.symbol} ${isWin ? 'WIN' : 'LOSS'} ${params.pnlPct >= 0 ? '+' : ''}${params.pnlPct.toFixed(2)}% (${dimensions.length} dims)`);
    }

    async close(): Promise<void> {
        try { await this.redis?.quit(); } catch { }
    }
}

export interface AktienixAgentConfig extends AgentConfig {
    tradingConfig: AktienixConfig;
}

export class AktienixAgent extends BaseAgent {
    private tradingConfig: AktienixConfig;
    private brokerClient: BrokerClient | null = null;
    private alpacaInstance: any = null;
    private accountState: AccountState | null = null;
    private positions: StockPosition[] = [];
    private isTrading = false;

    private signalGenerator: StockSignalGenerator | null = null;
    private watchlistCurator: WatchlistCurator | null = null;
    private loggerAdapter: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void } | null = null;
    private newsScanner: StockNewsScanner | null = null;
    private macroIntelligence: MacroIntelligence | null = null;
    private sentimentScanner: MarketSentimentScanner | null = null;
    private activeMacroSignals: MacroSignal[] = [];
    private lastNewsScanTime = 0;
    private lastSignalScanTime = 0;

    private exitMonitor = new ExitMonitor();
    private riskManager = new RiskManager();
    private statePublisher: StatePublisher | null = null;
    private tradeLogger = new TradeLogger();
    private bayesianUpdater = new BayesianUpdater();

    private tomlConfig = loadAktienixConfig();

    constructor(config: AktienixAgentConfig) {
        super(config);
        this.tradingConfig = config.tradingConfig;
    }

    async initialize(): Promise<void> {
        this.log('info', 'Initializing Aktienix Agent (Stock Trading)...');

        this.loggerAdapter = {
            info: (msg: string) => this.log('info', msg),
            warn: (msg: string) => this.log('warn', msg),
            error: (msg: string) => this.log('error', msg),
            debug: (msg: string) => this.log('info', msg),
        } as any;

        if (this.tradingConfig.broker === 'ibkr') {
            this.log('info', 'Connecting to IBKR CP Gateway...');
            this.brokerClient = new IbkrClient(this.tradingConfig, this.loggerAdapter!);
            await this.brokerClient.connect();
            this.accountState = await this.brokerClient.getAccountState();
            this.positions = await this.brokerClient.getPositions();
            this.log('info', `IBKR Connected. Settled Cash: ${this.accountState?.settledCash}`);

        } else if (this.tradingConfig.broker === 'alpaca') {
            this.log('info', 'Connecting to Alpaca...');
            this.brokerClient = new AlpacaClient(this.tradingConfig, this.loggerAdapter!);
            await this.brokerClient.connect();
            this.accountState = await this.brokerClient.getAccountState();
            this.positions = await this.brokerClient.getPositions();
            this.log('info', `Alpaca Connected. Portfolio Value: ${this.accountState?.portfolioValue}`);

            // Populate ExitMonitor state for existing positions (survives restarts)
            for (const pos of this.positions) {
                if (!this.exitMonitor) break;
                this.exitMonitor.recordEntry(
                    pos.symbol,
                    pos.avgEntryPrice,
                    pos.openedAt ? new Date(pos.openedAt) : new Date(),
                );
            }

            this.alpacaInstance = (this.brokerClient as AlpacaClient).getAlpacaInstance();
            this.signalGenerator = new StockSignalGenerator(
                this.alpacaInstance,
                this.loggerAdapter!,
                {
                    symbols: this.tomlConfig.watchlist.symbols,
                    timeframe: this.tomlConfig.watchlist.timeframe,
                    barsCount: this.tomlConfig.watchlist.bars_count,
                },
            );
            this.watchlistCurator = new WatchlistCurator(
                this.alpacaInstance,
                process.env.XAI_API_KEY ?? null,
                this.tomlConfig.watchlist.symbols,
                this.loggerAdapter ?? undefined,
            );

        } else if (this.tradingConfig.broker === 'mock') {
            this.log('info', 'Using MOCK broker for testing.');
            this.accountState = { buyingPower: 500, settledCash: 500, portfolioValue: 500, isPatternDayTrader: false, dailyPnl: 0, dailyPnlPct: 0, updatedAt: Date.now() };

        } else {
            this.log('warn', `Unknown broker "${this.tradingConfig.broker}". Using zeroed mock state.`);
            this.accountState = { buyingPower: 0, settledCash: 0, portfolioValue: 0, isPatternDayTrader: false, dailyPnl: 0, dailyPnlPct: 0, updatedAt: Date.now() };
        }

        if (this.tradingConfig.intelligence?.enabled) {
            this.macroIntelligence = new MacroIntelligence(
                process.env.KV_URL ?? 'redis://localhost:6379',
                process.env.XAI_API_KEY ?? '',
            );
            this.log('info', 'MacroIntelligence initialized.');
        }

        const kvUrl = process.env.KV_URL;
        if (kvUrl) {
            this.statePublisher = new StatePublisher(kvUrl);
            this.log('info', 'StatePublisher initialized.');

            // Initialize Market Sentiment Scanner
            const finnhubKey = process.env.FINNHUB_API_KEY || undefined;
            this.sentimentScanner = new MarketSentimentScanner(this.statePublisher, finnhubKey);
            this.log('info', `MarketSentimentScanner initialized${finnhubKey ? ' (Finnhub enabled)' : ' (no Finnhub key)'}.`);
        } else {
            this.log('warn', 'KV_URL not set \u2014 state will not be published to Redis.');
        }

        // Connect trade logger to Postgres
        await this.tradeLogger.connect();

        // Connect Bayesian learner to Redis
        await this.bayesianUpdater.connect(kvUrl || 'redis://localhost:6379');

        this.setStatus('idle');
        this.log('info', 'Aktienix initialization complete.');
    }

    async start(): Promise<void> {
        this.log('info', 'Starting Aktienix Agent trading loop...');
        this.setStatus('running');
        this.isTrading = true;

        let lastDayOfWeek = -1;

        while (this.isTrading) {
            try {
                const config = this.tomlConfig;

                // 1. Check market hours
                const marketResult = await MarketHours.check(this.alpacaInstance, config.market_hours);
                if (!marketResult.isOpen) {
                    // Market closed — but still gather intelligence + update dashboard
                    await this.statePublisher?.publishStatus('paused');

                    // Refresh portfolio for dashboard (every cycle)
                    try {
                        if (this.brokerClient) {
                            this.accountState = await this.brokerClient.getAccountState();
                            this.positions = await this.brokerClient.getPositions();
                            await this.statePublisher?.publishPositions(this.positions);
                            if (this.accountState) await this.statePublisher?.publishAccount(this.accountState);
                        }
                    } catch { /* non-critical */ }

                    // Run MacroIntelligence even when market is closed (news is 24/7)
                    try {
                        if (this.macroIntelligence && Date.now() - this.lastNewsScanTime > config.intelligence.news_scan_interval_ms) {
                            this.log('info', '[PRE-MARKET] Running MacroIntelligence cycle...');
                            await this.macroIntelligence.runIntelligenceCycle();
                            this.activeMacroSignals = await this.macroIntelligence.getLiveSignals();
                            this.lastNewsScanTime = Date.now();
                            if (this.activeMacroSignals.length > 0) {
                                this.log('info', `[PRE-MARKET] ${this.activeMacroSignals.length} macro signals active`);
                            }
                        }
                    } catch { /* non-critical */ }

                    // Fetch market sentiment data (Fear & Greed + Put/Call)
                    try {
                        if (this.sentimentScanner) {
                            await this.sentimentScanner.fetchFearGreed();
                            await this.sentimentScanner.fetchPutCallRatio();
                        }
                    } catch { /* non-critical */ }

                    const _pms = config.timing.poll_interval_ms;
                    const _tick = 250;
                    for (let _e = 0; _e < _pms && this.isTrading; _e += _tick) {
                        await this.sleep(Math.min(_tick, _pms - _e));
                    }
                    continue;
                }

                // Reset daily/weekly counters on new trading day
                const now = new Date();
                const currentDay = now.getDay();
                if (currentDay !== lastDayOfWeek) {
                    this.riskManager.resetDaily();
                    if (currentDay === 1) this.riskManager.resetWeekly();
                    lastDayOfWeek = currentDay;
                }

                // 2. Refresh account state and positions from broker
                if (this.brokerClient) {
                    this.accountState = await this.brokerClient.getAccountState();
                    this.positions = await this.brokerClient.getPositions();
                }

                // 3. Log current portfolio status
                this.log('info', [
                    `Portfolio Update:`,
                    `  Portfolio Value: \$${this.accountState?.portfolioValue?.toFixed(2)}`,
                    `  Buying Power:    \$${this.accountState?.buyingPower?.toFixed(2)}`,
                    `  Settled Cash:    \$${this.accountState?.settledCash?.toFixed(2)}`,
                    `  Open Positions:  ${this.positions.length}`,
                ].join('\n'));

                if (this.positions.length > 0) {
                    for (const pos of this.positions) {
                        const plPct = pos.avgEntryPrice > 0
                            ? ((pos.unrealizedPl / (pos.avgEntryPrice * pos.qty)) * 100).toFixed(2)
                            : '0.00';
                        this.log('info', `  ${pos.symbol}: ${pos.qty} shares @ \$${pos.avgEntryPrice.toFixed(2)} | P/L: \$${pos.unrealizedPl.toFixed(2)} (${plPct}%)`);
                    }
                }

                // 4. Update portfolio value in risk manager
                if (this.accountState) {
                    this.riskManager.updatePortfolioValue(this.accountState.portfolioValue);
                }

                // 5. Risk manager gate
                const riskCheck = this.riskManager.canTrade(this.accountState?.portfolioValue ?? 0, config.risk, config.limits);
                if (!riskCheck.canTrade) {
                    this.log('warn', `Risk gate blocked: ${riskCheck.reason}`);
                    const _pms = config.timing.poll_interval_ms;
                    const _tick = 250;
                    for (let _e = 0; _e < _pms && this.isTrading; _e += _tick) {
                        await this.sleep(Math.min(_tick, _pms - _e));
                    }
                    continue;
                }

                // 6. Check exits for open positions
                const exitDecisions = this.exitMonitor.check(
                    this.positions,
                    config.exits,
                );

                for (const decision of exitDecisions) {
                    if (!this.brokerClient) continue;

                    const pos = this.positions.find(p => p.symbol === decision.symbol);
                    if (!pos) continue;

                    this.log('info', `Exit signal [${decision.reason}] for ${decision.symbol}`);
                    const result = await this.brokerClient.submitOrder({
                        symbol: decision.symbol,
                        action: 'SELL',
                        qty: pos.qty,
                        orderType: 'MARKET',
                    });

                    if (result.success) {
                        this.log('info', `Exit order submitted: ${result.orderId} \u2014 ${result.status}`);
                        this.riskManager.recordExit(pos.unrealizedPl);
                        this.exitMonitor.clearPosition(decision.symbol);
                        // Log SELL to Postgres
                        await this.tradeLogger.logTrade({
                            symbol: decision.symbol,
                            side: 'SELL',
                            qty: pos.qty,
                            fillPrice: pos.currentPrice,
                            dollarAmount: pos.qty * pos.currentPrice,
                            realizedPnl: pos.unrealizedPl,
                            exitReason: decision.reason,
                            orderId: result.orderId,
                        });
                        // Bayesian self-learning
                        const pnlPct = pos.avgEntryPrice > 0 ? ((pos.currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100 : 0;
                        await this.bayesianUpdater.updatePosterior({
                            pattern: decision.reason?.split(':')[0] || 'exit_monitor',
                            symbol: decision.symbol,
                            pnlPct,
                            exitReason: decision.reason,
                        });
                    } else {
                        this.log('error', `Exit order failed for ${decision.symbol}: ${result.message}`);
                    }
                }

                // 6a. Macro delta exit: if oil sentiment shifts bearish rapidly,
                // tighten trailing stops on energy positions immediately
                if (this.statePublisher) {
                    try {
                        const ENERGY_TICKERS = ['XLE', 'XOM', 'CVX', 'USO', 'COP'];
                        const oilDeltaRaw = await this.statePublisher.get('polymarket:oil:delta');
                        const geoDeltaRaw = await this.statePublisher.get('polymarket:geopolitik:delta');

                        let bearishShift = false;
                        let shiftSource = '';

                        if (oilDeltaRaw) {
                            const delta = JSON.parse(oilDeltaRaw);
                            if (delta.direction === 'bearish' && Math.abs(delta.delta) >= 15) {
                                bearishShift = true;
                                shiftSource = `oil Δ${delta.delta} (${delta.from}→${delta.to})`;
                            }
                        }
                        if (geoDeltaRaw) {
                            const delta = JSON.parse(geoDeltaRaw);
                            // Geopolitik going bullish = ceasefire = bearish for energy
                            if (delta.direction === 'bullish' && Math.abs(delta.delta) >= 15) {
                                bearishShift = true;
                                shiftSource = `ceasefire Δ+${delta.delta} (${delta.from}→${delta.to})`;
                            }
                        }

                        if (bearishShift && this.brokerClient) {
                            this.log('warn', `🚨 MACRO DELTA: ${shiftSource} — selling energy positions with profit`);
                            for (const pos of this.positions) {
                                if (!ENERGY_TICKERS.includes(pos.symbol)) continue;
                                const pnlPct = pos.avgEntryPrice > 0
                                    ? ((pos.currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100 : 0;
                                // Only sell energy positions that are in profit (protect gains)
                                if (pnlPct <= 0.5) continue;

                                this.log('warn', `MACRO EXIT: Selling ${pos.symbol} (+${pnlPct.toFixed(2)}%) due to ${shiftSource}`);
                                const result = await this.brokerClient.submitOrder({
                                    symbol: pos.symbol, action: 'SELL', qty: pos.qty, orderType: 'MARKET',
                                });
                                if (result.success) {
                                    this.riskManager.recordExit(pos.unrealizedPl);
                                    this.exitMonitor.clearPosition(pos.symbol);
                                    await this.tradeLogger.logTrade({
                                        symbol: pos.symbol, side: 'SELL', qty: pos.qty,
                                        fillPrice: pos.currentPrice, dollarAmount: pos.qty * pos.currentPrice,
                                        realizedPnl: pos.unrealizedPl,
                                        exitReason: `macro_delta: ${shiftSource}`,
                                        orderId: result.orderId,
                                    });
                                    await this.bayesianUpdater.updatePosterior({
                                        pattern: 'macro_delta', symbol: pos.symbol, pnlPct,
                                        exitReason: 'macro_delta',
                                    });
                                }
                            }
                            // Refresh positions after macro exits
                            this.positions = await this.brokerClient.getPositions();
                        }
                    } catch { /* non-critical */ }
                }

                // 6b. EOD close: close all positions before market close if configured
                if (marketResult.shouldClosePositions && this.brokerClient) {
                    for (const pos of this.positions) {
                        this.log('info', `[EOD CLOSE] Closing ${pos.symbol} before market close`);
                        const result = await this.brokerClient.submitOrder({
                            symbol: pos.symbol,
                            action: 'SELL',
                            qty: pos.qty,
                            orderType: 'MARKET',
                        });
                        if (result.success) {
                            this.log('info', `[EOD CLOSE] ${pos.symbol} sold: ${result.orderId}`);
                            this.riskManager.recordExit(pos.unrealizedPl);
                            this.exitMonitor.clearPosition(pos.symbol);
                            await this.tradeLogger.logTrade({
                                symbol: pos.symbol,
                                side: 'SELL',
                                qty: pos.qty,
                                fillPrice: pos.currentPrice,
                                dollarAmount: pos.qty * pos.currentPrice,
                                realizedPnl: pos.unrealizedPl,
                                exitReason: 'eod_close',
                                orderId: result.orderId,
                            });
                            // Bayesian self-learning
                            const eodPnlPct = pos.avgEntryPrice > 0 ? ((pos.currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100 : 0;
                            await this.bayesianUpdater.updatePosterior({
                                pattern: 'eod_close',
                                symbol: pos.symbol,
                                pnlPct: eodPnlPct,
                                exitReason: 'eod_close',
                            });
                        } else {
                            this.log('error', `[EOD CLOSE] Failed to close ${pos.symbol}: ${result.message}`);
                        }
                    }
                }

                // 6c. Polymarket delta-reaction: force rescan on significant shifts
                if (this.statePublisher) {
                    for (const cat of ['fed', 'geopolitik', 'oil', 'crypto'] as const) {
                        try {
                            const deltaRaw = await this.statePublisher.get(`polymarket:${cat}:delta`);
                            if (!deltaRaw) continue;
                            const delta = JSON.parse(deltaRaw);

                            if (delta.direction === 'bearish' && (cat === 'geopolitik' || cat === 'fed')) {
                                this.log('warn', `POLYMARKET SHIFT: ${cat} ${delta.from}→${delta.to} — tightening exits, forcing rescan`);
                                this.lastSignalScanTime = 0;
                            } else if (delta.direction === 'bullish') {
                                this.log('info', `POLYMARKET SHIFT: ${cat} ${delta.from}→${delta.to} — opportunity scan`);
                                this.lastSignalScanTime = 0;
                            }
                        } catch { /* delta key missing or unparseable — skip */ }
                    }
                }

                // 7. Scan for Macro Intelligence
                const nowTs = Date.now();
                const scanIntervalMs = this.tradingConfig.intelligence?.news_scan_interval_ms
                    ?? config.intelligence.news_scan_interval_ms;

                if (this.macroIntelligence && (nowTs - this.lastNewsScanTime >= scanIntervalMs)) {
                    this.log('info', 'Running MacroIntelligence cycle...');
                    try {
                        await this.macroIntelligence.runIntelligenceCycle();
                        this.lastNewsScanTime = nowTs;
                    } catch (e: any) {
                        this.log('error', `MacroIntelligence cycle failed: ${e.message}`);
                    }
                }

                // 7a. Always refresh live macro signals from Redis (fast path, no Grok calls)
                if (this.macroIntelligence) {
                    try {
                        this.activeMacroSignals = await this.macroIntelligence.getLiveSignals();
                        if (this.activeMacroSignals.length > 0) {
                            this.log('info', `Active macro signals: ${this.activeMacroSignals.length}`);
                            for (const m of this.activeMacroSignals) {
                                this.log('info', `  [${m.impact.toUpperCase()}] ${m.event} → tickers: ${m.tickers.join(', ')}`);
                            }
                        }
                    } catch (e: any) {
                        this.log('error', `getLiveSignals failed: ${e.message}`);
                    }
                }

                // 7b. Refresh watchlist if new trading day
                if (this.watchlistCurator?.needsRefresh() && this.signalGenerator && this.loggerAdapter) {
                    try {
                        const symbols = await this.watchlistCurator.curate(this.activeMacroSignals);
                        this.signalGenerator = new StockSignalGenerator(
                            this.alpacaInstance, this.loggerAdapter,
                            { symbols, timeframe: config.watchlist.timeframe, barsCount: config.watchlist.bars_count }
                        );
                        this.log('info', `Watchlist refreshed: ${symbols.length} symbols`);
                    } catch (e: any) {
                        this.log('error', `WatchlistCurator failed: ${e.message} — keeping existing watchlist, retry tomorrow`);
                        // Force lastRefreshDate to today so we don't retry every poll cycle
                        this.watchlistCurator.markRefreshed();
                    }
                }

                // 7c. Fetch insider activity during signal scan
                if (this.sentimentScanner) {
                    try {
                        await this.sentimentScanner.fetchInsiderActivity(config.watchlist.symbols);
                    } catch { /* non-critical */ }
                }

                // 8. Scan for TA signals
                // Time-gate: only scan for signals every signal_scan_interval_ms
                if (marketResult.canOpenNew && this.signalGenerator &&
                    !marketResult.skipSignalScan &&
                    nowTs - this.lastSignalScanTime >= this.tomlConfig.timing.signal_scan_interval_ms) {
                    this.lastSignalScanTime = nowTs;
                    const signals = await this.signalGenerator.scan();
                    for (const signal of signals) {
                        // TA scanner generates SELL signals but Aktienix is BUY-only
                        // (exits are handled by ExitMonitor). Skip to avoid bypass.
                        if (signal.action === 'SELL') continue;
                        await this.evaluateSignal({
                            symbol: signal.symbol,
                            action: signal.action,
                            confidence: signal.confidence,
                            reasoning: signal.reasoning,
                            currentPrice: signal.currentPrice,
                        });
                    }
                }

                // 9. Process any pending messages from queue
                while (this.messageQueue.length > 0) {
                    const msg = this.messageQueue.shift()!;
                    await this.handleMessage(msg);
                }

                // 10. Publish state to Redis
                await this.statePublisher?.publishPositions(this.positions);
                if (this.accountState) {
                    await this.statePublisher?.publishAccount(this.accountState);
                }
                const riskState = this.riskManager.getState();
                await this.statePublisher?.publishRisk({
                    canTrade: riskState.canTrade,
                    dailyPnlDollar: riskState.dailyPnlDollar,
                    weeklyPnlDollar: riskState.weeklyPnlDollar,
                    consecutiveLosses: riskState.consecutiveLosses,
                    tradesToday: riskState.tradesToday,
                    dayTradesThisWeek: riskState.dayTradesThisWeek,
                });
                await this.statePublisher?.publishStatus('running');

            } catch (error: any) {
                this.log('error', `Trading loop error: ${error.message}`);
            }

            // Interruptible sleep: check isTrading every 250ms so stop() takes effect promptly
            const pollMs = this.tomlConfig.timing.poll_interval_ms;
            const tick = 250;
            for (let elapsed = 0; elapsed < pollMs && this.isTrading; elapsed += tick) {
                await this.sleep(Math.min(tick, pollMs - elapsed));
            }
        }

        this.log('info', 'Trading loop exited.');
    }

    async stop(): Promise<void> {
        this.log('info', 'Stopping Aktienix Agent...');
        this.isTrading = false;
        if (this.brokerClient) {
            await this.brokerClient.disconnect();
        }
        await this.statePublisher?.publishStatus('stopped');
        await this.statePublisher?.disconnect();
        await this.tradeLogger.close();
        this.setStatus('paused');
    }

    async handleMessage(message: AgentMessage): Promise<void> {
        this.log('info', `Received message: ${message.message_type}`, message.data);

        if (message.message_type === 'TRADE_SIGNAL') {
            await this.evaluateSignal(message.data);
        }
    }

    private async evaluateSignal(payload: any): Promise<void> {
        if (!this.accountState) {
            this.log('error', 'Cannot evaluate signal: Account state not initialized.');
            return;
        }

        const config = this.tomlConfig;
        let { symbol, action, confidence, reasoning, currentPrice } = payload;
        this.log('info', `Evaluating signal to ${action} ${symbol} (Base Confidence: ${confidence})`);

        // Max open positions check
        if (action === 'BUY' && this.positions.length >= config.limits.max_open_positions) {
            this.log('info', `Max open positions reached (${this.positions.length}/${config.limits.max_open_positions}). Skipping ${symbol}.`);
            return;
        }

        // Block accumulation: don't add to an existing position
        if (action === 'BUY') {
            const existing = this.positions.find(p => p.symbol === symbol);
            if (existing) {
                const existingValue = existing.marketValue ?? (existing.qty * existing.avgEntryPrice);
                this.log('info', `Already holding ${symbol} ($${existingValue.toFixed(0)}). Skipping duplicate BUY.`);
                return;
            }
        }

        // Smart rotation: if at max positions and new signal is strong,
        // consider closing the weakest loser to make room
        if (action === 'BUY' && this.positions.length >= config.limits.max_open_positions && this.brokerClient) {
            const losers = this.positions
                .filter(p => (p.unrealizedPl ?? 0) < 0)
                .sort((a, b) => (a.unrealizedPl ?? 0) - (b.unrealizedPl ?? 0));

            if (losers.length > 0 && confidence >= 0.55) {
                const worst = losers[0];
                const worstPnlPct = worst.avgEntryPrice > 0
                    ? ((worst.currentPrice - worst.avgEntryPrice) / worst.avgEntryPrice) * 100 : 0;

                // Only rotate if the loser is down >1% and new signal confidence > 55%
                if (worstPnlPct < -1.0) {
                    this.log('info', `SMART ROTATION: Closing ${worst.symbol} (${worstPnlPct.toFixed(2)}%) to open ${symbol} (conf: ${confidence.toFixed(2)})`);
                    try {
                        const closeResult = await this.brokerClient.submitOrder({
                            symbol: worst.symbol, action: 'SELL', qty: worst.qty, orderType: 'MARKET',
                        });
                        if (closeResult.success) {
                            this.riskManager.recordExit(worst.unrealizedPl ?? 0);
                            this.exitMonitor.clearPosition(worst.symbol);
                            const pnlPct = worst.avgEntryPrice > 0
                                ? ((worst.currentPrice - worst.avgEntryPrice) / worst.avgEntryPrice) * 100 : 0;
                            await this.tradeLogger.logTrade({
                                symbol: worst.symbol, side: 'SELL', qty: worst.qty,
                                fillPrice: worst.currentPrice, dollarAmount: worst.qty * worst.currentPrice,
                                realizedPnl: worst.unrealizedPl ?? 0,
                                exitReason: `smart_rotation: replaced by ${symbol}`,
                                orderId: closeResult.orderId,
                            });
                            await this.bayesianUpdater.updatePosterior({
                                pattern: 'smart_rotation', symbol: worst.symbol,
                                pnlPct, exitReason: 'smart_rotation',
                            });
                            // Refresh positions after close
                            this.positions = await this.brokerClient.getPositions();
                        }
                    } catch (err) {
                        this.log('error', `Smart rotation close failed: ${err}`);
                    }
                }
            }
        }

        // Signal cooldown: prevent re-buying same symbol within 4 hours
        if (action === 'BUY' && this.statePublisher) {
            try {
                const cooldownKey = `aktienix:cooldown:${symbol}`;
                const cooldownRaw = await this.statePublisher.get(cooldownKey);
                if (cooldownRaw) {
                    this.log('info', `COOLDOWN: ${symbol} was recently traded. Skipping.`);
                    return;
                }
            } catch { /* non-critical */ }
        }

        // Apply Macro Intelligence overlays
        const intelConfig = this.tradingConfig.intelligence;
        if (intelConfig?.enabled && this.activeMacroSignals.length > 0) {
            let blockedByMacro = false;

            for (const macro of this.activeMacroSignals) {
                if (action === 'BUY' && intelConfig.macro_bearish_block && macro.impact === 'bearish' && macro.tickers.includes(symbol)) {
                    this.log('warn', `MACRO BLOCK: ${symbol} is in a BEARISH macro event (${macro.event}). Cancelling BUY.`);
                    blockedByMacro = true;
                    break;
                }

                if (action === 'BUY' && macro.impact === 'bullish' && macro.tickers.includes(symbol)) {
                    confidence += intelConfig.macro_confidence_boost;
                    confidence = Math.min(confidence, 1.0);
                    this.log('info', `MACRO BOOST: ${symbol} is in a BULLISH macro event (${macro.event}). Confidence boosted to ${confidence.toFixed(2)}.`);
                }
            }

            if (blockedByMacro) return;
        }

        // Polymarket prediction market overlays
        const polyContext: Record<string, any> = {};
        const baseConfidence = confidence;
        try {
            if (this.statePublisher && action === 'BUY') {
                const [fedRaw, geoRaw, oilRaw, cryptoRaw] = await Promise.all([
                    this.statePublisher.get('polymarket:fed'),
                    this.statePublisher.get('polymarket:geopolitik'),
                    this.statePublisher.get('polymarket:oil'),
                    this.statePublisher.get('polymarket:crypto'),
                ]);

                // Fed dovish → boost growth stocks; hawkish → penalize
                if (fedRaw) {
                    const fed = JSON.parse(fedRaw);
                    polyContext.fed = fed.score;
                    if (fed.score >= 70) {
                        confidence = Math.min(1.0, confidence + 0.04);
                        this.log('info', `POLYMARKET: Fed dovish (${fed.score}) → +4% confidence for ${symbol}`);
                    } else if (fed.score <= 30) {
                        confidence = Math.max(0, confidence - 0.05);
                        this.log('info', `POLYMARKET: Fed hawkish (${fed.score}) → -5% confidence for ${symbol}`);
                    }
                }

                // Geopolitical risk → block non-defensive buys
                if (geoRaw) {
                    const geo = JSON.parse(geoRaw);
                    polyContext.geo = geo.score;
                    const defensiveTickers = ['XLE', 'XOM', 'CVX', 'USO', 'GLD', 'TLT'];
                    if (geo.score <= 30 && !defensiveTickers.includes(symbol)) {
                        this.log('warn', `POLYMARKET: Geo risk high (${geo.score}) → blocking ${symbol} (non-defensive)`);
                        return;
                    }
                }

                // Oil bullish → boost energy, penalize airlines/logistics
                if (oilRaw) {
                    const oil = JSON.parse(oilRaw);
                    polyContext.oil = oil.score;
                    const energyTickers = ['XLE', 'XOM', 'CVX', 'USO'];
                    const oilVictims = ['UAL', 'DAL', 'FDX', 'UPS'];
                    if (oil.score >= 70) {
                        if (energyTickers.includes(symbol)) {
                            confidence = Math.min(1.0, confidence + 0.06);
                            this.log('info', `POLYMARKET: Oil bullish (${oil.score}) → energy boost +6% for ${symbol}`);
                        } else if (oilVictims.includes(symbol)) {
                            confidence = Math.max(0, confidence - 0.06);
                            this.log('info', `POLYMARKET: Oil bullish (${oil.score}) → headwind -6% for ${symbol}`);
                        }
                    }
                }

                // Crypto sentiment → boost/penalize crypto-correlated stocks
                if (cryptoRaw) {
                    const crypto = JSON.parse(cryptoRaw);
                    polyContext.crypto = crypto.score;
                    const polyConfig = config.polymarket ?? ({} as any);
                    const cryptoTickers: string[] = polyConfig.crypto_correlated_tickers ?? ['MSTR', 'COIN', 'RIOT', 'MARA', 'SQ', 'PYPL'];
                    const boost = polyConfig.crypto_boost ?? 0.08;
                    const penalty = polyConfig.crypto_penalty ?? 0.08;

                    if (cryptoTickers.includes(symbol)) {
                        if (crypto.score >= 70) {
                            confidence = Math.min(1.0, confidence + boost);
                            this.log('info', `POLYMARKET: Crypto bullish (${crypto.score}) → +${(boost * 100).toFixed(0)}% for ${symbol}`);
                        } else if (crypto.score <= 30) {
                            confidence = Math.max(0, confidence - penalty);
                            this.log('info', `POLYMARKET: Crypto bearish (${crypto.score}) → -${(penalty * 100).toFixed(0)}% for ${symbol}`);
                        }
                    }
                }
            }
        } catch { /* Polymarket data unavailable — skip */ }

        // Market Sentiment overlay (Fear & Greed, Put/Call, Insider)
        let sentimentAdjustment = 0;
        if (this.sentimentScanner && action === 'BUY') {
            try {
                const sentiment = await this.sentimentScanner.getConfidenceAdjustment(symbol);
                sentimentAdjustment = sentiment.adjustment;
                if (sentiment.reasons.length > 0) {
                    this.log('info', `SENTIMENT: ${symbol} → ${sentiment.reasons.join(', ')}`);
                }
            } catch { /* non-critical */ }
        }

        // Cap total intelligence overlay at ±20%
        // Sum: Grok boost (already applied) + Polymarket (already applied) + Sentiment
        const currentOverlay = confidence - baseConfidence;
        const remainingCap = 0.20 - Math.abs(currentOverlay);
        if (remainingCap > 0) {
            const cappedSentiment = Math.max(-remainingCap, Math.min(remainingCap, sentimentAdjustment));
            confidence += cappedSentiment;
            confidence = Math.max(0, Math.min(0.95, confidence));
        }

        // Minimum confidence threshold (from TOML risk config)
        const minConfidence = config.risk.min_confidence;
        if (confidence < minConfidence) {
            this.log('info', `Signal confidence ${confidence} is below threshold (${minConfidence}). Skipping.`);
            return;
        }

        // T+1 Settlement Check for Cash Accounts
        if (action === 'BUY' && this.tradingConfig.accountType === 'cash') {
            const minSettledCash = config.risk.min_settled_cash;
            if (this.accountState.settledCash < minSettledCash) {
                this.log('warn', `Insufficient settled cash for ${symbol}. Wait for T+1 settlement.`);
                return;
            }
        }

        if (!this.brokerClient) {
            this.log('warn', `No broker client connected. Cannot submit order.`);
            return;
        }

        // Bayesian tiered position sizing:
        // Adjust max position size based on historical win rate for this symbol
        // Tier: <50% → 0.5x, 50-65% → 1.0x, >65% → 1.5x
        let bayesSizeMultiplier = 1.0;
        if (this.statePublisher) {
            try {
                const bayesRaw = await this.statePublisher.get(`bayes:aktienix:symbol:${symbol}`);
                if (bayesRaw) {
                    const prior = JSON.parse(bayesRaw);
                    if (prior.n >= 10) {
                        const winRate = prior.alpha / (prior.alpha + prior.beta);
                        if (winRate > 0.65) {
                            bayesSizeMultiplier = 1.5;
                            this.log('info', `BAYES SIZE: ${symbol} win rate ${(winRate * 100).toFixed(0)}% (n=${prior.n}) → 1.5x position`);
                        } else if (winRate < 0.50) {
                            bayesSizeMultiplier = 0.5;
                            this.log('info', `BAYES SIZE: ${symbol} win rate ${(winRate * 100).toFixed(0)}% (n=${prior.n}) → 0.5x position`);
                        }
                    }
                }
            } catch { /* non-critical — use default 1.0x */ }
        }

        // Apply Bayesian multiplier to config for this trade only
        const originalMaxSize = config.capital.max_position_size_usd;
        config.capital.max_position_size_usd = originalMaxSize * bayesSizeMultiplier;

        // Calculate fractional qty via the position-sizer module
        const qty = PositionSizer.calc(
            currentPrice ?? 0,
            this.accountState.settledCash,
            config.capital,
            this.accountState.portfolioValue,
        );

        // Restore original config (don't let Bayesian multiplier leak to next signal)
        config.capital.max_position_size_usd = originalMaxSize;

        if (qty <= 0) {
            this.log('warn', `Position sizer returned 0 for ${symbol} (insufficient cash or price invalid)`);
            return;
        }

        const dollarEstimate = qty * (currentPrice ?? 0);
        this.log('info', `Submitting ${action} order for ${symbol}. Qty: ${qty} (~\$${dollarEstimate.toFixed(2)})`);

        const result = await this.brokerClient.submitOrder({
            symbol,
            action,
            qty,
            orderType: 'MARKET',
        });

        if (result.success) {
            this.log('info', `Order submitted: ${result.orderId} \u2014 ${result.status}`);
            this.exitMonitor.recordEntry(symbol, currentPrice ?? 0, new Date());
            this.riskManager.recordTrade(false);
            await this.statePublisher?.addSignal({
                symbol,
                action,
                confidence,
                reasoning: reasoning ?? '',
                timestamp: Date.now(),
            });
            // Log BUY to Postgres with Polymarket context metadata
            const dollarEstimate = qty * (currentPrice ?? 0);
            const metadata = Object.keys(polyContext).length > 0
                ? JSON.stringify({ polymarket: polyContext, baseConfidence, finalConfidence: confidence })
                : undefined;
            await this.tradeLogger.logTrade({
                symbol,
                side: 'BUY',
                qty,
                fillPrice: currentPrice ?? 0,
                dollarAmount: dollarEstimate,
                confidence,
                reasoning: reasoning ?? undefined,
                orderId: result.orderId,
                metadata,
            });
            // Set 4h cooldown to prevent re-buying same symbol too quickly
            try {
                await this.statePublisher?.set(`aktienix:cooldown:${symbol}`, Date.now().toString(), 4 * 3600);
            } catch { /* non-critical */ }
        } else {
            this.log('error', `Order failed: ${result.message}`);
        }
    }
}
