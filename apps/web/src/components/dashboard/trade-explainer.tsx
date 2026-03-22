'use client';

/**
 * TradeExplainer — inline expand panel showing signals, exit rules, risk, and thesis.
 * Matches the dark-theme monospace style from the Polynix expanded panels.
 */

export interface TradeExplainerProps {
    symbol: string;
    direction: string;
    mode?: string;
    entryPrice: number;
    positionSize: number; // USD value
    quantity?: number;
    signals: { source: string; signalType: string; confidence: number; score?: number }[];
    totalScore?: number;
    exitRules: {
        tpPct: number;
        slPct: number;
        trailingPct?: number;
        trailingActivationPct?: number;
        maxHoldHours?: number;
    };
    capital: number;
    thesis: string;
    agentColor?: string; // tailwind text color class
}

// Source badge colors
const SOURCE_COLORS: Record<string, string> = {
    cryonix: 'text-blue-400 border-blue-400/30 bg-blue-400/5',
    psinix: 'text-purple-400 border-purple-400/30 bg-purple-400/5',
    orakel: 'text-amber-400 border-amber-400/30 bg-amber-400/5',
    vedic: 'text-orange-400 border-orange-400/30 bg-orange-400/5',
    polymarket: 'text-cyan-400 border-cyan-400/30 bg-cyan-400/5',
    cmc: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/5',
    copynix: 'text-pink-400 border-pink-400/30 bg-pink-400/5',
    solanix: 'text-teal-400 border-teal-400/30 bg-teal-400/5',
    aktienix: 'text-indigo-400 border-indigo-400/30 bg-indigo-400/5',
};

// Friendly signal names
const SIGNAL_LABELS: Record<string, string> = {
    RSI_OVERSOLD: 'RSI Oversold',
    BOLLINGER_SQUEEZE: 'Bollinger Squeeze',
    DEEP_VALUE_CRASH: 'Deep Value Crash',
    DIP_BUY: 'Dip Buy',
    phase_convergence: 'Phase Convergence',
    orakel_direction_up: 'Direction Up',
    orakel_direction_down: 'Direction Down',
    orakel_regime_bull: 'Regime Bull',
    orakel_regime_bear: 'Regime Bear',
    orakel_vol_spike: 'Vol Spike',
    whale_buy: 'Whale Buy',
    whale_sell: 'Whale Sell',
    extreme_fear: 'Extreme Fear',
    extreme_greed: 'Extreme Greed',
    venus_rx_active: 'Venus Rx Active',
    MACD_BULLISH_CROSS: 'MACD Bull Cross',
    MACD_BEARISH_CROSS: 'MACD Bear Cross',
    EMA_BULLISH_CROSS: 'EMA Bull Cross',
    EMA_BEARISH_CROSS: 'EMA Bear Cross',
    VOLUME_SPIKE_UP: 'Volume Spike',
};

export function TradeExplainer(props: TradeExplainerProps) {
    const {
        symbol, direction, entryPrice, positionSize, quantity,
        signals, totalScore, exitRules, capital, thesis, agentColor,
    } = props;

    const tpPrice = direction === 'long'
        ? entryPrice * (1 + exitRules.tpPct / 100)
        : entryPrice * (1 - exitRules.tpPct / 100);
    const slPrice = direction === 'long'
        ? entryPrice * (1 - exitRules.slPct / 100)
        : entryPrice * (1 + exitRules.slPct / 100);

    const maxLoss = positionSize * (exitRules.slPct / 100);
    const maxGain = positionSize * (exitRules.tpPct / 100);
    const rrRatio = exitRules.slPct > 0 ? (exitRules.tpPct / exitRules.slPct).toFixed(1) : '-';
    const positionPct = capital > 0 ? ((positionSize / capital) * 100).toFixed(1) : '0';

    const holdLabel = exitRules.maxHoldHours
        ? exitRules.maxHoldHours <= 24 ? `${exitRules.maxHoldHours}h`
        : `${Math.round(exitRules.maxHoldHours / 24)}d`
        : '-';

    const accentColor = agentColor ?? 'text-rose-400';

    return (
        <div className="border-t border-white/[0.04] px-4 py-3 space-y-3">
            {/* THESIS */}
            <div className="text-xs text-muted-foreground/80 italic">
                {thesis}
            </div>

            {/* SIGNALS */}
            <div>
                <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1.5">SIGNALS</div>
                <div className="space-y-1">
                    {signals.map((sig, i) => {
                        const sourceStyle = SOURCE_COLORS[sig.source] ?? 'text-zinc-400 border-zinc-400/30 bg-zinc-400/5';
                        const label = SIGNAL_LABELS[sig.signalType] ?? sig.signalType.replace(/_/g, ' ');
                        return (
                            <div key={i} className="flex items-center gap-2">
                                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${sourceStyle}`}>
                                    {sig.source}
                                </span>
                                <span className="text-xs font-mono text-foreground/80 truncate">
                                    {label}
                                </span>
                                <div className="flex items-center gap-1.5 ml-auto shrink-0">
                                    <div className="w-16 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                        <div
                                            className={`h-full rounded-full ${sig.confidence >= 70 ? 'bg-emerald-400' : sig.confidence >= 40 ? 'bg-amber-400' : 'bg-red-400'}`}
                                            style={{ width: `${Math.min(100, sig.confidence)}%` }}
                                        />
                                    </div>
                                    <span className="text-[10px] font-mono text-muted-foreground/50 w-7 text-right">
                                        {sig.confidence}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {totalScore != null && (
                    <div className="flex items-center gap-2 mt-1.5 pt-1 border-t border-white/[0.04]">
                        <span className="text-[10px] font-mono text-muted-foreground/50">TOTAL SCORE</span>
                        <span className={`text-sm font-mono font-bold ${accentColor}`}>{totalScore}</span>
                    </div>
                )}
            </div>

            {/* EXIT RULES */}
            <div>
                <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1.5">EXIT RULES</div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
                    <div className="flex justify-between">
                        <span className="text-muted-foreground/50">TP</span>
                        <span className="text-emerald-400">+{exitRules.tpPct}% (${tpPrice.toFixed(2)})</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-muted-foreground/50">SL</span>
                        <span className="text-red-400">-{exitRules.slPct}% (${slPrice.toFixed(2)})</span>
                    </div>
                    {exitRules.trailingPct != null && (
                        <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Trailing</span>
                            <span className="text-amber-400">{exitRules.trailingPct}%</span>
                        </div>
                    )}
                    {exitRules.trailingActivationPct != null && (
                        <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Trail activate</span>
                            <span className="text-foreground">+{exitRules.trailingActivationPct}%</span>
                        </div>
                    )}
                    <div className="flex justify-between">
                        <span className="text-muted-foreground/50">Max hold</span>
                        <span className="text-foreground">{holdLabel}</span>
                    </div>
                </div>
            </div>

            {/* RISK */}
            <div>
                <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1.5">RISK</div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
                    <div className="flex justify-between">
                        <span className="text-muted-foreground/50">Max loss</span>
                        <span className="text-red-400">-${maxLoss.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-muted-foreground/50">Max gain</span>
                        <span className="text-emerald-400">+${maxGain.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-muted-foreground/50">R:R</span>
                        <span className="text-foreground">1:{rrRatio}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-muted-foreground/50">Position %</span>
                        <span className="text-foreground">{positionPct}%</span>
                    </div>
                    {quantity != null && (
                        <div className="flex justify-between">
                            <span className="text-muted-foreground/50">Size</span>
                            <span className="text-foreground">${positionSize.toFixed(2)} ({quantity.toFixed(6)} {symbol})</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
