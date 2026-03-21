import Redis from 'ioredis';
import { loadApexConfig, type ApexTomlConfig } from './config';
import { SignalAggregator, type AggregatorSnapshot } from './signal-aggregator';
import { scoreOpportunities, type ScoredOpportunity } from './confluence-scorer';
import { RiskGate, type RiskState } from './risk-gate';
import { ExitMonitor, type ApexPosition } from './exit-monitor';

// ---------------------------------------------------------------------------
// Grok response cache
// ---------------------------------------------------------------------------

interface GrokCacheEntry {
    approve: boolean;
    confidence: number;
    reason: string;
    cachedAt: number;
}

export class ApexAgent {
    private redis!: Redis;
    private config!: ApexTomlConfig;
    private aggregator!: SignalAggregator;
    private riskGate!: RiskGate;
    private exitMonitor!: ExitMonitor;
    private positions: ApexPosition[] = [];
    private running = false;
    private tradeCount = 0;
    private totalPnl = 0;
    private winCount = 0;

    private ccxt!: import('ccxt').binance;
    private xai: import('openai').default | null = null;

    // Grok caching + rate limiting
    private grokCache = new Map<string, GrokCacheEntry>();
    private grokCallTimestamps: number[] = [];

    constructor(private meta: { id: string; name: string }) {}

    // -------------------------------------------------------------------------
    // initialize
    // -------------------------------------------------------------------------

    async initialize(): Promise<void> {
        this.config = loadApexConfig();

        this.redis = new Redis(process.env.KV_URL ?? 'redis://localhost:6379');
        this.redis.on('error', (err: Error) => console.error('[APEX] Redis error:', err.message));

        // Aggregator now takes config for staleness + orakel settings
        this.aggregator = new SignalAggregator(this.redis, this.config);

        this.riskGate = new RiskGate(this.config);
        this.riskGate.setRedis(this.redis); // For Cryonix dedup checks

        // Restore risk state
        try {
            const storedRisk = await this.redis.get('apex:risk');
            if (storedRisk) {
                this.riskGate.loadState(JSON.parse(storedRisk) as RiskState);
                console.log('[APEX] Restored risk state from Redis.');
            }
        } catch (err) {
            console.warn('[APEX] Could not restore risk state:', err instanceof Error ? err.message : err);
        }

        this.exitMonitor = new ExitMonitor(this.config);

        // Restore positions
        try {
            const storedPositions = await this.redis.get('apex:positions');
            if (storedPositions) {
                this.positions = JSON.parse(storedPositions) as ApexPosition[];
                console.log(`[APEX] Restored ${this.positions.length} position(s) from Redis.`);
            }
        } catch (err) {
            console.warn('[APEX] Could not restore positions:', err instanceof Error ? err.message : err);
        }

        // Restore trade stats
        try {
            const storedStats = await this.redis.get('apex:stats');
            if (storedStats) {
                const stats = JSON.parse(storedStats) as { tradeCount: number; totalPnl: number; winCount: number };
                this.tradeCount = stats.tradeCount ?? 0;
                this.totalPnl = stats.totalPnl ?? 0;
                this.winCount = stats.winCount ?? 0;
                console.log(`[APEX] Restored stats — trades: ${this.tradeCount}, PnL: ${this.totalPnl.toFixed(2)}, wins: ${this.winCount}`);
            }
        } catch (err) {
            console.warn('[APEX] Could not restore stats:', err instanceof Error ? err.message : err);
        }

        // CCXT (price data only)
        const ccxtMod = await import('ccxt');
        this.ccxt = new ccxtMod.binance({ enableRateLimit: true });

        // Grok
        if (process.env.XAI_API_KEY && this.config.grok.enabled) {
            const OpenAI = (await import('openai')).default;
            this.xai = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' });
        } else {
            console.warn('[APEX] Grok disabled — all trades will be skipped (fail-closed).');
        }

        console.log(`[APEX] Initialized — ${this.meta.name} | mode: ${this.config.general.mode} | capital: $${this.config.general.capital} | scan: ${this.config.general.scan_interval_seconds}s`);
    }

    // -------------------------------------------------------------------------
    // start / stop
    // -------------------------------------------------------------------------

    async start(): Promise<void> {
        this.running = true;
        const intervalMs = this.config.general.scan_interval_seconds * 1_000;
        console.log(`[APEX] Scan loop starting (${this.config.general.scan_interval_seconds}s interval)...`);
        while (this.running) {
            try {
                await this.tick();
            } catch (err) {
                console.error('[APEX] tick error:', err);
            }
            await this.sleep(intervalMs);
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        try {
            const snapshot = await this.aggregator.snapshot();
            await this.publishState(snapshot);
        } catch (err) {
            console.warn('[APEX] Could not publish final state:', err instanceof Error ? err.message : err);
        }
        await this.redis?.quit();
        console.log('[APEX] Stopped.');
    }

    // -------------------------------------------------------------------------
    // tick — main scan cycle
    // -------------------------------------------------------------------------

    private async tick(): Promise<void> {
        await this.monitorPositions();
        const snapshot = await this.aggregator.snapshot();
        const opportunities = scoreOpportunities(snapshot, this.config);

        for (const opp of opportunities) {
            await this.evaluateAndExecute(opp);
        }

        await this.publishState(snapshot, opportunities);
    }

    // -------------------------------------------------------------------------
    // monitorPositions
    // -------------------------------------------------------------------------

    private async monitorPositions(): Promise<void> {
        if (this.positions.length === 0) return;

        const symbols = [...new Set(this.positions.map(p => p.symbol + '/USDC'))];
        const priceMap: Record<string, number> = {};

        await Promise.all(
            symbols.map(async (pair) => {
                try {
                    const ticker = await this.ccxt.fetchTicker(pair);
                    priceMap[pair.split('/')[0]] = ticker.last ?? ticker.close ?? 0;
                } catch (err) {
                    console.warn(`[APEX] fetchTicker failed for ${pair}:`, err instanceof Error ? err.message : err);
                }
            }),
        );

        const toClose: ApexPosition[] = [];

        for (const pos of this.positions) {
            const currentPrice = priceMap[pos.symbol];
            if (!currentPrice || currentPrice <= 0) continue;

            pos.currentPrice = currentPrice;
            const exitDecision = this.exitMonitor.evaluate(pos);

            if (!exitDecision.shouldExit) continue;

            const pnl = pos.direction === 'long'
                ? (pos.currentPrice - pos.entryPrice) * pos.quantity
                : (pos.entryPrice - pos.currentPrice) * pos.quantity;
            const entrySize = pos.entryPrice * pos.quantity;

            this.riskGate.recordExit(pnl, entrySize, exitDecision.pnlPct);

            this.tradeCount++;
            this.totalPnl += pnl;
            if (pnl > 0) this.winCount++;

            console.log(`[APEX] EXIT ${pos.symbol} ${pos.direction} — ${exitDecision.reason} — PnL: ${pnl.toFixed(2)} USDC (${exitDecision.pnlPct.toFixed(2)}%)`);

            if (this.config.telegram.alert_on_exit) {
                const emoji = pnl > 0 ? '✅' : '❌';
                await this.sendTelegramAlert(
                    `${emoji} <b>APEX EXIT</b> ${pos.symbol} ${pos.direction.toUpperCase()}\n` +
                    `Reason: ${exitDecision.reason}\nPnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC (${exitDecision.pnlPct >= 0 ? '+' : ''}${exitDecision.pnlPct.toFixed(2)}%)\n` +
                    `Mode: ${pos.mode} | Score: ${pos.confluenceScore}`,
                );
            }

            toClose.push(pos);
        }

        if (toClose.length > 0) {
            this.positions = this.positions.filter(p => !toClose.includes(p));
            await this.persistAll();
        }
    }

    // -------------------------------------------------------------------------
    // evaluateAndExecute
    // -------------------------------------------------------------------------

    private async evaluateAndExecute(opp: ScoredOpportunity): Promise<void> {
        // Already in position?
        if (this.positions.some(p => p.symbol === opp.symbol)) return;

        // Risk gate
        const canTrade = this.riskGate.canTrade();
        if (!canTrade.allowed) {
            console.log(`[APEX] RiskGate blocked ${opp.symbol}: ${canTrade.reason}`);
            return;
        }

        // Cryonix dedup — reduce sizing if Cryonix holds same symbol
        const dedupFactor = await this.riskGate.checkCryonixDedup(opp.symbol);

        // Compute size
        let size = this.riskGate.computeSize(opp.mode, opp.score);
        size *= dedupFactor;
        if (size <= 0) {
            console.log(`[APEX] Size=0 for ${opp.symbol} ${opp.mode}`);
            return;
        }

        // Mode enabled?
        if (!this.config.modes[opp.mode].enabled) {
            console.log(`[APEX] Mode '${opp.mode}' disabled — skipping ${opp.symbol}`);
            return;
        }

        // Venus Rx: only trade bearish
        if (opp.mode === 'venus_rx' && opp.direction !== 'bearish') return;

        // Grok validation (cached + rate-limited, fail-closed)
        const grokResult = await this.validateWithGrok(opp);
        if (!grokResult) return;

        // Fetch current price
        let currentPrice: number;
        try {
            const ticker = await this.ccxt.fetchTicker(`${opp.symbol}/USDC`);
            currentPrice = ticker.last ?? ticker.close ?? 0;
            if (currentPrice <= 0) {
                console.warn(`[APEX] Invalid price for ${opp.symbol}/USDC`);
                return;
            }
        } catch (err) {
            console.warn(`[APEX] Price fetch failed for ${opp.symbol}:`, err instanceof Error ? err.message : err);
            return;
        }

        const quantity = size / currentPrice;
        const direction = opp.direction === 'bullish' ? 'long' as const : 'short' as const;

        // Live mode: spot-only, no shorts
        if (direction === 'short' && this.config.general.mode === 'live') {
            console.log(`[APEX] Skipping short ${opp.symbol} — spot-only in live mode`);
            return;
        }

        const position: ApexPosition = {
            id: `apex-${opp.symbol}-${Date.now()}`,
            symbol: opp.symbol,
            direction,
            mode: opp.mode,
            entryPrice: currentPrice,
            currentPrice,
            quantity,
            entryTime: Date.now(),
            highWatermark: currentPrice,
            trailingActive: false,
            confluenceScore: opp.score,
            contributingSignals: opp.contributingSignals.map(s => s.source),
        };

        this.riskGate.recordEntry(size);
        this.positions.push(position);
        await this.persistAll();

        console.log(`[APEX] ENTRY ${opp.symbol} ${opp.direction} ${opp.mode} — score: ${opp.score} — size: $${size.toFixed(2)} — price: ${currentPrice}`);

        if (this.config.telegram.alert_on_entry) {
            await this.sendTelegramAlert(
                `🚀 <b>APEX ENTRY</b> ${opp.symbol} ${opp.direction.toUpperCase()}\n` +
                `Mode: ${opp.mode} | Score: ${opp.score}\n` +
                `Size: $${size.toFixed(2)} | Price: ${currentPrice}\n` +
                `Signals: ${opp.contributingSignals.map(s => `${s.source}:${s.signalType}`).join(', ')}` +
                (dedupFactor < 1 ? `\n⚠️ Cryonix dedup: sizing reduced 50%` : ''),
            );
        }
    }

    // -------------------------------------------------------------------------
    // validateWithGrok — cached + rate-limited
    // -------------------------------------------------------------------------

    private async validateWithGrok(opp: ScoredOpportunity): Promise<boolean> {
        if (!this.xai || !this.config.grok.enabled) return false;

        const cacheKey = `${opp.symbol}:${opp.direction}`;
        const cacheTtlMs = this.config.grok.cache_ttl_seconds * 1000;
        const now = Date.now();

        // Check cache
        const cached = this.grokCache.get(cacheKey);
        if (cached && (now - cached.cachedAt) < cacheTtlMs) {
            console.log(`[APEX] Grok cache hit: ${cacheKey} → approve=${cached.approve} confidence=${cached.confidence}`);
            return cached.approve && cached.confidence >= 60;
        }

        // Rate limit: max N calls per minute (sliding window)
        const maxCalls = this.config.grok.max_calls_per_minute;
        this.grokCallTimestamps = this.grokCallTimestamps.filter(t => now - t < 60_000);
        if (this.grokCallTimestamps.length >= maxCalls) {
            console.log(`[APEX] Grok rate limit hit (${maxCalls}/min) — skipping ${opp.symbol}`);
            return false;
        }

        try {
            this.grokCallTimestamps.push(now);
            const validation = await this.xai.chat.completions.create({
                model: this.config.grok.model,
                messages: [{
                    role: 'user',
                    content:
                        `You are a meta-intelligence analyst. APEX has detected confluence across ` +
                        `${opp.contributingSignals.length} independent trading systems for ${opp.symbol} (${opp.direction}).\n` +
                        `Contributing signals: ${opp.contributingSignals.map(s => `${s.source}:${s.signalType}`).join(', ')}\n` +
                        `Confluence score: ${opp.score}/100\n\n` +
                        `Evaluate if this multi-system agreement represents a genuine opportunity ` +
                        `or if the signals are correlated (same underlying cause, not independent).\n` +
                        `Reply JSON: {"approve": true/false, "confidence": 0-100, "reason": "..."}`,
                }],
            });

            const raw = validation.choices[0]?.message?.content ?? '';
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.warn(`[APEX] Grok unparseable response for ${opp.symbol} — skip (fail-closed)`);
                return false;
            }

            const parsed = JSON.parse(jsonMatch[0]) as { approve: boolean; confidence: number; reason: string };

            // Cache the result
            this.grokCache.set(cacheKey, {
                approve: parsed.approve,
                confidence: parsed.confidence ?? 0,
                reason: parsed.reason ?? '',
                cachedAt: now,
            });

            if (!parsed.approve || (parsed.confidence ?? 0) < 60) {
                console.log(`[APEX] Grok rejected ${opp.symbol}: approve=${parsed.approve} confidence=${parsed.confidence} — ${parsed.reason}`);
                return false;
            }

            console.log(`[APEX] Grok approved ${opp.symbol} confidence=${parsed.confidence} — ${parsed.reason}`);
            return true;
        } catch (err) {
            console.warn(`[APEX] Grok error for ${opp.symbol} — skip (fail-closed):`, err instanceof Error ? err.message : err);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // publishState
    // -------------------------------------------------------------------------

    private async publishState(snapshot: AggregatorSnapshot, scored?: ScoredOpportunity[]): Promise<void> {
        const riskState = this.riskGate.getState();
        const opportunities = scored ?? scoreOpportunities(snapshot, this.config);

        const state = {
            status: this.running ? 'running' : 'stopped',
            mode: this.config.general.mode,
            capital: {
                total: riskState.currentCapital,
                deployed: riskState.deployedCapital,
                available: riskState.currentCapital - riskState.deployedCapital,
                reserve: riskState.currentCapital * (this.config.risk.cash_reserve_pct / 100),
            },
            positions: this.positions,
            confluenceBoard: opportunities.map(o => ({
                symbol: o.symbol,
                score: o.score,
                direction: o.direction,
                mode: o.mode,
                signals: o.contributingSignals.map(s => s.source),
            })),
            performance: {
                totalPnl: this.totalPnl,
                winRate: this.tradeCount > 0 ? Math.round((this.winCount / this.tradeCount) * 100) : 0,
                trades: this.tradeCount,
                maxDrawdown: riskState.peakCapital - riskState.currentCapital,
            },
            staleness: snapshot.staleness,
            timestamp: Date.now(),
            lastScan: new Date().toISOString(),
        };

        await this.redis.set('apex:state', JSON.stringify(state), 'EX', 120);
        await this.persistAll();
    }

    // -------------------------------------------------------------------------
    // persistAll
    // -------------------------------------------------------------------------

    private async persistAll(): Promise<void> {
        await Promise.all([
            this.redis.set('apex:risk', JSON.stringify(this.riskGate.getState())),
            this.redis.set('apex:positions', JSON.stringify(this.positions)),
            this.redis.set('apex:stats', JSON.stringify({
                tradeCount: this.tradeCount,
                totalPnl: this.totalPnl,
                winCount: this.winCount,
            })),
        ]);
    }

    // -------------------------------------------------------------------------
    // sendTelegramAlert
    // -------------------------------------------------------------------------

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
            console.warn('[APEX] Telegram alert failed:', err instanceof Error ? err.message : err);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
