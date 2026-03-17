/**
 * Ψnix (Psinix) — Phase Convergence Trading Agent
 *
 * The first trading bot to use Kuramoto order parameter for signal
 * aggregation. Trades only when independent signals synchronize
 * (phase transition), not on linear averages.
 *
 * Aggregates signals from: Copynix wallets, Polymarket, Fear & Greed,
 * Cryonix TA patterns. Computes Ψ(t) and trades when |Ψ| > threshold.
 */

import { readFileSync, existsSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';
import { PsiEngine, type PsiResult } from './psi-engine';
import { SignalCollector, type RedisReader } from './signal-collector';
import { OHLCVFetcher } from './ohlcv-fetcher';
import { BayesianWeightTracker } from './bayesian-weights';

// ── Types ────────────────────────────────────────────────────────────

interface PsinixConfig {
    broker: { paper_trading: boolean; exchange: string; initial_balance_usd: number };
    signals: { sources: string[]; min_signals: number };
    psi: { phase_transition_threshold: number; kelly_fraction_cap: number; entropy_bins: number; entropy_floor: number; beta_scale: number };
    trading: { min_psi_magnitude: number; max_position_size_usd: number; max_positions: number; symbols: string[] };
    exits: { take_profit_pct: number; stop_loss_pct: number; trailing_stop_pct: number; trailing_activation_pct: number };
    timing: { poll_interval_ms: number; price_update_ms: number };
}

interface PaperPosition {
    symbol: string;
    side: 'LONG' | 'SHORT';
    qty: number;
    entryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    psiAtEntry: number;
    coherenceAtEntry: number;
    entryTime: number;
    highWatermark: number;
    trailingActive: boolean;
    signalSourceIds: string[];
}

interface PaperTrade {
    timestamp: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    price: number;
    dollarAmount: number;
    psi: number;
    coherence: number;
    pnl: number | null;
    reason: string;
}

// ── Trade Logger ─────────────────────────────────────────────────────

class PsinixTradeLogger {
    private pg: any = null;

    async connect(): Promise<void> {
        const url = process.env.POSTGRES_URL;
        if (!url) return;
        try {
            const { Client } = await import('pg');
            this.pg = new Client({ connectionString: url });
            await this.pg.connect();
            await this.pg.query(`
                CREATE TABLE IF NOT EXISTS psinix_trades (
                    id SERIAL PRIMARY KEY,
                    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    qty DOUBLE PRECISION,
                    price DOUBLE PRECISION,
                    dollar_amount DOUBLE PRECISION,
                    realized_pnl DOUBLE PRECISION,
                    psi DOUBLE PRECISION,
                    coherence DOUBLE PRECISION,
                    entropy DOUBLE PRECISION,
                    signal_count INTEGER,
                    reason TEXT,
                    metadata JSONB
                )
            `);
        } catch (err: any) {
            console.warn('[PsinixTradeLogger] Connect failed:', err.message);
            this.pg = null;
        }
    }

    async log(trade: PaperTrade & { entropy?: number; signalCount?: number; metadata?: any }): Promise<void> {
        if (!this.pg) return;
        try {
            await this.pg.query(
                `INSERT INTO psinix_trades (symbol, side, qty, price, dollar_amount, realized_pnl, psi, coherence, entropy, signal_count, reason, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [trade.symbol, trade.side, trade.qty, trade.price, trade.dollarAmount,
                 trade.pnl, trade.psi, trade.coherence, trade.entropy ?? null,
                 trade.signalCount ?? null, trade.reason, trade.metadata ? JSON.stringify(trade.metadata) : null],
            );
        } catch (err: any) {
            console.warn('[PsinixTradeLogger] Insert failed:', err.message);
        }
    }

    async close(): Promise<void> {
        try { await this.pg?.end(); } catch { }
    }
}

// ── Main Agent ───────────────────────────────────────────────────────

export class PsinixAgent {
    private config: PsinixConfig;
    private redis: any = null;
    private collector: SignalCollector | null = null;
    private ohlcv = new OHLCVFetcher(60_000);
    private logger = new PsinixTradeLogger();
    private weights = new BayesianWeightTracker(0.92);
    private isRunning = false;

    // Paper trading state
    private balance: number;
    private positions = new Map<string, PaperPosition>();
    private trades: PaperTrade[] = [];
    private priceCache = new Map<string, number>();

    // Stats
    private pollCount = 0;
    private lastHeartbeat = 0;
    private totalPnl = 0;
    private wins = 0;
    private losses = 0;

    constructor() {
        this.config = this.loadConfig();
        this.balance = this.config.broker.initial_balance_usd;
    }

    async initialize(): Promise<void> {
        console.log('[psinix] Initializing Ψnix — Phase Convergence Trading Agent...');

        // Connect to Redis for signal collection
        const kvUrl = process.env.KV_URL ?? 'redis://localhost:6379';
        try {
            const Redis = (await import('ioredis')).default;
            this.redis = new Redis(kvUrl);

            this.collector = new SignalCollector({
                get: async (key: string) => this.redis.get(key),
                keys: async (pattern: string) => this.redis.keys(pattern),
                lrange: async (key: string, start: number, stop: number) => this.redis.lrange(key, start, stop),
            });

            console.log('[psinix] Redis connected — signal collector ready');

            // Restore Bayesian weights from Redis
            try {
                const saved = await this.redis?.get('psinix:weights');
                if (saved) this.weights = BayesianWeightTracker.deserialize(saved, 0.92);
            } catch { /* start fresh if restore fails */ }
        } catch (err: any) {
            console.error('[psinix] Redis connect failed:', err.message);
        }

        // Initialize OHLCV fetcher (Binance public API via ccxt)
        try {
            await this.ohlcv.initialize();
            console.log('[psinix] OHLCV fetcher initialized (Binance ccxt)');
        } catch (err: any) {
            console.error('[psinix] OHLCV fetcher init failed:', err.message);
        }

        // Connect trade logger
        await this.logger.connect();

        console.log(`[psinix] Paper trading: $${this.balance} USDC`);
        console.log(`[psinix] Symbols: ${this.config.trading.symbols.join(', ')}`);
        console.log(`[psinix] Phase transition threshold: C > ${this.config.psi.phase_transition_threshold}`);
        console.log(`[psinix] Min Ψ magnitude: ${this.config.trading.min_psi_magnitude}`);
        console.log('[psinix] Initialization complete.');
    }

    async start(): Promise<void> {
        this.isRunning = true;
        console.log('[psinix] Starting Ψnix main loop...');
        await this.runLoop();
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        await this.logger.close();
        try { await this.redis?.quit(); } catch { }
        console.log('[psinix] Stopped.');
    }

    // ── Main Loop ────────────────────────────────────────────────────

    private async runLoop(): Promise<void> {
        while (this.isRunning) {
            try {
                const now = Date.now();

                // Update prices (fetches 50 candles per symbol, cached 60s)
                await this.updatePrices();

                // Check exits first
                await this.checkExits();

                // Compute Ψ for each symbol
                for (const symbol of this.config.trading.symbols) {
                    try {
                        await this.evaluateSymbol(symbol);
                    } catch (symErr) {
                        console.warn(`[psinix] evaluateSymbol(${symbol}) error:`, symErr instanceof Error ? symErr.message : String(symErr));
                    }
                }

                // Heartbeat every 5 minutes
                if (now - this.lastHeartbeat >= 300_000) {
                    const posCount = this.positions.size;
                    const portfolioValue = this.getPortfolioValue();
                    const wr = this.wins + this.losses > 0 ? ((this.wins / (this.wins + this.losses)) * 100).toFixed(0) : '?';
                    console.log(`[psinix] [HEARTBEAT] poll #${this.pollCount} | ${posCount} pos | $${portfolioValue.toFixed(0)} value | ${this.wins}W/${this.losses}L (${wr}% WR) | PnL: $${this.totalPnl.toFixed(2)}`);
                    this.lastHeartbeat = now;

                    // Publish state to Redis
                    await this.publishState();
                }

                this.pollCount++;
            } catch (err) {
                console.error('[psinix] Loop error:', err instanceof Error ? err.message : String(err));
            }

            await new Promise(r => setTimeout(r, this.config.timing.poll_interval_ms));
        }
    }

    // ── Symbol Evaluation ────────────────────────────────────────────

    private async evaluateSymbol(symbol: string): Promise<void> {
        if (!this.collector) return;

        // Get recent prices first — needed for both price signals and entropy
        const prices = await this.getRecentPrices(symbol);

        // Collect signals from all sources (pass prices for price-based signals)
        const signals = await this.collector.collect(symbol, prices);
        if (signals.length < this.config.signals.min_signals) return;

        // Apply dynamic Bayesian weights before Ψ computation
        for (const sig of signals) {
            const dynWeight = this.weights.getWeight(sig.sourceId);
            sig.weight = dynWeight;
        }
        const entropy = PsiEngine.computeMarketEntropy(prices, this.config.psi.entropy_bins);

        // Compute Ψ
        const wr = this.wins + this.losses > 0 ? this.wins / (this.wins + this.losses) : 0.5;
        const betaScale = this.config.psi.beta_scale ?? 3.0;
        const result = PsiEngine.compute(signals, entropy, wr, 1.5, betaScale);

        // Log significant Ψ values
        if (Math.abs(result.psi) > 0.01 || result.phaseTransition) {
            const dir = result.psi > 0 ? '↑ LONG' : result.psi < 0 ? '↓ SHORT' : '— NEUTRAL';
            console.log(
                `[psinix] Ψ(${symbol}) = ${result.psi.toFixed(4)} ${dir} | ` +
                `C=${result.coherence.toFixed(3)} | β=${result.beta.toFixed(2)} | ` +
                `${result.debug.signalCount} signals | ` +
                `${result.phaseTransition ? '⚡ PHASE TRANSITION' : 'no transition'}`,
            );
        }

        // Trade decision
        if (result.phaseTransition && Math.abs(result.psi) >= this.config.trading.min_psi_magnitude) {
            const sourceIds = signals.map(s => s.sourceId);
            await this.executeTrade(symbol, result, sourceIds);
        }
    }

    // ── Trade Execution ──────────────────────────────────────────────

    private async executeTrade(symbol: string, psi: PsiResult, sourceIds: string[] = []): Promise<void> {
        // Already have position?
        if (this.positions.has(symbol)) return;

        // Max positions?
        if (this.positions.size >= this.config.trading.max_positions) return;

        const currentPrice = this.priceCache.get(symbol);
        if (!currentPrice || currentPrice <= 0) return;

        // Position size from Ψ — |Ψ| × max_position_size
        const dollarSize = Math.abs(psi.psi) * this.config.trading.max_position_size_usd;
        if (dollarSize < 5) return; // Minimum $5

        const cappedSize = Math.min(dollarSize, this.balance * 0.2); // Max 20% of balance
        const qty = cappedSize / currentPrice;
        const side: 'LONG' | 'SHORT' = psi.psi > 0 ? 'LONG' : 'SHORT';

        // Execute paper trade
        this.balance -= cappedSize;
        this.positions.set(symbol, {
            symbol,
            side,
            qty,
            entryPrice: currentPrice,
            currentPrice,
            unrealizedPnl: 0,
            psiAtEntry: psi.psi,
            coherenceAtEntry: psi.coherence,
            entryTime: Date.now(),
            highWatermark: currentPrice,
            trailingActive: false,
            signalSourceIds: sourceIds,
        });

        const trade: PaperTrade = {
            timestamp: Date.now(),
            symbol,
            side: 'BUY',
            qty,
            price: currentPrice,
            dollarAmount: cappedSize,
            psi: psi.psi,
            coherence: psi.coherence,
            pnl: null,
            reason: `Ψ=${psi.psi.toFixed(4)} C=${psi.coherence.toFixed(3)} ${side}`,
        };
        this.trades.push(trade);

        await this.logger.log({
            ...trade,
            entropy: psi.entropy,
            signalCount: psi.debug.signalCount,
            metadata: { beta: psi.beta, weightedSignal: psi.weightedSignal, kellyFraction: psi.kellyFraction },
        });

        console.log(
            `[psinix] ⚡ ${side} ${symbol} | $${cappedSize.toFixed(2)} @ $${currentPrice.toFixed(2)} | ` +
            `Ψ=${psi.psi.toFixed(4)} C=${psi.coherence.toFixed(3)} β=${psi.beta.toFixed(2)}`,
        );
    }

    // ── Exit Management ──────────────────────────────────────────────

    private async checkExits(): Promise<void> {
        const config = this.config.exits;

        for (const [symbol, pos] of this.positions) {
            const price = this.priceCache.get(symbol) ?? pos.currentPrice;
            pos.currentPrice = price;

            // Update PnL
            const direction = pos.side === 'LONG' ? 1 : -1;
            const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * direction;
            pos.unrealizedPnl = (price - pos.entryPrice) * pos.qty * direction;

            // High watermark
            if (pos.side === 'LONG' && price > pos.highWatermark) pos.highWatermark = price;
            if (pos.side === 'SHORT' && price < pos.highWatermark) pos.highWatermark = price;

            let exitReason: string | null = null;

            // Stop loss
            if (pnlPct <= -config.stop_loss_pct) {
                exitReason = `SL hit (${pnlPct.toFixed(1)}%)`;
            }
            // Take profit
            else if (pnlPct >= config.take_profit_pct) {
                exitReason = `TP hit (${pnlPct.toFixed(1)}%)`;
            }
            // Trailing stop
            else {
                if (pnlPct >= config.trailing_activation_pct) pos.trailingActive = true;
                if (pos.trailingActive) {
                    const hwmPnl = pos.side === 'LONG'
                        ? ((pos.highWatermark - pos.entryPrice) / pos.entryPrice) * 100
                        : ((pos.entryPrice - pos.highWatermark) / pos.entryPrice) * 100;
                    const drawdown = hwmPnl - pnlPct;
                    if (drawdown >= config.trailing_stop_pct) {
                        exitReason = `Trailing stop (${drawdown.toFixed(1)}% from HWM)`;
                    }
                }
            }

            if (exitReason) {
                await this.closePosition(symbol, price, exitReason);
            }
        }
    }

    private async closePosition(symbol: string, price: number, reason: string): Promise<void> {
        const pos = this.positions.get(symbol);
        if (!pos) return;

        const direction = pos.side === 'LONG' ? 1 : -1;
        const pnl = (price - pos.entryPrice) * pos.qty * direction;
        const proceeds = pos.qty * price;

        this.balance += proceeds;
        this.totalPnl += pnl;
        if (pnl > 0) this.wins++;
        else this.losses++;

        // Update Bayesian weights for contributing signal sources
        const profitable = pnl > 0;
        for (const sourceId of pos.signalSourceIds) {
            this.weights.update(sourceId, pos.side === 'LONG' ? 1 : -1, profitable);
        }
        try {
            await this.redis?.set('psinix:weights', this.weights.serialize());
        } catch { /* non-critical */ }

        this.positions.delete(symbol);

        const trade: PaperTrade = {
            timestamp: Date.now(),
            symbol,
            side: 'SELL',
            qty: pos.qty,
            price,
            dollarAmount: proceeds,
            psi: pos.psiAtEntry,
            coherence: pos.coherenceAtEntry,
            pnl,
            reason,
        };
        this.trades.push(trade);
        await this.logger.log(trade);

        const emoji = pnl >= 0 ? '🟢' : '🔴';
        console.log(
            `[psinix] ${emoji} CLOSE ${pos.side} ${symbol} | ${reason} | ` +
            `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Total: $${this.totalPnl.toFixed(2)}`,
        );
    }

    // ── Price Data ───────────────────────────────────────────────────

    private async updatePrices(): Promise<void> {
        // Fetch 50 candles (shared cache with getRecentPrices), use last for price
        for (const symbol of this.config.trading.symbols) {
            try {
                const closes = await this.ohlcv.getClosePrices(symbol, '15m', 50);
                if (closes.length > 0 && closes[closes.length - 1] > 0) {
                    this.priceCache.set(symbol, closes[closes.length - 1]);
                }
            } catch {
                // Non-critical — positions still use last known price
            }
        }
    }

    private async getRecentPrices(symbol: string): Promise<number[]> {
        // Real OHLCV close prices from Binance for entropy calculation
        try {
            return await this.ohlcv.getClosePrices(symbol, '15m', 50);
        } catch {
            // Fallback: return empty (will produce max entropy)
            return [];
        }
    }

    // ── State Publishing ─────────────────────────────────────────────

    private async publishState(): Promise<void> {
        if (!this.redis) return;
        try {
            const state = {
                status: 'running',
                portfolioValue: this.getPortfolioValue(),
                balance: this.balance,
                positions: Array.from(this.positions.values()),
                totalPnl: this.totalPnl,
                wins: this.wins,
                losses: this.losses,
                winRate: this.wins + this.losses > 0 ? this.wins / (this.wins + this.losses) : 0,
                pollCount: this.pollCount,
                weights: Object.fromEntries(this.weights.getAll()),
                updatedAt: Date.now(),
            };
            await this.redis.set('psinix:state', JSON.stringify(state));
            await this.redis.set('psinix:status', 'running');
        } catch { /* non-critical */ }
    }

    private getPortfolioValue(): number {
        let posValue = 0;
        for (const pos of this.positions.values()) {
            posValue += pos.qty * pos.currentPrice;
        }
        return this.balance + posValue;
    }

    // ── Config ───────────────────────────────────────────────────────

    private loadConfig(): PsinixConfig {
        const defaults: PsinixConfig = {
            broker: { paper_trading: true, exchange: 'binance', initial_balance_usd: 1000 },
            signals: { sources: ['smartmoney', 'polymarket', 'fear_greed'], min_signals: 3 },
            psi: { phase_transition_threshold: 0.6, kelly_fraction_cap: 0.25, entropy_bins: 10, entropy_floor: 0.1, beta_scale: 3.0 },
            trading: { min_psi_magnitude: 0.05, max_position_size_usd: 200, max_positions: 3, symbols: ['BTC/USDC', 'ETH/USDC', 'SOL/USDC'] },
            exits: { take_profit_pct: 5, stop_loss_pct: 3, trailing_stop_pct: 2, trailing_activation_pct: 2.5 },
            timing: { poll_interval_ms: 60000, price_update_ms: 30000 },
        };

        const tomlPath = join(process.cwd(), 'psinix.toml');
        if (!existsSync(tomlPath)) return defaults;

        try {
            const raw = readFileSync(tomlPath, 'utf-8');
            const parsed = parse(raw) as Partial<PsinixConfig>;
            return {
                broker: { ...defaults.broker, ...parsed.broker },
                signals: { ...defaults.signals, ...parsed.signals },
                psi: { ...defaults.psi, ...parsed.psi },
                trading: { ...defaults.trading, ...parsed.trading },
                exits: { ...defaults.exits, ...parsed.exits },
                timing: { ...defaults.timing, ...parsed.timing },
            };
        } catch {
            console.warn('[psinix] Failed to parse psinix.toml, using defaults');
            return defaults;
        }
    }
}
