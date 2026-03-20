import Redis from 'ioredis';
import { loadApexConfig, type ApexTomlConfig } from './config';
import { SignalAggregator, type AggregatorSnapshot } from './signal-aggregator';
import { scoreOpportunities, type ScoredOpportunity } from './confluence-scorer';
import { RiskGate, type RiskState } from './risk-gate';
import { ExitMonitor, type ApexPosition } from './exit-monitor';

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

    // Reusable instances — created once in initialize()
    private ccxt!: import('ccxt').binance;
    private xai: import('openai').default | null = null;

    constructor(private meta: { id: string; name: string }) {}

    // -------------------------------------------------------------------------
    // initialize
    // -------------------------------------------------------------------------

    async initialize(): Promise<void> {
        // Load config
        this.config = loadApexConfig();

        // Connect Redis
        this.redis = new Redis(process.env.KV_URL ?? 'redis://localhost:6379');
        this.redis.on('error', (err: Error) => console.error('[APEX] Redis error:', err.message));

        // Signal aggregator
        this.aggregator = new SignalAggregator(this.redis);

        // Risk gate (constructor sets defaults)
        this.riskGate = new RiskGate(this.config);

        // Restore risk state from Redis
        try {
            const storedRisk = await this.redis.get('apex:risk');
            if (storedRisk) {
                const parsed = JSON.parse(storedRisk) as RiskState;
                this.riskGate.loadState(parsed);
                console.log('[APEX] Restored risk state from Redis.');
            }
        } catch (err) {
            console.warn('[APEX] Could not restore risk state:', err instanceof Error ? err.message : err);
        }

        // Exit monitor
        this.exitMonitor = new ExitMonitor(this.config);

        // Restore positions from Redis
        try {
            const storedPositions = await this.redis.get('apex:positions');
            if (storedPositions) {
                this.positions = JSON.parse(storedPositions) as ApexPosition[];
                console.log(`[APEX] Restored ${this.positions.length} position(s) from Redis.`);
            }
        } catch (err) {
            console.warn('[APEX] Could not restore positions:', err instanceof Error ? err.message : err);
        }

        // Restore trade stats from Redis
        try {
            const storedStats = await this.redis.get('apex:stats');
            if (storedStats) {
                const stats = JSON.parse(storedStats) as { tradeCount: number; totalPnl: number; winCount: number };
                this.tradeCount = stats.tradeCount ?? 0;
                this.totalPnl   = stats.totalPnl   ?? 0;
                this.winCount   = stats.winCount    ?? 0;
                console.log(`[APEX] Restored stats — trades: ${this.tradeCount}, PnL: ${this.totalPnl.toFixed(2)} USDC, wins: ${this.winCount}`);
            }
        } catch (err) {
            console.warn('[APEX] Could not restore stats:', err instanceof Error ? err.message : err);
        }

        // CCXT Binance instance (paper trading — price fetching only)
        const ccxtMod = await import('ccxt');
        this.ccxt = new ccxtMod.binance({ enableRateLimit: true });

        // xAI / Grok instance (optional — skip if key not set)
        if (process.env.XAI_API_KEY) {
            const OpenAI = (await import('openai')).default;
            this.xai = new OpenAI({
                apiKey: process.env.XAI_API_KEY,
                baseURL: 'https://api.x.ai/v1',
            });
        } else {
            console.warn('[APEX] XAI_API_KEY not set — Grok validation disabled (all trades skipped).');
        }

        console.log(
            `[APEX] Initialized — ${this.meta.name} (${this.meta.id}) | mode: ${this.config.general.mode} | capital: $${this.config.general.capital}`,
        );
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
            console.warn('[APEX] Could not publish final state on stop:', err instanceof Error ? err.message : err);
        }
        await this.redis?.quit();
        console.log('[APEX] Stopped.');
    }

    // -------------------------------------------------------------------------
    // tick — main scan cycle
    // -------------------------------------------------------------------------

    private async tick(): Promise<void> {
        // 1. Monitor open positions for exits
        await this.monitorPositions();

        // 2. Snapshot all signals from every instance
        const snapshot = await this.aggregator.snapshot();

        // 3. Score opportunities (reused in publishState to avoid double-scoring)
        const opportunities = scoreOpportunities(snapshot, this.config);

        // 4. Evaluate each opportunity (highest score first)
        for (const opp of opportunities) {
            await this.evaluateAndExecute(opp);
        }

        // 5. Publish state to Redis
        await this.publishState(snapshot, opportunities);
    }

    // -------------------------------------------------------------------------
    // monitorPositions — check exits for all open positions
    // -------------------------------------------------------------------------

    private async monitorPositions(): Promise<void> {
        if (this.positions.length === 0) return;

        // Batch-fetch all unique symbols
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

            // Compute PnL in USDC
            const pnl = pos.direction === 'long'
                ? (pos.currentPrice - pos.entryPrice) * pos.quantity
                : (pos.entryPrice - pos.currentPrice) * pos.quantity;

            const entrySize = pos.entryPrice * pos.quantity;

            this.riskGate.recordExit(pnl, entrySize);

            // Update stats
            this.tradeCount++;
            this.totalPnl += pnl;
            if (pnl > 0) this.winCount++;

            const emoji = pnl > 0 ? '✅' : '❌';
            console.log(
                `[APEX] EXIT ${pos.symbol} ${pos.direction} — ${exitDecision.reason} — PnL: ${pnl.toFixed(2)} USDC (${exitDecision.pnlPct.toFixed(2)}%)`,
            );

            if (this.config.telegram.alert_on_exit) {
                await this.sendTelegramAlert(
                    `${emoji} <b>APEX EXIT</b> ${pos.symbol} ${pos.direction.toUpperCase()}\n` +
                    `Reason: ${exitDecision.reason}\n` +
                    `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC (${exitDecision.pnlPct >= 0 ? '+' : ''}${exitDecision.pnlPct.toFixed(2)}%)\n` +
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
    // evaluateAndExecute — evaluate a single opportunity and open a position
    // -------------------------------------------------------------------------

    private async evaluateAndExecute(opp: ScoredOpportunity): Promise<void> {
        // 1. Already in position for this symbol?
        if (this.positions.some(p => p.symbol === opp.symbol)) {
            return;
        }

        // 2. Risk gate check
        const canTrade = this.riskGate.canTrade();
        if (!canTrade.allowed) {
            console.log(`[APEX] RiskGate blocked ${opp.symbol}: ${canTrade.reason}`);
            return;
        }

        // 3. Compute size
        const size = this.riskGate.computeSize(opp.mode, opp.score);
        if (size <= 0) {
            console.log(`[APEX] Size=0 for ${opp.symbol} ${opp.mode} — insufficient capital or reserve`);
            return;
        }

        // 4. Mode enabled?
        if (!this.config.modes[opp.mode].enabled) {
            console.log(`[APEX] Mode '${opp.mode}' is disabled — skipping ${opp.symbol}`);
            return;
        }

        // 5. Venus Rx mode: only trade bearish
        if (opp.mode === 'venus_rx' && opp.direction !== 'bearish') {
            return;
        }

        // 6. Grok AI validation (fail-closed)
        if (!this.xai) {
            // No xAI instance — skip trade (fail-closed)
            return;
        }

        try {
            const validation = await this.xai.chat.completions.create({
                model: 'grok-3-mini',
                messages: [
                    {
                        role: 'user',
                        content:
                            `APEX confluence validation: ${opp.symbol} ${opp.direction} ` +
                            `score=${opp.score} mode=${opp.mode} ` +
                            `signals=[${opp.contributingSignals.map(s => `${s.source}:${s.signalType}`).join(', ')}]. ` +
                            `Should we trade? Reply JSON: {"approve": true/false, "confidence": 0-100, "reason": "..."}`,
                    },
                ],
            });

            const raw = validation.choices[0]?.message?.content ?? '';
            // Extract JSON from response (may have surrounding text)
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.warn(`[APEX] Grok returned unparseable response for ${opp.symbol} — skipping (fail-closed)`);
                return;
            }

            const parsed = JSON.parse(jsonMatch[0]) as { approve: boolean; confidence: number; reason: string };
            if (!parsed.approve || (parsed.confidence ?? 0) < 60) {
                console.log(
                    `[APEX] Grok rejected ${opp.symbol}: approve=${parsed.approve} confidence=${parsed.confidence} reason=${parsed.reason}`,
                );
                return;
            }

            console.log(
                `[APEX] Grok approved ${opp.symbol} confidence=${parsed.confidence} — ${parsed.reason}`,
            );
        } catch (err) {
            // Fail-closed: if Grok errors, skip the trade
            console.warn(`[APEX] Grok validation error for ${opp.symbol} — skipping (fail-closed):`, err instanceof Error ? err.message : err);
            return;
        }

        // 7. Fetch current price
        let currentPrice: number;
        try {
            const ticker = await this.ccxt.fetchTicker(`${opp.symbol}/USDC`);
            currentPrice = ticker.last ?? ticker.close ?? 0;
            if (currentPrice <= 0) {
                console.warn(`[APEX] Invalid price for ${opp.symbol}/USDC — skipping`);
                return;
            }
        } catch (err) {
            console.warn(`[APEX] Price fetch failed for ${opp.symbol}:`, err instanceof Error ? err.message : err);
            return;
        }

        // 8. Compute quantity
        const quantity = size / currentPrice;

        // 9. Create ApexPosition
        // Paper mode: shorts are simulated. In live mode, spot-only = long only.
        const direction = opp.direction === 'bullish' ? 'long' as const : 'short' as const;
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

        // 10. Record entry with risk gate
        this.riskGate.recordEntry(size);

        // 11. Add to positions
        this.positions.push(position);

        // 12. Persist
        await this.persistAll();

        // 13. Telegram alert
        console.log(
            `[APEX] ENTRY ${opp.symbol} ${opp.direction} ${opp.mode} — score: ${opp.score} — size: $${size.toFixed(2)} — price: ${currentPrice}`,
        );

        if (this.config.telegram.alert_on_entry) {
            await this.sendTelegramAlert(
                `🚀 <b>APEX ENTRY</b> ${opp.symbol} ${opp.direction.toUpperCase()}\n` +
                `Mode: ${opp.mode} | Score: ${opp.score}\n` +
                `Size: $${size.toFixed(2)} | Price: ${currentPrice}\n` +
                `Signals: ${opp.contributingSignals.map(s => `${s.source}:${s.signalType}`).join(', ')}`,
            );
        }
    }

    // -------------------------------------------------------------------------
    // publishState — write full APEX state to Redis
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
    // persistAll — persist risk, positions and stats to Redis (no TTL)
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
        const token  = process.env.TELEGRAM_INTERACTIVE_BOT_TOKEN;
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

    // -------------------------------------------------------------------------
    // sleep
    // -------------------------------------------------------------------------

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
