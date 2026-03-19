import type { StatePublisher } from '../aktienix/state-publisher';

/**
 * Reads Cryonix macro data from Redis and returns confidence adjustments
 * for Solanix signals. Leverages CMC Fear & Greed, BTC dominance,
 * market regime, and X sentiment alerts already written by the Python engine.
 */

export interface MacroAdjustment {
    /** Additive confidence delta (positive = boost, negative = penalty) */
    delta: number;
    /** Human-readable reasons for the adjustment */
    reasons: string[];
    /** Hard veto — reject the signal entirely */
    veto: boolean;
    vetoReason?: string;
}

export interface MacroFilterConfig {
    /** F&G <= this → boost deep-value / dip signals */
    fear_threshold: number;
    /** F&G >= this → penalize all BUY signals */
    greed_threshold: number;
    /** Confidence boost during extreme fear */
    fear_boost: number;
    /** Confidence penalty during extreme greed */
    greed_penalty: number;
    /** BTC dom 24h change % above this → penalize altcoins */
    btc_dom_rise_threshold: number;
    /** Confidence penalty when BTC dom rising */
    btc_dom_alt_penalty: number;
    /** Tighten stop loss multiplier during volatile regime (e.g. 0.7 = 70% of normal SL) */
    volatile_sl_multiplier: number;
}

export const MACRO_FILTER_DEFAULTS: MacroFilterConfig = {
    fear_threshold: 25,
    greed_threshold: 75,
    fear_boost: 0.08,
    greed_penalty: 0.10,
    btc_dom_rise_threshold: 2.0,
    btc_dom_alt_penalty: 0.05,
    volatile_sl_multiplier: 0.7,
};

export class MacroFilter {
    private readonly config: MacroFilterConfig;
    private readonly publisher: StatePublisher;
    private readonly log: (msg: string) => void;

    // Cache regime per loop (avoid repeated Redis reads)
    private cachedRegime: string | null = null;
    private cacheTs = 0;
    private readonly cacheTtlMs = 30_000;

    constructor(
        publisher: StatePublisher,
        config?: Partial<MacroFilterConfig>,
        logger?: (msg: string) => void,
    ) {
        this.publisher = publisher;
        this.config = { ...MACRO_FILTER_DEFAULTS, ...config };
        this.log = logger ?? (() => {});
    }

    /**
     * Evaluate macro conditions and return confidence adjustment for a signal.
     */
    async evaluate(symbol: string): Promise<MacroAdjustment> {
        const result: MacroAdjustment = { delta: 0, reasons: [], veto: false };

        // 1. X Sentiment alert — hard veto on hack/exploit
        try {
            const alertRaw = await this.publisher.get(`sentiment:alert:${symbol}`);
            if (alertRaw) {
                let alertText = alertRaw;
                try {
                    const parsed = JSON.parse(alertRaw);
                    alertText = parsed.reason ?? alertRaw;
                } catch {}

                const keywords = ['hack', 'exploit', 'rug', 'scam', 'fraud', 'delist', 'vulnerability', 'sec', 'lawsuit'];
                if (keywords.some(kw => alertText.toLowerCase().includes(kw))) {
                    result.veto = true;
                    result.vetoReason = `X alert: ${alertText}`;
                    return result;
                }
            }
        } catch {}

        // 2. Fear & Greed index
        try {
            const fgRaw = await this.publisher.get('cmc:fear_greed');
            if (fgRaw) {
                const fg = JSON.parse(fgRaw) as { value: number; label: string };
                if (fg.value <= this.config.fear_threshold) {
                    result.delta += this.config.fear_boost;
                    result.reasons.push(`F&G=${fg.value} (${fg.label}) dip boost +${(this.config.fear_boost * 100).toFixed(0)}%`);
                } else if (fg.value >= this.config.greed_threshold) {
                    result.delta -= this.config.greed_penalty;
                    result.reasons.push(`F&G=${fg.value} (${fg.label}) greed penalty -${(this.config.greed_penalty * 100).toFixed(0)}%`);
                }
            }
        } catch {}

        // 3. BTC dominance — penalize altcoins when BTC dom rising
        if (symbol !== 'BTC') {
            try {
                const globalRaw = await this.publisher.get('cmc:global');
                if (globalRaw) {
                    const global = JSON.parse(globalRaw) as { btc_dominance_24h_pct: number; btc_dominance: number };
                    const domChange = global.btc_dominance_24h_pct ?? 0;
                    if (domChange > this.config.btc_dom_rise_threshold) {
                        result.delta -= this.config.btc_dom_alt_penalty;
                        result.reasons.push(`BTC dom +${domChange.toFixed(1)}% alt penalty -${(this.config.btc_dom_alt_penalty * 100).toFixed(0)}%`);
                    }
                }
            } catch {}
        }

        // 4. X Sentiment score — soft boost/penalty
        try {
            const scoreRaw = await this.publisher.get(`sentiment:${symbol}`);
            if (scoreRaw) {
                const score = parseInt(scoreRaw);
                if (score >= 3) {
                    result.delta += 0.05;
                    result.reasons.push(`X sentiment +${score} bullish boost`);
                } else if (score <= -2) {
                    result.delta -= 0.05;
                    result.reasons.push(`X sentiment ${score} bearish penalty`);
                }
            }
        } catch {}

        // 5. VIX / Equity Fear & Greed (from Aktienix)
        try {
            const fgRaw = await this.publisher.get('aktienix:feargreed');
            if (fgRaw) {
                const fg = JSON.parse(fgRaw) as { vix?: number; vixScore?: number; score?: number };
                const vix = fg.vixScore ?? fg.vix ?? 0;
                if (vix >= 30) {
                    result.delta -= 0.08;
                    result.reasons.push(`VIX=${vix.toFixed(0)} panic risk-off -8%`);
                } else if (vix >= 25) {
                    result.delta -= 0.04;
                    result.reasons.push(`VIX=${vix.toFixed(0)} elevated fear -4%`);
                } else if (vix > 0 && vix <= 15) {
                    result.delta += 0.03;
                    result.reasons.push(`VIX=${vix.toFixed(0)} low vol +3%`);
                }
            }
        } catch {}

        // 6. Equity correlation — SPY/QQQ (from Ψnix EquityFetcher)
        try {
            let weightedChange = 0;
            let totalWeight = 0;
            for (const [key, weight] of [['psinix:equity:spy', 0.4], ['psinix:equity:qqq', 0.6]] as const) {
                const raw = await this.publisher.get(key);
                if (!raw) continue;
                const data = JSON.parse(raw) as { changePct?: number; timestamp?: number };
                const age = Date.now() - (data.timestamp ?? 0);
                if (age > 15 * 60_000) continue; // stale
                weightedChange += (data.changePct ?? 0) * weight;
                totalWeight += weight;
            }
            if (totalWeight >= 0.3) {
                const composite = weightedChange / totalWeight;
                if (composite >= 1.5) {
                    result.delta += 0.06;
                    result.reasons.push(`equity rally +${composite.toFixed(1)}% boost +6%`);
                } else if (composite >= 0.5) {
                    result.delta += 0.03;
                    result.reasons.push(`equity up +${composite.toFixed(1)}% boost +3%`);
                } else if (composite <= -1.5) {
                    result.delta -= 0.08;
                    result.reasons.push(`equity sell-off ${composite.toFixed(1)}% penalty -8%`);
                } else if (composite <= -0.5) {
                    result.delta -= 0.04;
                    result.reasons.push(`equity weak ${composite.toFixed(1)}% penalty -4%`);
                }
            }
        } catch {}

        // 7. Aktienix Macro Events (FOMC, inflation, recession)
        try {
            const events = await this.publisher.hgetall('aktienix:macro:event_states');
            if (events && Object.keys(events).length > 0) {
                const cryptoImpact: Record<string, number> = {
                    fed_rate_hike: -0.08,
                    fomc_statement_release: -0.03,
                    inflation_surge: -0.06,
                    recession_fear: -0.05,
                    oil_supply_shock: -0.04,
                    trade_war_tariffs: -0.04,
                };
                let macroSum = 0;
                const activeEvents: string[] = [];
                for (const [eventId, rawValue] of Object.entries(events)) {
                    try {
                        const event = JSON.parse(rawValue) as { phase?: string; confidence?: number };
                        if (event.phase === 'resolved') continue;
                        const impact = cryptoImpact[eventId];
                        if (!impact) continue;
                        macroSum += impact * (event.confidence ?? 0.5);
                        activeEvents.push(eventId);
                    } catch { continue; }
                }
                const clampedMacro = Math.max(-0.15, Math.min(0.15, macroSum));
                if (Math.abs(clampedMacro) > 0.02 && activeEvents.length > 0) {
                    result.delta += clampedMacro;
                    result.reasons.push(`macro events [${activeEvents.join(',')}] ${clampedMacro > 0 ? '+' : ''}${(clampedMacro * 100).toFixed(0)}%`);
                }
            }
        } catch {}

        return result;
    }

    /**
     * Get current market regime from Redis (cached for 30s).
     */
    async getRegime(): Promise<string> {
        const now = Date.now();
        if (this.cachedRegime && now - this.cacheTs < this.cacheTtlMs) {
            return this.cachedRegime;
        }
        try {
            const regime = await this.publisher.get('market:regime');
            this.cachedRegime = regime ?? 'unknown';
            this.cacheTs = now;
        } catch {
            this.cachedRegime = 'unknown';
            this.cacheTs = now;
        }
        return this.cachedRegime;
    }

    /**
     * Returns adjusted stop-loss % based on market regime.
     * During volatile regime, stops are tightened.
     */
    async adjustedStopLoss(baseStopLossPct: number): Promise<number> {
        const regime = await this.getRegime();
        if (regime === 'volatile') {
            return baseStopLossPct * this.config.volatile_sl_multiplier;
        }
        return baseStopLossPct;
    }
}
