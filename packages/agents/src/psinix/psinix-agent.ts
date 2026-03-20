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
import { EquityFetcher } from './equity-fetcher';

// ── Types ────────────────────────────────────────────────────────────

interface PsinixConfig {
    broker: { paper_trading: boolean; exchange: string; initial_balance_usd: number };
    signals: { sources: string[]; min_signals: number };
    psi: { phase_transition_threshold: number; kelly_fraction_cap: number; entropy_bins: number; entropy_floor: number; beta_scale: number };
    trading: { min_psi_magnitude: number; max_position_size_usd: number; max_positions: number; symbols: string[] };
    exits: { take_profit_pct: number; stop_loss_pct: number; trailing_stop_pct: number; trailing_activation_pct: number };
    risk: {
        fee_pct: number;                 // Binance fee per side (0.1% default)
        min_edge_after_fees: number;     // Min expected edge after round-trip fees to trade
        circuit_breaker_losses: number;  // Consecutive losses before halt
        circuit_breaker_cooldown_ms: number; // Cooldown after circuit breaker
        drawdown_halflife_pct: number;   // Halve position size at this drawdown %
        max_drawdown_halt_pct: number;   // Stop trading entirely at this drawdown %
        min_hold_bars: number;           // Minimum bars to hold a position (anti-churn)
        profit_factor_gate: number;      // If rolling PF < this, halve positions
        rolling_window: number;          // Number of recent trades for dynamic Kelly + PF
        post_exit_cooldown_ms: number;   // Per-symbol cooldown after exit (anti-churn)
        min_weighted_signal: number;     // Min |weightedSignal| to enter (filter weak entries)
    };
    equity: { finnhub_api_key: string; poll_interval_ms: number };
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
    betaAtEntry: number;
    atrPctAtEntry: number;  // ATR as % of price at entry
    entryTime: number;
    highWatermark: number;
    trailingActive: boolean;
    signalSourceIds: string[];
    // Dynamic exit levels (computed at entry from Ψ state)
    dynamicTpPct: number;
    dynamicSlPct: number;
    dynamicTrailActivation: number;
    dynamicTrailDistance: number;
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

    /**
     * Restore historical stats from Postgres so we don't lose PnL/W/L on restart.
     * Returns: { totalPnl, totalFees, wins, losses, recentPnls, balance }
     */
    async restoreStats(initialBalance: number): Promise<{
        totalPnl: number; totalFees: number; wins: number; losses: number;
        recentPnls: number[]; balance: number; consecutiveLosses: number;
    } | null> {
        if (!this.pg) return null;
        try {
            // Get all closed trades (SELL with realized_pnl)
            const { rows } = await this.pg.query(
                `SELECT realized_pnl, dollar_amount, side FROM psinix_trades
                 WHERE side = 'SELL' AND realized_pnl IS NOT NULL
                 ORDER BY timestamp ASC`,
            );
            if (rows.length === 0) return null;

            let totalPnl = 0;
            let wins = 0;
            let losses = 0;
            let consecutiveLosses = 0;
            const recentPnls: number[] = [];

            for (const row of rows) {
                const pnl = parseFloat(row.realized_pnl);
                totalPnl += pnl;
                if (pnl > 0) { wins++; consecutiveLosses = 0; }
                else { losses++; consecutiveLosses++; }
                recentPnls.push(pnl);
            }

            // Keep only last 30 for rolling window
            const rollingPnls = recentPnls.slice(-30);

            // Estimate total fees from all trades (entry + exit)
            const { rows: allRows } = await this.pg.query(
                `SELECT dollar_amount FROM psinix_trades WHERE dollar_amount IS NOT NULL`,
            );
            const totalVolume = allRows.reduce((s: number, r: any) => s + parseFloat(r.dollar_amount || 0), 0);
            const estimatedFees = totalVolume * 0.001; // 0.1% per fill

            // Reconstruct balance: initial + totalPnl - fees
            const balance = initialBalance + totalPnl - estimatedFees;

            console.log(`[psinix] Restored from Postgres: ${wins}W/${losses}L | PnL: $${totalPnl.toFixed(2)} | Fees: ~$${estimatedFees.toFixed(2)} | Balance: $${balance.toFixed(2)}`);

            return {
                totalPnl, totalFees: estimatedFees, wins, losses,
                recentPnls: rollingPnls, balance, consecutiveLosses,
            };
        } catch (err: any) {
            console.warn('[PsinixTradeLogger] Restore failed:', err.message);
            return null;
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
    private equityFetcher: EquityFetcher | null = null;
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
    private totalFees = 0;
    private wins = 0;
    private losses = 0;

    // Risk state
    private consecutiveLosses = 0;
    private circuitBreakerUntil = 0;       // Timestamp when CB lifts
    private peakEquity: number = 0;
    private recentTradePnls: number[] = []; // Rolling window for dynamic Kelly + PF
    private symbolCooldownUntil = new Map<string, number>(); // Per-symbol re-entry cooldown

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
                hgetall: async (key: string) => this.redis.hgetall(key),
            });

            console.log('[psinix] Redis connected — signal collector ready');

            // Start equity data poller (Finnhub → Redis)
            if (this.redis) {
                this.equityFetcher = new EquityFetcher(
                    this.redis,
                    this.config.equity.finnhub_api_key || undefined,
                    this.config.equity.poll_interval_ms,
                );
                this.equityFetcher.start();
            }

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

        // Connect trade logger + restore historical stats
        await this.logger.connect();

        const restored = await this.logger.restoreStats(this.config.broker.initial_balance_usd);
        if (restored) {
            this.totalPnl = restored.totalPnl;
            this.totalFees = restored.totalFees;
            this.wins = restored.wins;
            this.losses = restored.losses;
            this.recentTradePnls = restored.recentPnls;
            this.consecutiveLosses = restored.consecutiveLosses;
            this.balance = restored.balance;
            this.peakEquity = Math.max(this.config.broker.initial_balance_usd, this.balance);
        }

        console.log(`[psinix] Paper trading: $${this.balance.toFixed(2)} USDC`);
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
        this.equityFetcher?.stop();
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
                    const dd = this.peakEquity > 0 ? ((this.peakEquity - portfolioValue) / this.peakEquity * 100).toFixed(1) : '0.0';
                    console.log(`[psinix] [HEARTBEAT] poll #${this.pollCount} | ${posCount} pos | $${portfolioValue.toFixed(0)} value | ${this.wins}W/${this.losses}L (${wr}% WR) | PnL: $${this.totalPnl.toFixed(2)} | Fees: $${this.totalFees.toFixed(2)} | DD: ${dd}%`);
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
            await this.executeTrade(symbol, result, sourceIds, prices);
        }
    }

    // ── Trade Execution ──────────────────────────────────────────────

    private async executeTrade(symbol: string, psi: PsiResult, sourceIds: string[] = [], recentPrices: number[] = []): Promise<void> {
        // Already have position?
        if (this.positions.has(symbol)) return;

        // Max positions?
        if (this.positions.size >= this.config.trading.max_positions) return;

        const currentPrice = this.priceCache.get(symbol);
        if (!currentPrice || currentPrice <= 0) return;

        const risk = this.config.risk;

        // ── Per-symbol cooldown (anti-churn after exit) ──
        const cooldownUntil = this.symbolCooldownUntil.get(symbol) ?? 0;
        if (Date.now() < cooldownUntil) return;

        // ── Min weighted signal strength ──
        if (Math.abs(psi.weightedSignal) < risk.min_weighted_signal) {
            if (Math.abs(psi.psi) > 0.03) {
                console.log(`[psinix] WEAK SIGNAL ${symbol} — |weightedSignal|=${Math.abs(psi.weightedSignal).toFixed(3)} < ${risk.min_weighted_signal}`);
            }
            return;
        }

        // ── Circuit breaker ──
        if (Date.now() < this.circuitBreakerUntil) return;

        // ── Drawdown guard ──
        const equity = this.getPortfolioValue();
        if (this.peakEquity === 0) this.peakEquity = this.config.broker.initial_balance_usd;
        if (equity > this.peakEquity) this.peakEquity = equity;
        const drawdownPct = this.peakEquity > 0 ? ((this.peakEquity - equity) / this.peakEquity) * 100 : 0;

        if (drawdownPct >= risk.max_drawdown_halt_pct) {
            console.log(`[psinix] HALTED — drawdown ${drawdownPct.toFixed(1)}% >= max ${risk.max_drawdown_halt_pct}%`);
            return;
        }

        // ── Fee-aware edge check ──
        // Edge = C × avgAbsReturn × holdBars (coherence = signal quality)
        // Must exceed round-trip fees to justify the trade
        const roundTripFeePct = risk.fee_pct * 2 / 100; // 0.002 for 0.1% per side
        let expectedEdgePct = 0;
        if (recentPrices.length >= 10) {
            let sumAbsRet = 0;
            for (let i = 1; i < recentPrices.length; i++) {
                sumAbsRet += Math.abs(recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1];
            }
            const avgAbsRetPerBar = sumAbsRet / (recentPrices.length - 1);
            const estimatedHoldBars = Math.max(risk.min_hold_bars, 10);
            // Use COHERENCE as edge multiplier, not Ψ (which includes sizing)
            expectedEdgePct = psi.coherence * avgAbsRetPerBar * estimatedHoldBars;
        } else {
            expectedEdgePct = psi.coherence * 0.0013 * 10;
        }
        const minRequiredEdge = roundTripFeePct + risk.min_edge_after_fees / 100;
        if (expectedEdgePct < minRequiredEdge) {
            if (Math.abs(psi.psi) > 0.05) {
                console.log(`[psinix] REJECTED ${symbol} — edge ${(expectedEdgePct * 100).toFixed(3)}% < required ${(minRequiredEdge * 100).toFixed(3)}%`);
            }
            return;
        }

        // ── Dynamic Kelly ──
        let kellyFraction = this.config.psi.kelly_fraction_cap;
        if (this.recentTradePnls.length >= 10) {
            const recentWins = this.recentTradePnls.filter(p => p > 0);
            const recentLosses = this.recentTradePnls.filter(p => p < 0);
            const wr = recentWins.length / this.recentTradePnls.length;
            const avgWin = recentWins.length > 0 ? recentWins.reduce((a, b) => a + b, 0) / recentWins.length : 0;
            const avgLoss = recentLosses.length > 0 ? Math.abs(recentLosses.reduce((a, b) => a + b, 0) / recentLosses.length) : 1;
            const rr = avgLoss > 0 ? avgWin / avgLoss : 1;

            // Kelly: f* = (W × R - (1-W)) / R
            const kellyRaw = rr > 0 ? (wr * rr - (1 - wr)) / rr : 0;
            kellyFraction = Math.max(0.05, Math.min(this.config.psi.kelly_fraction_cap, kellyRaw));
        }

        // ── Profit factor gate ──
        if (this.recentTradePnls.length >= 10) {
            const grossProfit = this.recentTradePnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
            const grossLoss = Math.abs(this.recentTradePnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
            const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 0;
            if (pf < risk.profit_factor_gate) {
                kellyFraction *= 0.5; // Halve position when losing
            }
        }

        // ── Drawdown position scaling ──
        let drawdownScale = 1.0;
        if (drawdownPct >= risk.drawdown_halflife_pct) {
            drawdownScale = risk.drawdown_halflife_pct / drawdownPct; // Linear reduction
        }

        // ── Position size: |Ψ| × maxPos × kelly × drawdownScale ──
        const baseDollarSize = Math.abs(psi.psi) * this.config.trading.max_position_size_usd;
        const scaledSize = baseDollarSize * (kellyFraction / this.config.psi.kelly_fraction_cap) * drawdownScale;
        if (scaledSize < 5) return;

        const cappedSize = Math.min(scaledSize, this.balance * 0.25);
        const fee = cappedSize * risk.fee_pct / 100;
        const qty = cappedSize / currentPrice;
        const side: 'LONG' | 'SHORT' = psi.psi > 0 ? 'LONG' : 'SHORT';

        // ── Dynamic exit levels from Ψ state ──
        // ATR as % of price (from recent prices)
        let atrPct = 0.5; // Fallback: 0.5% per bar
        if (recentPrices.length >= 10) {
            let sumAbsRet = 0;
            for (let i = 1; i < recentPrices.length; i++) {
                sumAbsRet += Math.abs(recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1];
            }
            atrPct = (sumAbsRet / (recentPrices.length - 1)) * 100; // Convert to %
        }

        // Normalize β to [0.5, 2.0] range for exit scaling
        // High β (ordered market) → tighter exits (trend will reverse cleanly)
        // Low β (chaotic market) → wider exits (more noise to survive)
        const betaNorm = Math.max(0.5, Math.min(2.0, psi.beta / 3.0));

        // TP scales with: coherence (wider when signals agree) + ATR (wider in volatile markets)
        // High C → let profit run, low C → take quick profit
        const baseTp = this.config.exits.take_profit_pct;
        const baseSl = this.config.exits.stop_loss_pct;

        const dynamicTpPct = Math.max(1.0, baseTp * (0.5 + psi.coherence * 0.8) * (atrPct / 0.3));
        // SL scales inversely with β: chaotic market → wider SL to avoid whipsaws
        const dynamicSlPct = Math.max(0.5, baseSl * (1 / betaNorm) * (atrPct / 0.3));
        const dynamicTrailActivation = dynamicTpPct * 0.5;
        const dynamicTrailDistance = dynamicSlPct * 0.67;

        console.log(
            `[psinix] Dynamic exits ${symbol}: TP=${dynamicTpPct.toFixed(1)}% SL=${dynamicSlPct.toFixed(1)}% ` +
            `trail=${dynamicTrailActivation.toFixed(1)}%/${dynamicTrailDistance.toFixed(1)}% | ATR=${atrPct.toFixed(2)}% β=${psi.beta.toFixed(1)} C=${psi.coherence.toFixed(2)}`,
        );

        // Execute paper trade (deduct fee)
        this.balance -= (cappedSize + fee);
        this.totalFees += fee;
        this.positions.set(symbol, {
            symbol,
            side,
            qty,
            entryPrice: currentPrice,
            currentPrice,
            unrealizedPnl: 0,
            psiAtEntry: psi.psi,
            coherenceAtEntry: psi.coherence,
            betaAtEntry: psi.beta,
            atrPctAtEntry: atrPct,
            entryTime: Date.now(),
            highWatermark: currentPrice,
            trailingActive: false,
            signalSourceIds: sourceIds,
            dynamicTpPct,
            dynamicSlPct,
            dynamicTrailActivation,
            dynamicTrailDistance,
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

            // Use DYNAMIC exit levels (computed at entry from Ψ state)
            const tp = pos.dynamicTpPct;
            const sl = pos.dynamicSlPct;
            const trailAct = pos.dynamicTrailActivation;
            const trailDist = pos.dynamicTrailDistance;

            let exitReason: string | null = null;

            // Stop loss (dynamic)
            if (pnlPct <= -sl) {
                exitReason = `SL hit (${pnlPct.toFixed(1)}% / limit -${sl.toFixed(1)}%)`;
            }
            // Take profit (dynamic)
            else if (pnlPct >= tp) {
                exitReason = `TP hit (${pnlPct.toFixed(1)}% / target ${tp.toFixed(1)}%)`;
            }
            // Trailing stop (dynamic)
            else {
                if (pnlPct >= trailAct) pos.trailingActive = true;
                if (pos.trailingActive) {
                    const hwmPnl = pos.side === 'LONG'
                        ? ((pos.highWatermark - pos.entryPrice) / pos.entryPrice) * 100
                        : ((pos.entryPrice - pos.highWatermark) / pos.entryPrice) * 100;
                    const drawdown = hwmPnl - pnlPct;
                    if (drawdown >= trailDist) {
                        exitReason = `Trailing stop (${drawdown.toFixed(1)}% from HWM / dist ${trailDist.toFixed(1)}%)`;
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

        const risk = this.config.risk;

        // ── Minimum hold time (anti-churn) ──
        const barsHeld = Math.floor((Date.now() - pos.entryTime) / this.config.timing.poll_interval_ms);
        if (barsHeld < risk.min_hold_bars && reason !== 'SL hit' && !reason.startsWith('SL')) {
            return; // Don't exit early unless it's a stop loss
        }

        const direction = pos.side === 'LONG' ? 1 : -1;
        const grossPnl = (price - pos.entryPrice) * pos.qty * direction;
        const exitFee = (pos.qty * price) * risk.fee_pct / 100;
        const pnl = grossPnl - exitFee; // Net of exit fee (entry fee already deducted)
        const proceeds = pos.qty * price - exitFee;

        this.balance += proceeds;
        this.totalPnl += pnl;
        this.totalFees += exitFee;

        if (pnl > 0) {
            this.wins++;
            this.consecutiveLosses = 0;
        } else {
            this.losses++;
            this.consecutiveLosses++;

            // ── Circuit breaker ──
            if (this.consecutiveLosses >= risk.circuit_breaker_losses) {
                this.circuitBreakerUntil = Date.now() + risk.circuit_breaker_cooldown_ms;
                console.log(`[psinix] ⚠️ CIRCUIT BREAKER — ${this.consecutiveLosses} consecutive losses, cooling down ${risk.circuit_breaker_cooldown_ms / 60_000}min`);
            }
        }

        // ── Per-symbol cooldown (anti-churn) ──
        this.symbolCooldownUntil.set(symbol, Date.now() + risk.post_exit_cooldown_ms);

        // ── Rolling PnL tracking ──
        this.recentTradePnls.push(pnl);
        if (this.recentTradePnls.length > risk.rolling_window) {
            this.recentTradePnls.shift();
        }

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
                totalFees: this.totalFees,
                wins: this.wins,
                losses: this.losses,
                winRate: this.wins + this.losses > 0 ? this.wins / (this.wins + this.losses) : 0,
                consecutiveLosses: this.consecutiveLosses,
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
            risk: {
                fee_pct: 0.1,
                min_edge_after_fees: 0.1,
                circuit_breaker_losses: 4,
                circuit_breaker_cooldown_ms: 60 * 60 * 1000, // 1 hour
                drawdown_halflife_pct: 5,
                max_drawdown_halt_pct: 15,
                min_hold_bars: 3,
                profit_factor_gate: 0.8,
                rolling_window: 30,
                post_exit_cooldown_ms: 30 * 60 * 1000, // 30 minutes
                min_weighted_signal: 0.15,
            },
            equity: { finnhub_api_key: '', poll_interval_ms: 300_000 },
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
                risk: { ...defaults.risk, ...(parsed as any).risk },
                equity: { ...defaults.equity, ...(parsed as any).equity },
                timing: { ...defaults.timing, ...parsed.timing },
            };
        } catch {
            console.warn('[psinix] Failed to parse psinix.toml, using defaults');
            return defaults;
        }
    }
}
