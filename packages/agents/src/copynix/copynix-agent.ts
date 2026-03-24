import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import { RiskManager } from '../aktienix/risk-manager';
import { StatePublisher } from '../aktienix/state-publisher';
import { WalletMonitor } from './wallet-monitor';
import { ConsensusEngine } from './consensus-engine';
import { CopyExecutor } from './copy-executor';
import { CopyRiskGate } from './risk-gate';
import { loadCopynixConfig } from './config';
import { PolymarketIntelligence } from '../shared/polymarket-intelligence';
import { WalletDiscovery } from './wallet-discovery';
import { BayesianScorer } from './bayesian-scorer';
import { PostTradeAnalyzer, type TradeContext } from './post-trade-analyzer';
import { WebSocketMonitor } from './websocket-monitor';
import { CopyTracker } from './copy-tracker';
import type { CopyPosition, CopySignal, WalletTrade } from './types';

// ── Telegram Alert Helper ─────────────────────────────────────────────
async function sendTelegramAlert(message: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
            signal: AbortSignal.timeout(5_000),
        });
    } catch { /* non-critical */ }
}

// ── Trade Logger — persist paper trades to Postgres ───────────────────
class CopynixTradeLogger {
    private pg: any = null;

    async connect(): Promise<void> {
        const url = process.env.POSTGRES_URL;
        if (!url) return;
        try {
            const { Client } = await import('pg');
            this.pg = new Client({ connectionString: url });
            await this.pg.connect();

            // Ensure table exists
            await this.pg.query(`
                CREATE TABLE IF NOT EXISTS copynix_trades (
                    id SERIAL PRIMARY KEY,
                    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    token_mint TEXT NOT NULL,
                    token_symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    qty DOUBLE PRECISION,
                    entry_price DOUBLE PRECISION,
                    exit_price DOUBLE PRECISION,
                    dollar_amount DOUBLE PRECISION,
                    realized_pnl DOUBLE PRECISION,
                    consensus_level TEXT,
                    wallet_count INTEGER,
                    confidence DOUBLE PRECISION,
                    exit_reason TEXT,
                    metadata JSONB
                )
            `);
        } catch (err: any) {
            console.warn('[CopynixTradeLogger] Postgres connect failed (non-fatal):', err.message);
            this.pg = null;
        }
    }

    async logTrade(params: {
        tokenMint: string;
        tokenSymbol: string;
        side: 'BUY' | 'SELL';
        qty?: number;
        entryPrice?: number;
        exitPrice?: number;
        dollarAmount?: number;
        realizedPnl?: number;
        consensusLevel?: string;
        walletCount?: number;
        confidence?: number;
        exitReason?: string;
        metadata?: Record<string, any>;
    }): Promise<void> {
        if (!this.pg) return;
        try {
            await this.pg.query(
                `INSERT INTO copynix_trades (token_mint, token_symbol, side, qty, entry_price, exit_price, dollar_amount, realized_pnl, consensus_level, wallet_count, confidence, exit_reason, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [
                    params.tokenMint, params.tokenSymbol, params.side,
                    params.qty ?? null, params.entryPrice ?? null,
                    params.exitPrice ?? null, params.dollarAmount ?? null,
                    params.realizedPnl ?? null, params.consensusLevel ?? null,
                    params.walletCount ?? null, params.confidence ?? null,
                    params.exitReason ?? null,
                    params.metadata ? JSON.stringify(params.metadata) : null,
                ],
            );
        } catch (err: any) {
            console.warn('[CopynixTradeLogger] Insert failed (non-fatal):', err.message);
        }
    }

    /**
     * Find open positions: BUY trades without a matching SELL for the same token.
     * Uses the most recent BUY per token_mint where no SELL exists after it.
     */
    async getOpenPositions(): Promise<Array<{
        tokenMint: string;
        tokenSymbol: string;
        entryPrice: number;
        dollarAmount: number;
        consensusLevel: string | null;
        timestamp: number;
    }>> {
        if (!this.pg) return [];
        try {
            const { rows } = await this.pg.query(`
                SELECT DISTINCT ON (token_mint)
                    token_mint, token_symbol, entry_price, dollar_amount,
                    consensus_level, EXTRACT(EPOCH FROM timestamp) * 1000 as ts
                FROM copynix_trades
                WHERE side = 'BUY'
                  AND token_mint NOT IN (
                      SELECT token_mint FROM copynix_trades WHERE side = 'SELL'
                  )
                ORDER BY token_mint, timestamp DESC
            `);
            return rows.map((r: any) => ({
                tokenMint: r.token_mint,
                tokenSymbol: r.token_symbol,
                entryPrice: parseFloat(r.entry_price) || 0,
                dollarAmount: parseFloat(r.dollar_amount) || 0,
                consensusLevel: r.consensus_level,
                timestamp: parseFloat(r.ts) || Date.now(),
            }));
        } catch (err: any) {
            console.warn('[CopynixTradeLogger] getOpenPositions failed:', err.message);
            return [];
        }
    }

    async hasRecentBuy(tokenMint: string, hoursBack: number): Promise<boolean> {
        if (!this.pg) return false;
        try {
            const { rows } = await this.pg.query(
                `SELECT 1 FROM copynix_trades WHERE token_mint = $1 AND side = 'BUY' AND timestamp > NOW() - INTERVAL '1 hour' * $2 LIMIT 1`,
                [tokenMint, hoursBack],
            );
            return rows.length > 0;
        } catch { return false; }
    }

    getPg(): any { return this.pg; }

    async close(): Promise<void> {
        try { await this.pg?.end(); } catch { }
    }
}

export class CopynixAgent extends BaseAgent {
    private isRunning = false;

    private walletMonitor: WalletMonitor | null = null;
    private consensusEngine: ConsensusEngine | null = null;
    private executor: CopyExecutor | null = null;
    private riskGate: CopyRiskGate | null = null;
    private statePublisher: StatePublisher | null = null;
    private riskManager = new RiskManager();
    private polymarket = new PolymarketIntelligence(300_000);
    private tradeLogger = new CopynixTradeLogger();
    private bayesian = new BayesianScorer();
    private copyTracker: CopyTracker | null = null;
    private wsMonitor: WebSocketMonitor | null = null;
    private postTradeAnalyzer: PostTradeAnalyzer | null = null;

    private walletDiscovery: WalletDiscovery | null = null;
    // Delay first discovery by 10 minutes after startup (avoid Helius burst),
    // then run every discovery_interval_hours (24h).
    private lastDiscoveryTime = Date.now() - (23.83 * 3_600_000); // = 10 min from now at 24h interval

    private lastResetDay = new Date().getUTCDate();
    private tradesToday = 0;
    private pollCount = 0;
    private lastHeartbeat = 0;
    private lastWalletScanTime = 0;
    private walletScanBackoff = 1; // multiplier for backoff on 429

    private tomlConfig = loadCopynixConfig();

    constructor(config: AgentConfig) {
        super(config);
    }

    async initialize(): Promise<void> {
        this.log('info', 'Initializing Copynix Agent (Solana Copy Trading)...');

        const config = this.tomlConfig;

        // Wallet monitor (polls tracked wallets for new trades)
        this.walletMonitor = new WalletMonitor({
            wallets: config.wallets.tracked,
            poll_interval_ms: config.timing.wallet_scan_interval_ms,
        });

        // Consensus engine (aggregates wallet signals)
        this.consensusEngine = new ConsensusEngine({
            min_wallets_strong: config.consensus.min_wallets_strong,
            min_wallets_medium: config.consensus.min_wallets_medium,
            time_window_minutes: config.consensus.time_window_minutes,
            cooldown_hours: config.consensus.cooldown_hours,
        });

        // Paper trading executor
        this.executor = new CopyExecutor({
            initial_usdc_balance: 500, // $500 virtual starting capital
            max_position_size_usd: config.capital.max_position_size_usd,
            max_capital_per_trade_pct: config.capital.max_capital_per_trade_pct,
            min_order_value: config.capital.min_order_value,
        });

        // Anti-rug risk gate
        this.riskGate = new CopyRiskGate({
            min_token_age_hours: config.safety.min_token_age_hours,
            min_liquidity_usd: config.safety.min_liquidity_usd,
            min_holders: config.safety.min_holders,
            min_lp_burnt_pct: config.safety.min_lp_burnt_pct,
            require_immutable_supply: config.safety.require_immutable_supply,
        });

        // State publisher (Redis)
        const kvUrl = process.env.KV_URL;
        if (kvUrl) {
            this.statePublisher = new StatePublisher(kvUrl, 'copynix');
            this.log('info', 'State publisher connected (Redis copynix:*)');
        }

        // Seed risk manager
        const acct = this.executor.getAccountState();
        this.riskManager.updatePortfolioValue(acct.portfolioValue);

        // Wallet discovery (finds new wallets on trending tokens)
        if (config.wallets.discovery_enabled) {
            this.walletDiscovery = new WalletDiscovery({
                helius_api_key: process.env.HELIUS_API_KEY ?? null,
                existing_wallets: config.wallets.tracked,
                max_tracked: config.wallets.max_tracked,
            });
            this.log('info', 'Wallet discovery enabled');
        }

        // Phase 2: WebSocket real-time detection (disabled until free WS endpoint available)
        // Set SOLANA_WS_URL env var to enable. Code ready in websocket-monitor.ts.
        if (process.env.SOLANA_WS_URL) {
            const heliusKey = process.env.HELIUS_API_KEY ?? '';
            this.wsMonitor = new WebSocketMonitor(heliusKey, config.wallets.tracked);
            const wsOk = await this.wsMonitor.connect();
            if (wsOk) {
                this.log('info', 'WebSocket monitor connected — real-time swap detection active');
            } else {
                await this.wsMonitor.disconnect();
                this.wsMonitor = null;
            }
        }

        // Connect trade logger to Postgres
        await this.tradeLogger.connect();

        // Initialize post-trade AI analyzer (uses Grok via XAI_API_KEY)
        if (process.env.XAI_API_KEY) {
            this.postTradeAnalyzer = new PostTradeAnalyzer(this.tradeLogger.getPg(), 5 * 60_000);
            this.log('info', 'Post-trade AI analyzer enabled (Grok, 5min delay)');
        }

        // Restore open positions from Postgres (survives restarts)
        await this.restorePositionsFromDb();

        // Initialize Bayesian scorer with Redis persistence
        if (this.statePublisher) {
            const sp = this.statePublisher;
            await this.bayesian.connect({
                get: (key: string) => sp.get(key),
                set: async (key: string, value: string) => { await sp.set(key, value); },
            });
            // Initialize beliefs for all tracked wallets
            for (const addr of config.wallets.tracked) {
                const priorScore = config.wallets.scores[addr] ?? 50;
                this.bayesian.initializeWallet(addr, priorScore);
            }
            this.log('info', `Bayesian scorer loaded: ${this.bayesian.getAllBeliefs().length} wallets`);
            // Persist beliefs immediately so they survive container restarts
            await this.bayesian.persistNow();
        }

        // Set priority wallets (score ≥85) — polled every cycle, not rotated
        const priorityAddresses = Object.entries(config.wallets.scores)
            .filter(([_, score]) => score >= 85)
            .map(([addr]) => addr);
        this.walletMonitor.setPriorityWallets(priorityAddresses);
        this.log('info', `Priority wallets: ${priorityAddresses.length} (polled every cycle)`);

        // Initialize CopyTracker for wallet performance auto-rotation
        if (this.tomlConfig.copy_tracker?.enabled !== false) {
            this.copyTracker = new CopyTracker(this.tomlConfig);
            this.log('info', `CopyTracker enabled: promote>=${this.tomlConfig.copy_tracker?.promote_threshold ?? 75}, demote<=${this.tomlConfig.copy_tracker?.demote_threshold ?? 40}`);
        }

        this.log('info', `Tracked wallets: ${this.walletMonitor.walletCount}`);
        this.log('info', `Single-whale mode: ${Object.keys(config.wallets.scores).length} scored wallets`);
        this.log('info', `Paper trading: $${acct.usdcBalance} USDC`);
        this.log('info', 'Copynix initialized.');
    }

    async start(): Promise<void> {
        this.isRunning = true;
        this.log('info', 'Copynix agent started — entering main loop');
        await this.runLoop();
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        await this.tradeLogger.close();
        await this.statePublisher?.disconnect();
        this.log('info', 'Copynix agent stopped.');
    }

    async handleMessage(_msg: AgentMessage): Promise<void> {
        // No-op — Copynix doesn't process external messages
    }

    // -------------------------------------------------------------------------
    // Main Loop
    // -------------------------------------------------------------------------

    private async runLoop(): Promise<void> {
        while (this.isRunning) {
            try {
                // Daily reset check
                const today = new Date().getUTCDate();
                if (today !== this.lastResetDay) {
                    this.tradesToday = 0;
                    this.riskManager.resetDaily();
                    this.lastResetDay = today;
                    this.log('info', '[DAILY RESET] Trade counter and risk state cleared');
                }

                // 1. Get new trades — priority wallets every cycle (30s), regular wallets every 2min
                this.pollCount++;
                const now = Date.now();
                let newTrades: WalletTrade[] = [];

                // Phase 2: drain WebSocket buffer if connected
                if (this.wsMonitor?.isConnected) {
                    newTrades = this.wsMonitor.drainTrades();
                    if (newTrades.length > 0) {
                        this.log('info', `[WS] ${newTrades.length} real-time trade(s) from WebSocket`);
                    }
                }

                // Priority wallets: poll EVERY cycle (30s) for minimum latency
                if (!this.wsMonitor?.isConnected) {
                    try {
                        const priorityTrades = await this.walletMonitor!.pollPriorityOnly();
                        if (priorityTrades.length > 0) {
                            newTrades.push(...priorityTrades);
                        }
                    } catch { /* non-critical */ }
                }

                // Regular wallets: poll on interval with backoff
                const walletScanInterval = this.tomlConfig.timing.wallet_scan_interval_ms * this.walletScanBackoff;
                if (!this.wsMonitor?.isConnected && now - this.lastWalletScanTime >= walletScanInterval) {
                    const errorsBefore = this.walletMonitor!.getStats().rateLimited;
                    const pollStart = Date.now();
                    newTrades = await this.walletMonitor!.pollNewTrades();
                    const pollMs = Date.now() - pollStart;
                    this.lastWalletScanTime = Date.now();

                    // Check for 429 errors and apply backoff
                    const errorsAfter = this.walletMonitor!.getStats().rateLimited;
                    if (errorsAfter > errorsBefore) {
                        this.walletScanBackoff = Math.min(this.walletScanBackoff * 2, 10);
                        const nextInterval = (this.tomlConfig.timing.wallet_scan_interval_ms * this.walletScanBackoff / 1000).toFixed(0);
                        this.log('warn', `[RATE LIMIT] Helius 429 — backing off wallet scans to ${nextInterval}s`);
                    } else if (this.walletScanBackoff > 1) {
                        this.walletScanBackoff = 1;
                        this.log('info', '[RATE LIMIT] Helius responding — backoff reset');
                    }

                    if (pollMs > 5000) {
                        this.log('info', `[SLOW POLL] pollNewTrades took ${(pollMs / 1000).toFixed(1)}s`);
                    }

                    if (newTrades.length > 0) {
                        this.log('info', `[POLL] ${newTrades.length} new trade(s) from tracked wallets`);
                    }
                }

                // Heartbeat every 5 minutes
                if (now - this.lastHeartbeat >= 300_000) {
                    const acct = this.executor!.getAccountState();
                    const pending = this.consensusEngine!.getPending().size;
                    const stats = this.walletMonitor!.getStats();
                    const beliefs = this.bayesian.getAllBeliefs();
                    const avgScore = beliefs.length > 0 ? beliefs.reduce((s, b) => s + b.score, 0) / beliefs.length : 0;
                    const wsStatus = this.wsMonitor?.isConnected ? 'WS:live' : 'WS:off';
                    this.log('info', `[HEARTBEAT] poll #${this.pollCount} | ${acct.totalPositions} pos | $${acct.portfolioValue.toFixed(0)} value | ${pending} pending | ${this.tradesToday} trades | ${wsStatus} | API: ${stats.calls}/${stats.errors}err/${stats.swapsFound}swaps | Bayes: ${beliefs.length}w avg=${avgScore.toFixed(0)}`);
                    this.lastHeartbeat = now;
                }

                // 2. Enrich trade prices via DexScreener (priceUsd is 0 from Helius)
                if (newTrades.length > 0) {
                    await this.enrichTradePrices(newTrades);
                }

                // 3. Feed trades into consensus engine
                for (const trade of newTrades) {
                    await this.processTrade(trade);
                }

                // 3a. Publish Smart Money sentiment to Redis (for Cryonix cross-intel)
                if (newTrades.length > 0) {
                    await this.publishSmartMoneySentiment(newTrades);
                }

                // 4. Check exits on existing positions
                await this.checkExits();

                // 4. Update position prices
                await this.updatePositionPrices();

                // 5. Publish state
                await this.publishState();

                // 6. Wallet discovery (periodic)
                await this.runDiscovery();

            } catch (err) {
                this.log('error', `Loop error: ${err instanceof Error ? err.message : String(err)}`);
            }

            // Wait before next poll
            await new Promise(r => setTimeout(r, this.tomlConfig.timing.poll_interval_ms));
        }
    }

    // -------------------------------------------------------------------------
    // Trade Processing
    // -------------------------------------------------------------------------

    private async processTrade(trade: WalletTrade): Promise<void> {
        this.log('info', `[TRADE] ${trade.walletAddress.slice(0, 8)}... ${trade.action} ${trade.tokenSymbol} ($${trade.amountUsd.toFixed(0)})`);

        // Check if a tracked wallet sold a token we hold (leader exit)
        if (trade.action === 'SELL') {
            await this.handleLeaderExit(trade);
            return;
        }

        // Feed BUY into consensus engine
        const signal = this.consensusEngine!.ingest(trade);

        if (signal) {
            await this.executeSignal(signal);
        } else {
            // Single-whale mode: high-score wallets can trigger alone.
            // Threshold configurable via [single_whale] min_score in copynix.toml.
            const walletScore = this.tomlConfig.wallets.scores[trade.walletAddress] ?? 0;
            const whaleThreshold = (this.tomlConfig as any).single_whale?.min_score ?? 75;
            if (walletScore >= whaleThreshold) {
                const whaleSignal = this.consensusEngine!.createSingleWhaleSignal(trade, walletScore);
                if (whaleSignal) {
                    this.log('info', `[WHALE] Single-whale signal from ${trade.walletAddress.slice(0, 8)}... (score ${walletScore})`);
                    await this.executeSignal(whaleSignal);
                }
            }
        }
    }

    private async executeSignal(signal: CopySignal): Promise<void> {
        this.log('info', `[CONSENSUS] ${signal.consensusLevel} signal: ${signal.walletCount} wallets bought ${signal.tokenSymbol}`);

        // Daily trade limit
        if (this.tradesToday >= this.tomlConfig.limits.max_trades_per_day) {
            this.log('info', `[SKIP] Daily trade limit reached (${this.tradesToday}/${this.tomlConfig.limits.max_trades_per_day})`);
            return;
        }

        // Max positions check
        const positions = this.executor!.getPositions();
        if (positions.length >= this.tomlConfig.limits.max_open_positions) {
            this.log('info', `[SKIP] Max positions reached (${positions.length}/${this.tomlConfig.limits.max_open_positions})`);
            return;
        }

        // Portfolio exposure limit: max X% of capital locked in positions
        const acct = this.executor!.getAccountState();
        const maxExposurePct = this.tomlConfig.capital.max_portfolio_exposure_pct ?? 0.20;
        const currentExposure = acct.portfolioValue - acct.usdcBalance;
        if (acct.portfolioValue > 0 && currentExposure / acct.portfolioValue >= maxExposurePct) {
            this.log('info', `[SKIP] Portfolio exposure ${((currentExposure / acct.portfolioValue) * 100).toFixed(0)}% >= max ${(maxExposurePct * 100).toFixed(0)}%`);
            return;
        }

        // Polymarket sentiment adjustment
        let adjustedConfidence = signal.confidence;
        try {
            const poly = await this.polymarket.getConfidenceDelta('copynix');
            if (poly.delta !== 0) {
                adjustedConfidence = Math.max(0, Math.min(100, adjustedConfidence + poly.delta));
                this.log('info', `[POLY] ${poly.delta >= 0 ? '+' : ''}${poly.delta}% (${poly.reason})`);
            }
        } catch {
            // Non-critical
        }

        // Confidence check (after Polymarket adjustment)
        if (adjustedConfidence < this.tomlConfig.risk.min_confidence * 100) {
            this.log('info', `[SKIP] Low confidence: ${adjustedConfidence}% (min ${this.tomlConfig.risk.min_confidence * 100}%)`);
            return;
        }

        // LATENCY FIX 1: Reject stale signals — if the whale bought >10 min ago, we're too late
        const signalAge = Date.now() - signal.timestamp;
        const maxSignalAgeMs = 10 * 60_000; // 10 minutes
        if (signalAge > maxSignalAgeMs) {
            this.log('info', `[STALE] ${signal.tokenSymbol} signal is ${(signalAge / 60_000).toFixed(0)}min old — too late`);
            return;
        }

        // LATENCY FIX 2: Check if pump already happened — compare current price to whale entry
        if (signal.avgPriceUsd > 0) {
            try {
                const url = `https://api.dexscreener.com/tokens/v1/solana/${signal.tokenMint}`;
                const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
                if (res.ok) {
                    const pairs = await res.json() as Array<{ priceUsd: string; chainId: string; liquidity?: { usd: number } }>;
                    const solanaPair = Array.isArray(pairs) ? pairs.find(p => p.chainId === 'solana') : null;
                    if (solanaPair) {
                        const currentPrice = parseFloat(solanaPair.priceUsd);
                        const pumpPct = ((currentPrice - signal.avgPriceUsd) / signal.avgPriceUsd) * 100;
                        if (pumpPct > 30) {
                            this.log('info', `[TOO LATE] ${signal.tokenSymbol} already pumped +${pumpPct.toFixed(0)}% since whale entry — skipping`);
                            return;
                        }
                    }
                }
            } catch { /* non-critical — proceed if price check fails */ }
        }

        // Anti-rug safety check
        const safety = await this.riskGate!.validateSignal(signal);
        if (!safety.allowed) {
            this.log('info', `[BLOCKED] ${signal.tokenSymbol} failed safety: ${safety.reasons.join(', ')}`);
            return;
        }

        // Dedup: check Postgres for recent BUY on same token (survives restarts)
        try {
            const recent = await this.tradeLogger.hasRecentBuy(signal.tokenMint, 24); // 24h cooldown
            if (recent) {
                this.log('info', `[DEDUP] Already bought ${signal.tokenSymbol} recently — skipping`);
                return;
            }
        } catch { /* non-critical, proceed */ }

        // Execute the copy trade
        const result = this.executor!.executeBuy(signal);
        if (result.success) {
            this.tradesToday++;
            this.log('info', `[BUY] ${result.message}`);

            // Log to Postgres — get actual position for accurate qty/amount
            const boughtPos = this.executor!.getPosition(signal.tokenMint);
            const actualQty = boughtPos?.qty ?? 0;
            const actualDollar = actualQty * (signal.avgPriceUsd || 0);
            await this.tradeLogger.logTrade({
                tokenMint: signal.tokenMint,
                tokenSymbol: signal.tokenSymbol,
                side: 'BUY',
                qty: actualQty,
                entryPrice: signal.avgPriceUsd,
                dollarAmount: actualDollar > 0 ? actualDollar : (boughtPos ? boughtPos.qty * boughtPos.avgEntryPrice : 0),
                consensusLevel: signal.consensusLevel,
                walletCount: signal.walletCount,
                confidence: adjustedConfidence,
                metadata: { wallets: signal.wallets.map(w => w.slice(0, 8)), reasoning: signal.reasoning },
            });

            // Publish to copynix:signals for APEX consumption
            if (this.statePublisher) {
                try {
                    const redis = (this.statePublisher as any).redis;
                    if (redis) {
                        const signalEvent = {
                            token: signal.tokenMint,
                            symbol: signal.tokenSymbol,
                            score: this.tomlConfig.wallets.scores[signal.wallets[0]] ?? 0,
                            direction: 'buy',
                            consensusLevel: signal.consensusLevel,
                            walletCount: signal.walletCount,
                            ecosystem: 'solana',
                            timestamp: Date.now(),
                        };
                        const existing = await redis.get('copynix:signals');
                        const signals = existing ? JSON.parse(existing) : [];
                        const fiveMinAgo = Date.now() - 300_000;
                        signals.push(signalEvent);
                        const filtered = signals.filter((s: any) => s.timestamp > fiveMinAgo);
                        await redis.set('copynix:signals', JSON.stringify(filtered), 'EX', 600);
                    }
                } catch (err) {
                    this.log('warn', `[APEX] Failed to publish copynix:signals: ${err}`);
                }
            }

            // Telegram alert
            await sendTelegramAlert(
                `🟢 <b>COPYNIX BUY</b>\n` +
                `Token: <b>${signal.tokenSymbol}</b>\n` +
                `Consensus: ${signal.consensusLevel} (${signal.walletCount} wallets)\n` +
                `Confidence: ${adjustedConfidence}%\n` +
                `Price: $${signal.avgPriceUsd.toFixed(6)}`,
            );
        } else {
            this.log('info', `[SKIP] ${result.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // Exit Management
    // -------------------------------------------------------------------------

    // Track which wallets have exited each position
    private leaderExits = new Map<string, Set<string>>(); // tokenMint -> wallets that sold

    private async handleLeaderExit(trade: WalletTrade): Promise<void> {
        if (!this.tomlConfig.exits.leader_exit_enabled) return;

        const pos = this.executor!.getPosition(trade.tokenMint);
        if (!pos) return;

        // Check if the selling wallet is one we copied from
        if (!pos.copiedFrom.includes(trade.walletAddress)) return;

        // Track this wallet's exit
        let exits = this.leaderExits.get(trade.tokenMint);
        if (!exits) {
            exits = new Set();
            this.leaderExits.set(trade.tokenMint, exits);
        }
        exits.add(trade.walletAddress);

        const totalCopied = pos.copiedFrom.length;
        const totalExited = exits.size;
        const exitRatio = totalExited / totalCopied;

        this.log('info', `[LEADER EXIT] ${trade.walletAddress.slice(0, 8)}... sold ${pos.tokenSymbol} (${totalExited}/${totalCopied} wallets exited)`);

        if (totalCopied <= 1 || exitRatio >= 1.0) {
            // ALL wallets sold → full exit
            this.log('info', `[LEADER EXIT] All ${totalCopied} wallets sold ${pos.tokenSymbol} — closing position`);
            const result = this.executor!.executeSell(trade.tokenMint, pos.currentPrice, 'leader_exit_all');
            if (result.success) {
                this.log('info', `[SELL] ${result.message}`);
                await this.logSell(pos, pos.currentPrice, 'leader_exit_all', result.pnl);
                this.leaderExits.delete(trade.tokenMint);
            }
        } else if (exitRatio >= 0.5 && !pos.partialTpTaken) {
            // MAJORITY sold → sell 50%, keep rest riding
            this.log('info', `[LEADER EXIT] Majority (${totalExited}/${totalCopied}) sold ${pos.tokenSymbol} — partial exit 50%`);
            const halfQty = pos.qty / 2;
            const halfPnl = (pos.currentPrice - pos.avgEntryPrice) * halfQty;
            this.executor!.reducePosition(pos.tokenMint, halfQty);
            pos.partialTpTaken = true;
            await this.logSell(
                { ...pos, qty: halfQty },
                pos.currentPrice,
                'leader_exit_majority',
                halfPnl,
            );
        } else {
            // MINORITY sold → log but hold. Other wallets still believe in this token.
            this.log('info', `[LEADER EXIT] Only ${totalExited}/${totalCopied} wallets sold ${pos.tokenSymbol} — holding (minority exit)`);
        }
    }

    private async checkExits(): Promise<void> {
        const config = this.tomlConfig.exits;
        const positions = this.executor!.getPositions();

        for (const pos of positions) {
            const pnlPct = ((pos.currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100;
            const holdHours = (Date.now() - pos.entryTime) / 3_600_000;

            // Take profit — partial exit: sell 50% to secure gains, let rest ride with trailing
            if (pnlPct >= config.take_profit_pct) {
                if (!pos.partialTpTaken) {
                    // First TP hit: sell 50%, mark as partial
                    const halfQty = pos.qty / 2;
                    const halfValue = halfQty * pos.currentPrice;
                    const halfCost = halfQty * pos.avgEntryPrice;
                    const halfPnl = halfValue - halfCost;
                    this.executor!.reducePosition(pos.tokenMint, halfQty);
                    pos.partialTpTaken = true;
                    this.log('info', `[TP-PARTIAL] Sold 50% of ${pos.tokenSymbol} at +${pnlPct.toFixed(1)}% — letting rest ride with trailing`);
                    await this.logSell(
                        { ...pos, qty: halfQty },
                        pos.currentPrice,
                        'partial_take_profit',
                        halfPnl,
                    );
                    continue;
                }
                // Second TP: already took partial, full exit handled by trailing stop
            }

            // Stop loss — time-aware: fast dump = rug, slow decline = wider tolerance
            const holdMinutes = (Date.now() - pos.entryTime) / 60_000;
            let effectiveSL = config.standard_sl_pct; // Default: 25%

            if (holdMinutes <= config.rug_window_minutes) {
                effectiveSL = config.rug_sl_pct; // 15% — rug detection
            } else if (holdMinutes >= config.wide_sl_after_minutes) {
                effectiveSL = config.wide_sl_pct; // 35% — memecoins need room
            }

            if (pnlPct <= -effectiveSL) {
                const phase = holdMinutes <= config.rug_window_minutes ? 'stop_loss_rug' :
                              holdMinutes >= config.wide_sl_after_minutes ? 'stop_loss_wide' : 'stop_loss';
                const label = phase === 'stop_loss_rug' ? 'RUG' :
                              phase === 'stop_loss_wide' ? 'WIDE-SL' : 'SL';
                const result = this.executor!.executeSell(pos.tokenMint, pos.currentPrice,
                    `${label} hit (${pnlPct.toFixed(1)}% in ${holdMinutes.toFixed(0)}min)`);
                if (result.success) {
                    this.log('info', `[${label}] ${result.message}`);
                    await this.logSell(pos, pos.currentPrice, phase, result.pnl);
                }
                continue;
            }

            // Trailing stop — dynamic: tighter for strong consensus, wider for single whale
            if (pnlPct >= config.trailing_activation_pct) {
                pos.trailingStopActive = true;
            }
            if (pos.trailingStopActive) {
                // Dynamic trailing: strong consensus = tighter (lock gains), single = wider (let it run)
                let trailPct = config.trailing_stop_pct;
                if (pos.consensusLevel === 'strong') trailPct = Math.max(3, trailPct * 0.6); // Tighter
                if (pos.consensusLevel === 'single') trailPct = trailPct * 1.3; // Wider for high-conviction whale plays

                const drawdownFromHwm = ((pos.highWatermark - pos.currentPrice) / pos.highWatermark) * 100;
                if (drawdownFromHwm >= trailPct) {
                    const result = this.executor!.executeSell(pos.tokenMint, pos.currentPrice, `trailing stop (${drawdownFromHwm.toFixed(1)}% from HWM, trail=${trailPct.toFixed(1)}%)`);
                    if (result.success) {
                        this.log('info', `[TRAIL] ${result.message}`);
                        await this.logSell(pos, pos.currentPrice, 'trailing_stop', result.pnl);
                    }
                    continue;
                }
            }

            // Stagnation — only exit if not losing (if losing, let SL handle it)
            if (holdHours >= config.stagnation_timeout_hours && pnlPct >= 0 && pnlPct < config.stagnation_min_pnl_pct) {
                const result = this.executor!.executeSell(pos.tokenMint, pos.currentPrice, `stagnation (${holdHours.toFixed(0)}h, ${pnlPct.toFixed(1)}%)`);
                if (result.success) {
                    this.log('info', `[STAG] ${result.message}`);
                    await this.logSell(pos, pos.currentPrice, 'stagnation', result.pnl);
                }
                continue;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Position Restoration (from Postgres, survives restarts)
    // -------------------------------------------------------------------------

    private async restorePositionsFromDb(): Promise<void> {
        const openPositions = await this.tradeLogger.getOpenPositions();
        if (openPositions.length === 0) return;

        for (const pos of openPositions) {
            // Re-create position in executor
            const signal: CopySignal = {
                tokenMint: pos.tokenMint,
                tokenSymbol: pos.tokenSymbol,
                action: 'BUY',
                consensusLevel: (pos.consensusLevel as 'strong' | 'medium' | 'single') ?? 'single',
                walletCount: 1,
                wallets: [],
                avgPriceUsd: pos.entryPrice,
                totalVolumeUsd: pos.dollarAmount,
                confidence: 50,
                reasoning: ['Restored from Postgres after restart'],
                timestamp: pos.timestamp,
            };

            const result = this.executor!.executeBuy(signal);
            if (result.success) {
                this.log('info', `[RESTORE] Restored position: ${pos.tokenSymbol} @ $${pos.entryPrice.toFixed(8)} ($${pos.dollarAmount.toFixed(2)})`);
            }
        }

        this.log('info', `[RESTORE] Restored ${openPositions.length} position(s) from Postgres`);
    }

    // -------------------------------------------------------------------------
    // Sell Logging (Postgres + Telegram)
    // -------------------------------------------------------------------------

    private async logSell(pos: CopyPosition, exitPrice: number, reason: string, pnl: number): Promise<void> {
        const pnlPct = pos.avgEntryPrice > 0 ? ((exitPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100 : 0;
        const isWin = pnl > 0;

        // ── Bayesian update: learn from this trade ──
        this.bayesian.recordOutcome({
            walletAddresses: pos.copiedFrom,
            consensusLevel: pos.consensusLevel,
            pnlUsd: pnl,
            isWin,
            tokenSymbol: pos.tokenSymbol,
            hourUtc: new Date().getUTCHours(),
        });

        // Check for promotions/demotions after update
        const whaleMin = (this.tomlConfig as any).single_whale?.min_score ?? 75;
        for (const addr of pos.copiedFrom) {
            const belief = this.bayesian.getBelief(addr);
            if (!belief) continue;

            if (this.bayesian.shouldPromote(addr)) {
                const oldScore = this.tomlConfig.wallets.scores[addr] ?? 0;
                if (oldScore < whaleMin) {
                    this.tomlConfig.wallets.scores[addr] = whaleMin;
                    this.log('info', `[BAYESIAN] PROMOTED ${addr.slice(0, 8)}... to single-whale (score ${belief.score.toFixed(0)}, ${belief.wins}W/${belief.losses}L)`);
                }
            }
            if (this.bayesian.shouldDowngrade(addr)) {
                // Downgrade = lose single-whale privileges, NOT removal.
                // Wallet stays tracked but needs consensus to trigger trades.
                const oldScore = this.tomlConfig.wallets.scores[addr] ?? 0;
                if (oldScore >= whaleMin) {
                    this.tomlConfig.wallets.scores[addr] = whaleMin - 15; // Below whale threshold
                    this.log('warn', `[BAYESIAN] DOWNGRADED ${addr.slice(0, 8)}... from single-whale to consensus-only (score ${belief.score.toFixed(0)} after ${belief.totalTrades} trades)`);
                }
            }
        }

        await this.tradeLogger.logTrade({
            tokenMint: pos.tokenMint,
            tokenSymbol: pos.tokenSymbol,
            side: 'SELL',
            qty: pos.qty,
            entryPrice: pos.avgEntryPrice,
            exitPrice,
            dollarAmount: pos.qty * exitPrice,
            realizedPnl: pnl,
            consensusLevel: pos.consensusLevel,
            exitReason: reason,
            metadata: {
                bayesianScores: pos.copiedFrom.map(a => ({
                    wallet: a.slice(0, 8),
                    score: this.bayesian.getScore(a).toFixed(0),
                })),
            },
        });

        // Feed CopyTracker — auto-promote/demote wallets based on results
        if (this.copyTracker) {
            const won = pnl > 0;
            for (const addr of pos.copiedFrom) {
                this.copyTracker.recordCopyOutcome(addr, pnl / pos.copiedFrom.length, won);
            }
        }

        const emoji = pnl >= 0 ? '🟢' : '🔴';
        const walletScores = pos.copiedFrom.map(a => `${a.slice(0, 6)}:${this.bayesian.getScore(a).toFixed(0)}`).join(', ');
        await sendTelegramAlert(
            `${emoji} <b>COPYNIX SELL</b>\n` +
            `Token: <b>${pos.tokenSymbol}</b>\n` +
            `Reason: ${reason}\n` +
            `P/L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)\n` +
            `Wallet scores: ${walletScores}`,
        );

        // Schedule AI post-trade analysis (runs 5 min after exit)
        if (this.postTradeAnalyzer) {
            let tradeId: number | null = null;
            try {
                const pgClient = this.tradeLogger.getPg();
                if (pgClient) {
                    const { rows } = await pgClient.query(
                        `SELECT id FROM copynix_trades WHERE token_mint = $1 AND side = 'SELL' ORDER BY id DESC LIMIT 1`,
                        [pos.tokenMint],
                    );
                    tradeId = rows[0]?.id ?? null;
                }
            } catch { /* non-critical */ }

            const tradeContext: TradeContext = {
                tokenMint: pos.tokenMint,
                tokenSymbol: pos.tokenSymbol,
                entryPrice: pos.avgEntryPrice,
                exitPrice,
                holdMinutes: (Date.now() - pos.entryTime) / 60_000,
                pnlUsd: pnl,
                pnlPct,
                exitReason: reason,
                consensusLevel: pos.consensusLevel,
                walletAddresses: pos.copiedFrom,
                walletScores: pos.copiedFrom.map(a => ({
                    wallet: a.slice(0, 8),
                    score: Math.round(this.bayesian.getScore(a)),
                })),
                tradeId,
            };
            this.postTradeAnalyzer.scheduleAnalysis(tradeContext);
        }
    }

    // -------------------------------------------------------------------------
    // Price Enrichment (for new trades from Helius where priceUsd=0)
    // -------------------------------------------------------------------------

    private async enrichTradePrices(trades: WalletTrade[]): Promise<void> {
        // Collect mints needing price OR symbol resolution
        const mintsToEnrich = [...new Set(
            trades.filter(t => t.priceUsd <= 0 || t.tokenSymbol === 'UNKNOWN').map(t => t.tokenMint)
        )];
        if (mintsToEnrich.length === 0) return;

        try {
            const url = `https://api.dexscreener.com/tokens/v1/solana/${mintsToEnrich.join(',')}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return;

            const pairs = (await res.json()) as Array<{
                baseToken: { address: string; symbol: string; name: string };
                priceUsd: string;
                chainId: string;
                liquidity?: { usd: number };
            }>;
            if (!Array.isArray(pairs)) return;

            // Pick highest-liquidity pair per token
            const tokenMap = new Map<string, { price: number; symbol: string; liquidity: number }>();
            for (const pair of pairs) {
                if (pair.chainId !== 'solana') continue;
                const addr = pair.baseToken.address.toLowerCase();
                const price = parseFloat(pair.priceUsd);
                if (!price || price <= 0) continue;
                const liq = pair.liquidity?.usd ?? 0;

                const existing = tokenMap.get(addr);
                if (!existing || liq > existing.liquidity) {
                    tokenMap.set(addr, {
                        price,
                        symbol: pair.baseToken.symbol || 'UNKNOWN',
                        liquidity: liq,
                    });
                }
            }

            let resolved = 0;
            for (const trade of trades) {
                const data = tokenMap.get(trade.tokenMint.toLowerCase());
                if (!data) continue;

                if (trade.priceUsd <= 0) trade.priceUsd = data.price;

                // Resolve UNKNOWN symbols from DexScreener
                if (trade.tokenSymbol === 'UNKNOWN' && data.symbol !== 'UNKNOWN') {
                    trade.tokenSymbol = data.symbol;
                    resolved++;
                }
            }

            if (resolved > 0) {
                this.log('info', `[ENRICH] Resolved ${resolved} UNKNOWN token symbol(s) via DexScreener`);
            }
        } catch (err) {
            this.log('error', `[ENRICH] DexScreener error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // -------------------------------------------------------------------------
    // Smart Money Sentiment Bridge (Copynix → Cryonix cross-intelligence)
    // -------------------------------------------------------------------------

    /**
     * Aggregate whale BUY/SELL activity into per-asset sentiment scores.
     * Written to Redis so Cryonix auto-trader can read them as signals.
     *
     * Maps Solana token symbols to Binance CEX symbols where possible:
     *   SOL → SOL, BONK → BONK, JUP → JUP, etc.
     *   Unmapped tokens contribute to general "crypto_risk" sentiment.
     *
     * Score: -100 (mass selling) to +100 (mass buying)
     * TTL: 30 min (stale whale data is worse than no data)
     */
    private async publishSmartMoneySentiment(trades: WalletTrade[]): Promise<void> {
        if (!this.statePublisher) return;

        try {
            // Count buys/sells per symbol
            const activity = new Map<string, { buys: number; sells: number; buyVolume: number; sellVolume: number; wallets: Set<string> }>();

            for (const trade of trades) {
                if (trade.tokenSymbol === 'UNKNOWN') continue;
                const symbol = trade.tokenSymbol.toUpperCase();

                let entry = activity.get(symbol);
                if (!entry) {
                    entry = { buys: 0, sells: 0, buyVolume: 0, sellVolume: 0, wallets: new Set() };
                    activity.set(symbol, entry);
                }

                entry.wallets.add(trade.walletAddress);
                if (trade.action === 'BUY') {
                    entry.buys++;
                    entry.buyVolume += trade.amountUsd;
                } else {
                    entry.sells++;
                    entry.sellVolume += trade.amountUsd;
                }
            }

            // Publish per-asset sentiment
            let published = 0;
            for (const [symbol, data] of activity) {
                const totalTrades = data.buys + data.sells;
                if (totalTrades === 0) continue;

                // Score: buy-ratio normalized to -100..+100
                const buyRatio = data.buys / totalTrades;
                const score = Math.round((buyRatio - 0.5) * 200); // 0.5 → 0, 1.0 → 100, 0.0 → -100

                const sentiment = {
                    symbol,
                    score,
                    buys: data.buys,
                    sells: data.sells,
                    buyVolume: data.buyVolume,
                    sellVolume: data.sellVolume,
                    uniqueWallets: data.wallets.size,
                    timestamp: Date.now(),
                };

                await this.statePublisher.set(
                    `smartmoney:${symbol}`,
                    JSON.stringify(sentiment),
                );
                published++;
            }

            // Aggregate crypto risk sentiment (overall whale mood)
            const totalBuys = [...activity.values()].reduce((s, d) => s + d.buys, 0);
            const totalSells = [...activity.values()].reduce((s, d) => s + d.sells, 0);
            const totalTrades = totalBuys + totalSells;
            if (totalTrades > 0) {
                const overallScore = Math.round(((totalBuys / totalTrades) - 0.5) * 200);
                await this.statePublisher.set('smartmoney:_overall', JSON.stringify({
                    score: overallScore,
                    buys: totalBuys,
                    sells: totalSells,
                    uniqueAssets: activity.size,
                    timestamp: Date.now(),
                }));
            }

            // Publish granular whale flow per Binance-tradeable asset (for Cryonix)
            // Maps Solana token symbols to CEX symbols where possible
            const SOLANA_TO_CEX: Record<string, string> = {
                'SOL': 'SOL', 'WSOL': 'SOL', 'BONK': 'BONK', 'JUP': 'JUP',
                'RAY': 'RAY', 'ORCA': 'ORCA', 'PYTH': 'PYTH', 'JTO': 'JTO',
                'WIF': 'WIF', 'RENDER': 'RENDER', 'HNT': 'HNT', 'W': 'W',
            };

            // Aggregate flow for CEX-tradeable assets
            const cexFlow = new Map<string, {
                buys: number; sells: number; buyVolume: number; sellVolume: number;
                wallets: string[]; lastTrade: number;
            }>();

            for (const trade of trades) {
                if (trade.tokenSymbol === 'UNKNOWN') continue;
                const cexSymbol = SOLANA_TO_CEX[trade.tokenSymbol.toUpperCase()];
                if (!cexSymbol) continue; // Not tradeable on CEX

                let flow = cexFlow.get(cexSymbol);
                if (!flow) {
                    flow = { buys: 0, sells: 0, buyVolume: 0, sellVolume: 0, wallets: [], lastTrade: 0 };
                    cexFlow.set(cexSymbol, flow);
                }
                if (trade.action === 'BUY') {
                    flow.buys++;
                    flow.buyVolume += trade.amountUsd;
                } else {
                    flow.sells++;
                    flow.sellVolume += trade.amountUsd;
                }
                if (!flow.wallets.includes(trade.walletAddress.slice(0, 8))) {
                    flow.wallets.push(trade.walletAddress.slice(0, 8));
                }
                flow.lastTrade = Math.max(flow.lastTrade, trade.timestamp);
            }

            for (const [symbol, flow] of cexFlow) {
                const netFlow = flow.buyVolume - flow.sellVolume;
                await this.statePublisher.set(`smartmoney:flow:${symbol}`, JSON.stringify({
                    symbol,
                    buys: flow.buys,
                    sells: flow.sells,
                    buyVolume: flow.buyVolume,
                    sellVolume: flow.sellVolume,
                    netFlowUsd: netFlow,
                    uniqueWallets: flow.wallets.length,
                    walletLabels: flow.wallets,
                    lastTrade: flow.lastTrade,
                    timestamp: Date.now(),
                }));
            }

            if (published > 0 || cexFlow.size > 0) {
                this.log('info', `[SMART-MONEY] Published: ${published} sentiment + ${cexFlow.size} CEX flow (${totalBuys}B/${totalSells}S)`);
            }
        } catch (err) {
            this.log('warn', `[SMART-MONEY] Publish failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // -------------------------------------------------------------------------
    // Price Updates
    // -------------------------------------------------------------------------

    private async updatePositionPrices(): Promise<void> {
        const positions = this.executor!.getPositions();
        if (positions.length === 0) return;

        // Batch fetch prices from DexScreener
        const mints = positions.map(p => p.tokenMint).join(',');
        try {
            const url = `https://api.dexscreener.com/tokens/v1/solana/${mints}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return;

            const pairs = (await res.json()) as Array<{ baseToken: { address: string }; priceUsd: string; chainId: string; liquidity?: { usd: number } }>;
            if (!Array.isArray(pairs)) return;

            // Group by token, pick highest liquidity
            const priceMap = new Map<string, { price: number; liquidity: number }>();
            for (const pair of pairs) {
                if (pair.chainId !== 'solana') continue;
                const addr = pair.baseToken.address.toLowerCase();
                const price = parseFloat(pair.priceUsd);
                if (!price || price <= 0) continue;
                const liq = pair.liquidity?.usd ?? 0;

                const existing = priceMap.get(addr);
                if (!existing || liq > existing.liquidity) {
                    priceMap.set(addr, { price, liquidity: liq });
                }
            }

            for (const pos of positions) {
                const data = priceMap.get(pos.tokenMint.toLowerCase());
                if (data) {
                    this.executor!.updatePrice(pos.tokenMint, data.price);
                }
            }
        } catch {
            // Skip price update on error
        }
    }

    // -------------------------------------------------------------------------
    // Wallet Discovery
    // -------------------------------------------------------------------------

    private async runDiscovery(): Promise<void> {
        if (!this.walletDiscovery) return;

        const intervalMs = this.tomlConfig.wallets.discovery_interval_hours * 3_600_000;
        if (Date.now() - this.lastDiscoveryTime < intervalMs) return;
        this.lastDiscoveryTime = Date.now();

        try {
            this.log('info', '[DISCOVERY] Searching for new wallets...');
            const newWallets = await this.walletDiscovery.discover();

            if (newWallets.length === 0) {
                this.log('info', '[DISCOVERY] No new wallets found');
                return;
            }

            for (const w of newWallets) {
                this.walletMonitor!.addWallet(w.address);
                // Give discovered wallets a starting score of 70 (below single-whale threshold)
                // CopyTracker will promote them if they perform well (>= whale threshold)
                const wt = (this.tomlConfig as any).single_whale?.min_score ?? 75;
                this.tomlConfig.wallets.scores[w.address] = w.score >= wt ? w.score : 70;
                this.log('info', `[DISCOVERY] Added wallet ${w.label} (${w.address.slice(0, 8)}...) score=${w.score} WR=${w.winRate.toFixed(0)}%`);
            }

            this.log('info', `[DISCOVERY] Total tracked wallets: ${this.walletMonitor!.walletCount}`);
        } catch (err) {
            this.log('error', `[DISCOVERY] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // -------------------------------------------------------------------------
    // State Publishing
    // -------------------------------------------------------------------------

    private async publishState(): Promise<void> {
        if (!this.statePublisher) return;

        const acct = this.executor!.getAccountState();
        const positions = this.executor!.getPositions();

        try {
            // Use StatePublisher's existing methods with copynix namespace
            await this.statePublisher.publishPositions(
                positions.map(p => ({
                    symbol: p.tokenSymbol,
                    qty: p.qty,
                    avgEntryPrice: p.avgEntryPrice,
                    currentPrice: p.currentPrice,
                    marketValue: p.qty * p.currentPrice,
                    unrealizedPl: p.unrealizedPl,
                    unrealizedPlPct: p.avgEntryPrice > 0
                        ? ((p.currentPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100
                        : 0,
                })),
            );
            const totalUnrealizedPl = positions.reduce((s, p) => s + p.unrealizedPl, 0);
            await this.statePublisher.publishAccount({
                buyingPower: acct.usdcBalance,
                settledCash: acct.usdcBalance,
                portfolioValue: acct.portfolioValue,
                isPatternDayTrader: false,
                dailyPnl: totalUnrealizedPl,
                dailyPnlPct: acct.portfolioValue > 0
                    ? (totalUnrealizedPl / acct.portfolioValue) * 100
                    : 0,
                updatedAt: Date.now(),
            });
            await this.statePublisher.publishStatus('running');
        } catch (err) {
            this.log('warn', `publishState failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
