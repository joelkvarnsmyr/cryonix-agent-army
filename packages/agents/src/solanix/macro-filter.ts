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
