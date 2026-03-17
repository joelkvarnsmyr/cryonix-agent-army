/**
 * Psinix Backtester — Replay historical prices through the Psi engine
 *
 * Iterates through price bars, converts signal snapshots to PsiSignals,
 * computes market entropy from a rolling window, and uses PsiEngine.compute
 * to decide entries/exits. Tracks equity curve, drawdown, and Sharpe ratio.
 */

import { PsiEngine, type PsiSignal } from './psi-engine';

// ── Config ──────────────────────────────────────────────────────────

export interface BacktestConfig {
    phaseTransitionThreshold: number;
    kellyFractionCap: number;
    minPsiMagnitude: number;
    maxPositionSizeUsd: number;
    takeProfitPct: number;
    stopLossPct: number;
    trailingStopPct: number;
    trailingActivationPct: number;
    initialBalance: number;
    betaScale: number;
}

export interface SignalSnapshot {
    sources: Array<{ id: string; direction: number; weight: number }>;
}

// ── Internal types ──────────────────────────────────────────────────

interface BTPosition {
    entryPrice: number;
    qty: number;
    side: 'LONG' | 'SHORT';
    psi: number;
    coherence: number;
    highWatermark: number;
    trailingActive: boolean;
    entryIdx: number;
}

interface BTTrade {
    entryIdx: number;
    exitIdx: number;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    psi: number;
    coherence: number;
    reason: string;
}

// ── Result ──────────────────────────────────────────────────────────

export interface BacktestResult {
    trades: BTTrade[];
    totalPnl: number;
    winRate: number;
    wins: number;
    losses: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    equityCurve: number[];
    avgCoherenceAtEntry: number;
    avgPsiAtEntry: number;
    totalBars: number;
}

// ── Constants ───────────────────────────────────────────────────────

const ENTROPY_WINDOW = 20;
const MIN_SOURCES = 2;
const MIN_POSITION_USD = 5;
const MAX_BALANCE_FRACTION = 0.2;
const DEFAULT_WIN_RATE = 0.5;
const DEFAULT_WIN_LOSS_RATIO = 1.5;
const ANNUALIZATION_FACTOR = Math.sqrt(252);

// ── Backtester ──────────────────────────────────────────────────────

export class PsinixBacktester {
    private readonly cfg: BacktestConfig;

    constructor(config: BacktestConfig) {
        this.cfg = config;
    }

    run(prices: number[], signals: SignalSnapshot[]): BacktestResult {
        const trades: BTTrade[] = [];
        const equityCurve: number[] = [];
        let balance = this.cfg.initialBalance;
        let peak = balance;
        let maxDrawdownPct = 0;
        let position: BTPosition | null = null;

        // Running win rate for Kelly (start at 50%)
        let wins = 0;
        let totalTrades = 0;

        for (let i = 0; i < prices.length; i++) {
            const price = prices[i];

            // ── Check exits ─────────────────────────────────────
            if (position) {
                const exitResult = this.checkExit(position, price, i);
                if (exitResult) {
                    balance += exitResult.pnl;
                    totalTrades++;
                    if (exitResult.pnl > 0) wins++;
                    trades.push(exitResult);
                    position = null;
                }
            }

            // ── Check entries (only after entropy window) ───────
            if (!position && i >= ENTROPY_WINDOW) {
                const snap = i < signals.length ? signals[i] : undefined;
                if (snap && snap.sources.length >= MIN_SOURCES) {
                    const psiSignals: PsiSignal[] = snap.sources.map(s => ({
                        sourceId: s.id,
                        direction: s.direction,
                        weight: s.weight,
                        timestamp: Date.now(),
                    }));

                    const priceWindow = prices.slice(i - ENTROPY_WINDOW, i);
                    const entropy = PsiEngine.computeMarketEntropy(priceWindow);

                    const winRate = totalTrades > 0
                        ? wins / totalTrades
                        : DEFAULT_WIN_RATE;

                    const result = PsiEngine.compute(
                        psiSignals,
                        entropy,
                        winRate,
                        DEFAULT_WIN_LOSS_RATIO,
                        this.cfg.betaScale,
                    );

                    if (result.phaseTransition && Math.abs(result.psi) >= this.cfg.minPsiMagnitude) {
                        const rawSize = Math.abs(result.psi) * this.cfg.maxPositionSizeUsd;
                        const cappedSize = Math.min(rawSize, balance * MAX_BALANCE_FRACTION);

                        if (cappedSize >= MIN_POSITION_USD && cappedSize <= balance) {
                            const side: 'LONG' | 'SHORT' = result.psi > 0 ? 'LONG' : 'SHORT';
                            const qty = cappedSize / price;

                            position = {
                                entryPrice: price,
                                qty,
                                side,
                                psi: result.psi,
                                coherence: result.coherence,
                                highWatermark: price,
                                trailingActive: false,
                                entryIdx: i,
                            };
                        }
                    }
                }
            }

            // ── Update high watermark for trailing stop ─────────
            if (position) {
                if (position.side === 'LONG' && price > position.highWatermark) {
                    position.highWatermark = price;
                } else if (position.side === 'SHORT' && price < position.highWatermark) {
                    position.highWatermark = price;
                }

                // Activate trailing stop when profit exceeds threshold
                if (!position.trailingActive) {
                    const profitPct = position.side === 'LONG'
                        ? (price - position.entryPrice) / position.entryPrice
                        : (position.entryPrice - price) / position.entryPrice;
                    if (profitPct >= this.cfg.trailingActivationPct / 100) {
                        position.trailingActive = true;
                    }
                }
            }

            // ── Track equity ────────────────────────────────────
            let equity = balance;
            if (position) {
                const unrealized = position.side === 'LONG'
                    ? (price - position.entryPrice) * position.qty
                    : (position.entryPrice - price) * position.qty;
                equity += unrealized;
            }
            equityCurve.push(equity);

            if (equity > peak) peak = equity;
            const dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
            if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        }

        // ── Close any open position at last price ───────────────
        if (position && prices.length > 0) {
            const lastPrice = prices[prices.length - 1];
            const pnl = position.side === 'LONG'
                ? (lastPrice - position.entryPrice) * position.qty
                : (position.entryPrice - lastPrice) * position.qty;
            balance += pnl;
            totalTrades++;
            if (pnl > 0) wins++;
            trades.push({
                entryIdx: position.entryIdx,
                exitIdx: prices.length - 1,
                side: position.side,
                entryPrice: position.entryPrice,
                exitPrice: lastPrice,
                pnl,
                psi: position.psi,
                coherence: position.coherence,
                reason: 'end_of_data',
            });
            position = null;

            // Update final equity
            equityCurve[equityCurve.length - 1] = balance;
        }

        // ── Compute stats ───────────────────────────────────────
        const losses = totalTrades - wins;
        const winRate = totalTrades > 0 ? wins / totalTrades : 0;
        const totalPnl = balance - this.cfg.initialBalance;

        // Sharpe ratio from per-bar returns
        const returns: number[] = [];
        for (let i = 1; i < equityCurve.length; i++) {
            if (equityCurve[i - 1] > 0) {
                returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
            }
        }
        const avgReturn = returns.length > 0
            ? returns.reduce((s, r) => s + r, 0) / returns.length
            : 0;
        const variance = returns.length > 1
            ? returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1)
            : 0;
        const stdReturn = Math.sqrt(variance);
        const sharpeRatio = stdReturn > 0
            ? (avgReturn / stdReturn) * ANNUALIZATION_FACTOR
            : 0;

        // Average coherence and psi at entry
        const avgCoherenceAtEntry = trades.length > 0
            ? trades.reduce((s, t) => s + t.coherence, 0) / trades.length
            : 0;
        const avgPsiAtEntry = trades.length > 0
            ? trades.reduce((s, t) => s + Math.abs(t.psi), 0) / trades.length
            : 0;

        return {
            trades,
            totalPnl,
            winRate,
            wins,
            losses,
            maxDrawdownPct,
            sharpeRatio,
            equityCurve,
            avgCoherenceAtEntry,
            avgPsiAtEntry,
            totalBars: prices.length,
        };
    }

    // ── Exit logic ──────────────────────────────────────────────────

    private checkExit(pos: BTPosition, price: number, idx: number): BTTrade | null {
        const pnlPct = pos.side === 'LONG'
            ? (price - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - price) / pos.entryPrice * 100;

        let reason: string | null = null;

        // Stop loss
        if (pnlPct <= -this.cfg.stopLossPct) {
            reason = 'stop_loss';
        }
        // Take profit
        else if (pnlPct >= this.cfg.takeProfitPct) {
            reason = 'take_profit';
        }
        // Trailing stop (only when activated)
        else if (pos.trailingActive) {
            const drawdownFromHWM = pos.side === 'LONG'
                ? (pos.highWatermark - price) / pos.highWatermark * 100
                : (price - pos.highWatermark) / pos.highWatermark * 100;
            if (drawdownFromHWM >= this.cfg.trailingStopPct) {
                reason = 'trailing_stop';
            }
        }

        if (!reason) return null;

        const pnl = pos.side === 'LONG'
            ? (price - pos.entryPrice) * pos.qty
            : (pos.entryPrice - price) * pos.qty;

        return {
            entryIdx: pos.entryIdx,
            exitIdx: idx,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: price,
            pnl,
            psi: pos.psi,
            coherence: pos.coherence,
            reason,
        };
    }
}
