import type { TradingSignal, PatternType, SignalAction } from '@cryonix/types';
import type { OhlcvData } from '../../market-scout/pattern-detectors';
import type { BacktestConfig, BacktestPosition, BacktestTrade } from '../../backtester/types';

/**
 * Generate mock OHLCV (candlestick) data for testing
 * @param days Number of days of data to generate
 * @param symbol Trading pair symbol
 * @param basePrice Starting price
 * @param volatility Price volatility (0-1, where 0.1 = 10% daily volatility)
 * @param timeframe Candle timeframe (default: '1h')
 * @returns Array of OHLCV candles
 */
export function generateMockOHLCV(
    days: number,
    symbol: string = 'BTC/USDT',
    basePrice: number = 50000,
    volatility: number = 0.02,
    timeframe: string = '1h'
): OhlcvData[] {
    const candles: OhlcvData[] = [];
    const candlesPerDay = timeframe === '15m' ? 96 : timeframe === '1h' ? 24 : timeframe === '4h' ? 6 : 24;
    const totalCandles = days * candlesPerDay;

    let currentPrice = basePrice;
    const startTime = new Date('2024-01-01T00:00:00Z');

    for (let i = 0; i < totalCandles; i++) {
        // Random walk with slight upward bias
        const change = (Math.random() - 0.48) * volatility;
        currentPrice = currentPrice * (1 + change);

        // Generate OHLCV
        const open = currentPrice;
        const close = currentPrice * (1 + (Math.random() - 0.5) * volatility * 0.5);
        const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.3);
        const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.3);
        const volume = 1000000 + Math.random() * 5000000;

        const timestamp = startTime.getTime() + i * getTimeframeMs(timeframe);

        candles.push({
            timestamp,
            open,
            high,
            low,
            close,
            volume,
        });

        currentPrice = close;
    }

    return candles;
}

/**
 * Generate OHLCV data with a clear uptrend
 */
export function generateTrendingOHLCV(
    days: number,
    symbol: string = 'BTC/USDT',
    basePrice: number = 50000,
    trendStrength: number = 0.05 // 5% upward trend per day
): OhlcvData[] {
    const candles = generateMockOHLCV(days, symbol, basePrice, 0.015, '1h');

    // Apply upward trend
    return candles.map((candle, index) => {
        const trendMultiplier = 1 + (trendStrength * index) / (days * 24);
        return {
            ...candle,
            open: candle.open * trendMultiplier,
            high: candle.high * trendMultiplier,
            low: candle.low * trendMultiplier,
            close: candle.close * trendMultiplier,
        };
    });
}

/**
 * Generate OHLCV data with mean-reverting behavior
 */
export function generateMeanRevertingOHLCV(
    days: number,
    symbol: string = 'BTC/USDT',
    basePrice: number = 50000,
    cyclePeriodDays: number = 7
): OhlcvData[] {
    const candles = generateMockOHLCV(days, symbol, basePrice, 0.01, '1h');

    // Apply sine wave oscillation
    return candles.map((candle, index) => {
        const dayFraction = index / 24;
        const oscillation = Math.sin((dayFraction / cyclePeriodDays) * Math.PI * 2) * 0.1;
        const multiplier = 1 + oscillation;

        return {
            ...candle,
            open: candle.open * multiplier,
            high: candle.high * multiplier,
            low: candle.low * multiplier,
            close: candle.close * multiplier,
        };
    });
}

/**
 * Generate OHLCV data with high volatility
 */
export function generateVolatileOHLCV(
    days: number,
    symbol: string = 'BTC/USDT',
    basePrice: number = 50000
): OhlcvData[] {
    return generateMockOHLCV(days, symbol, basePrice, 0.08, '1h'); // 8% volatility
}

/**
 * Create a mock trading signal with sensible defaults
 */
export function createMockSignal(overrides?: Partial<TradingSignal>): TradingSignal {
    const defaults: TradingSignal = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        symbol: 'BTC/USDT',
        action: 'BUY' as SignalAction,
        confidence: 0.75,
        pattern: 'bollinger_squeeze' as PatternType,
        entry_price: 50000,
        target_price: 54000,
        stop_loss: 48000,
        reasoning: ['Mock signal for testing'],
        agent_id: 'market_scout',
    };

    return { ...defaults, ...overrides };
}

/**
 * Create a mock backtest configuration with sensible defaults
 */
export function createMockBacktestConfig(overrides?: Partial<BacktestConfig>): BacktestConfig {
    const defaults: BacktestConfig = {
        initialCapital: 10000,
        symbols: ['BTC/USDT'],
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-02-01'),
        timeframe: '1h',
        patterns: ['bollinger_squeeze', 'volume_spike'] as PatternType[],
        positionSizing: 'fixed',
        fixedPositionPercent: 10,
        maxPositionPercent: 20,
        maxRiskPercent: 2,
        slippagePercent: 0.1,
        feePercent: 0.1,
        minConfidence: 0.6,
        maxConcurrentPositions: 3,
    };

    return { ...defaults, ...overrides };
}

/**
 * Create a mock backtest position
 */
export function createMockPosition(overrides?: Partial<BacktestPosition>): BacktestPosition {
    const defaults: BacktestPosition = {
        id: `pos-${Date.now()}`,
        symbol: 'BTC/USDT',
        side: 'LONG',
        entryPrice: 50000,
        entryTime: new Date(),
        quantity: 0.1,
        stopLoss: 48000,
        takeProfit: 54000,
        confidence: 0.75,
        pattern: 'bollinger_squeeze' as PatternType,
        signalId: 'signal-123',
    };

    return { ...defaults, ...overrides };
}

/**
 * Create a mock completed trade
 */
export function createMockTrade(overrides?: Partial<BacktestTrade>): BacktestTrade {
    const entryPrice = overrides?.entryPrice || 50000;
    const exitPrice = overrides?.exitPrice || 52000;
    const quantity = overrides?.quantity || 0.1;
    const fees = (entryPrice * quantity * 0.001) + (exitPrice * quantity * 0.001);
    const pnl = (exitPrice - entryPrice) * quantity - fees;
    const pnlPercent = (pnl / (entryPrice * quantity)) * 100;

    const defaults: BacktestTrade = {
        id: `trade-${Date.now()}`,
        symbol: 'BTC/USDT',
        side: 'LONG',
        entryPrice,
        exitPrice,
        entryTime: new Date(Date.now() - 3600000), // 1 hour ago
        exitTime: new Date(),
        quantity,
        pnl,
        pnlPercent,
        fees,
        slippage: 10,
        exitReason: 'take_profit',
        pattern: 'bollinger_squeeze' as PatternType,
        confidence: 0.75,
        holdingPeriodCandles: 4,
    };

    return { ...defaults, ...overrides };
}

/**
 * Create an array of mock winning trades
 */
export function createWinningTrades(count: number): BacktestTrade[] {
    const trades: BacktestTrade[] = [];

    for (let i = 0; i < count; i++) {
        trades.push(
            createMockTrade({
                id: `trade-win-${i}`,
                entryPrice: 50000,
                exitPrice: 50000 * (1 + 0.02 + Math.random() * 0.03), // 2-5% profit
                exitReason: 'take_profit',
            })
        );
    }

    return trades;
}

/**
 * Create an array of mock losing trades
 */
export function createLosingTrades(count: number): BacktestTrade[] {
    const trades: BacktestTrade[] = [];

    for (let i = 0; i < count; i++) {
        trades.push(
            createMockTrade({
                id: `trade-loss-${i}`,
                entryPrice: 50000,
                exitPrice: 50000 * (1 - 0.01 - Math.random() * 0.02), // 1-3% loss
                exitReason: 'stop_loss',
            })
        );
    }

    return trades;
}

/**
 * Helper to get timeframe in milliseconds
 */
function getTimeframeMs(timeframe: string): number {
    const unit = timeframe.slice(-1);
    const value = parseInt(timeframe.slice(0, -1));

    switch (unit) {
        case 'm':
            return value * 60 * 1000;
        case 'h':
            return value * 60 * 60 * 1000;
        case 'd':
            return value * 24 * 60 * 60 * 1000;
        default:
            return 60 * 60 * 1000; // default 1h
    }
}
