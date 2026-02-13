/**
 * Dynamic Stop-Loss Management
 *
 * Provides different stop-loss strategies:
 * 1. ATR-based stops - volatility-adjusted stops
 * 2. Trailing stops - lock in profits as price moves
 * 3. Time-based stops - close positions with no movement
 */

export interface StopLossConfig {
    atrMultiplier: number;      // Default 2.0 = 2x ATR
    trailingPercent: number;    // Default 0.02 = 2%
    trailingAtrMultiplier: number; // For ATR-based trailing
    timeoutHours: number;       // Default 24 = close after 24h of no movement
    movementThreshold: number;  // Minimum movement % to reset timeout
    useAtrTrailing: boolean;    // Use ATR-based trailing instead of percentage
}

export interface StopLossState {
    symbol: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    currentStopLoss: number;
    initialStopLoss: number;
    highestPrice: number;       // For BUY positions
    lowestPrice: number;        // For SELL positions
    entryTime: Date;
    lastMovementTime: Date;
    lastSignificantPrice: number;
    isTrailingActive: boolean;
    stopType: 'initial' | 'trailing' | 'breakeven' | 'time_based';
}

export interface StopLossUpdate {
    symbol: string;
    newStopLoss: number;
    previousStopLoss: number;
    stopType: StopLossState['stopType'];
    reason: string;
    shouldClose: boolean;
    closeReason?: string;
}

/**
 * Default configuration for stop-loss management
 */
export const DEFAULT_STOP_CONFIG: StopLossConfig = {
    atrMultiplier: 2.0,
    trailingPercent: 0.02,
    trailingAtrMultiplier: 1.5,
    timeoutHours: 24,
    movementThreshold: 0.005, // 0.5% movement to reset timeout
    useAtrTrailing: true,
};

/**
 * Calculate ATR-based stop loss
 */
export function calculateAtrStopLoss(
    entryPrice: number,
    side: 'BUY' | 'SELL',
    atr: number,
    multiplier: number = 2.0
): number {
    const stopDistance = atr * multiplier;

    if (side === 'BUY') {
        return entryPrice - stopDistance;
    } else {
        return entryPrice + stopDistance;
    }
}

/**
 * Calculate percentage-based trailing stop
 */
export function calculateTrailingStop(
    currentPrice: number,
    side: 'BUY' | 'SELL',
    trailingPercent: number,
    highestPrice: number,
    lowestPrice: number
): number {
    if (side === 'BUY') {
        // For long positions, trail below the highest price
        const referencePrice = Math.max(currentPrice, highestPrice);
        return referencePrice * (1 - trailingPercent);
    } else {
        // For short positions, trail above the lowest price
        const referencePrice = Math.min(currentPrice, lowestPrice);
        return referencePrice * (1 + trailingPercent);
    }
}

/**
 * Calculate ATR-based trailing stop
 */
export function calculateAtrTrailingStop(
    currentPrice: number,
    side: 'BUY' | 'SELL',
    atr: number,
    multiplier: number,
    highestPrice: number,
    lowestPrice: number
): number {
    const trailDistance = atr * multiplier;

    if (side === 'BUY') {
        const referencePrice = Math.max(currentPrice, highestPrice);
        return referencePrice - trailDistance;
    } else {
        const referencePrice = Math.min(currentPrice, lowestPrice);
        return referencePrice + trailDistance;
    }
}

/**
 * Calculate breakeven stop (move stop to entry after X% profit)
 */
export function calculateBreakevenStop(
    entryPrice: number,
    currentPrice: number,
    side: 'BUY' | 'SELL',
    breakevenThreshold: number = 0.01 // 1% profit to move to breakeven
): { shouldActivate: boolean; stopLoss: number } {
    const profitPercent = side === 'BUY'
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice;

    if (profitPercent >= breakevenThreshold) {
        // Add small buffer to account for fees/slippage
        const buffer = entryPrice * 0.001; // 0.1% buffer
        const stopLoss = side === 'BUY'
            ? entryPrice + buffer
            : entryPrice - buffer;

        return { shouldActivate: true, stopLoss };
    }

    return { shouldActivate: false, stopLoss: entryPrice };
}

/**
 * Dynamic Stops Manager - manages stop losses for multiple positions
 */
export class DynamicStopsManager {
    private positions: Map<string, StopLossState> = new Map();
    private config: StopLossConfig;

    constructor(config?: Partial<StopLossConfig>) {
        this.config = { ...DEFAULT_STOP_CONFIG, ...config };
    }

    /**
     * Initialize a new position with stop loss tracking
     */
    initializePosition(
        symbol: string,
        side: 'BUY' | 'SELL',
        entryPrice: number,
        initialStopLoss: number
    ): StopLossState {
        const state: StopLossState = {
            symbol,
            side,
            entryPrice,
            currentStopLoss: initialStopLoss,
            initialStopLoss,
            highestPrice: side === 'BUY' ? entryPrice : Infinity,
            lowestPrice: side === 'SELL' ? entryPrice : 0,
            entryTime: new Date(),
            lastMovementTime: new Date(),
            lastSignificantPrice: entryPrice,
            isTrailingActive: false,
            stopType: 'initial',
        };

        this.positions.set(symbol, state);
        return state;
    }

    /**
     * Update position with new price data
     * Returns updated stop loss or close signal
     */
    updatePosition(
        symbol: string,
        currentPrice: number,
        atr?: number
    ): StopLossUpdate | null {
        const state = this.positions.get(symbol);
        if (!state) return null;

        const previousStopLoss = state.currentStopLoss;
        let newStopLoss = state.currentStopLoss;
        let stopType = state.stopType;
        let reason = '';
        let shouldClose = false;
        let closeReason: string | undefined;

        // Update high/low tracking
        if (state.side === 'BUY') {
            state.highestPrice = Math.max(state.highestPrice, currentPrice);
        } else {
            state.lowestPrice = Math.min(state.lowestPrice, currentPrice);
        }

        // Check for significant movement (reset timeout)
        const movementPercent = Math.abs(currentPrice - state.lastSignificantPrice) / state.lastSignificantPrice;
        if (movementPercent >= this.config.movementThreshold) {
            state.lastMovementTime = new Date();
            state.lastSignificantPrice = currentPrice;
        }

        // Check time-based stop
        const hoursSinceMovement = (Date.now() - state.lastMovementTime.getTime()) / (1000 * 60 * 60);
        if (hoursSinceMovement >= this.config.timeoutHours) {
            shouldClose = true;
            closeReason = `Time-based stop: No significant movement for ${this.config.timeoutHours} hours`;
            stopType = 'time_based';
        }

        // Check if stop loss hit
        if (!shouldClose) {
            if (state.side === 'BUY' && currentPrice <= state.currentStopLoss) {
                shouldClose = true;
                closeReason = `Stop loss hit at ${state.currentStopLoss.toFixed(2)}`;
            } else if (state.side === 'SELL' && currentPrice >= state.currentStopLoss) {
                shouldClose = true;
                closeReason = `Stop loss hit at ${state.currentStopLoss.toFixed(2)}`;
            }
        }

        // If not closing, check for stop loss updates
        if (!shouldClose) {
            // Check breakeven activation
            if (!state.isTrailingActive) {
                const breakeven = calculateBreakevenStop(
                    state.entryPrice,
                    currentPrice,
                    state.side
                );

                if (breakeven.shouldActivate) {
                    // Only move stop if it improves position
                    if (state.side === 'BUY' && breakeven.stopLoss > state.currentStopLoss) {
                        newStopLoss = breakeven.stopLoss;
                        stopType = 'breakeven';
                        reason = 'Moved to breakeven after reaching profit threshold';
                        state.isTrailingActive = true;
                    } else if (state.side === 'SELL' && breakeven.stopLoss < state.currentStopLoss) {
                        newStopLoss = breakeven.stopLoss;
                        stopType = 'breakeven';
                        reason = 'Moved to breakeven after reaching profit threshold';
                        state.isTrailingActive = true;
                    }
                }
            }

            // Calculate trailing stop (only if trailing is active)
            if (state.isTrailingActive) {
                let trailingStop: number;

                if (this.config.useAtrTrailing && atr && atr > 0) {
                    trailingStop = calculateAtrTrailingStop(
                        currentPrice,
                        state.side,
                        atr,
                        this.config.trailingAtrMultiplier,
                        state.highestPrice,
                        state.lowestPrice
                    );
                } else {
                    trailingStop = calculateTrailingStop(
                        currentPrice,
                        state.side,
                        this.config.trailingPercent,
                        state.highestPrice,
                        state.lowestPrice
                    );
                }

                // Only update if trailing stop is better than current stop
                if (state.side === 'BUY' && trailingStop > newStopLoss) {
                    newStopLoss = trailingStop;
                    stopType = 'trailing';
                    reason = `Trailing stop moved up following price (high: ${state.highestPrice.toFixed(2)})`;
                } else if (state.side === 'SELL' && trailingStop < newStopLoss) {
                    newStopLoss = trailingStop;
                    stopType = 'trailing';
                    reason = `Trailing stop moved down following price (low: ${state.lowestPrice.toFixed(2)})`;
                }
            }
        }

        // Update state
        state.currentStopLoss = newStopLoss;
        state.stopType = stopType;

        // Only return update if something changed
        if (newStopLoss !== previousStopLoss || shouldClose) {
            return {
                symbol,
                newStopLoss,
                previousStopLoss,
                stopType,
                reason: reason || `Stop maintained at ${newStopLoss.toFixed(2)}`,
                shouldClose,
                closeReason,
            };
        }

        return null;
    }

    /**
     * Remove position from tracking
     */
    removePosition(symbol: string): void {
        this.positions.delete(symbol);
    }

    /**
     * Get current state for a position
     */
    getPositionState(symbol: string): StopLossState | undefined {
        return this.positions.get(symbol);
    }

    /**
     * Get all positions
     */
    getAllPositions(): Map<string, StopLossState> {
        return new Map(this.positions);
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<StopLossConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current configuration
     */
    getConfig(): StopLossConfig {
        return { ...this.config };
    }

    /**
     * Check all positions for time-based closures
     * Returns list of positions that should be closed
     */
    checkTimeBasedStops(): StopLossUpdate[] {
        const closures: StopLossUpdate[] = [];

        for (const [symbol, state] of this.positions) {
            const hoursSinceMovement = (Date.now() - state.lastMovementTime.getTime()) / (1000 * 60 * 60);

            if (hoursSinceMovement >= this.config.timeoutHours) {
                closures.push({
                    symbol,
                    newStopLoss: state.currentStopLoss,
                    previousStopLoss: state.currentStopLoss,
                    stopType: 'time_based',
                    reason: `No significant movement for ${hoursSinceMovement.toFixed(1)} hours`,
                    shouldClose: true,
                    closeReason: `Time-based stop triggered after ${this.config.timeoutHours} hours`,
                });
            }
        }

        return closures;
    }

    /**
     * Force activate trailing for a position (e.g., after manual intervention)
     */
    activateTrailing(symbol: string): boolean {
        const state = this.positions.get(symbol);
        if (state) {
            state.isTrailingActive = true;
            return true;
        }
        return false;
    }

    /**
     * Manually update stop loss for a position
     */
    setStopLoss(symbol: string, newStopLoss: number, reason: string = 'Manual update'): StopLossUpdate | null {
        const state = this.positions.get(symbol);
        if (!state) return null;

        const previousStopLoss = state.currentStopLoss;

        // Validate the new stop loss
        if (state.side === 'BUY' && newStopLoss >= state.entryPrice * 1.1) {
            // Don't allow stop above 10% profit for longs
            return null;
        }
        if (state.side === 'SELL' && newStopLoss <= state.entryPrice * 0.9) {
            // Don't allow stop below 10% profit for shorts
            return null;
        }

        state.currentStopLoss = newStopLoss;

        return {
            symbol,
            newStopLoss,
            previousStopLoss,
            stopType: state.stopType,
            reason,
            shouldClose: false,
        };
    }
}

/**
 * Utility function to calculate optimal stop loss based on multiple factors
 */
export function calculateOptimalStopLoss(
    entryPrice: number,
    side: 'BUY' | 'SELL',
    atr: number,
    recentSwingLow?: number,
    recentSwingHigh?: number,
    config: Partial<StopLossConfig> = {}
): { stopLoss: number; method: string } {
    const effectiveConfig = { ...DEFAULT_STOP_CONFIG, ...config };

    // Calculate ATR-based stop
    const atrStop = calculateAtrStopLoss(entryPrice, side, atr, effectiveConfig.atrMultiplier);

    // Calculate swing-based stop if provided
    let swingStop: number | null = null;
    if (side === 'BUY' && recentSwingLow) {
        // Place stop just below recent swing low
        swingStop = recentSwingLow * 0.995; // 0.5% below swing low
    } else if (side === 'SELL' && recentSwingHigh) {
        // Place stop just above recent swing high
        swingStop = recentSwingHigh * 1.005; // 0.5% above swing high
    }

    // Choose the tighter stop (more conservative)
    if (swingStop !== null) {
        if (side === 'BUY') {
            // For longs, higher stop is tighter
            if (swingStop > atrStop) {
                return { stopLoss: swingStop, method: 'swing_low' };
            }
        } else {
            // For shorts, lower stop is tighter
            if (swingStop < atrStop) {
                return { stopLoss: swingStop, method: 'swing_high' };
            }
        }
    }

    return { stopLoss: atrStop, method: 'atr_based' };
}

/**
 * Calculate time remaining before time-based stop triggers
 */
export function getTimeUntilTimeout(
    lastMovementTime: Date,
    timeoutHours: number
): { hoursRemaining: number; isExpired: boolean } {
    const hoursSinceMovement = (Date.now() - lastMovementTime.getTime()) / (1000 * 60 * 60);
    const hoursRemaining = Math.max(0, timeoutHours - hoursSinceMovement);

    return {
        hoursRemaining,
        isExpired: hoursRemaining <= 0,
    };
}
