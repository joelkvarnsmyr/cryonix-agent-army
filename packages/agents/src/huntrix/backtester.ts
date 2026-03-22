import type {
    ManipulationSignal, HunterPosition, PriceTick,
    ExitReason, HuntrixConfig, PumpProfile,
} from './types';
import type { OhlcvData } from '../market-scout/pattern-detectors/pattern-detector.interface';
import type { EquityPoint } from '@cryonix/types';
import { DumpDetector } from './dump-detector';

export interface HuntrixBTTrade {
    symbol: string;
    exchange: string;
    entryIdx: number;
    exitIdx: number;
    entryPrice: number;
    exitPrice: number;
    entryTimestamp: number;
    pnl: number;
    pnlPct: number;
    holdMinutes: number;
    exitReason: string;
    signalType: string;
    signalConfidence: number;
    phase: string;
}

export interface CalibrationResult {
    precision: number;
    recall: number;
    matchedProfiles: number;
    unmatchedProfiles: number;
    falsePositives: number;
}

export interface HuntrixBacktestResult {
    trades: HuntrixBTTrade[];
    totalPnl: number;
    winRate: number;
    wins: number;
    losses: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    equityCurve: EquityPoint[];
    avgHoldMinutes: number;
    exitBreakdown: Record<string, number>;
    signalsGenerated: number;
    signalsApproved: number;
    approvalRate: number;
    calibration: CalibrationResult | null;
}

export class HuntrixBacktester {
    private config: HuntrixConfig;

    constructor(config: HuntrixConfig) {
        this.config = config;
    }

    filterSignals(signals: ManipulationSignal[]): ManipulationSignal[] {
        return signals.filter(s => {
            if (s.phase === 'peak' || s.phase === 'dump' || s.phase === 'post_dump' || s.phase === 'pre_pump') {
                return false;
            }
            const minConf = this.getMinConfidence(s.type);
            if (s.confidence < minConf) return false;
            return true;
        });
    }

    simulateExits(signals: ManipulationSignal[], candles1m: OhlcvData[], entryOffset: number): HuntrixBTTrade[] {
        const trades: HuntrixBTTrade[] = [];
        const detector = new DumpDetector(this.config);

        for (const signal of signals) {
            const entryIdx = entryOffset;
            const entryPrice = signal.price_at_detection;
            if (entryIdx >= candles1m.length - 1) continue;

            const entryTimestamp = candles1m[entryIdx].timestamp;
            const positionId = signal.id;

            const position: HunterPosition = {
                id: positionId,
                symbol: signal.symbol,
                exchange: signal.exchange,
                entry_price: entryPrice,
                current_price: entryPrice,
                size_usd: 25,
                quantity: 25 / entryPrice,
                unrealized_pnl: 0,
                unrealized_pnl_pct: 0,
                signal,
                price_history: [],
                trailing_high: entryPrice,
                trailing_active: false,
                entered_at: new Date(entryTimestamp).toISOString(),
                exit_reason: null,
                exit_price: null,
                exited_at: null,
            };

            let exitIdx = -1;
            let exitReason: ExitReason = 'max_hold_time';
            let exitPrice = entryPrice;

            for (let i = entryIdx + 1; i < candles1m.length; i++) {
                const candle = candles1m[i];

                position.current_price = candle.close;
                position.unrealized_pnl = (candle.close - entryPrice) * position.quantity;
                position.unrealized_pnl_pct = ((candle.close - entryPrice) / entryPrice) * 100;
                position.price_history.push({
                    price: candle.close,
                    timestamp: candle.timestamp,
                    volume: candle.volume,
                });

                detector.updateTrailing(position);

                // Check max hold time directly using candle timestamps (avoids Date.now() in DumpDetector)
                const holdMinutes = (candle.timestamp - entryTimestamp) / 60_000;
                if (holdMinutes >= this.config.exits.max_hold_minutes) {
                    exitIdx = i;
                    exitReason = 'max_hold_time';
                    exitPrice = candle.close;
                    break;
                }

                // Hard exits evaluated inline so they always take priority over soft exits.
                const lossPct = ((entryPrice - candle.close) / entryPrice) * 100;
                if (lossPct >= this.config.exits.stop_loss_pct) {
                    exitIdx = i;
                    exitReason = 'stop_loss';
                    exitPrice = candle.close;
                    break;
                }
                if (position.unrealized_pnl_pct >= this.config.exits.take_profit_pct) {
                    exitIdx = i;
                    exitReason = 'take_profit';
                    exitPrice = candle.close;
                    break;
                }

                // Immediate-urgency exits from DumpDetector: trailing_stop, dump_velocity, shill_drop.
                // Volume_reversal and other normal-urgency exits are intentionally excluded here
                // to prevent them from firing before hard SL/TP thresholds are reached.
                const exitSignal = detector.check(position);
                if (exitSignal && exitSignal.should_exit && exitSignal.urgency === 'immediate'
                    && exitSignal.reason !== 'stop_loss' && exitSignal.reason !== 'max_hold_time') {
                    exitIdx = i;
                    exitReason = exitSignal.reason;
                    exitPrice = candle.close;
                    break;
                }
            }

            if (exitIdx === -1) {
                exitIdx = candles1m.length - 1;
                exitPrice = candles1m[exitIdx].close;
            }

            const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
            const pnl = (exitPrice - entryPrice) * position.quantity; // dollar PnL
            const holdMinutes = (candles1m[exitIdx].timestamp - entryTimestamp) / 60_000;

            trades.push({
                symbol: signal.symbol,
                exchange: signal.exchange,
                entryIdx,
                exitIdx,
                entryPrice,
                exitPrice,
                entryTimestamp,
                pnl,
                pnlPct,
                holdMinutes,
                exitReason,
                signalType: signal.type,
                signalConfidence: signal.confidence,
                phase: signal.phase,
            });

            detector.cleanup(positionId);
        }

        return trades;
    }

    computeMetrics(
        trades: HuntrixBTTrade[],
        signalsGenerated: number,
        signalsApproved: number,
        pumpProfiles?: PumpProfile[],
    ): HuntrixBacktestResult {
        const wins = trades.filter(t => t.pnl > 0).length;
        const losses = trades.filter(t => t.pnl <= 0).length;
        const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
        const winRate = trades.length > 0 ? wins / trades.length : 0;
        const avgHoldMinutes = trades.length > 0
            ? trades.reduce((sum, t) => sum + t.holdMinutes, 0) / trades.length
            : 0;

        const exitBreakdown: Record<string, number> = {};
        for (const t of trades) {
            exitBreakdown[t.exitReason] = (exitBreakdown[t.exitReason] ?? 0) + 1;
        }

        let equity = 100;
        let peak = equity;
        let maxDrawdown = 0;
        const equityCurve: EquityPoint[] = [{ date: new Date(trades[0]?.entryTimestamp ?? Date.now()), equity, drawdown: 0 }];

        for (const t of trades) {
            equity += t.pnl;
            if (equity > peak) peak = equity;
            const dd = ((peak - equity) / peak) * 100;
            if (dd > maxDrawdown) maxDrawdown = dd;
            equityCurve.push({ date: new Date(t.entryTimestamp), equity, drawdown: dd });
        }

        let sharpe = 0;
        if (trades.length > 1) {
            const returns = trades.map(t => t.pnlPct / 100);
            const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / (returns.length - 1);
            const stdDev = Math.sqrt(variance);
            sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
        }

        let calibration: CalibrationResult | null = null;
        if (pumpProfiles && pumpProfiles.length > 0) {
            calibration = this.calibrate(trades, pumpProfiles);
        }

        return {
            trades,
            totalPnl,
            winRate,
            wins,
            losses,
            maxDrawdownPct: maxDrawdown,
            sharpeRatio: sharpe,
            equityCurve,
            avgHoldMinutes,
            exitBreakdown,
            signalsGenerated,
            signalsApproved,
            approvalRate: signalsGenerated > 0 ? signalsApproved / signalsGenerated : 0,
            calibration,
        };
    }

    private calibrate(trades: HuntrixBTTrade[], profiles: PumpProfile[]): CalibrationResult {
        const WINDOW_MS = 5 * 60_000;
        let matched = 0;
        const matchedProfileIds = new Set<string>();

        for (const trade of trades) {
            const tradeTime = trade.entryTimestamp;
            for (const profile of profiles) {
                if (matchedProfileIds.has(profile.id)) continue;
                const baseSymbol = trade.symbol.split('/')[0];
                if (!profile.symbol.includes(baseSymbol)) continue;

                const profileTime = new Date(profile.detected_at).getTime();
                if (Math.abs(tradeTime - profileTime) <= WINDOW_MS) {
                    matchedProfileIds.add(profile.id);
                    matched++;
                    break;
                }
            }
        }

        const falsePositives = trades.length - matched;
        const unmatchedProfiles = profiles.length - matchedProfileIds.size;

        return {
            precision: trades.length > 0 ? matched / trades.length : 0,
            recall: profiles.length > 0 ? matchedProfileIds.size / profiles.length : 0,
            matchedProfiles: matched,
            unmatchedProfiles,
            falsePositives,
        };
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
