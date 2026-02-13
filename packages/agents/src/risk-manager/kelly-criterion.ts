/**
 * Kelly Criterion Position Sizing
 * 
 * The Kelly Criterion helps determine optimal position size based on:
 * - Win probability (confidence from AI)
 * - Risk/Reward ratio (based on entry, stop-loss, target)
 * 
 * Formula: f = (bp - q) / b
 * Where:
 *   f = Kelly fraction (% of portfolio to risk)
 *   b = odds (reward/risk ratio)
 *   p = probability of winning
 *   q = probability of losing (1 - p)
 */

export interface KellyInputs {
    winProbability: number; // 0-1 (from AI confidence)
    riskRewardRatio: number; // e.g., 3 means risk $1 to make $3
}

export interface PositionSizingParams {
    portfolioValue: number;
    kellyFraction: number;
    maxRiskPercent: number; // e.g., 0.02 for 2%
    maxPositionPercent: number; // e.g., 0.30 for 30%
}

/**
 * Calculate Kelly Criterion fraction
 * @param winProbability - Probability of winning (0-1)
 * @param riskRewardRatio - Reward/Risk ratio (e.g., 3:1 = 3)
 * @returns Kelly fraction (0-1)
 */
export function calculateKellyFraction(
    winProbability: number,
    riskRewardRatio: number
): number {
    // Validate inputs
    if (winProbability < 0 || winProbability > 1) {
        throw new Error('Win probability must be between 0 and 1');
    }
    if (riskRewardRatio <= 0) {
        throw new Error('Risk/Reward ratio must be positive');
    }

    const p = winProbability;
    const q = 1 - p;
    const b = riskRewardRatio;

    // Kelly formula: f = (bp - q) / b
    const kelly = (b * p - q) / b;

    // Kelly can be negative if expected value is negative
    // In that case, we should not take the trade (return 0)
    return Math.max(0, kelly);
}

/**
 * Calculate Half-Kelly (more conservative)
 * Reduces risk of ruin while still growing capital
 * @param winProbability 
 * @param riskRewardRatio 
 * @returns Half of the Kelly fraction
 */
export function calculateHalfKelly(
    winProbability: number,
    riskRewardRatio: number
): number {
    const fullKelly = calculateKellyFraction(winProbability, riskRewardRatio);
    return fullKelly * 0.5;
}

/**
 * Calculate risk/reward ratio from prices
 * @param entryPrice 
 * @param stopLoss 
 * @param target 
 * @returns Risk/Reward ratio
 */
export function calculateRiskRewardRatio(
    entryPrice: number,
    stopLoss: number,
    target: number
): number {
    const risk = Math.abs(entryPrice - stopLoss);
    const reward = Math.abs(target - entryPrice);

    if (risk === 0) {
        throw new Error('Risk cannot be zero (entry price = stop loss)');
    }

    return reward / risk;
}

/**
 * Calculate optimal position size in USD
 * @param params Position sizing parameters
 * @returns Position size in USD
 */
export function calculatePositionSize(params: PositionSizingParams): number {
    const { portfolioValue, kellyFraction, maxRiskPercent, maxPositionPercent } = params;

    // Start with Kelly suggestion
    let positionSize = portfolioValue * kellyFraction;

    // Apply max risk limit (e.g., never risk more than 2% of portfolio)
    const maxRiskAmount = portfolioValue * maxRiskPercent;
    if (positionSize > maxRiskAmount) {
        positionSize = maxRiskAmount;
    }

    // Apply max position size limit (e.g., never more than 30% of portfolio in one position)
    const maxPositionAmount = portfolioValue * maxPositionPercent;
    if (positionSize > maxPositionAmount) {
        positionSize = maxPositionAmount;
    }

    return positionSize;
}

/**
 * Calculate position size in units (e.g., BTC quantity)
 * @param usdAmount - Position size in USD
 * @param entryPrice - Entry price
 * @param stopLoss - Stop loss price
 * @returns Position size in units
 */
export function calculatePositionUnits(
    usdAmount: number,
    entryPrice: number,
    stopLoss: number
): number {
    // How much we're risking per unit
    const riskPerUnit = Math.abs(entryPrice - stopLoss);

    if (riskPerUnit === 0) {
        throw new Error('Risk per unit cannot be zero');
    }

    // Position size = USD amount we're willing to risk / risk per unit
    const units = usdAmount / riskPerUnit;

    return units;
}

/**
 * Get human-readable explanation of Kelly calculation
 */
export function explainKellyCalculation(inputs: KellyInputs): string {
    const { winProbability, riskRewardRatio } = inputs;
    const kelly = calculateKellyFraction(winProbability, riskRewardRatio);
    const halfKelly = kelly * 0.5;

    return [
        `Kelly Criterion Analysis:`,
        `- Win Probability: ${(winProbability * 100).toFixed(1)}%`,
        `- Risk/Reward Ratio: ${riskRewardRatio.toFixed(2)}:1`,
        `- Full Kelly: ${(kelly * 100).toFixed(2)}%`,
        `- Half Kelly (recommended): ${(halfKelly * 100).toFixed(2)}%`,
        kelly === 0 ? '⚠️ Expected value is negative - DO NOT TRADE' : '',
    ]
        .filter(Boolean)
        .join('\n');
}
