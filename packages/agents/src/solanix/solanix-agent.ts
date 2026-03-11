import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import { RiskManager } from '../aktienix/risk-manager';
import { PositionSizer } from '../aktienix/position-sizer';
import { StatePublisher } from '../aktienix/state-publisher';
import { SolanaClient } from './brokers/solana-client';
import { MINT_ADDRESS_MAP } from './signals/solana-signal-generator';
import { DexScreenerSignalGenerator } from './signals/dexscreener-signal-generator';
import { DexScreenerScanner } from './signals/dexscreener-scanner';
import { SolanaWatchlistCurator } from './watchlist-curator';
import { SolanaExitMonitor } from './exit-monitor';
import { MacroFilter } from './macro-filter';
import { trySmartRotation } from './smart-rotation';
import { loadSolanixConfig } from './config';
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
    private riskManager = new RiskManager();

    private positions: SolanaPosition[] = [];
    private positionMeta: Map<string, { entryTime: number; highWatermark: number; trailingActive: boolean }> = new Map();
    private accountState: SolanaAccountState | null = null;

    private lastDexScanTime = 0;
    private lastSignalScanTime = 0;

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
                    await this.brokerClient.closePosition(exit.symbol);
                    this.positionMeta.delete(exit.symbol);
                    this.riskManager.recordTrade(exit.pnlPct >= 0);
                    this.log('info', `EXIT ${exit.symbol}: ${exit.reason} (P&L: ${exit.pnlPct >= 0 ? '+' : ''}${exit.pnlPct.toFixed(2)}%)`);
                } catch (e: any) {
                    this.log('error', `Failed to close ${exit.symbol}: ${e.message}`);
                }
            }
        }

        if (!riskCheck.canTrade) return;

        const nowTs = Date.now();

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
                // Register discovered mint addresses with broker
                for (const t of tokens) {
                    if (t.mintAddress) {
                        this.brokerClient?.addDynamicToken(t.symbol, t.mintAddress);
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
                this.log('info', `TA scan complete: ${signals.length} actionable signal(s) from ${this.signalGenerator.watchlistSize} tokens`);
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
        const { symbol, action, confidence, reasoning, currentPrice } = payload;

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

        // Confidence threshold (after macro adjustment)
        if (adjustedConfidence < config.risk.min_confidence) {
            this.log('info', `Signal confidence ${adjustedConfidence.toFixed(2)} below threshold (${config.risk.min_confidence}). Skipping ${symbol}.`);
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
                const victimPnlPct = rotation.victim.avgEntryPrice > 0
                    ? ((rotation.victim.currentPrice - rotation.victim.avgEntryPrice) / rotation.victim.avgEntryPrice) * 100
                    : 0;
                this.riskManager.recordTrade(victimPnlPct >= 0);
                this.log('info', `Closed ${rotation.victim.symbol} for rotation (P&L: ${victimPnlPct >= 0 ? '+' : ''}${victimPnlPct.toFixed(2)}%)`);
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
            config.capital,
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
            this.riskManager.recordTrade(false);
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
