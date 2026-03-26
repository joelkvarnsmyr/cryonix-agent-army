/**
 * Predator Hunter — Entry Validator
 *
 * Confirms that a detected manipulation campaign is in the right phase
 * for profitable entry. Validates volume, price velocity, spread,
 * market cap rank, and phase timing.
 */

import type { ManipulationSignal, PredatorHunterConfig } from './types';
import type Redis from 'ioredis';

export interface EntryValidation {
    approved: boolean;
    reasons: string[];
    /** Updated signal with live market data filled in */
    signal: ManipulationSignal;
    /** Current live price */
    live_price: number;
    /** Current 24h volume */
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
    private config: PredatorHunterConfig;
    private exchange: any; // CCXT exchange instance
    private redis: Redis;

    constructor(config: PredatorHunterConfig, exchange: any, redis: Redis) {
        this.config = config;
        this.exchange = exchange;
        this.redis = redis;
    }

    /**
     * Validate a manipulation signal for potential entry
     */
    async validate(signal: ManipulationSignal): Promise<EntryValidation> {
        const reasons: string[] = [];
        let approved = true;

        // ── Phase check ─────────────────────────────────────────
        if (signal.phase === 'peak' || signal.phase === 'dump' || signal.phase === 'post_dump') {
            reasons.push(`❌ Phase "${signal.phase}" — too late to enter safely`);
            approved = false;
        } else if (signal.phase === 'mid_pump') {
            reasons.push(`⚠️ Phase "mid_pump" — cautious entry, pump may be advanced`);
        } else if (signal.phase === 'early_pump') {
            reasons.push(`✅ Phase "early_pump" — ideal entry timing`);
        } else if (signal.phase === 'pre_pump') {
            reasons.push(`⏳ Phase "pre_pump" — too early, pump not confirmed yet`);
            approved = false;
        }

        // ── Confidence check ────────────────────────────────────
        const minConfidence = this.getMinConfidence(signal.type);
        if (signal.confidence < minConfidence) {
            reasons.push(`❌ Confidence ${signal.confidence}% < required ${minConfidence}% for ${signal.type}`);
            approved = false;
        } else {
            reasons.push(`✅ Confidence ${signal.confidence}% >= ${minConfidence}%`);
        }

        // ── Fetch live market data ──────────────────────────────
        let ticker: TickerData;
        try {
            // Convert symbol format (SOL/USDC -> SOL/USDC for CCXT)
            const ccxtSymbol = signal.symbol;
            ticker = await this.exchange.fetchTicker(ccxtSymbol);
        } catch (err) {
            reasons.push(`❌ Failed to fetch ticker for ${signal.symbol}: ${err}`);
            return { approved: false, reasons, signal, live_price: 0, live_volume: 0 };
        }

        const livePrice = ticker.last;
        const liveVolume = ticker.quoteVolume;

        // Update signal with live data
        signal.price_at_detection = livePrice;
        signal.volume_24h = liveVolume;

        // ── Spread check ────────────────────────────────────────
        if (ticker.bid && ticker.ask && ticker.bid > 0) {
            const spread = ((ticker.ask - ticker.bid) / ticker.bid) * 100;
            if (spread > this.config.detection.max_spread_pct) {
                reasons.push(`❌ Spread ${spread.toFixed(2)}% > max ${this.config.detection.max_spread_pct}%`);
                approved = false;
            } else {
                reasons.push(`✅ Spread ${spread.toFixed(2)}% within limits`);
            }
        }

        // ── OHLCV (Volume spike & Price Velocity) ───────────────
        try {
            // Fetch last 15 1-minute candles
            const ohlcv = await this.exchange.fetchOHLCV(signal.symbol, '1m', undefined, 15);
            if (ohlcv && ohlcv.length >= 10) {
                const len = ohlcv.length;
                const recentCandles = ohlcv.slice(0, len - 1);
                const currentCandle = ohlcv[len - 1];
                
                // Volume spike check (current 1m volume > 3x average of previous)
                const avgVol = recentCandles.reduce((sum: number, c: any) => sum + c[5], 0) / recentCandles.length;
                const currentVol = currentCandle[5];
                if (avgVol > 0) {
                    const ratio = currentVol / avgVol;
                    if (ratio < 3.0) {
                        reasons.push(`❌ Volume ratio ${ratio.toFixed(1)}x < min 3.0x average`);
                        approved = false;
                    } else {
                        reasons.push(`✅ Volume ratio ${ratio.toFixed(1)}x >= 3.0x average`);
                    }
                }

                // Price velocity check (change over last 5 minutes)
                const price5mAgo = ohlcv[Math.max(0, len - 6)][4]; // Close price 5 mins ago
                const currentPriceOHLCV = currentCandle[4];
                if (price5mAgo > 0) {
                    const priceDiff5m = ((currentPriceOHLCV - price5mAgo) / price5mAgo) * 100;
                    const velocityPerMin = priceDiff5m / 5;
                    
                    if (velocityPerMin < 1.0) {
                        reasons.push(`❌ Price velocity ${velocityPerMin.toFixed(2)}%/min < min 1.0%/min`);
                        approved = false;
                    } else if (velocityPerMin > 10.0) {
                        reasons.push(`❌ Price velocity ${velocityPerMin.toFixed(2)}%/min > max 10.0%/min (too fast, might peak)`);
                        approved = false;
                    } else {
                        reasons.push(`✅ Price velocity ${velocityPerMin.toFixed(2)}%/min within 1-10% range`);
                    }
                    signal.price_velocity = velocityPerMin;
                }
            }
        } catch (err) {
            reasons.push(`⚠️ Failed to fetch OHLCV for volume/velocity check: ${err}`);
        }

        // ── Already Pumped check (24h) ──────────────────────────
        // Using ticker.percentage to see if it's already overextended
        if (ticker.percentage !== undefined && ticker.percentage !== null) {
            const priceChange24h = Math.abs(ticker.percentage);
            if (priceChange24h > this.config.detection.max_already_pumped_pct) {
                reasons.push(`❌ Already pumped ${priceChange24h.toFixed(1)}% in 24h > max ${this.config.detection.max_already_pumped_pct}%`);
                approved = false;
            } else {
                reasons.push(`✅ 24h change ${ticker.percentage.toFixed(1)}% — not overly pumped yet`);
            }
        }

        // ── CMC rank check ──────────────────────────────────────
        // Read from Redis if available
        try {
            const baseSymbol = signal.symbol.split('/')[0];
            const cmcRaw = await this.redis.get(`cmc:mcap:${baseSymbol}`);
            if (cmcRaw) {
                const cmcData = JSON.parse(cmcRaw);
                if (cmcData.rank && cmcData.rank > this.config.detection.max_cmc_rank) {
                    reasons.push(`❌ CMC rank #${cmcData.rank} > max #${this.config.detection.max_cmc_rank}`);
                    approved = false;
                } else if (cmcData.rank) {
                    reasons.push(`✅ CMC rank #${cmcData.rank} within top ${this.config.detection.max_cmc_rank}`);
                }
            }
        } catch {
            // CMC data optional — continue without it
        }

        // ── Min order value check ───────────────────────────────
        if (this.config.capital.max_position_size_usd < this.config.capital.min_order_value) {
            reasons.push(`❌ Position size $${this.config.capital.max_position_size_usd} < min order $${this.config.capital.min_order_value}`);
            approved = false;
        }

        // ── Log decision ────────────────────────────────────────
        const decision = approved ? '✅ APPROVED' : '❌ REJECTED';
        console.log(`[PREDATOR] Entry validation for ${signal.symbol} [${signal.type}]: ${decision}`);
        for (const reason of reasons) {
            console.log(`  ${reason}`);
        }

        return { approved, reasons, signal, live_price: livePrice, live_volume: liveVolume };
    }

    /**
     * Get minimum confidence threshold based on manipulation type
     */
    private getMinConfidence(type: string): number {
        switch (type) {
            case 'pump_and_dump':
                return this.config.detection.min_pnd_confidence;
            case 'coordinated_shill':
            case 'influencer_pump':
                return this.config.detection.min_shill_confidence;
            case 'whale_accumulation':
                return this.config.detection.min_whale_confidence;
            default:
                return 70; // Conservative default
        }
    }
}
