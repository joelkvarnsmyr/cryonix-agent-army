import type { ManipulationSignal, HuntrixConfig, PumpPhase } from './types';
import { VolumeSpikeDetector } from '../market-scout/pattern-detectors/volume-spike';
import type { OhlcvData } from '../market-scout/pattern-detectors/pattern-detector.interface';

type DetectionConfig = HuntrixConfig['detection'];

export class SyntheticSignalGenerator {
    private detection: DetectionConfig;
    private velocityWindowMinutes: number;
    private volumeDetector = new VolumeSpikeDetector();

    constructor(detection: DetectionConfig, velocityWindowSeconds?: number) {
        this.detection = detection;
        // Use velocity_window_seconds from config (default 300s = 5 min)
        this.velocityWindowMinutes = (velocityWindowSeconds ?? 300) / 60;
    }

    /**
     * Scan a window of candles for manipulation signals.
     * Called per sliding window — returns at most 1 signal per call.
     * @param symbol - trading pair (e.g. 'BTC/USDC')
     */
    scan(candles15m: OhlcvData[], candles1m: OhlcvData[], symbol: string = 'BACKTEST'): ManipulationSignal[] {
        const signals: ManipulationSignal[] = [];

        // 1. Volume spike detection on 15m candles
        const spikeResult = this.volumeDetector.detect(candles15m, symbol);
        if (!spikeResult) return signals;

        // 2. Price velocity check on 1m candles (using config velocity_window_seconds)
        const velocity = this.computeVelocity(candles1m);
        if (velocity === null) return signals;
        if (velocity < this.detection.min_entry_velocity_pct_per_min) return signals;
        if (velocity > this.detection.max_entry_velocity_pct_per_min) return signals;

        // 3. Already-pumped guard on 15m candles
        if (candles15m.length >= 2) {
            const oldest = candles15m[0].close;
            const newest = candles15m[candles15m.length - 1].close;
            if (oldest > 0) {
                const changePct = ((newest - oldest) / oldest) * 100;
                if (changePct > this.detection.max_already_pumped_pct) return signals;
            }
        }

        // 4. Phase classification
        const recentChange = candles1m.length >= 20
            ? ((candles1m[candles1m.length - 1].close - candles1m[candles1m.length - 20].close) / candles1m[candles1m.length - 20].close) * 100
            : 0;
        const phase: PumpPhase = recentChange < 5 ? 'early_pump' : 'mid_pump';

        const lastCandle = candles1m[candles1m.length - 1];
        const confidence = Math.min(85, 55 + velocity * 5);

        signals.push({
            id: `synth-${lastCandle.timestamp}`,
            type: 'wash_trading_pump',
            symbol,
            exchange: 'backtest',
            confidence,
            phase,
            shill_activity: [],
            total_shill_accounts: 0,
            price_at_detection: lastCandle.close,
            volume_24h: lastCandle.volume,
            volume_spike_ratio: spikeResult.metadata?.volumeRatio ?? 0,
            price_velocity: velocity,
            reasoning: `Synthetic: volume ${(spikeResult.metadata?.volumeRatio ?? 0).toFixed(1)}x avg, velocity ${velocity.toFixed(2)}%/min`,
            estimated_peak_minutes: null,
            detected_at: new Date(lastCandle.timestamp).toISOString(),
            source: 'trending_anomaly',
        });

        return signals;
    }

    private computeVelocity(candles1m: OhlcvData[]): number | null {
        const windowCandles = Math.ceil(this.velocityWindowMinutes) + 1;
        if (candles1m.length < windowCandles) return null;
        const len = candles1m.length;
        const startPrice = candles1m[len - windowCandles].close;
        const currentPrice = candles1m[len - 1].close;
        if (startPrice <= 0) return null;
        const priceDiff = ((currentPrice - startPrice) / startPrice) * 100;
        return priceDiff / this.velocityWindowMinutes;
    }
}
