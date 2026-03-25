import Redis from 'ioredis';
import { Client as PgClient } from 'pg';
import { loadHuntrixConfig, type HuntrixConfig } from './config';
import { ManipulationScanner } from './manipulation-scanner';
import { EntryValidator } from './entry-validator';
import { DumpDetector } from './dump-detector';
import { ExchangeManager } from './exchange-manager';
import { PumpProfiler } from './pump-profiler';
import type {
    HuntrixState,
    ManipulationSignal,
    HunterPosition,
    ExitReason,
} from './types';

export class HuntrixAgent {
    private redis!: Redis;
    private config!: HuntrixConfig;
    private exchangeManager!: ExchangeManager;
    private pumpProfiler!: PumpProfiler;
    private scanner!: ManipulationScanner;
    private validator!: EntryValidator;
    private dumpDetector!: DumpDetector;

    private pg: PgClient | null = null;
    private positions: HunterPosition[] = [];
    private recentTrades: HunterPosition[] = [];
    private activeSignals: ManipulationSignal[] = [];
    private virtualBalance = 0;
    private dailyPnl = 0;
    private tradesToday = 0;
    private consecutiveLosses = 0;
    private totalTrades = 0;
    private totalWins = 0;
    private lastScanAt: string | null = null;
    private lastShillRecheck = 0;
    private running = false;
    private cooldownUntil = 0;
    private lastDailyReset = '';

    constructor(private meta: { id: string; name: string }) {}

    // ─── Initialize ──────────────────────────────────────────────

    async initialize(): Promise<void> {
        this.config = loadHuntrixConfig();
        this.virtualBalance = this.config.capital.virtual_balance;

        this.redis = new Redis(process.env.KV_URL ?? 'redis://localhost:6379');
        this.redis.on('error', (err: Error) => console.error('[HUNTRIX] Redis error:', err.message));

        // Multi-exchange initialization
        this.exchangeManager = new ExchangeManager(this.config.exchanges, this.config.general.mode);
        await this.exchangeManager.initialize();
        await this.exchangeManager.loadMarkets();

        this.pumpProfiler = new PumpProfiler(this.redis);

        this.scanner = new ManipulationScanner(this.config, this.redis);
        const primaryId = this.exchangeManager.getScanExchangeIds()[0] ?? 'binance';
        const primaryExchange = this.exchangeManager.getExchange(primaryId);
        if (!primaryExchange) {
            throw new Error(`[HUNTRIX] No exchange available — check [[exchanges]] config`);
        }
        this.validator = new EntryValidator(this.config, primaryExchange, this.redis);
        this.dumpDetector = new DumpDetector(this.config);
        await this.dumpDetector.initXai();

        // Postgres trade persistence
        const pgUrl = process.env.POSTGRES_URL;
        if (pgUrl) {
            this.pg = new PgClient({ connectionString: pgUrl });
            await this.pg.connect();
            await this.pg.query(`
                CREATE TABLE IF NOT EXISTS huntrix_trades (
                    id SERIAL PRIMARY KEY,
                    symbol VARCHAR(20) NOT NULL,
                    side VARCHAR(10) NOT NULL,
                    entry_price DECIMAL(20,8),
                    exit_price DECIMAL(20,8),
                    size DECIMAL(20,8),
                    pnl DECIMAL(20,8),
                    entry_reason TEXT,
                    exit_reason TEXT,
                    status TEXT DEFAULT 'open',
                    entered_at TIMESTAMPTZ DEFAULT NOW(),
                    exited_at TIMESTAMPTZ,
                    metadata JSONB
                )
            `);
            await this.pg.query(`
                CREATE TABLE IF NOT EXISTS huntrix_signals (
                    id SERIAL PRIMARY KEY,
                    signal_id VARCHAR(64) NOT NULL,
                    symbol VARCHAR(20) NOT NULL,
                    type VARCHAR(50) NOT NULL,
                    source VARCHAR(50) NOT NULL,
                    exchange VARCHAR(20),
                    confidence DECIMAL(5,2),
                    phase VARCHAR(20),
                    price_at_detection DECIMAL(20,8),
                    volume_spike_ratio DECIMAL(10,4),
                    price_velocity DECIMAL(10,6),
                    total_shill_accounts INTEGER DEFAULT 0,
                    estimated_peak_minutes INTEGER,
                    reasoning TEXT,
                    detected_at TIMESTAMPTZ NOT NULL,
                    logged_at TIMESTAMPTZ DEFAULT NOW(),
                    metadata JSONB
                )
            `);
            await this.pg.query(`
                CREATE INDEX IF NOT EXISTS idx_huntrix_signals_symbol ON huntrix_signals(symbol)
            `);
            await this.pg.query(`
                CREATE INDEX IF NOT EXISTS idx_huntrix_signals_detected ON huntrix_signals(detected_at)
            `);
            console.log('[huntrix] Postgres connected');
        }

        // Restore state from Redis
        await this.loadState();

        console.log(
            `[HUNTRIX] Initialized — ${this.meta.name} (${this.meta.id}) | mode: ${this.config.general.mode} | capital: $${this.config.general.capital}`,
        );
    }

    // ─── Start / Stop ────────────────────────────────────────────

    async start(): Promise<void> {
        this.running = true;
        console.log(`[HUNTRIX] Scan loop starting...`);
        while (this.running) {
            try {
                await this.tick();
            } catch (err) {
                console.error('[HUNTRIX] tick error:', err);
            }
            const sleepMs = this.positions.length > 0
                ? this.config.timing.price_check_ms
                : this.config.timing.scan_interval_ms;
            await this.sleep(sleepMs);
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        for (const pos of this.positions) {
            await this.closePosition(pos, 'manual');
        }
        await this.saveState();
        await this.redis?.quit();
        console.log('[HUNTRIX] Stopped.');
    }

    // ─── Main Loop ───────────────────────────────────────────────

    private async tick(): Promise<void> {
        this.checkDailyReset();

        // 0. Check brain force-exit signal
        try {
            const forceExitRaw = await this.redis.get('huntrix:brain:force_exit');
            if (forceExitRaw) {
                const { symbol, reason } = JSON.parse(forceExitRaw);
                const pos = this.positions.find(p => p.symbol === symbol);
                if (pos) {
                    console.log(`[HUNTRIX] Brain force-exit: ${symbol} — ${reason}`);
                    await this.closePosition(pos, 'manual');
                    if (this.config.telegram.alert_on_exit) {
                        await this.sendTelegramAlert(
                            `<b>🧠 HUNTRIX BRAIN EXIT</b>\n${symbol}: ${reason}\nP&L: ${pos.unrealized_pnl_pct.toFixed(2)}%`,
                        );
                    }
                }
                await this.redis.del('huntrix:brain:force_exit');
            }
        } catch { /* best effort */ }

        // 1. Monitor open positions (fast path)
        if (this.positions.length > 0) {
            await this.monitorPositions();

            // Shill re-scan on interval
            const now = Date.now();
            if (now - this.lastShillRecheck >= this.config.timing.shill_recheck_ms) {
                this.lastShillRecheck = now;
                for (const pos of this.positions) {
                    await this.dumpDetector.recheckShillActivity(pos);
                }
            }
        }

        // 2. Should we scan?
        const now = Date.now();
        const lastScanTime = this.lastScanAt ? new Date(this.lastScanAt).getTime() : 0;
        if (now - lastScanTime < this.config.timing.scan_interval_ms) return;

        // 3. Circuit breakers
        if (this.isCircuitBroken()) {
            this.lastScanAt = new Date().toISOString();
            return;
        }

        // 4. Cooldown
        if (now < this.cooldownUntil) {
            const remaining = Math.round((this.cooldownUntil - now) / 60_000);
            console.log(`[HUNTRIX] Cooldown active — ${remaining} min remaining`);
            this.lastScanAt = new Date().toISOString();
            return;
        }

        // 5. Scan
        console.log('[HUNTRIX] Scanning for manipulation campaigns...');
        const watchlist = this.positions.map(p => p.symbol.split('/')[0]);
        const signals = await this.scanner.fullScan(watchlist);

        // 5b. Order book spoofing scan (uses CCXT exchange instance)
        if (this.config.scanner.sources.orderbook_spoof_enabled) {
            const spoofSymbols = this.positions.map(p => p.symbol);
            for (const [exId, exchange] of this.exchangeManager.getAllExchanges()) {
                const spoofSignals = await this.scanner.scanOrderBook(exchange, spoofSymbols, exId);
                signals.push(...spoofSignals);
            }
        }

        this.activeSignals = signals;

        // Persist all signals to Postgres for future backtesting
        await this.persistSignals(signals);

        // Write blacklist keys so auto-trade pipeline blocks flagged tokens
        await this.writeBlacklistKeys(signals);

        // Start tracking detected pumps for profiling
        for (const signal of signals) {
            this.pumpProfiler.startTracking(signal);
        }
        await this.pumpProfiler.checkTimeouts();
        this.lastScanAt = new Date().toISOString();

        // 5c. Check for new blacklist entries and alert
        try {
            const recentBlacklist = await this.redis.get('huntrix:blacklist:recent');
            if (recentBlacklist) {
                const entries: Array<{ symbol: string; reason: string }> = JSON.parse(recentBlacklist);
                if (entries.length > 0 && this.config.telegram.alert_on_detection) {
                    const lines = entries.slice(0, 5).map(e => `• ${e.symbol}: ${e.reason}`).join('\n');
                    await this.sendTelegramAlert(
                        `<b>🛡 HUNTRIX BLACKLIST</b>\n${entries.length} symbol(s) blocked:\n${lines}`,
                    );
                }
                await this.redis.del('huntrix:blacklist:recent');
            }
        } catch { /* best effort */ }

        if (signals.length === 0) {
            await this.saveState();
            return;
        }

        console.log(`[HUNTRIX] ${signals.length} manipulation campaign(s) detected!`);

        if (this.config.telegram.alert_on_detection) {
            for (const sig of signals.slice(0, 3)) {
                await this.sendTelegramAlert(
                    `<b>HUNTRIX DETECTION</b> ${sig.symbol}\n` +
                    `Type: ${sig.type} | Phase: ${sig.phase}\n` +
                    `Confidence: ${sig.confidence}% | Shills: ${sig.total_shill_accounts}\n` +
                    `Source: ${sig.source}`,
                );
            }
        }

        // 6. Validate and enter
        for (const signal of signals) {
            if (this.positions.length >= this.config.limits.max_open_positions) break;
            if (this.tradesToday >= this.config.limits.max_trades_per_day) break;
            if (this.positions.some(p => p.symbol === signal.symbol)) continue;

            // Only trade P&D and coordinated shill (spec says whale/fake_news not tradeable)
            if (signal.type !== 'pump_and_dump' && signal.type !== 'coordinated_shill') {
                console.log(`[HUNTRIX] Skipping ${signal.symbol} — type ${signal.type} not tradeable`);
                continue;
            }

            const validation = await this.validator.validate(signal);
            if (!validation.approved) continue;

            await this.enterPosition(validation.signal, validation.live_price);
        }

        await this.saveState();
    }

    // ─── Position Management ─────────────────────────────────────

    private async enterPosition(signal: ManipulationSignal, price: number): Promise<void> {
        // Find best exchange for this trade first (price may differ)
        let targetExchangeId = signal.exchange;
        let targetExchange: any;

        const best = await this.exchangeManager.getBestExchange(signal.symbol);
        if (best) {
            targetExchangeId = best.id;
            targetExchange = best.exchange;
            // Use the routed exchange's price for accurate sizing
            try {
                const ticker = await targetExchange.fetchTicker(signal.symbol);
                if (ticker?.last) price = ticker.last;
            } catch { /* fallback to original price */ }
        } else {
            targetExchange = this.exchangeManager.getExchange(targetExchangeId);
            if (!targetExchange) {
                // No CEX exchange → relay to Solanix for DEX execution
                console.log(`[HUNTRIX] No CEX exchange for ${signal.symbol} — relaying to Solanix`);
                await this.relayToSolanix(signal);
                return;
            }
        }

        const positionSize = Math.min(
            this.config.capital.max_position_size_usd,
            this.virtualBalance * 0.25,
        );

        if (positionSize < 5) {
            console.log(`[HUNTRIX] Position size $${positionSize.toFixed(2)} too small — skipping`);
            return;
        }

        const quantity = positionSize / price;

        if (this.config.general.mode !== 'paper') {
            try {
                const order = await targetExchange.createMarketBuyOrder(signal.symbol, quantity);
                price = order.average || price;
                console.log(`[HUNTRIX] LIVE BUY ${signal.symbol} on ${targetExchangeId} — $${positionSize.toFixed(2)} @ $${price}`);
            } catch (err) {
                console.error(`[HUNTRIX] BUY failed for ${signal.symbol} on ${targetExchangeId}:`, err instanceof Error ? err.message : err);
                return;
            }
        } else {
            console.log(`[HUNTRIX] PAPER BUY ${signal.symbol} on ${targetExchangeId} — $${positionSize.toFixed(2)} @ $${price.toFixed(6)} (${signal.type}, conf: ${signal.confidence}%)`);
        }

        const position: HunterPosition = {
            id: `htx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            symbol: signal.symbol,
            exchange: targetExchangeId,
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

        // Persist trade to Postgres
        if (this.pg) {
            await this.pg.query(
                `INSERT INTO huntrix_trades (symbol, side, entry_price, size, entry_reason, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [signal.symbol, 'BUY', price, quantity, `${signal.type}:${signal.phase}`, JSON.stringify({
                    confidence: signal.confidence,
                    exchange: targetExchangeId,
                    source: signal.source,
                    position_id: position.id,
                })]
            ).catch(e => console.warn('[huntrix-db]', e.message));
        }

        if (this.config.telegram.alert_on_entry) {
            await this.sendTelegramAlert(
                `<b>HUNTRIX ENTRY</b> ${signal.symbol}\n` +
                `Type: ${signal.type} | Phase: ${signal.phase}\n` +
                `Size: $${positionSize.toFixed(2)} | Price: ${price}\n` +
                `Confidence: ${signal.confidence}%`,
            );
        }

        await this.persistPositions();
    }

    private async monitorPositions(): Promise<void> {
        const toClose: Array<{ position: HunterPosition; reason: ExitReason }> = [];

        for (const position of this.positions) {
            try {
                const exchangeId = position.exchange ?? 'binance';
                const ex = this.exchangeManager.getExchange(exchangeId);
                if (!ex) continue;
                const ticker = await ex.fetchTicker(position.symbol).catch(() => null);
                let currentPrice = ticker?.last ?? ticker?.close ?? 0;

                // DexScreener fallback for DEX tokens not listed on CEX
                if (currentPrice <= 0 && (position.signal as any)?.tokenAddress) {
                    currentPrice = await this.fetchDexScreenerPrice((position.signal as any).tokenAddress);
                }
                if (currentPrice <= 0) continue;

                position.current_price = currentPrice;
                position.unrealized_pnl = (currentPrice - position.entry_price) * position.quantity;
                position.unrealized_pnl_pct = ((currentPrice - position.entry_price) / position.entry_price) * 100;

                position.price_history.push({
                    price: currentPrice,
                    timestamp: Date.now(),
                    volume: ticker.quoteVolume || 0,
                });

                // Update pump profiler with current price
                this.pumpProfiler.updatePrice(position.signal.id, currentPrice);

                if (position.price_history.length > 120) {
                    position.price_history = position.price_history.slice(-120);
                }

                this.dumpDetector.updateTrailing(position);

                const exitSignal = this.dumpDetector.check(position);
                if (exitSignal) {
                    toClose.push({ position, reason: exitSignal.reason });
                    console.log(`[HUNTRIX] EXIT SIGNAL: ${position.symbol} — ${exitSignal.reason}: ${exitSignal.details}`);
                }
            } catch (err) {
                console.warn(`[HUNTRIX] Monitor failed for ${position.symbol}:`, err instanceof Error ? err.message : err);
            }
        }

        for (const { position, reason } of toClose) {
            await this.closePosition(position, reason);
        }
    }

    /**
     * Fetch price from DexScreener for DEX tokens not on CEX.
     * Uses Solana chain by default (most pump tokens are Solana).
     */
    private async fetchDexScreenerPrice(tokenAddress: string): Promise<number> {
        try {
            const url = `https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
            if (!res.ok) return 0;
            const pairs = await res.json() as Array<{
                baseToken: { address: string };
                priceUsd: string;
                chainId: string;
                liquidity?: { usd: number };
            }>;
            if (!Array.isArray(pairs) || pairs.length === 0) return 0;

            // Pick highest-liquidity pair
            const best = pairs
                .filter(p => p.chainId === 'solana')
                .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
            return best ? parseFloat(best.priceUsd) || 0 : 0;
        } catch {
            return 0;
        }
    }

    /**
     * Relay a pump signal to Solanix via Redis for DEX execution.
     * Called when Huntrix detects a pump on a token not tradeable on CEX.
     */
    private async relayToSolanix(signal: any): Promise<void> {
        try {
            const relayData = {
                symbol: signal.symbol || signal.token,
                tokenAddress: signal.tokenAddress || signal.mint,
                action: 'BUY',
                confidence: signal.coordinationScore || signal.score || 50,
                source: 'huntrix_pump',
                detectedAt: Date.now(),
                maxHoldMinutes: 30,
                reason: `Pump detected: ${signal.type || 'coordination'} (score ${signal.coordinationScore || 0})`,
            };

            await this.redis.set('huntrix:trade_signal', JSON.stringify(relayData), 'EX', 300);
            console.log(`[HUNTRIX] Relayed pump signal to Solanix: ${relayData.symbol} (conf=${relayData.confidence})`);
        } catch (err) {
            console.warn('[HUNTRIX] Failed to relay signal to Solanix:', err);
        }
    }

    private async closePosition(position: HunterPosition, reason: ExitReason): Promise<void> {
        const currentPrice = position.current_price;

        if (this.config.general.mode !== 'paper' && reason !== 'manual') {
            try {
                const sellExId = position.exchange ?? 'binance';
                const ex = this.exchangeManager.getExchange(sellExId);
                if (!ex) throw new Error(`Exchange ${sellExId} not available`);
                await ex.createMarketSellOrder(position.symbol, position.quantity);
            } catch (err) {
                console.error(`[HUNTRIX] SELL failed for ${position.symbol}:`, err instanceof Error ? err.message : err);
                return;
            }
        }

        const pnl = (currentPrice - position.entry_price) * position.quantity;
        const pnlPct = ((currentPrice - position.entry_price) / position.entry_price) * 100;

        position.exit_reason = reason;
        position.exit_price = currentPrice;
        position.exited_at = new Date().toISOString();
        position.unrealized_pnl = pnl;
        position.unrealized_pnl_pct = pnlPct;

        this.virtualBalance += position.size_usd + pnl;
        this.dailyPnl += pnl;
        this.totalTrades++;

        if (pnl < 0) {
            this.consecutiveLosses++;
            if (this.consecutiveLosses >= this.config.risk.max_consecutive_losses) {
                this.cooldownUntil = Date.now() + this.config.risk.consecutive_loss_cooldown_minutes * 60_000;
                console.log(`[HUNTRIX] ${this.consecutiveLosses} consecutive losses — cooldown for ${this.config.risk.consecutive_loss_cooldown_minutes} min`);

                if (this.config.telegram.alert_on_circuit_breaker) {
                    await this.sendTelegramAlert(
                        `<b>HUNTRIX CIRCUIT BREAKER</b>\n` +
                        `${this.consecutiveLosses} consecutive losses\n` +
                        `Cooldown: ${this.config.risk.consecutive_loss_cooldown_minutes} min`,
                    );
                }
            }
        } else {
            this.consecutiveLosses = 0;
            this.totalWins++;
        }

        // Record recent exit for "no recent exit" guard
        try {
            const baseSymbol = position.symbol.split('/')[0];
            await this.redis.zadd('huntrix:exits:recent', Date.now(), `${baseSymbol}:${Date.now()}`);
            // Self-clean entries older than 30min
            await this.redis.zremrangebyscore('huntrix:exits:recent', 0, Date.now() - 30 * 60 * 1000);
        } catch { /* non-critical */ }

        this.positions = this.positions.filter(p => p.id !== position.id);
        this.recentTrades.push(position);
        if (this.recentTrades.length > 50) this.recentTrades = this.recentTrades.slice(-50);

        this.dumpDetector.cleanup(position.id);

        // Finalize pump profile with trade result
        await this.pumpProfiler.finalize(position.signal.id, true, pnlPct);

        // Persist exit to Postgres
        if (this.pg) {
            await this.pg.query(
                `UPDATE huntrix_trades SET exit_price=$1, pnl=$2, exit_reason=$3, status='closed', exited_at=NOW()
                 WHERE symbol=$4 AND status='open' ORDER BY entered_at DESC LIMIT 1`,
                [currentPrice, pnl, reason, position.symbol]
            ).catch(e => console.warn('[huntrix-db]', e.message));
        }

        const emoji = pnl >= 0 ? '+' : '';
        const mode = this.config.general.mode === 'paper' ? 'PAPER' : 'LIVE';
        console.log(`[HUNTRIX] [${mode}] CLOSED ${position.symbol} — ${reason} — PnL: ${emoji}$${pnl.toFixed(2)} (${emoji}${pnlPct.toFixed(2)}%)`);
        console.log(`[HUNTRIX] Balance: $${this.virtualBalance.toFixed(2)} | Daily P&L: $${this.dailyPnl.toFixed(2)}`);

        if (this.config.telegram.alert_on_exit) {
            const icon = pnl >= 0 ? '✅' : '❌';
            await this.sendTelegramAlert(
                `${icon} <b>HUNTRIX EXIT</b> ${position.symbol}\n` +
                `Reason: ${reason}\n` +
                `PnL: ${emoji}$${pnl.toFixed(2)} (${emoji}${pnlPct.toFixed(2)}%)\n` +
                `Balance: $${this.virtualBalance.toFixed(2)}`,
            );
        }

        // Win rate review circuit breaker
        if (this.totalTrades >= this.config.risk.review_threshold_trades) {
            const winRate = (this.totalWins / this.totalTrades) * 100;
            if (winRate < this.config.risk.review_min_win_rate) {
                console.log(`[HUNTRIX] Win rate ${winRate.toFixed(1)}% < ${this.config.risk.review_min_win_rate}% after ${this.totalTrades} trades — PAUSED for review`);
                this.running = false;
                if (this.config.telegram.alert_on_circuit_breaker) {
                    await this.sendTelegramAlert(
                        `<b>HUNTRIX REVIEW REQUIRED</b>\n` +
                        `Win rate ${winRate.toFixed(1)}% after ${this.totalTrades} trades\n` +
                        `Trading paused — manual review needed`,
                    );
                }
            }
        }

        await this.saveState();
    }

    // ─── Circuit Breakers ────────────────────────────────────────

    private isCircuitBroken(): boolean {
        const dailyLossLimit = this.config.capital.virtual_balance * (this.config.risk.max_daily_loss_pct / 100);
        if (this.dailyPnl < -dailyLossLimit) {
            console.log(`[HUNTRIX] Daily loss circuit breaker: $${this.dailyPnl.toFixed(2)} < -$${dailyLossLimit.toFixed(2)}`);
            return true;
        }

        if (this.consecutiveLosses >= this.config.risk.max_consecutive_losses && Date.now() < this.cooldownUntil) {
            return true;
        }

        return false;
    }

    private checkDailyReset(): void {
        const today = new Date().toISOString().split('T')[0];
        if (this.lastDailyReset !== today) {
            if (this.lastDailyReset && (this.tradesToday > 0 || this.dailyPnl !== 0)) {
                console.log(`[HUNTRIX] Daily reset — Trades: ${this.tradesToday}, P&L: $${this.dailyPnl.toFixed(2)}`);
            }
            this.tradesToday = 0;
            this.dailyPnl = 0;
            this.lastDailyReset = today;
        }
    }

    // ─── State Persistence ───────────────────────────────────────

    private async saveState(): Promise<void> {
        const closedWins = this.recentTrades.filter(t => (t.unrealized_pnl || 0) > 0).length;
        const totalClosed = this.recentTrades.length;

        const state: HuntrixState = {
            status: !this.running ? 'stopped' :
                    this.positions.length > 0 ? 'in_position' :
                    Date.now() < this.cooldownUntil ? 'cooldown' : 'scanning',
            positions: this.positions,
            recent_trades: this.recentTrades.slice(-10),
            active_signals: this.activeSignals,
            daily_pnl: this.dailyPnl,
            trades_today: this.tradesToday,
            win_rate: totalClosed > 0 ? (closedWins / totalClosed) * 100 : 0,
            paper_mode: this.config.general.mode === 'paper',
            virtual_balance: this.virtualBalance,
            last_scan_at: this.lastScanAt,
            consecutive_losses: this.consecutiveLosses,
            updated_at: new Date().toISOString(),
        };

        try {
            await Promise.all([
                this.redis.setex('huntrix:state', 3600, JSON.stringify(state)),
                this.redis.setex('huntrix:risk', 3600, JSON.stringify({
                    dailyPnl: this.dailyPnl,
                    consecutiveLosses: this.consecutiveLosses,
                    cooldownUntil: this.cooldownUntil,
                    totalTrades: this.totalTrades,
                    totalWins: this.totalWins,
                    virtualBalance: this.virtualBalance,
                })),
            ]);
        } catch (err) {
            console.error('[HUNTRIX] Failed to save state:', err instanceof Error ? err.message : err);
        }
    }

    /**
     * Write huntrix:blacklist:{SYMBOL} keys for each confirmed manipulation signal.
     * Auto-trade pipeline reads these keys to block flagged tokens.
     * TTL: 1 hour — tokens auto-unblock if not re-detected.
     */
    private async writeBlacklistKeys(signals: ManipulationSignal[]): Promise<void> {
        if (signals.length === 0) return;

        const BLACKLIST_TTL = 3600; // 1 hour
        const pipeline = this.redis.pipeline();
        const entries: Array<{ symbol: string; reason: string }> = [];

        for (const signal of signals) {
            const key = `huntrix:blacklist:${signal.symbol}`;
            const reason = `${signal.type} detected: ${signal.total_shill_accounts} shill accounts, ${signal.confidence}% confidence (${signal.source})`;
            const value = JSON.stringify({
                reason,
                type: signal.type,
                source: signal.source,
                confidence: signal.confidence,
                phase: signal.phase,
                added_at: new Date().toISOString(),
            });
            pipeline.setex(key, BLACKLIST_TTL, value);
            entries.push({ symbol: signal.symbol, reason });
            console.log(`[HUNTRIX] Blacklisted ${signal.symbol} — ${signal.type} (${signal.confidence}% conf, TTL ${BLACKLIST_TTL}s)`);
        }

        // Also write recent blacklist summary for Telegram alert in tick()
        if (entries.length > 0) {
            pipeline.setex('huntrix:blacklist:recent', 3600, JSON.stringify(entries));
        }

        try {
            await pipeline.exec();
        } catch (err) {
            console.error('[HUNTRIX] Failed to write blacklist keys:', err instanceof Error ? err.message : err);
        }
    }

    private async persistPositions(): Promise<void> {
        try {
            await this.redis.setex('huntrix:positions', 3600, JSON.stringify(this.positions));
        } catch { /* non-critical */ }
    }

    private async loadState(): Promise<void> {
        try {
            const [stateRaw, riskRaw] = await Promise.all([
                this.redis.get('huntrix:state'),
                this.redis.get('huntrix:risk'),
            ]);

            if (stateRaw) {
                const state: HuntrixState = JSON.parse(stateRaw);
                this.virtualBalance = state.virtual_balance ?? this.config.capital.virtual_balance;
                this.dailyPnl = state.daily_pnl ?? 0;
                this.tradesToday = state.trades_today ?? 0;
                this.consecutiveLosses = state.consecutive_losses ?? 0;
                this.recentTrades = state.recent_trades ?? [];
                this.lastScanAt = state.last_scan_at ?? null;
                console.log(`[HUNTRIX] State loaded — Balance: $${this.virtualBalance.toFixed(2)}, Daily P&L: $${this.dailyPnl.toFixed(2)}`);
            }

            if (riskRaw) {
                const risk = JSON.parse(riskRaw);
                this.totalTrades = risk.totalTrades ?? 0;
                this.totalWins = risk.totalWins ?? 0;
                this.cooldownUntil = risk.cooldownUntil ?? 0;
            }
        } catch (err) {
            console.warn('[HUNTRIX] Could not restore state — starting fresh:', err instanceof Error ? err.message : err);
        }
    }

    // ─── Telegram ────────────────────────────────────────────────

    private async sendTelegramAlert(message: string): Promise<void> {
        const token = process.env.TELEGRAM_INTERACTIVE_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!this.config.telegram.enabled || !token || !chatId) return;
        try {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
            });
        } catch (err) {
            console.warn('[HUNTRIX] Telegram alert failed:', err instanceof Error ? err.message : err);
        }
    }

    // ─── Signal Persistence ──────────────────────────────────────

    private async persistSignals(signals: ManipulationSignal[]): Promise<void> {
        if (!this.pg || signals.length === 0) return;
        for (const sig of signals) {
            try {
                await this.pg.query(
                    `INSERT INTO huntrix_signals
                     (signal_id, symbol, type, source, exchange, confidence, phase,
                      price_at_detection, volume_spike_ratio, price_velocity,
                      total_shill_accounts, estimated_peak_minutes, reasoning,
                      detected_at, metadata)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                    [
                        sig.id,
                        sig.symbol,
                        sig.type,
                        sig.source,
                        sig.exchange ?? null,
                        sig.confidence,
                        sig.phase,
                        sig.price_at_detection,
                        sig.volume_spike_ratio,
                        sig.price_velocity,
                        sig.total_shill_accounts,
                        sig.estimated_peak_minutes,
                        sig.reasoning,
                        sig.detected_at,
                        JSON.stringify({
                            shill_activity: sig.shill_activity,
                            volume_24h: sig.volume_24h,
                        }),
                    ],
                );
            } catch (err) {
                console.warn('[huntrix-db] Signal persist failed:', err instanceof Error ? err.message : err);
            }
        }
        console.log(`[HUNTRIX] Persisted ${signals.length} signal(s) to Postgres`);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
