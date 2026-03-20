import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import { RiskManager } from '../aktienix/risk-manager';
import { PositionSizer } from '../aktienix/position-sizer';
import { StatePublisher } from '../aktienix/state-publisher';
import { SolanaClient } from './brokers/solana-client';
import { MINT_ADDRESS_MAP } from './signals/solana-signal-generator';
import { DexScreenerSignalGenerator } from './signals/dexscreener-signal-generator';
import { DexScreenerScanner } from './signals/dexscreener-scanner';
import { StablecoinScanner, type StablecoinStatus } from './signals/stablecoin-scanner';
import { TokenUnlockMonitor, type TokenUnlockEvent } from './signals/token-unlock-monitor';
import { SolanaWatchlistCurator } from './watchlist-curator';
import { SolanaExitMonitor } from './exit-monitor';
import { MacroFilter } from './macro-filter';
import { trySmartRotation } from './smart-rotation';
import { loadSolanixConfig } from './config';
import { PolymarketIntelligence } from '../shared/polymarket-intelligence';
import { SolanixPersistence } from './persistence';
import { BayesianLearner } from './bayesian-learner';
import { ShadowStrategy } from './shadow-strategy';
import { PostTradeAnalyzer } from './post-trade-analyzer';
import type { SolanaPosition, SolanaAccountState } from './types';

export class SolanaAgent extends BaseAgent {
    private isRunning = false;

    private brokerClient: SolanaClient | null = null;
    private signalGenerator: DexScreenerSignalGenerator | null = null;
    private dexScanner: DexScreenerScanner | null = null;
    private watchlistCurator: SolanaWatchlistCurator | null = null;
    private statePublisher: StatePublisher | null = null;
    private exitMonitor = new SolanaExitMonitor();
    private macroFilter: MacroFilter | null = null;
    private polymarket = new PolymarketIntelligence(300_000); // 5 min cache
    private stablecoinScanner = new StablecoinScanner();
    private unlockMonitor = new TokenUnlockMonitor();
    private riskManager = new RiskManager();
    private persistence = new SolanixPersistence();
    private bayesian = new BayesianLearner();
    private postTradeAnalyzer = new PostTradeAnalyzer();
    private shadows: ShadowStrategy[] = [];
    /** Maps symbol -> DB position ID for open positions */
    private positionDbIds = new Map<string, number>();

    private lastStablecoinStatus: StablecoinStatus | null = null;
    private lastUnlockCheckTime = 0;
    private upcomingUnlocks: TokenUnlockEvent[] = [];

    private positions: SolanaPosition[] = [];
    private positionMeta: Map<string, { entryTime: number; highWatermark: number; trailingActive: boolean }> = new Map();
    private accountState: SolanaAccountState | null = null;

    private lastDexScanTime = 0;
    private lastSignalScanTime = 0;
    private lastResetDay = new Date().getUTCDate();
    private lastResetWeek = getISOWeek();
    private signalsBoughtThisLoop = new Set<string>();
    /** Per-symbol cooldown after exit — prevents re-entry into same losing trade */
    private symbolCooldowns = new Map<string, number>();
    private readonly SYMBOL_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

    private tomlConfig = loadSolanixConfig();

    constructor(config: AgentConfig) {
        super(config);
    }

    async initialize(): Promise<void> {
        this.log('info', 'Initializing Solanix Agent (Solana DEX Trading)...');

        const config = this.tomlConfig;

        // Broker client (paper trading)
        this.brokerClient = new SolanaClient({
            rpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
            paperTrading: config.broker.paper_trading,
            initialUsdcBalance: 500,
        });
        await this.brokerClient.connect();

        // Seed portfolio value into risk manager
        const acct = await this.brokerClient.getAccountState();
        this.accountState = {
            usdcBalance: acct.settledCash,
            solBalance: 0,
            portfolioValue: acct.portfolioValue,
        };
        this.riskManager.updatePortfolioValue(acct.portfolioValue);

        // Signal generator (DexScreener-based — real-time momentum)
        this.signalGenerator = new DexScreenerSignalGenerator({
            symbols: config.watchlist.symbols,
            min_signal_score: config.signals.min_signal_score,
        });

        // Watchlist curator (daily refresh with DexScreener + CoinGecko + Grok)
        this.watchlistCurator = new SolanaWatchlistCurator(
            process.env.XAI_API_KEY ?? null,
            config.watchlist.symbols,
            MINT_ADDRESS_MAP,
            config.signals.dexscreener_min_liquidity_usd,
            { info: (msg: string) => this.log('info', msg) },
        );

        // DexScreener scanner
        this.dexScanner = new DexScreenerScanner({
            minLiquidityUsd: config.signals.dexscreener_min_liquidity_usd,
            volumeSpikeMultiplier: config.signals.dexscreener_volume_spike_multiplier,
            dynamicTtlMs: config.signals.dexscreener_dynamic_ttl_ms,
        });

        // StatePublisher (optional — requires KV_URL)
        const kvUrl = process.env.KV_URL;
        if (kvUrl) {
            this.statePublisher = new StatePublisher(
                kvUrl,
                'solanix',
            );
            // MacroFilter reads Cryonix data from the same Redis
            this.macroFilter = new MacroFilter(
                this.statePublisher,
                undefined,
                (msg) => this.log('info', `[macro] ${msg}`),
            );
            this.log('info', 'StatePublisher + MacroFilter initialized.');
        } else {
            this.log('warn', 'KV_URL not set — state will not be published to Redis.');
        }

        // Persistence (optional — requires POSTGRES_URL)
        const dbConnected = await this.persistence.connect();
        if (dbConnected) {
            const saved = await this.persistence.loadOpenPositions();
            if (saved.length > 0) {
                for (const p of saved) {
                    // Restore position in broker client
                    this.brokerClient.restorePaperPosition(p.symbol, p.mintAddress, p.qty, p.avgEntryPrice, p.currentPrice);
                    this.positionDbIds.set(p.symbol, p.id);
                    this.positionMeta.set(p.symbol, {
                        entryTime: p.openedAt,
                        highWatermark: p.highWatermark,
                        trailingActive: p.trailingStopActive,
                    });
                }
                this.log('info', `Restored ${saved.length} position(s) from DB: ${saved.map(p => p.symbol).join(', ')}`);
            }
        }

        // Load symbol cooldowns from recent exits (prevents restart bypass)
        if (dbConnected) {
            const recentExits = await this.persistence.getRecentExits(this.SYMBOL_COOLDOWN_MS);
            for (const exit of recentExits) {
                const cooldownEnd = exit.closedAt + this.SYMBOL_COOLDOWN_MS;
                if (cooldownEnd > Date.now()) {
                    this.symbolCooldowns.set(exit.symbol, cooldownEnd);
                }
            }
            if (this.symbolCooldowns.size > 0) {
                this.log('info', `Restored ${this.symbolCooldowns.size} symbol cooldown(s): ${[...this.symbolCooldowns.keys()].join(', ')}`);
            }
        }

        // Bayesian self-learning (reads closed trades to adjust confidence)
        const bayesOk = await this.bayesian.connect();
        if (bayesOk) {
            const summary = this.bayesian.getSummary();
            if (summary.includes('n=0')) {
                this.log('info', 'Bayesian learner initialized — no closed trades yet, using priors');
            } else {
                this.log('info', `Bayesian learner initialized:\n${summary}`);
            }
        }

        // Shadow strategies for A/B testing exit parameters
        const shadowConfigs = [
            {
                name: 'wide-trail',
                capitalUsd: 250, maxPositions: 5, positionSizeUsd: 50,
                takeProfitPct: 12, stopLossPct: 2.5,
                trailingStopPct: 8, trailingActivationPct: 5,
                stagnationDays: 3,
            },
            {
                name: 'tight-scalp',
                capitalUsd: 250, maxPositions: 5, positionSizeUsd: 50,
                takeProfitPct: 4, stopLossPct: 2,
                trailingStopPct: 3, trailingActivationPct: 2,
                stagnationDays: 1,
            },
        ];
        for (const sc of shadowConfigs) {
            const shadow = new ShadowStrategy(sc);
            const ok = await shadow.connect();
            if (ok) {
                this.shadows.push(shadow);
                this.log('info', `Shadow strategy "${sc.name}" initialized (TP ${sc.takeProfitPct}% / SL ${sc.stopLossPct}% / Trail ${sc.trailingStopPct}%)`);
            }
        }

        this.setStatus('idle');
        this.log('info', 'Solanix initialization complete.');
    }

    async start(): Promise<void> {
        this.log('info', 'Starting Solanix Agent trading loop...');
        this.setStatus('running');
        this.isRunning = true;

        while (this.isRunning) {
            try {
                await this.runLoop();
            } catch (error: any) {
                this.log('error', `Trading loop error: ${error.message}`);
            }

            // Interruptible sleep
            const pollMs = this.tomlConfig.timing.poll_interval_ms;
            const tick = 250;
            for (let elapsed = 0; elapsed < pollMs && this.isRunning; elapsed += tick) {
                await this.sleep(Math.min(tick, pollMs - elapsed));
            }
        }

        this.log('info', 'Solanix trading loop exited.');
    }

    async stop(): Promise<void> {
        this.log('info', 'Stopping Solanix Agent...');
        this.isRunning = false;

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

    // -------------------------------------------------------------------------
    // Main loop
    // -------------------------------------------------------------------------

    private async runLoop(): Promise<void> {
        const config = this.tomlConfig;

        // 0. Daily + weekly reset
        const today = new Date().getUTCDate();
        if (today !== this.lastResetDay) {
            this.riskManager.resetDaily();
            this.lastResetDay = today;
            this.log('info', 'Daily risk counters reset (new UTC day)');

            const currentWeek = getISOWeek();
            if (currentWeek !== this.lastResetWeek) {
                this.riskManager.resetWeekly();
                this.lastResetWeek = currentWeek;
                this.log('info', 'Weekly risk counters reset (new ISO week)');
            }
        }

        // Clear per-loop signal dedup set
        this.signalsBoughtThisLoop.clear();

        // 1. Circuit breaker check via Redis (skip trading if tripped)
        const circuitOpen = await this.isCircuitBreakerOpen();
        if (circuitOpen) {
            this.log('warn', 'Circuit breaker open — skipping loop iteration.');
            await this.statePublisher?.publishStatus('paused');
            return;
        }

        // 2. Refresh account state and positions
        if (this.brokerClient) {
            const acct = await this.brokerClient.getAccountState();
            this.accountState = {
                usdcBalance: acct.settledCash,
                solBalance: 0,
                portfolioValue: acct.portfolioValue,
            };
            await this.brokerClient.refreshPositionPrices();

            const rawPositions = await this.brokerClient.getPositions();
            this.positions = rawPositions.map((p) => {
                const currentPrice = p.avgEntryPrice + (p.unrealizedPl / Math.max(p.qty, 1e-12));
                // Preserve persistent per-position state (entryTime, highWatermark)
                const meta = this.positionMeta.get(p.symbol) ?? {
                    entryTime: Date.now(),
                    highWatermark: p.avgEntryPrice,
                    trailingActive: false,
                };
                // Update high watermark
                if (currentPrice > meta.highWatermark) {
                    meta.highWatermark = currentPrice;
                }
                // Activate trailing once threshold reached
                const pnlPct = ((currentPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100;
                if (pnlPct >= config.exits.trailing_activation_pct) {
                    meta.trailingActive = true;
                }
                this.positionMeta.set(p.symbol, meta);

                return {
                    symbol: p.symbol,
                    mintAddress: this.brokerClient!.getMintAddress(p.symbol) ?? '',
                    qty: p.qty,
                    avgEntryPrice: p.avgEntryPrice,
                    currentPrice,
                    unrealizedPl: p.unrealizedPl,
                    entryTime: meta.entryTime,
                    highWatermark: meta.highWatermark,
                    trailingStopActive: meta.trailingActive,
                };
            });
            // Clean up meta for closed positions
            for (const sym of this.positionMeta.keys()) {
                if (!rawPositions.some(p => p.symbol === sym)) {
                    this.positionMeta.delete(sym);
                }
            }
        }

        // 3. Update risk manager
        if (this.accountState) {
            this.riskManager.updatePortfolioValue(this.accountState.portfolioValue);
        }

        const nowTs = Date.now();

        // 3b. Stablecoin depeg scan (every loop, cached 60s internally)
        try {
            this.lastStablecoinStatus = await this.stablecoinScanner.scan();
            if (this.lastStablecoinStatus.depeg) {
                this.log('warn', `Stablecoin depeg detected: spread=${(this.lastStablecoinStatus.spread * 100).toFixed(3)}% direction=${this.lastStablecoinStatus.direction}`);
            }
            // Publish to Redis for external consumers
            if (this.statePublisher) {
                await this.statePublisher.set(
                    'solanix:stablecoin',
                    JSON.stringify(this.lastStablecoinStatus),
                );
            }
        } catch (err: any) {
            this.log('warn', `Stablecoin scan error: ${err.message}`);
        }

        // 3c. Token unlock check (every 6 hours)
        const UNLOCK_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
        if (nowTs - this.lastUnlockCheckTime >= UNLOCK_CHECK_INTERVAL_MS) {
            this.lastUnlockCheckTime = nowTs;
            try {
                this.upcomingUnlocks = await this.unlockMonitor.getUpcoming(7);
                if (this.upcomingUnlocks.length > 0) {
                    for (const unlock of this.upcomingUnlocks) {
                        this.log('info', `Token unlock: ${unlock.symbol} in ${unlock.daysUntil}d — $${(unlock.amountUsd / 1_000_000).toFixed(1)}M (${unlock.percentOfCirculating.toFixed(1)}% circ, severity=${unlock.severity})`);
                    }
                }
            } catch (err: any) {
                this.log('warn', `Token unlock check error: ${err.message}`);
            }
        }

        // 4. Risk gate
        const riskCheck = this.riskManager.canTrade(
            this.accountState?.portfolioValue ?? 0,
            // Solanix has no settled-cash concept; pass 0 so the check always passes
            { ...config.risk, min_settled_cash: 0 },
            // Adapt Solanix limits to the shape RiskManager expects
            {
                max_open_positions: config.limits.max_open_positions,
                max_trades_per_day: config.limits.max_trades_per_day,
                // Solanix has no PDT rule; set a high sentinel
                max_day_trades_per_5d: 999,
            },
        );

        if (!riskCheck.canTrade) {
            this.log('warn', `Risk gate blocked: ${riskCheck.reason}`);
            // Still check exits even when risk gate blocks new trades
        }

        // 4b. Exit monitor — check TP/SL/trailing/stagnation on open positions
        if (this.positions.length > 0 && this.brokerClient) {
            // Tighten stop-loss during volatile regime
            const exitConfig = { ...config.exits };
            if (this.macroFilter) {
                exitConfig.stop_loss_pct = await this.macroFilter.adjustedStopLoss(config.exits.stop_loss_pct);
            }
            const exits = this.exitMonitor.check(this.positions, exitConfig);
            for (const exit of exits) {
                try {
                    const pos = this.positions.find(p => p.symbol === exit.symbol);
                    await this.brokerClient.closePosition(exit.symbol);
                    this.positionMeta.delete(exit.symbol);
                    this.symbolCooldowns.set(exit.symbol, Date.now() + this.SYMBOL_COOLDOWN_MS);
                    // Track realized P&L in dollars for risk limits
                    const pnlDollar = pos ? pos.unrealizedPl : 0;
                    this.riskManager.recordExit(pnlDollar);
                    this.riskManager.recordTrade(false);
                    // Post-Trade Analysis — fetch market context at exit
                    const holdMin = pos ? Math.round((Date.now() - pos.entryTime) / 60_000) : 0;
                    const pta = await this.postTradeAnalyzer.analyze(
                        exit.symbol, pos?.mintAddress ?? '',
                        pos?.avgEntryPrice ?? 0, pos?.currentPrice ?? 0,
                        holdMin, exit.reason, exit.pnlPct, pnlDollar,
                    );
                    this.log('info', `[PTA] ${exit.symbol}: ${pta.verdict} — ${pta.lesson}`);

                    // Persist exit to DB
                    const dbId = this.positionDbIds.get(exit.symbol);
                    if (dbId) {
                        await this.persistence.closePosition(dbId, exit.reason, pnlDollar, exit.pnlPct, pos?.currentPrice ?? 0);
                        await this.persistence.logTrade({
                            symbol: exit.symbol, mintAddress: pos?.mintAddress ?? '', side: 'SELL',
                            qty: pos?.qty ?? 0, fillPrice: pos?.currentPrice ?? 0,
                            dollarAmount: (pos?.qty ?? 0) * (pos?.currentPrice ?? 0),
                            realizedPnl: pnlDollar, exitReason: exit.reason,
                            paperTrading: this.tomlConfig.broker.paper_trading,
                            metadata: { pta },
                        });
                        this.positionDbIds.delete(exit.symbol);
                    }
                    this.log('info', `EXIT ${exit.symbol}: ${exit.reason} (P&L: ${exit.pnlPct >= 0 ? '+' : ''}${exit.pnlPct.toFixed(2)}% / $${pnlDollar.toFixed(2)})`);
                } catch (e: any) {
                    this.log('error', `Failed to close ${exit.symbol}: ${e.message}`);
                }
            }
        }

        // Always publish state (even when risk gate blocks new trades)
        // so the dashboard stays alive and Redis keys don't expire.
        await this.publishState();

        if (!riskCheck.canTrade) return;

        // 5. Daily watchlist refresh
        if (this.watchlistCurator?.needsRefresh() && this.signalGenerator) {
            try {
                const tokens = await this.watchlistCurator.curate();
                const newSymbols = tokens.map(t => t.symbol);
                // Rebuild signal generator with fresh watchlist
                this.signalGenerator = new DexScreenerSignalGenerator({
                    symbols: newSymbols,
                    min_signal_score: config.signals.min_signal_score,
                });
                // Register discovered mint addresses with broker + signal generator
                for (const t of tokens) {
                    if (t.mintAddress) {
                        this.brokerClient?.addDynamicToken(t.symbol, t.mintAddress);
                        // Ensure dynamic tokens (not in MINT_ADDRESS_MAP) get TA signals too
                        this.signalGenerator.addSymbol(t.symbol, t.mintAddress);
                    }
                }
                this.log('info', `Watchlist refreshed: ${newSymbols.length} symbols — ${newSymbols.join(', ')}`);
            } catch (e: any) {
                this.log('error', `WatchlistCurator failed: ${e.message} — keeping existing watchlist`);
                this.watchlistCurator.markRefreshed();
            }
        }

        // 6. DexScreener scan (every dexscreener_scan_interval_ms)
        if (
            config.signals.dexscreener_enabled &&
            this.dexScanner &&
            nowTs - this.lastDexScanTime >= config.timing.dexscreener_scan_interval_ms
        ) {
            this.lastDexScanTime = nowTs;
            this.dexScanner.evictExpired();
            try {
                const tokens = await this.dexScanner.scan();
                for (const token of tokens) {
                    // Register newly discovered tokens with the broker client
                    this.brokerClient?.addDynamicToken(token.symbol, token.mintAddress);
                    this.log('info', `DexScreener breakout: ${token.symbol} @ $${token.priceUsd}`);

                    // Generate a BUY signal from the volume spike
                    const spikeRatio = token.volumeChange1h / Math.max(token.volume24h / 24, 1);
                    const confidence = Math.min(0.85, 0.5 + spikeRatio * 0.05);
                    await this.evaluateSignal({
                        symbol: token.symbol,
                        action: 'BUY',
                        confidence,
                        reasoning: `DexScreener volume spike (${spikeRatio.toFixed(1)}x avg), liquidity $${(token.liquidityUsd / 1000).toFixed(0)}k`,
                        currentPrice: token.priceUsd,
                    });
                }
            } catch (e: any) {
                this.log('error', `DexScreener scan error: ${e.message}`);
            }
        }

        // 6. TA signal scan (every signal_scan_interval_ms)
        if (
            this.signalGenerator &&
            nowTs - this.lastSignalScanTime >= config.timing.signal_scan_interval_ms
        ) {
            this.lastSignalScanTime = nowTs;
            try {
                const signals = await this.signalGenerator.scan();
                this.log('info', `DexScreener signal scan: ${signals.length} actionable signal(s) from ${this.signalGenerator.watchlistSize} tokens`);
                for (const signal of signals) {
                    await this.evaluateSignal({
                        symbol: signal.symbol,
                        action: signal.action,
                        confidence: signal.confidence / 100, // normalize 0-100 → 0-1
                        reasoning: signal.reasoning.join('; '),
                        currentPrice: signal.currentPrice,
                    });
                }
            } catch (e: any) {
                this.log('error', `TA signal scan error: ${e.message}`);
            }
        }

        // 7. Process queued messages
        while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift()!;
            await this.handleMessage(msg);
        }

        // 8. Publish state to Redis
        await this.publishState();
    }

    // -------------------------------------------------------------------------
    // Signal evaluation
    // -------------------------------------------------------------------------

    private async evaluateSignal(payload: any): Promise<void> {
        if (!this.accountState || !this.brokerClient) {
            this.log('warn', 'Cannot evaluate signal: not initialized.');
            return;
        }

        const config = this.tomlConfig;
        const { symbol, action, confidence, reasoning, currentPrice, source } = payload;

        // BUY-only for now (spot long only)
        if (action !== 'BUY') {
            this.log('info', `Skipping non-BUY signal for ${symbol} (action=${action})`);
            return;
        }

        // Macro filter — veto check + confidence adjustment from Cryonix data
        let adjustedConfidence = confidence;
        if (this.macroFilter) {
            const macro = await this.macroFilter.evaluate(symbol);
            if (macro.veto) {
                this.log('warn', `Macro veto for ${symbol}: ${macro.vetoReason}`);
                return;
            }
            if (macro.delta !== 0) {
                adjustedConfidence = Math.max(0, Math.min(1, confidence + macro.delta));
                this.log('info', `Macro adjustment for ${symbol}: ${macro.delta >= 0 ? '+' : ''}${(macro.delta * 100).toFixed(0)}% (${macro.reasons.join(', ')})`);
            }
        }

        // Polymarket sentiment adjustment
        try {
            const poly = await this.polymarket.getConfidenceDelta('solanix');
            if (poly.delta !== 0) {
                adjustedConfidence = Math.max(0, Math.min(1, adjustedConfidence + poly.delta / 100));
                this.log('info', `Polymarket: ${poly.delta >= 0 ? '+' : ''}${poly.delta}% (${poly.reason})`);
            }
        } catch {
            // Non-critical, continue without Polymarket data
        }

        // Stablecoin depeg penalty — market stress indicator
        if (this.lastStablecoinStatus?.depeg) {
            adjustedConfidence = Math.max(0, adjustedConfidence - 0.10);
            this.log('info', `Stablecoin depeg penalty for ${symbol}: -10% (spread=${(this.lastStablecoinStatus.spread * 100).toFixed(3)}%)`);
        }

        // Token unlock penalty — large upcoming unlocks create sell pressure
        const unlockEvent = this.upcomingUnlocks.find(
            u => u.symbol === symbol && u.daysUntil <= 3 && u.severity === 'high',
        );
        if (unlockEvent) {
            adjustedConfidence = Math.max(0, adjustedConfidence - 0.15);
            this.log('info', `Token unlock penalty for ${symbol}: -15% ($${(unlockEvent.amountUsd / 1_000_000).toFixed(1)}M unlock in ${unlockEvent.daysUntil}d)`);
        }

        // Bayesian self-learning adjustment (based on historical trade outcomes)
        await this.bayesian.maybeRefresh();
        const bayesResult = this.bayesian.adjustConfidence(adjustedConfidence, {
            symbol,
            source: (source as any) ?? 'ta',
            confidence: adjustedConfidence,
            hourUtc: new Date().getUTCHours(),
        });
        if (bayesResult.factors.length > 0 && !bayesResult.factors[0].includes('insufficient')) {
            const delta = bayesResult.adjusted - adjustedConfidence;
            if (Math.abs(delta) > 0.01) {
                this.log('info', `[bayes] ${symbol}: ${adjustedConfidence.toFixed(2)} → ${bayesResult.adjusted.toFixed(2)} (${bayesResult.factors.join(', ')})`);
            }
            adjustedConfidence = bayesResult.adjusted;
        }

        // Confidence threshold (after macro + polymarket + stablecoin + unlock + Bayesian adjustment)
        if (adjustedConfidence < config.risk.min_confidence) {
            this.log('info', `Signal confidence ${adjustedConfidence.toFixed(2)} below threshold (${config.risk.min_confidence}). Skipping ${symbol}.`);
            return;
        }

        // Symbol cooldown — prevent re-entry after recent exit
        const cooldownUntil = this.symbolCooldowns.get(symbol);
        if (cooldownUntil && Date.now() < cooldownUntil) {
            const minsLeft = Math.round((cooldownUntil - Date.now()) / 60_000);
            this.log('info', `${symbol} on cooldown (${minsLeft}min left) — skipping re-entry.`);
            return;
        }

        // Dedup: skip if we already bought this symbol in the current loop iteration
        if (this.signalsBoughtThisLoop.has(symbol)) {
            this.log('info', `Already bought ${symbol} this loop — dedup skip.`);
            return;
        }

        // Already holding this symbol — skip re-entry
        if (this.positions.some(p => p.symbol === symbol)) {
            this.log('info', `Already holding ${symbol} — skipping re-entry.`);
            return;
        }

        // Max positions gate — try smart rotation before giving up
        if (this.positions.length >= config.limits.max_open_positions) {
            const rotation = trySmartRotation(
                adjustedConfidence,
                reasoning ?? '',
                symbol,
                this.positions,
                config.rotation,
            );
            if (!rotation.shouldRotate || !rotation.victim) {
                this.log('info', `Max positions reached, rotation declined: ${rotation.reason}`);
                return;
            }
            // Close the weakest position to make room
            this.log('info', `ROTATION: ${rotation.reason}`);
            try {
                await this.brokerClient.closePosition(rotation.victim.symbol);
                this.positionMeta.delete(rotation.victim.symbol);
                this.symbolCooldowns.set(rotation.victim.symbol, Date.now() + this.SYMBOL_COOLDOWN_MS);
                const victimPnlPct = rotation.victim.avgEntryPrice > 0
                    ? ((rotation.victim.currentPrice - rotation.victim.avgEntryPrice) / rotation.victim.avgEntryPrice) * 100
                    : 0;
                const victimPnlDollar = rotation.victim.unrealizedPl ?? 0;
                this.riskManager.recordExit(victimPnlDollar);
                this.riskManager.recordTrade(false);
                // Post-Trade Analysis for rotation victim
                const victimHoldMin = Math.round((Date.now() - (rotation.victim.entryTime ?? Date.now())) / 60_000);
                const victimPta = await this.postTradeAnalyzer.analyze(
                    rotation.victim.symbol, rotation.victim.mintAddress,
                    rotation.victim.avgEntryPrice, rotation.victim.currentPrice,
                    victimHoldMin, 'rotation', victimPnlPct, victimPnlDollar,
                );
                this.log('info', `[PTA] ${rotation.victim.symbol}: ${victimPta.verdict} — ${victimPta.lesson}`);

                // Persist rotation close to DB
                const victimDbId = this.positionDbIds.get(rotation.victim.symbol);
                if (victimDbId) {
                    await this.persistence.closePosition(victimDbId, 'rotation', victimPnlDollar, victimPnlPct, rotation.victim.currentPrice);
                    await this.persistence.logTrade({
                        symbol: rotation.victim.symbol, mintAddress: rotation.victim.mintAddress, side: 'SELL',
                        qty: rotation.victim.qty, fillPrice: rotation.victim.currentPrice,
                        dollarAmount: rotation.victim.qty * rotation.victim.currentPrice,
                        realizedPnl: victimPnlDollar, exitReason: 'rotation',
                        paperTrading: this.tomlConfig.broker.paper_trading,
                        metadata: { pta: victimPta },
                    });
                    this.positionDbIds.delete(rotation.victim.symbol);
                }
                this.log('info', `Closed ${rotation.victim.symbol} for rotation (P&L: ${victimPnlPct >= 0 ? '+' : ''}${victimPnlPct.toFixed(2)}% / $${victimPnlDollar.toFixed(2)})`);
                // Refresh positions after close
                const rawPositions = await this.brokerClient.getPositions();
                this.positions = rawPositions.map((p) => {
                    const cp = p.avgEntryPrice + (p.unrealizedPl / Math.max(p.qty, 1e-12));
                    const meta = this.positionMeta.get(p.symbol) ?? { entryTime: Date.now(), highWatermark: p.avgEntryPrice, trailingActive: false };
                    return { symbol: p.symbol, mintAddress: this.brokerClient!.getMintAddress(p.symbol) ?? '', qty: p.qty, avgEntryPrice: p.avgEntryPrice, currentPrice: cp, unrealizedPl: p.unrealizedPl, entryTime: meta.entryTime, highWatermark: meta.highWatermark, trailingStopActive: meta.trailingActive };
                });
            } catch (e: any) {
                this.log('error', `Rotation close failed for ${rotation.victim.symbol}: ${e.message}`);
                return;
            }
        }

        // Risk gate
        const riskCheck = this.riskManager.canTrade(
            this.accountState.portfolioValue,
            // Solanix has no settled-cash concept; pass 0 so the check always passes
            { ...config.risk, min_settled_cash: 0 },
            { max_open_positions: config.limits.max_open_positions, max_trades_per_day: config.limits.max_trades_per_day, max_day_trades_per_5d: 999 },
        );
        if (!riskCheck.canTrade) {
            this.log('warn', `Risk gate blocked signal for ${symbol}: ${riskCheck.reason}`);
            return;
        }

        // Size the position
        const usdcToSpend = PositionSizer.calc(
            currentPrice ?? 0,
            this.accountState.usdcBalance,
            { ...config.capital, max_single_position_pct: 1.0 },
        ) * (currentPrice ?? 0); // PositionSizer returns fractional qty; convert back to dollars

        if (usdcToSpend <= 0) {
            this.log('warn', `Position sizer returned 0 for ${symbol} (insufficient balance or price invalid)`);
            return;
        }

        this.log('info', `Submitting BUY for ${symbol} ~$${usdcToSpend.toFixed(2)} (confidence=${adjustedConfidence.toFixed(2)}${adjustedConfidence !== confidence ? ` ← ${confidence.toFixed(2)} raw` : ''})`);

        const result = await this.brokerClient.submitOrder({
            symbol,
            action: 'BUY',
            qty: usdcToSpend,
            orderType: 'MARKET',
        });

        if (result.success) {
            this.log('info', `Order filled: ${result.orderId} — ${result.status}`);
            this.signalsBoughtThisLoop.add(symbol);
            this.riskManager.recordTrade(false);

            // Persist to DB
            const mint = this.brokerClient.getMintAddress(symbol) ?? '';
            const posId = await this.persistence.openPosition(
                symbol, mint, result.filledQty ?? 0, result.filledAvgPrice ?? 0,
                confidence, reasoning ?? undefined,
                { source: source ?? 'ta', hourUtc: new Date().getUTCHours() },
            );
            if (posId) this.positionDbIds.set(symbol, posId);
            await this.persistence.logTrade({
                symbol, mintAddress: mint, side: 'BUY',
                qty: result.filledQty ?? 0, fillPrice: result.filledAvgPrice ?? 0,
                dollarAmount: usdcToSpend, confidence, reasoning: reasoning ?? undefined,
                orderId: result.orderId, positionId: posId ?? undefined,
                paperTrading: this.tomlConfig.broker.paper_trading,
                metadata: {
                    entry: {
                        fillPrice: result.filledAvgPrice ?? 0,
                        signalPrice: currentPrice ?? 0,
                        rawConfidence: confidence,
                        adjustedConfidence,
                        source: source ?? 'dexscreener',
                    },
                },
            });

            // Mirror BUY to shadow strategies
            for (const shadow of this.shadows) {
                await shadow.onPrimaryBuy(symbol, mint, result.filledAvgPrice ?? 0, confidence);
            }

            await this.statePublisher?.addSignal({
                symbol,
                action: 'BUY',
                confidence,
                reasoning: reasoning ?? '',
                timestamp: Date.now(),
            });
        } else {
            this.log('error', `Order failed for ${symbol}: ${result.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /** Publishes current state to Redis. Errors are swallowed. */
    private async publishState(): Promise<void> {
        await this.statePublisher?.publishPositions(this.positions as any);
        if (this.accountState) {
            await this.statePublisher?.publishAccount({
                buyingPower: this.accountState.usdcBalance,
                settledCash: this.accountState.usdcBalance,
                portfolioValue: this.accountState.portfolioValue,
                isPatternDayTrader: false,
                dailyPnl: 0,
                dailyPnlPct: 0,
                updatedAt: Date.now(),
            });
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

        // Sync position prices to DB (every publishState call)
        const priceUpdates = this.positions
            .filter(p => this.positionDbIds.has(p.symbol))
            .map(p => ({
                id: this.positionDbIds.get(p.symbol)!,
                currentPrice: p.currentPrice,
                highWatermark: p.highWatermark,
                trailingStopActive: p.trailingStopActive ?? false,
            }));
        if (priceUpdates.length > 0) {
            await this.persistence.syncPrices(priceUpdates);
        }

        // Tick shadow strategies with current prices
        if (this.shadows.length > 0 && this.positions.length > 0) {
            const priceMap = new Map(this.positions.map(p => [p.symbol, p.currentPrice]));
            for (const shadow of this.shadows) {
                const exits = await shadow.tick(priceMap);
                for (const msg of exits) {
                    this.log('info', msg);
                }
            }
            // Publish shadow stats to Redis for dashboard comparison
            const shadowStats = this.shadows.map(s => s.getStats());
            await this.statePublisher?.set('solanix:shadows', JSON.stringify(shadowStats));
        }
    }

    /**
     * Check the solanix:circuit_breaker Redis key.
     * Returns true if the circuit breaker is open (value === '1' or 'true').
     * Gracefully returns false if Redis is unavailable.
     */
    private async isCircuitBreakerOpen(): Promise<boolean> {
        if (!this.statePublisher) return false;
        const value = await this.statePublisher.get('solanix:circuit_breaker');
        return value === '1' || value === 'true';
    }
}

/** ISO week number (1-53) for weekly risk reset. */
function getISOWeek(): number {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
