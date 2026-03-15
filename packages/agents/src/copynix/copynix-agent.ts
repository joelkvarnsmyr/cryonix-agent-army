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
import type { CopyPosition, CopySignal, WalletTrade } from './types';

export class CopynixAgent extends BaseAgent {
    private isRunning = false;

    private walletMonitor: WalletMonitor | null = null;
    private consensusEngine: ConsensusEngine | null = null;
    private executor: CopyExecutor | null = null;
    private riskGate: CopyRiskGate | null = null;
    private statePublisher: StatePublisher | null = null;
    private riskManager = new RiskManager();
    private polymarket = new PolymarketIntelligence(300_000);

    private walletDiscovery: WalletDiscovery | null = null;
    private lastDiscoveryTime = 0;

    private lastResetDay = new Date().getUTCDate();
    private tradesToday = 0;
    private pollCount = 0;
    private lastHeartbeat = 0;

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

                // 1. Poll tracked wallets for new trades
                this.pollCount++;
                const pollStart = Date.now();
                const newTrades = await this.walletMonitor!.pollNewTrades();
                const pollMs = Date.now() - pollStart;
                if (pollMs > 5000) {
                    this.log('info', `[SLOW POLL] pollNewTrades took ${(pollMs / 1000).toFixed(1)}s`);
                }

                if (newTrades.length > 0) {
                    this.log('info', `[POLL] ${newTrades.length} new trade(s) from tracked wallets`);
                }

                // Heartbeat every 5 minutes
                const now = Date.now();
                if (now - this.lastHeartbeat >= 300_000) {
                    const acct = this.executor!.getAccountState();
                    const pending = this.consensusEngine!.getPending().size;
                    this.log('info', `[HEARTBEAT] poll #${this.pollCount} | ${acct.totalPositions} pos | $${acct.portfolioValue.toFixed(0)} value | ${pending} pending consensus | ${this.tradesToday} trades today`);
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

                // 3. Check exits on existing positions
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
            // Single-whale mode: high-score wallets can trigger alone
            const walletScore = this.tomlConfig.wallets.scores[trade.walletAddress] ?? 0;
            if (walletScore >= 80) {
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

        // Anti-rug safety check
        const safety = await this.riskGate!.validateSignal(signal);
        if (!safety.allowed) {
            this.log('info', `[BLOCKED] ${signal.tokenSymbol} failed safety: ${safety.reasons.join(', ')}`);
            return;
        }

        // Execute the copy trade
        const result = this.executor!.executeBuy(signal);
        if (result.success) {
            this.tradesToday++;
            this.log('info', `[BUY] ${result.message}`);
        } else {
            this.log('info', `[SKIP] ${result.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // Exit Management
    // -------------------------------------------------------------------------

    private async handleLeaderExit(trade: WalletTrade): Promise<void> {
        if (!this.tomlConfig.exits.leader_exit_enabled) return;

        const pos = this.executor!.getPosition(trade.tokenMint);
        if (!pos) return;

        // Check if the selling wallet is one we copied from
        if (!pos.copiedFrom.includes(trade.walletAddress)) return;

        this.log('info', `[LEADER EXIT] ${trade.walletAddress.slice(0, 8)}... sold ${pos.tokenSymbol} — closing position`);
        const result = this.executor!.executeSell(trade.tokenMint, pos.currentPrice, 'leader exit');
        if (result.success) {
            this.log('info', `[SELL] ${result.message}`);
        }
    }

    private async checkExits(): Promise<void> {
        const config = this.tomlConfig.exits;
        const positions = this.executor!.getPositions();

        for (const pos of positions) {
            const pnlPct = ((pos.currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100;
            const holdHours = (Date.now() - pos.entryTime) / 3_600_000;

            // Take profit
            if (pnlPct >= config.take_profit_pct) {
                const result = this.executor!.executeSell(pos.tokenMint, pos.currentPrice, `TP hit (${pnlPct.toFixed(1)}%)`);
                if (result.success) this.log('info', `[TP] ${result.message}`);
                continue;
            }

            // Stop loss
            if (pnlPct <= -config.stop_loss_pct) {
                const result = this.executor!.executeSell(pos.tokenMint, pos.currentPrice, `SL hit (${pnlPct.toFixed(1)}%)`);
                if (result.success) this.log('info', `[SL] ${result.message}`);
                continue;
            }

            // Trailing stop
            if (pnlPct >= config.trailing_activation_pct) {
                pos.trailingStopActive = true;
            }
            if (pos.trailingStopActive) {
                const drawdownFromHwm = ((pos.highWatermark - pos.currentPrice) / pos.highWatermark) * 100;
                if (drawdownFromHwm >= config.trailing_stop_pct) {
                    const result = this.executor!.executeSell(pos.tokenMint, pos.currentPrice, `trailing stop (${drawdownFromHwm.toFixed(1)}% from HWM)`);
                    if (result.success) this.log('info', `[TRAIL] ${result.message}`);
                    continue;
                }
            }

            // Stagnation
            if (holdHours >= config.stagnation_timeout_hours && Math.abs(pnlPct) < config.stagnation_min_pnl_pct) {
                const result = this.executor!.executeSell(pos.tokenMint, pos.currentPrice, `stagnation (${holdHours.toFixed(0)}h, ${pnlPct.toFixed(1)}%)`);
                if (result.success) this.log('info', `[STAG] ${result.message}`);
                continue;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Price Enrichment (for new trades from Helius where priceUsd=0)
    // -------------------------------------------------------------------------

    private async enrichTradePrices(trades: WalletTrade[]): Promise<void> {
        const mintsToEnrich = [...new Set(
            trades.filter(t => t.priceUsd <= 0).map(t => t.tokenMint)
        )];
        if (mintsToEnrich.length === 0) return;

        try {
            const url = `https://api.dexscreener.com/tokens/v1/solana/${mintsToEnrich.join(',')}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return;

            const pairs = (await res.json()) as Array<{
                baseToken: { address: string };
                priceUsd: string;
                chainId: string;
                liquidity?: { usd: number };
            }>;
            if (!Array.isArray(pairs)) return;

            // Pick highest-liquidity pair per token
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

            for (const trade of trades) {
                if (trade.priceUsd > 0) continue;
                const data = priceMap.get(trade.tokenMint.toLowerCase());
                if (data) {
                    trade.priceUsd = data.price;
                    this.log('info', `[ENRICH] ${trade.tokenSymbol} price: $${data.price.toFixed(6)}`);
                }
            }
        } catch (err) {
            this.log('error', `[ENRICH] DexScreener error: ${err instanceof Error ? err.message : String(err)}`);
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
                // They need to prove themselves before getting single-whale privileges
                this.tomlConfig.wallets.scores[w.address] = w.score >= 80 ? w.score : 70;
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
        } catch {
            // Non-critical, skip
        }
    }
}
