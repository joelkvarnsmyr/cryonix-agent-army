import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import type { AktienixConfig, AccountState, StockPosition } from './types';
import type { BrokerClient } from './brokers/types';
import { IbkrClient } from './brokers/ibkr/ibkr-client';
import { AlpacaClient } from './brokers/alpaca/alpaca-client';
import { StockSignalGenerator } from './signals/stock-signal-generator';
import { StockNewsScanner, type MacroSignal } from './intelligence/news-scanner';
import { loadAktienixConfig } from './config';
import { MarketHours } from './market-hours';
import { PositionSizer } from './position-sizer';
import { ExitMonitor } from './exit-monitor';
import { RiskManager } from './risk-manager';
import { StatePublisher } from './state-publisher';

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
    private newsScanner: StockNewsScanner | null = null;
    private activeMacroSignals: MacroSignal[] = [];
    private lastNewsScanTime = 0;
    private lastSignalScanTime = 0;

    private exitMonitor = new ExitMonitor();
    private riskManager = new RiskManager();
    private statePublisher: StatePublisher | null = null;

    private tomlConfig = loadAktienixConfig();

    constructor(config: AktienixAgentConfig) {
        super(config);
        this.tradingConfig = config.tradingConfig;
    }

    async initialize(): Promise<void> {
        this.log('info', 'Initializing Aktienix Agent (Stock Trading)...');

        const loggerAdapter = {
            info: (msg: string) => this.log('info', msg),
            warn: (msg: string) => this.log('warn', msg),
            error: (msg: string) => this.log('error', msg),
            debug: (msg: string) => this.log('info', msg),
        } as any;

        if (this.tradingConfig.broker === 'ibkr') {
            this.log('info', 'Connecting to IBKR CP Gateway...');
            this.brokerClient = new IbkrClient(this.tradingConfig, loggerAdapter);
            await this.brokerClient.connect();
            this.accountState = await this.brokerClient.getAccountState();
            this.positions = await this.brokerClient.getPositions();
            this.log('info', `IBKR Connected. Settled Cash: ${this.accountState?.settledCash}`);

        } else if (this.tradingConfig.broker === 'alpaca') {
            this.log('info', 'Connecting to Alpaca...');
            this.brokerClient = new AlpacaClient(this.tradingConfig, loggerAdapter);
            await this.brokerClient.connect();
            this.accountState = await this.brokerClient.getAccountState();
            this.positions = await this.brokerClient.getPositions();
            this.log('info', `Alpaca Connected. Portfolio Value: ${this.accountState?.portfolioValue}`);

            this.alpacaInstance = (this.brokerClient as AlpacaClient).getAlpacaInstance();
            this.signalGenerator = new StockSignalGenerator(
                this.alpacaInstance,
                loggerAdapter,
                {
                    symbols: this.tomlConfig.watchlist.symbols,
                    timeframe: this.tomlConfig.watchlist.timeframe,
                    barsCount: this.tomlConfig.watchlist.bars_count,
                },
            );

        } else if (this.tradingConfig.broker === 'mock') {
            this.log('info', 'Using MOCK broker for testing.');
            this.accountState = { buyingPower: 500, settledCash: 500, portfolioValue: 500, isPatternDayTrader: false };

        } else {
            this.log('warn', `Unknown broker "${this.tradingConfig.broker}". Using zeroed mock state.`);
            this.accountState = { buyingPower: 0, settledCash: 0, portfolioValue: 0, isPatternDayTrader: false };
        }

        if (this.tradingConfig.intelligence?.enabled) {
            this.newsScanner = new StockNewsScanner();
            if (this.newsScanner.isInitialized()) {
                this.log('info', 'StockNewsScanner connected to xAI.');
            } else {
                this.log('warn', 'StockNewsScanner failed to initialize (check XAI_API_KEY).');
            }
        }

        const kvUrl = process.env.KV_URL;
        if (kvUrl) {
            this.statePublisher = new StatePublisher(kvUrl);
            this.log('info', 'StatePublisher initialized.');
        } else {
            this.log('warn', 'KV_URL not set \u2014 state will not be published to Redis.');
        }

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
                    this.log('info', 'Market hours guard: market is closed');
                    await this.statePublisher?.publishStatus('paused');
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
                        const pnlDollar = (decision.pnlPct / 100) * pos.marketValue;
                        this.riskManager.recordExit(pnlDollar);
                        this.exitMonitor.clearPosition(decision.symbol);
                    } else {
                        this.log('error', `Exit order failed for ${decision.symbol}: ${result.message}`);
                    }
                }

                // 7. Scan for Macro Intelligence
                const nowTs = Date.now();
                const scanIntervalMs = this.tradingConfig.intelligence?.news_scan_interval_ms
                    ?? config.intelligence.news_scan_interval_ms;

                if (this.newsScanner && this.newsScanner.isInitialized() && (nowTs - this.lastNewsScanTime >= scanIntervalMs)) {
                    this.log('info', 'Running macro intelligence scan via Grok...');
                    try {
                        this.activeMacroSignals = await this.newsScanner.scanMacroEvents();
                        this.lastNewsScanTime = nowTs;

                        if (this.activeMacroSignals.length > 0) {
                            this.log('info', `Detected ${this.activeMacroSignals.length} active macro events:`);
                        } else {
                            this.log('info', 'No major actionable macro events detected.');
                        }
                    } catch (e: any) {
                        this.log('error', `Macro scan failed: ${e.message}`);
                    }
                }

                // 8. Scan for TA signals
                // Time-gate: only scan for signals every signal_scan_interval_ms
                if (marketResult.canOpenNew && this.signalGenerator &&
                    !marketResult.skipSignalScan &&
                    nowTs - this.lastSignalScanTime >= this.tomlConfig.timing.signal_scan_interval_ms) {
                    this.lastSignalScanTime = nowTs;
                    const signals = await this.signalGenerator.scan();
                    for (const signal of signals) {
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
                    this.log('info', `MACRO BOOST: ${symbol} is in a BULLISH macro event (${macro.event}). Confidence boosted to ${confidence.toFixed(2)}.`);
                }
            }

            if (blockedByMacro) return;
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

        // Calculate fractional qty via the position-sizer module
        const qty = PositionSizer.calc(
            currentPrice ?? 0,
            this.accountState.settledCash,
            config.capital,
        );

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
        } else {
            this.log('error', `Order failed: ${result.message}`);
        }
    }
}
