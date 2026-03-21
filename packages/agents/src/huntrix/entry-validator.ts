import type { ManipulationSignal, HuntrixConfig } from './types';
import type Redis from 'ioredis';
import { GoPlusScanner } from './scanners/goplus';

export interface EntryValidation {
    approved: boolean;
    reasons: string[];
    signal: ManipulationSignal;
    live_price: number;
    live_volume: number;
}

interface TickerData {
    symbol: string;
    last: number;
    bid: number;
    ask: number;
    quoteVolume: number;
    percentage: number;
}

export class EntryValidator {
    private config: HuntrixConfig;
    private exchange: any;
    private redis: Redis;
    private goplusScanner: GoPlusScanner;

    constructor(config: HuntrixConfig, exchange: any, redis: Redis) {
        this.config = config;
        this.exchange = exchange;
        this.redis = redis;
        this.goplusScanner = new GoPlusScanner(redis);
    }

    async validate(signal: ManipulationSignal): Promise<EntryValidation> {
        const reasons: string[] = [];
        let approved = true;

        // Defensive blacklist check
        try {
            const baseSymbol = signal.symbol.split('/')[0];
            const blacklisted = await this.redis.get(`huntrix:blacklist:${baseSymbol}`);
            if (blacklisted) {
                const data = JSON.parse(blacklisted);
                reasons.push(`BLACKLISTED: ${data.reason}`);
                approved = false;
                // Early return — no point checking further
                console.log(`[HUNTRIX] Entry validation for ${signal.symbol}: REJECTED (blacklisted)`);
                return { approved: false, reasons, signal, live_price: 0, live_volume: 0 };
            }
        } catch {
            // Blacklist check is best-effort
        }

        // Phase check
        if (signal.phase === 'peak' || signal.phase === 'dump' || signal.phase === 'post_dump') {
            reasons.push(`Phase "${signal.phase}" — too late to enter safely`);
            approved = false;
        } else if (signal.phase === 'mid_pump') {
            reasons.push(`Phase "mid_pump" — cautious entry, pump may be advanced`);
        } else if (signal.phase === 'early_pump') {
            reasons.push(`Phase "early_pump" — ideal entry timing`);
        } else if (signal.phase === 'pre_pump') {
            reasons.push(`Phase "pre_pump" — too early, pump not confirmed yet`);
            approved = false;
        }

        // Confidence check (hardcoded thresholds — P&D=70, shill=65, whale=75)
        const minConfidence = this.getMinConfidence(signal.type);
        if (signal.confidence < minConfidence) {
            reasons.push(`Confidence ${signal.confidence}% < required ${minConfidence}% for ${signal.type}`);
            approved = false;
        }

        // Fetch live market data
        let ticker: TickerData;
        try {
            ticker = await this.exchange.fetchTicker(signal.symbol);
        } catch (err) {
            reasons.push(`Failed to fetch ticker for ${signal.symbol}: ${err}`);
            return { approved: false, reasons, signal, live_price: 0, live_volume: 0 };
        }

        const livePrice = ticker.last;
        const liveVolume = ticker.quoteVolume;
        signal.price_at_detection = livePrice;
        signal.volume_24h = liveVolume;

        // Spread check
        if (ticker.bid && ticker.ask && ticker.bid > 0) {
            const spread = ((ticker.ask - ticker.bid) / ticker.bid) * 100;
            if (spread > this.config.detection.max_spread_pct) {
                reasons.push(`Spread ${spread.toFixed(2)}% > max ${this.config.detection.max_spread_pct}%`);
                approved = false;
            }
        }

        // Volume spike & price velocity from OHLCV
        try {
            const ohlcv = await this.exchange.fetchOHLCV(signal.symbol, '1m', undefined, 15);
            if (ohlcv && ohlcv.length >= 10) {
                const len = ohlcv.length;
                const recentCandles = ohlcv.slice(0, len - 1);
                const currentCandle = ohlcv[len - 1];

                // Volume spike
                const avgVol = recentCandles.reduce((sum: number, c: any) => sum + c[5], 0) / recentCandles.length;
                const currentVol = currentCandle[5];
                if (avgVol > 0) {
                    const ratio = currentVol / avgVol;
                    if (ratio < this.config.detection.min_volume_spike_multiplier) {
                        reasons.push(`Volume ratio ${ratio.toFixed(1)}x < min ${this.config.detection.min_volume_spike_multiplier}x`);
                        approved = false;
                    }
                }

                // Price velocity
                const price5mAgo = ohlcv[Math.max(0, len - 6)][4];
                const currentPriceOHLCV = currentCandle[4];
                if (price5mAgo > 0) {
                    const priceDiff5m = ((currentPriceOHLCV - price5mAgo) / price5mAgo) * 100;
                    const velocityPerMin = priceDiff5m / 5;

                    if (velocityPerMin < this.config.detection.min_entry_velocity_pct_per_min) {
                        reasons.push(`Velocity ${velocityPerMin.toFixed(2)}%/min < min ${this.config.detection.min_entry_velocity_pct_per_min}%/min`);
                        approved = false;
                    } else if (velocityPerMin > this.config.detection.max_entry_velocity_pct_per_min) {
                        reasons.push(`Velocity ${velocityPerMin.toFixed(2)}%/min > max ${this.config.detection.max_entry_velocity_pct_per_min}%/min`);
                        approved = false;
                    }
                    signal.price_velocity = velocityPerMin;
                }
            }
        } catch (err) {
            reasons.push(`Failed to fetch OHLCV: ${err}`);
        }

        // Already pumped check
        if (ticker.percentage !== undefined && ticker.percentage !== null) {
            const priceChange24h = Math.abs(ticker.percentage);
            if (priceChange24h > this.config.detection.max_already_pumped_pct) {
                reasons.push(`Already pumped ${priceChange24h.toFixed(1)}% > max ${this.config.detection.max_already_pumped_pct}%`);
                approved = false;
            }
        }

        // CMC rank check (top 500 hardcoded — spec doesn't put this in config)
        try {
            const baseSymbol = signal.symbol.split('/')[0];
            const cmcRaw = await this.redis.get(`cmc:mcap:${baseSymbol}`);
            if (cmcRaw) {
                const cmcData = JSON.parse(cmcRaw);
                if (cmcData.rank && cmcData.rank > 500) {
                    reasons.push(`CMC rank #${cmcData.rank} > max #500`);
                    approved = false;
                }
            }
        } catch {
            // CMC data optional
        }

        // GoPlus token safety check
        if (this.goplusScanner.hasMapping(signal.symbol)) {
            try {
                const safety = await this.goplusScanner.checkSymbol(signal.symbol);
                if (safety) {
                    if (safety.is_honeypot) {
                        reasons.push(`GoPlus: honeypot detected — cannot sell`);
                        approved = false;
                    }
                    if (safety.is_mintable) {
                        reasons.push(`GoPlus: mintable token — supply can be inflated`);
                        approved = false;
                    }
                    if (safety.sell_tax > 10) {
                        reasons.push(`GoPlus: sell tax ${safety.sell_tax.toFixed(1)}% > 10%`);
                        approved = false;
                    }
                    if (safety.risk_score >= 60) {
                        reasons.push(`GoPlus: risk score ${safety.risk_score}/100 >= 60`);
                        approved = false;
                    }
                }
            } catch (err) {
                reasons.push(`GoPlus check failed: ${err instanceof Error ? err.message : err}`);
                // Fail-open for GoPlus — don't block entry on API failures
            }
        }

        // No recent exit guard — check huntrix:exits:recent sorted set
        try {
            const baseSymbol = signal.symbol.split('/')[0];
            const now = Date.now();
            const thirtyMinAgo = now - 30 * 60 * 1000;
            const recentExits = await this.redis.zrangebyscore(
                'huntrix:exits:recent', thirtyMinAgo, now,
            );
            if (recentExits.some(entry => entry.startsWith(baseSymbol + ':'))) {
                reasons.push(`Recently exited ${baseSymbol} within 30min — cooling off`);
                approved = false;
            }
        } catch {
            // No recent exits data — continue
        }

        const decision = approved ? 'APPROVED' : 'REJECTED';
        console.log(`[HUNTRIX] Entry validation for ${signal.symbol} [${signal.type}]: ${decision}`);
        for (const reason of reasons) {
            console.log(`  ${reason}`);
        }

        return { approved, reasons, signal, live_price: livePrice, live_volume: liveVolume };
    }

    private getMinConfidence(type: string): number {
        switch (type) {
            case 'pump_and_dump': return 70;
            case 'coordinated_shill':
            case 'influencer_pump': return 65;
            case 'whale_accumulation': return 75;
            default: return 70;
        }
    }
}
