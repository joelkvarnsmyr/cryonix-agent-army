/**
 * Predator Hunter — Main Agent
 *
 * Counter-exploitation trading bot that detects manipulation campaigns
 * (P&D, coordinated shills, whale games) and profits from early pump phases.
 *
 * Extends BaseAgent with: scan → detect → validate → enter → monitor → exit
 */

import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import type Redis from 'ioredis';
import { loadPredatorHunterConfig } from './config';
import { ManipulationScanner } from './manipulation-scanner';
import { EntryValidator } from './entry-validator';
import { DumpDetector } from './dump-detector';
import type {
    PredatorHunterConfig,
    PredatorHunterState,
    ManipulationSignal,
    HunterPosition,
    PriceTick,
    ExitReason,
} from './types';

const STATE_KEY = 'predatorhunter:state';
const STATE_TTL = 600; // 10 min

export class PredatorHunterAgent extends BaseAgent {
    private cfg!: PredatorHunterConfig;
    private redis!: Redis;
    private exchange: any; // CCXT Binance instance
    private scanner!: ManipulationScanner;
    private validator!: EntryValidator;
    private dumpDetector!: DumpDetector;

    private positions: HunterPosition[] = [];
    private recentTrades: HunterPosition[] = [];
    private activeSignals: ManipulationSignal[] = [];
    private virtualBalance: number = 0;
    private dailyPnl: number = 0;
    private tradesToday: number = 0;
    private consecutiveLosses: number = 0;
    private lastScanAt: string | null = null;
    private running: boolean = false;
    private cooldownUntil: number = 0;

    constructor(agentConfig: AgentConfig) {
        super(agentConfig);
    }

    async initialize(): Promise<void> {
        this.log('info', 'Initializing Predator Hunter agent...');

        // Load config
        this.cfg = loadPredatorHunterConfig();
        this.virtualBalance = this.cfg.capital.virtual_balance;

        // Connect Redis
        const IORedis = require('ioredis');
        const kvUrl = process.env.KV_URL || 'redis://localhost:6379';
        this.redis = new IORedis(kvUrl, { maxRetriesPerRequest: 3 });

        // Initialize CCXT exchange
        const ccxt = require('ccxt');
        if (this.cfg.broker.paper_trading) {
            // Paper mode: use public API only (no keys needed)
            this.exchange = new ccxt.binance({
                timeout: this.cfg.timing.api_timeout_ms,
                enableRateLimit: true,
            });
            // Attach redis instance for CMC lookups
            (this.exchange as any)._redis = this.redis;
            this.log('info', '📝 PAPER TRADING MODE — no real trades will be executed');
        } else {
            this.exchange = new ccxt.binance({
                apiKey: process.env.BINANCE_API_KEY,
                secret: process.env.BINANCE_API_SECRET,
                timeout: this.cfg.timing.api_timeout_ms,
                enableRateLimit: true,
            });
            (this.exchange as any)._redis = this.redis;
            this.log('info', '🔴 LIVE TRADING MODE — real money at risk!');
        }

        // Initialize subsystems
        this.scanner = new ManipulationScanner(this.cfg, this.redis);
        this.validator = new EntryValidator(this.cfg, this.exchange, this.redis);
        this.dumpDetector = new DumpDetector(this.cfg);

        await this.loadState();
        this.setStatus('idle');
        this.log('info', 'Predator Hunter initialized');
    }

    async start(): Promise<void> {
        this.running = true;
        this.setStatus('running');
        this.log('info', '🎯 Predator Hunter started — hunting for manipulation campaigns');
        this.log('info', `Config: paper=${this.cfg.broker.paper_trading}, balance=$${this.virtualBalance}, max_pos=${this.cfg.limits.max_open_positions}`);

        while (this.running) {
            try {
                await this.tick();
            } catch (err) {
                this.log('error', 'Tick error', err);
            }

            // Sleep based on whether we have open positions
            const sleepMs = this.positions.length > 0
                ? this.cfg.timing.position_check_ms  // 5s when in position
                : this.cfg.scanner.scan_interval_ms;  // 5min when scanning
            await this.sleep(sleepMs);
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        this.log('info', 'Stopping Predator Hunter...');

        // Close all positions on shutdown
        for (const pos of this.positions) {
            await this.closePosition(pos, 'manual');
        }

        await this.saveState();
        if (this.redis) await this.redis.quit();
        this.setStatus('idle');
        this.log('info', 'Predator Hunter stopped');
    }

    async handleMessage(message: AgentMessage): Promise<void> {
        this.log('info', `Received message: ${message.message_type}`, message.data);
    }

    // ─── Main Loop ──────────────────────────────────────────────

    private async tick(): Promise<void> {
        // Reset daily counters at midnight UTC
        this.checkDailyReset();

        // 1. Monitor open positions (fast path — every 5s)
        if (this.positions.length > 0) {
            await this.monitorPositions();
        }

        // 2. Check if we should scan for new signals
        const now = Date.now();
        const lastScanTime = this.lastScanAt ? new Date(this.lastScanAt).getTime() : 0;
        const shouldScan = now - lastScanTime >= this.cfg.scanner.scan_interval_ms;

        if (!shouldScan) return; // Still in position monitoring mode

        // 3. Check circuit breakers
        if (this.isCircuitBroken()) return;

        // 4. Check cooldown
        if (now < this.cooldownUntil) {
            const remaining = Math.round((this.cooldownUntil - now) / 60_000);
            this.log('info', `Cooldown active — ${remaining} min remaining`);
            this.lastScanAt = new Date().toISOString();
            return;
        }

        // 5. Scan for manipulation campaigns
        this.log('info', '🔍 Scanning for manipulation campaigns...');
        const watchlist = this.positions.map(p => p.symbol.split('/')[0]);
        const signals = await this.scanner.fullScan(watchlist);
        this.activeSignals = signals;
        this.lastScanAt = new Date().toISOString();

        if (signals.length === 0) {
            this.log('info', 'No manipulation campaigns detected');
            await this.saveState();
            return;
        }

        this.log('info', `🚨 ${signals.length} manipulation campaign(s) detected!`);

        // 6. Validate and potentially enter positions
        for (const signal of signals) {
            // Check position limits
            if (this.positions.length >= this.cfg.limits.max_open_positions) {
                this.log('info', `Max positions reached (${this.cfg.limits.max_open_positions})`);
                break;
            }
            if (this.tradesToday >= this.cfg.limits.max_trades_per_day) {
                this.log('info', `Daily trade limit reached (${this.cfg.limits.max_trades_per_day})`);
                break;
            }

            // Check if we already have a position in this symbol
            if (this.positions.some(p => p.symbol === signal.symbol)) {
                this.log('info', `Already in position for ${signal.symbol}`);
                continue;
            }

            // Validate entry
            const validation = await this.validator.validate(signal);
            if (!validation.approved) {
                this.log('info', `Entry rejected for ${signal.symbol}`);
                continue;
            }

            // Enter position
            await this.enterPosition(validation.signal, validation.live_price);
        }

        await this.saveState();
    }

    // ─── Position Management ────────────────────────────────────

    private async enterPosition(signal: ManipulationSignal, price: number): Promise<void> {
        const positionSize = Math.min(
            this.cfg.capital.max_position_size_usd,
            this.virtualBalance * this.cfg.capital.max_capital_per_trade_pct
        );

        if (positionSize < this.cfg.capital.min_order_value) {
            this.log('warn', `Position size $${positionSize.toFixed(2)} < min order $${this.cfg.capital.min_order_value}`);
            return;
        }

        const quantity = positionSize / price;

        if (this.cfg.broker.paper_trading) {
            // Paper trade: simulate fill at current price
            this.log('info', `📝 [PAPER] BUY ${signal.symbol} — $${positionSize.toFixed(2)} @ $${price.toFixed(6)} (${signal.type}, conf: ${signal.confidence}%)`);
        } else {
            // Live trade: execute market buy on Binance
            try {
                const order = await this.exchange.createMarketBuyOrder(signal.symbol, quantity);
                this.log('info', `🔴 [LIVE] BUY ${signal.symbol} — $${positionSize.toFixed(2)} @ $${order.average}`);
                price = order.average || price;
            } catch (err) {
                this.log('error', `Failed to execute BUY for ${signal.symbol}`, err);
                return;
            }
        }

        const position: HunterPosition = {
            id: `ph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            symbol: signal.symbol,
            entry_price: price,
            current_price: price,
            size_usd: positionSize,
            quantity,
            unrealized_pnl: 0,
            unrealized_pnl_pct: 0,
            signal,
            price_history: [{ price, timestamp: Date.now(), volume: 0 }],
            trailing_high: price,
            trailing_active: false,
            entered_at: new Date().toISOString(),
            exit_reason: null,
            exit_price: null,
            exited_at: null,
        };

        this.positions.push(position);
        this.virtualBalance -= positionSize;
        this.tradesToday++;

        this.log('info', `Position opened: ${position.id} — ${signal.symbol} @ $${price.toFixed(6)}`);
    }

    private async monitorPositions(): Promise<void> {
        const toClose: Array<{ position: HunterPosition; reason: ExitReason }> = [];

        for (const position of this.positions) {
            try {
                // Fetch current price
                const ticker = await this.exchange.fetchTicker(position.symbol);
                const currentPrice = ticker.last;

                // Update position
                position.current_price = currentPrice;
                position.unrealized_pnl = (currentPrice - position.entry_price) * position.quantity;
                position.unrealized_pnl_pct = ((currentPrice - position.entry_price) / position.entry_price) * 100;

                // Add price tick
                position.price_history.push({
                    price: currentPrice,
                    timestamp: Date.now(),
                    volume: ticker.quoteVolume || 0,
                });

                // Keep last 120 ticks (10 min at 5s intervals)
                if (position.price_history.length > 120) {
                    position.price_history = position.price_history.slice(-120);
                }

                // Update trailing stop
                this.dumpDetector.updateTrailing(position);

                // Check for exit signals
                const exitSignal = this.dumpDetector.check(position);
                if (exitSignal) {
                    toClose.push({ position, reason: exitSignal.reason });
                    this.log('info', `🚨 EXIT SIGNAL: ${position.symbol} — ${exitSignal.reason}: ${exitSignal.details}`);
                }
            } catch (err) {
                this.log('error', `Failed to monitor ${position.symbol}`, err);
            }
        }

        // Close positions that triggered exits
        for (const { position, reason } of toClose) {
            await this.closePosition(position, reason);
        }
    }

    private async closePosition(position: HunterPosition, reason: ExitReason): Promise<void> {
        const currentPrice = position.current_price;

        if (!this.cfg.broker.paper_trading && reason !== 'manual') {
            // Live trade: execute market sell
            try {
                const order = await this.exchange.createMarketSellOrder(position.symbol, position.quantity);
                this.log('info', `🔴 [LIVE] SELL ${position.symbol} — ${position.quantity} @ $${order.average}`);
            } catch (err) {
                this.log('error', `Failed to execute SELL for ${position.symbol}`, err);
                return;
            }
        }

        // Calculate final P&L
        const pnl = (currentPrice - position.entry_price) * position.quantity;
        const pnlPct = ((currentPrice - position.entry_price) / position.entry_price) * 100;

        // Update position
        position.exit_reason = reason;
        position.exit_price = currentPrice;
        position.exited_at = new Date().toISOString();
        position.unrealized_pnl = pnl;
        position.unrealized_pnl_pct = pnlPct;

        // Update agent state
        this.virtualBalance += position.size_usd + pnl;
        this.dailyPnl += pnl;

        if (pnl < 0) {
            this.consecutiveLosses++;
            if (this.consecutiveLosses >= this.cfg.risk.max_consecutive_losses) {
                this.cooldownUntil = Date.now() + this.cfg.limits.cooldown_after_loss_minutes * 60_000;
                this.log('warn', `${this.consecutiveLosses} consecutive losses — cooldown for ${this.cfg.limits.cooldown_after_loss_minutes} min`);
            }
        } else {
            this.consecutiveLosses = 0;
        }

        // Move to recent trades
        this.positions = this.positions.filter(p => p.id !== position.id);
        this.recentTrades.push(position);
        // Keep last 50 trades
        if (this.recentTrades.length > 50) this.recentTrades = this.recentTrades.slice(-50);

        // Cleanup dump detector state
        this.dumpDetector.cleanup(position.id);

        const emoji = pnl >= 0 ? '💰' : '💸';
        const mode = this.cfg.broker.paper_trading ? 'PAPER' : 'LIVE';
        this.log('info', `${emoji} [${mode}] CLOSED ${position.symbol} — ${reason} — PnL: $${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`);
        this.log('info', `  Balance: $${this.virtualBalance.toFixed(2)} | Daily P&L: $${this.dailyPnl.toFixed(2)}`);

        await this.saveState();
    }

    // ─── Circuit Breakers ───────────────────────────────────────

    private isCircuitBroken(): boolean {
        // Daily loss limit
        const dailyLossLimit = this.cfg.capital.virtual_balance * this.cfg.risk.max_daily_loss_pct;
        if (this.dailyPnl < -dailyLossLimit) {
            this.log('warn', `🔒 Daily loss circuit breaker: $${this.dailyPnl.toFixed(2)} < -$${dailyLossLimit.toFixed(2)}`);
            return true;
        }

        // Consecutive losses
        if (this.consecutiveLosses >= this.cfg.risk.max_consecutive_losses) {
            this.log('warn', `🔒 Consecutive loss circuit breaker: ${this.consecutiveLosses} losses`);
            return true;
        }

        return false;
    }

    private checkDailyReset(): void {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMinute = now.getUTCMinutes();

        // Reset at 00:00 UTC
        if (utcHour === 0 && utcMinute === 0) {
            if (this.tradesToday > 0 || this.dailyPnl !== 0) {
                this.log('info', `📊 Daily reset — Trades: ${this.tradesToday}, P&L: $${this.dailyPnl.toFixed(2)}`);
                this.tradesToday = 0;
                this.dailyPnl = 0;
            }
        }
    }

    // ─── State Persistence ──────────────────────────────────────

    private getState(): PredatorHunterState {
        const closedWins = this.recentTrades.filter(t => (t.unrealized_pnl || 0) > 0).length;
        const totalClosed = this.recentTrades.length;

        return {
            status: this.positions.length > 0 ? 'in_position' :
                    Date.now() < this.cooldownUntil ? 'cooldown' : 'scanning',
            positions: this.positions,
            recent_trades: this.recentTrades.slice(-10),
            active_signals: this.activeSignals,
            daily_pnl: this.dailyPnl,
            trades_today: this.tradesToday,
            win_rate: totalClosed > 0 ? (closedWins / totalClosed) * 100 : 0,
            paper_mode: this.cfg.broker.paper_trading,
            virtual_balance: this.virtualBalance,
            last_scan_at: this.lastScanAt,
            consecutive_losses: this.consecutiveLosses,
            updated_at: new Date().toISOString(),
        };
    }

    private async saveState(): Promise<void> {
        try {
            const state = this.getState();
            await this.redis.setex(STATE_KEY, STATE_TTL, JSON.stringify(state));
        } catch (err) {
            this.log('error', 'Failed to save state to Redis', err);
        }
    }

    private async loadState(): Promise<void> {
        try {
            const raw = await this.redis.get(STATE_KEY);
            if (!raw) return;

            const state: PredatorHunterState = JSON.parse(raw);
            this.virtualBalance = state.virtual_balance ?? this.cfg.capital.virtual_balance;
            this.dailyPnl = state.daily_pnl ?? 0;
            this.tradesToday = state.trades_today ?? 0;
            this.consecutiveLosses = state.consecutive_losses ?? 0;
            this.recentTrades = state.recent_trades ?? [];
            this.lastScanAt = state.last_scan_at ?? null;

            // Don't restore open positions from previous session — they may be stale
            this.log('info', `State loaded — Balance: $${this.virtualBalance.toFixed(2)}, Daily P&L: $${this.dailyPnl.toFixed(2)}`);
        } catch (err) {
            this.log('warn', 'Failed to load state from Redis — starting fresh', err);
        }
    }
}
