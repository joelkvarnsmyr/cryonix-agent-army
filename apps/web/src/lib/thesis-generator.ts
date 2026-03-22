/**
 * Thesis Generator — produces a human-readable one-liner explaining WHY a trade was taken.
 */

export interface ThesisInput {
    agent: string;
    symbol: string;
    direction: string;
    mode?: string;
    signals: { source: string; signalType: string; confidence: number }[];
    exitRules: { tpPct: number; slPct: number; maxHoldHours?: number };
    fearGreed?: number;
}

const SIGNAL_NAMES: Record<string, string> = {
    'RSI_OVERSOLD': 'RSI oversold',
    'BOLLINGER_SQUEEZE': 'Bollinger squeeze',
    'DEEP_VALUE_CRASH': 'deep value crash',
    'DIP_BUY': 'dip buy',
    'phase_convergence': 'phase convergence',
    'orakel_direction_up': 'direction up',
    'orakel_direction_down': 'direction down',
    'orakel_regime_bull': 'regime bull',
    'orakel_regime_bear': 'regime bear',
    'orakel_vol_spike': 'vol spike',
    'whale_buy': 'whale buy',
    'whale_sell': 'whale sell',
    'extreme_fear': 'extreme fear',
    'extreme_greed': 'extreme greed',
    'venus_rx_active': 'Venus Rx active',
    'MACD_BULLISH_CROSS': 'MACD bullish cross',
    'MACD_BEARISH_CROSS': 'MACD bearish cross',
    'EMA_BULLISH_CROSS': 'EMA bullish cross',
    'EMA_BEARISH_CROSS': 'EMA bearish cross',
    'VOLUME_SPIKE_UP': 'volume spike',
};

const MODE_NAMES: Record<string, string> = {
    'confluence': 'confluence trade',
    'dip_sniper': 'dip sniper',
    'venus_rx': 'Venus Rx harvest',
};

export function generateThesis(input: ThesisInput): string {
    const signalNames = input.signals
        .map(s => SIGNAL_NAMES[s.signalType] ?? s.signalType.toLowerCase().replace(/_/g, ' '))
        .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
        .slice(0, 3)
        .join(' + ');

    const context = input.fearGreed != null && input.fearGreed <= 25
        ? ` in extreme fear (F&G ${input.fearGreed})`
        : input.fearGreed != null && input.fearGreed >= 75
        ? ` in greed (F&G ${input.fearGreed})`
        : '';

    const strategy = MODE_NAMES[input.mode ?? ''] ?? `${input.agent.toLowerCase()} trade`;

    const holdHours = input.exitRules.maxHoldHours;
    const horizon = holdHours
        ? holdHours <= 24 ? `${holdHours}h scalp`
        : holdHours <= 96 ? `${Math.round(holdHours / 24)}d swing trade`
        : `${Math.round(holdHours / 24)}d cycle trade`
        : '';

    return `${input.symbol} ${signalNames}${context} — ${strategy}${horizon ? ', ' + horizon : ''}`;
}
