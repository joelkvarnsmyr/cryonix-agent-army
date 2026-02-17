import { BaseAgent } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import {
    calculateHalfKelly,
    calculateRiskRewardRatio,
    calculatePositionSize,
    calculatePositionUnits,
    type KellyInputs,
    type PositionSizingParams,
} from './kelly-criterion';

export interface RiskCheckRequest {
    symbol: string;
    side: 'BUY' | 'SELL';
    confidence: number; // 0-1 from AI
    entry_price: number;
    stop_loss: number;
    target_price: number;
    atr?: number; // Optional ATR for dynamic stops
    currentVolatility?: number; // Current market volatility (e.g., from VIX or historical vol)
}

export interface RiskCheck {
    name: string;
    passed: boolean;
    message: string;
    severity: 'info' | 'warning' | 'blocker';
}

export interface RiskCheckResult {
    approved: boolean;
    position_size: number; // in units (e.g., BTC)
    position_value: number; // in USD
    risk_amount: number; // USD at risk
    kelly_fraction: number;
    reasoning: string;
    checks: RiskCheck[];
    warnings: string[];
    blockers: string[];
    limits: {
        portfolio_exposure: string;
        daily_loss_remaining: string;
        weekly_loss_remaining: string;
        open_positions: number;
    };
    adjustments?: {
        adjusted_stop_loss?: number;
        adjusted_target?: number;
        correlation_warning?: string;
    };
}

export interface RiskLimits {
    dailyLossLimit: number;  // 0.03 = 3% soft cap (warning)
    dailyHardLimit: number;  // 0.10 = 10% hard cap (block)
    weeklyLossLimit: number; // 0.08 = 8% soft cap (warning)
    weeklyHardLimit: number; // 0.15 = 15% hard cap (block)
    maxOpenPositions: number; // 5
    maxCorrelation: number;  // 0.7
    volatilityThreshold: number; // 0.05 = 5% volatility threshold
    cooldownMinutes: number; // 15 minutes after a loss
}

interface RiskManagerConfig {
    maxPortfolioRisk: number; // 0.10 = 10% max drawdown
    maxPositionRisk: number; // 0.02 = 2% per trade
    maxPositionSize: number; // 0.30 = 30% of portfolio
    maxOpenPositions: number; // 5
    dailyLossLimit: number; // 0.10 = 10% (HARD STOP)
    dailySoftLimit: number; // 0.03 = 3% (soft warning)
    weeklyLossLimit: number; // 0.15 = 15% (HARD STOP)
    weeklySoftLimit: number; // 0.08 = 8% (soft warning)
    useHalfKelly: boolean; // true for conservative
    atrStopMultiplier: number; // 2.0 = 2x ATR for stops
    atrTargetMultiplier: number; // 3.0 = 3x ATR for targets
    enableCircuitBreaker: boolean;
    circuitBreakerThreshold: number; // 0.05 = 5% rapid loss
    circuitBreakerWindowMinutes: number; // 30 minutes
    maxCorrelatedExposure: number; // 0.50 = 50% max in correlated assets
    cooldownAfterLossMinutes: number; // 15 minutes after a losing trade
    volatilityThreshold: number; // 0.05 = 5% threshold for volatility circuit breaker
    maxCorrelation: number; // 0.7 max correlation between positions
}

interface PositionRecord {
    symbol: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    quantity: number;
    value: number;
    entryTime: Date;
    correlationGroup?: string;
}

interface LossEvent {
    timestamp: Date;
    amount: number;
    percentOfPortfolio: number;
}

// Asset correlation groups for crypto
const CORRELATION_GROUPS: Record<string, string> = {
    'BTC/USDT': 'btc_ecosystem',
    'WBTC/USDT': 'btc_ecosystem',
    'ETH/USDT': 'eth_ecosystem',
    'STETH/USDT': 'eth_ecosystem',
    'OP/USDT': 'eth_ecosystem',
    'ARB/USDT': 'eth_ecosystem',
    'MATIC/USDT': 'eth_ecosystem',
    'SOL/USDT': 'sol_ecosystem',
    'JTO/USDT': 'sol_ecosystem',
    'BONK/USDT': 'sol_ecosystem',
    'BNB/USDT': 'bnb_ecosystem',
    'CAKE/USDT': 'bnb_ecosystem',
    'DOGE/USDT': 'meme_coins',
    'SHIB/USDT': 'meme_coins',
    'PEPE/USDT': 'meme_coins',
    'LINK/USDT': 'oracles',
    'BAND/USDT': 'oracles',
    'AAVE/USDT': 'defi',
    'COMP/USDT': 'defi',
    'UNI/USDT': 'defi',
    'AVAX/USDT': 'alt_l1',
    'NEAR/USDT': 'alt_l1',
    'ADA/USDT': 'alt_l1',
    'DOT/USDT': 'alt_l1',
};

// Correlation matrix between groups (simplified)
const GROUP_CORRELATIONS: Record<string, Record<string, number>> = {
    'btc_ecosystem': { 'eth_ecosystem': 0.85, 'sol_ecosystem': 0.75, 'alt_l1': 0.70, 'defi': 0.65, 'meme_coins': 0.50, 'oracles': 0.60, 'bnb_ecosystem': 0.70 },
    'eth_ecosystem': { 'btc_ecosystem': 0.85, 'sol_ecosystem': 0.70, 'alt_l1': 0.75, 'defi': 0.80, 'meme_coins': 0.45, 'oracles': 0.70, 'bnb_ecosystem': 0.65 },
    'sol_ecosystem': { 'btc_ecosystem': 0.75, 'eth_ecosystem': 0.70, 'alt_l1': 0.65, 'defi': 0.55, 'meme_coins': 0.60, 'oracles': 0.50, 'bnb_ecosystem': 0.55 },
    'alt_l1': { 'btc_ecosystem': 0.70, 'eth_ecosystem': 0.75, 'sol_ecosystem': 0.65, 'defi': 0.60, 'meme_coins': 0.40, 'oracles': 0.55, 'bnb_ecosystem': 0.60 },
    'defi': { 'btc_ecosystem': 0.65, 'eth_ecosystem': 0.80, 'sol_ecosystem': 0.55, 'alt_l1': 0.60, 'meme_coins': 0.35, 'oracles': 0.65, 'bnb_ecosystem': 0.50 },
    'meme_coins': { 'btc_ecosystem': 0.50, 'eth_ecosystem': 0.45, 'sol_ecosystem': 0.60, 'alt_l1': 0.40, 'defi': 0.35, 'oracles': 0.30, 'bnb_ecosystem': 0.40 },
    'oracles': { 'btc_ecosystem': 0.60, 'eth_ecosystem': 0.70, 'sol_ecosystem': 0.50, 'alt_l1': 0.55, 'defi': 0.65, 'meme_coins': 0.30, 'bnb_ecosystem': 0.50 },
    'bnb_ecosystem': { 'btc_ecosystem': 0.70, 'eth_ecosystem': 0.65, 'sol_ecosystem': 0.55, 'alt_l1': 0.60, 'defi': 0.50, 'meme_coins': 0.40, 'oracles': 0.50 },
};

export class RiskManagerAgent extends BaseAgent {
    private riskConfig: RiskManagerConfig;
    private dailyStartingValue: number = 0;
    private weeklyStartingValue: number = 0;
    private currentPortfolioValue: number = 0;
    private openPositions: Map<string, PositionRecord> = new Map();
    private dailyLoss: number = 0;
    private weeklyLoss: number = 0;
    private recentLosses: LossEvent[] = [];
    private circuitBreakerActive: boolean = false;
    private circuitBreakerUntil: Date | null = null;
    private lastWeekReset: Date = new Date();
    private lastDailyReset: Date = new Date();
    private lastLossTime: Date | null = null;
    private cooldownActive: boolean = false;
    private cooldownUntil: Date | null = null;
    private currentVolatility: number = 0;

    constructor(config?: Partial<RiskManagerConfig>) {
        super({
            id: 'risk_manager',
            name: 'Risk Manager Agent',
            description: 'Kelly Criterion position sizing and advanced portfolio risk management',
            enabled: true,
        });

        // Conservative defaults with new features
        this.riskConfig = {
            maxPortfolioRisk: 0.10, // 10% max portfolio drawdown
            maxPositionRisk: 0.02, // 2% risk per trade (HARD CAP)
            maxPositionSize: 0.30, // 30% max position size
            maxOpenPositions: 5,
            dailyLossLimit: 0.10, // 10% daily loss = emergency stop (HARD)
            dailySoftLimit: 0.03, // 3% daily loss = warning (SOFT)
            weeklyLossLimit: 0.15, // 15% weekly loss limit (HARD)
            weeklySoftLimit: 0.08, // 8% weekly loss = warning (SOFT)
            useHalfKelly: true, // Use half-Kelly by default
            atrStopMultiplier: 2.0, // 2x ATR for dynamic stops
            atrTargetMultiplier: 3.0, // 3x ATR for targets
            enableCircuitBreaker: true,
            circuitBreakerThreshold: 0.05, // 5% rapid loss
            circuitBreakerWindowMinutes: 30,
            maxCorrelatedExposure: 0.50, // Max 50% in correlated assets
            cooldownAfterLossMinutes: 15, // 15 minutes cooldown after loss
            volatilityThreshold: 0.05, // 5% volatility threshold
            maxCorrelation: 0.7, // Max 0.7 correlation between positions
            ...config,
        };
    }

    async initialize(): Promise<void> {
        this.log('info', 'Initializing Risk Manager Agent...');
        this.log('info', 'Risk Configuration:', this.riskConfig);
        this.setStatus('idle');
    }

    async start(): Promise<void> {
        this.log('info', 'Starting Risk Manager Agent...');
        this.setStatus('running');

        // Initialize daily/weekly tracking
        await this.resetDailyMetrics();
        await this.checkWeeklyReset();

        // Start automatic reset scheduler
        this.scheduleDailyReset();
    }

    async stop(): Promise<void> {
        this.log('info', 'Stopping Risk Manager Agent...');
        this.setStatus('idle');
    }

    /**
     * Schedule automatic daily reset at midnight UTC
     */
    private scheduleDailyReset(): void {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(0, 0, 0, 0);

        const msUntilMidnight = tomorrow.getTime() - now.getTime();

        setTimeout(async () => {
            await this.resetDailyMetrics();
            this.scheduleDailyReset(); // Schedule next reset
        }, msUntilMidnight);

        this.log('info', `Daily reset scheduled in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);
    }

    async handleMessage(message: AgentMessage): Promise<void> {
        this.log('info', `Received message: ${message.message_type}`, message);

        if (message.message_type === 'RISK_CHECK') {
            const request = message.data as RiskCheckRequest;
            const result = await this.checkSignalRisk(request);
            this.emit('risk_check_complete', result);
        } else if (message.message_type === 'POSITION_OPENED') {
            const position = message.data as PositionRecord;
            this.recordPosition(position);
        } else if (message.message_type === 'POSITION_CLOSED') {
            const { symbol, pnl } = message.data;
            this.closePosition(symbol, pnl);
        } else if (message.message_type === 'RESET_CIRCUIT_BREAKER') {
            this.resetCircuitBreaker();
        } else if (message.message_type === 'VOLATILITY_UPDATE') {
            this.currentVolatility = message.data.volatility;
        }
    }

    /**
     * Main risk check function - validates signal and calculates position size
     */
    async checkSignalRisk(request: RiskCheckRequest): Promise<RiskCheckResult> {
        this.log('info', 'Checking risk for signal:', request);

        const checks: RiskCheck[] = [];
        const warnings: string[] = [];
        const blockers: string[] = [];

        // Update portfolio metrics
        await this.updatePortfolioMetrics();
        await this.checkDailyReset();
        await this.checkWeeklyReset();

        // Update volatility if provided
        if (request.currentVolatility !== undefined) {
            this.currentVolatility = request.currentVolatility;
        }

        // ===========================================
        // BLOCKER CHECKS (will reject the trade)
        // ===========================================

        // Check circuit breaker
        const circuitBreakerCheck = this.checkCircuitBreakerStatus();
        checks.push(circuitBreakerCheck);
        if (!circuitBreakerCheck.passed) {
            blockers.push(circuitBreakerCheck.message);
        }

        // Check cooldown period
        const cooldownCheck = this.checkCooldownPeriod();
        checks.push(cooldownCheck);
        if (!cooldownCheck.passed) {
            blockers.push(cooldownCheck.message);
        }

        // Check daily hard limit
        const dailyHardCheck = this.checkDailyHardLimit();
        checks.push(dailyHardCheck);
        if (!dailyHardCheck.passed) {
            blockers.push(dailyHardCheck.message);
        }

        // Check weekly hard limit
        const weeklyHardCheck = this.checkWeeklyHardLimit();
        checks.push(weeklyHardCheck);
        if (!weeklyHardCheck.passed) {
            blockers.push(weeklyHardCheck.message);
        }

        // Check volatility circuit breaker
        const volatilityCheck = this.checkVolatilityCircuitBreaker();
        checks.push(volatilityCheck);
        if (!volatilityCheck.passed) {
            blockers.push(volatilityCheck.message);
        }

        // Check max open positions
        const positionsCheck = this.checkMaxOpenPositions();
        checks.push(positionsCheck);
        if (!positionsCheck.passed) {
            blockers.push(positionsCheck.message);
        }

        // Check correlation exposure
        const correlationCheck = this.checkCorrelationExposure(request.symbol);
        checks.push({
            name: 'correlation_exposure',
            passed: correlationCheck.allowed,
            message: correlationCheck.message || 'Correlation exposure within limits',
            severity: correlationCheck.allowed ? (correlationCheck.warning ? 'warning' : 'info') : 'blocker',
        });
        if (!correlationCheck.allowed) {
            blockers.push(correlationCheck.message || 'Correlation limit exceeded');
        }
        if (correlationCheck.warning) {
            warnings.push(correlationCheck.warning);
        }

        // Check cross-correlation between new position and existing positions
        const crossCorrelationCheck = this.checkCrossCorrelation(request.symbol);
        checks.push(crossCorrelationCheck);
        if (!crossCorrelationCheck.passed) {
            blockers.push(crossCorrelationCheck.message);
        } else if (crossCorrelationCheck.severity === 'warning') {
            warnings.push(crossCorrelationCheck.message);
        }

        // ===========================================
        // WARNING CHECKS (will warn but still allow)
        // ===========================================

        // Check daily soft limit
        const dailySoftCheck = this.checkDailySoftLimit();
        checks.push(dailySoftCheck);
        if (!dailySoftCheck.passed) {
            warnings.push(dailySoftCheck.message);
        }

        // Check weekly soft limit
        const weeklySoftCheck = this.checkWeeklySoftLimit();
        checks.push(weeklySoftCheck);
        if (!weeklySoftCheck.passed) {
            warnings.push(weeklySoftCheck.message);
        }

        // If there are any blockers, reject the signal
        if (blockers.length > 0) {
            return this.rejectSignalWithChecks(
                blockers[0],
                request,
                checks,
                warnings,
                blockers
            );
        }

        // Calculate ATR-adjusted stops if ATR provided
        let adjustedStopLoss = request.stop_loss;
        let adjustedTarget = request.target_price;

        if (request.atr && request.atr > 0) {
            const atrAdjustments = this.calculateAtrAdjustedLevels(
                request.entry_price,
                request.side,
                request.atr
            );

            // Use ATR-based levels if they provide better risk/reward
            if (request.side === 'BUY') {
                if (atrAdjustments.stopLoss < adjustedStopLoss) {
                    adjustedStopLoss = atrAdjustments.stopLoss;
                }
                if (atrAdjustments.target > adjustedTarget) {
                    adjustedTarget = atrAdjustments.target;
                }
            } else {
                if (atrAdjustments.stopLoss > adjustedStopLoss) {
                    adjustedStopLoss = atrAdjustments.stopLoss;
                }
                if (atrAdjustments.target < adjustedTarget) {
                    adjustedTarget = atrAdjustments.target;
                }
            }
        }

        // Calculate risk/reward ratio with potentially adjusted levels
        const rrRatio = calculateRiskRewardRatio(
            request.entry_price,
            adjustedStopLoss,
            adjustedTarget
        );

        // Risk/Reward check
        const rrCheck: RiskCheck = {
            name: 'risk_reward_ratio',
            passed: rrRatio >= 1.5,
            message: rrRatio >= 1.5
                ? `Risk/Reward ${rrRatio.toFixed(2)}:1 is acceptable`
                : `Poor risk/reward ratio (${rrRatio.toFixed(2)}:1, minimum 1.5:1)`,
            severity: rrRatio >= 1.5 ? 'info' : 'blocker',
        };
        checks.push(rrCheck);
        if (!rrCheck.passed) {
            blockers.push(rrCheck.message);
            return this.rejectSignalWithChecks(rrCheck.message, request, checks, warnings, blockers);
        }

        // Kelly Criterion calculation
        const kellyInputs: KellyInputs = {
            winProbability: request.confidence,
            riskRewardRatio: rrRatio,
        };

        let kellyFraction = calculateHalfKelly(
            kellyInputs.winProbability,
            kellyInputs.riskRewardRatio
        );

        // If not using half-Kelly, use full Kelly
        if (!this.riskConfig.useHalfKelly) {
            kellyFraction = kellyFraction * 2;
        }

        // Kelly check
        const kellyCheck: RiskCheck = {
            name: 'kelly_criterion',
            passed: kellyFraction > 0,
            message: kellyFraction > 0
                ? `Kelly suggests ${(kellyFraction * 100).toFixed(2)}% allocation`
                : 'Negative expected value - Kelly suggests no trade',
            severity: kellyFraction > 0 ? 'info' : 'blocker',
        };
        checks.push(kellyCheck);
        if (!kellyCheck.passed) {
            blockers.push(kellyCheck.message);
            return this.rejectSignalWithChecks(kellyCheck.message, request, checks, warnings, blockers);
        }

        // Apply position sizing with safety caps
        const positionSizingParams: PositionSizingParams = {
            portfolioValue: this.currentPortfolioValue,
            kellyFraction,
            maxRiskPercent: this.riskConfig.maxPositionRisk,
            maxPositionPercent: this.riskConfig.maxPositionSize,
        };

        let riskAmountUsd = calculatePositionSize(positionSizingParams);

        // Calculate position size in units
        let positionUnits = calculatePositionUnits(
            riskAmountUsd,
            request.entry_price,
            adjustedStopLoss
        );

        // Calculate actual position value
        let positionValue = positionUnits * request.entry_price;

        // Check if position value exceeds max position size
        const positionPercent = positionValue / this.currentPortfolioValue;

        if (positionPercent > this.riskConfig.maxPositionSize) {
            const maxVal = this.currentPortfolioValue * this.riskConfig.maxPositionSize;
            const scale = maxVal / positionValue;

            this.log('warn', `Position capped at max size (${(this.riskConfig.maxPositionSize * 100).toFixed(0)}%)`, {
                originalValue: positionValue,
                cappedValue: maxVal,
                scale
            });

            // Scale everything down
            positionValue = maxVal;
            positionUnits *= scale;
            riskAmountUsd *= scale;

            warnings.push(`Position size capped at ${(this.riskConfig.maxPositionSize * 100).toFixed(0)}% of portfolio`);
        }

        // Build reasoning
        const reasoning = this.buildReasoning(
            kellyInputs,
            kellyFraction,
            riskAmountUsd,
            positionValue,
            rrRatio,
            request.atr,
            warnings
        );

        // Calculate limits for response
        const portfolioExposure = (positionValue / this.currentPortfolioValue) * 100;
        const dailyLossRemaining =
            (this.riskConfig.dailyLossLimit - this.dailyLoss / this.dailyStartingValue) * 100;
        const weeklyLossRemaining =
            (this.riskConfig.weeklyLossLimit - this.weeklyLoss / this.weeklyStartingValue) * 100;

        const result: RiskCheckResult = {
            approved: true,
            position_size: positionUnits,
            position_value: positionValue,
            risk_amount: riskAmountUsd,
            kelly_fraction: kellyFraction,
            reasoning,
            checks,
            warnings,
            blockers: [],
            limits: {
                portfolio_exposure: `${portfolioExposure.toFixed(1)}%`,
                daily_loss_remaining: `${dailyLossRemaining.toFixed(1)}%`,
                weekly_loss_remaining: `${weeklyLossRemaining.toFixed(1)}%`,
                open_positions: this.openPositions.size,
            },
            adjustments: {
                adjusted_stop_loss: adjustedStopLoss !== request.stop_loss ? adjustedStopLoss : undefined,
                adjusted_target: adjustedTarget !== request.target_price ? adjustedTarget : undefined,
                correlation_warning: correlationCheck.warning,
            },
        };

        this.log('info', 'Risk check APPROVED', result);
        return result;
    }

    /**
     * Check circuit breaker status
     */
    private checkCircuitBreakerStatus(): RiskCheck {
        const isActive = this.isCircuitBreakerActive();
        return {
            name: 'circuit_breaker',
            passed: !isActive,
            message: isActive
                ? `CIRCUIT BREAKER active until ${this.circuitBreakerUntil?.toISOString()}`
                : 'Circuit breaker inactive',
            severity: isActive ? 'blocker' : 'info',
        };
    }

    /**
     * Check cooldown period after loss
     */
    private checkCooldownPeriod(): RiskCheck {
        if (!this.cooldownActive || !this.cooldownUntil) {
            return {
                name: 'cooldown_period',
                passed: true,
                message: 'No cooldown active',
                severity: 'info',
            };
        }

        if (new Date() >= this.cooldownUntil) {
            this.cooldownActive = false;
            this.cooldownUntil = null;
            return {
                name: 'cooldown_period',
                passed: true,
                message: 'Cooldown period expired',
                severity: 'info',
            };
        }

        const remainingMs = this.cooldownUntil.getTime() - Date.now();
        const remainingMins = Math.ceil(remainingMs / 60000);
        return {
            name: 'cooldown_period',
            passed: false,
            message: `Cooldown active: ${remainingMins} minutes remaining after recent loss`,
            severity: 'blocker',
        };
    }

    /**
     * Check daily hard limit (10% - blocks trading)
     */
    private checkDailyHardLimit(): RiskCheck {
        if (this.dailyStartingValue === 0) {
            return { name: 'daily_hard_limit', passed: true, message: 'Daily limit check skipped (no starting value)', severity: 'info' };
        }
        const dailyLossPercent = this.dailyLoss / this.dailyStartingValue;
        const exceeded = dailyLossPercent >= this.riskConfig.dailyLossLimit;

        return {
            name: 'daily_hard_limit',
            passed: !exceeded,
            message: exceeded
                ? `DAILY HARD LIMIT EXCEEDED: ${(dailyLossPercent * 100).toFixed(2)}% >= ${(this.riskConfig.dailyLossLimit * 100).toFixed(0)}%`
                : `Daily loss at ${(dailyLossPercent * 100).toFixed(2)}% (hard limit: ${(this.riskConfig.dailyLossLimit * 100).toFixed(0)}%)`,
            severity: exceeded ? 'blocker' : 'info',
        };
    }

    /**
     * Check daily soft limit (3% - warning)
     */
    private checkDailySoftLimit(): RiskCheck {
        if (this.dailyStartingValue === 0) {
            return { name: 'daily_soft_limit', passed: true, message: 'Daily soft limit check skipped', severity: 'info' };
        }
        const dailyLossPercent = this.dailyLoss / this.dailyStartingValue;
        const exceeded = dailyLossPercent >= this.riskConfig.dailySoftLimit;

        return {
            name: 'daily_soft_limit',
            passed: !exceeded,
            message: exceeded
                ? `WARNING: Daily soft limit reached: ${(dailyLossPercent * 100).toFixed(2)}% >= ${(this.riskConfig.dailySoftLimit * 100).toFixed(0)}%`
                : `Daily loss at ${(dailyLossPercent * 100).toFixed(2)}% (soft limit: ${(this.riskConfig.dailySoftLimit * 100).toFixed(0)}%)`,
            severity: exceeded ? 'warning' : 'info',
        };
    }

    /**
     * Check weekly hard limit (15% - blocks trading)
     */
    private checkWeeklyHardLimit(): RiskCheck {
        if (this.weeklyStartingValue === 0) {
            return { name: 'weekly_hard_limit', passed: true, message: 'Weekly limit check skipped (no starting value)', severity: 'info' };
        }
        const weeklyLossPercent = this.weeklyLoss / this.weeklyStartingValue;
        const exceeded = weeklyLossPercent >= this.riskConfig.weeklyLossLimit;

        return {
            name: 'weekly_hard_limit',
            passed: !exceeded,
            message: exceeded
                ? `WEEKLY HARD LIMIT EXCEEDED: ${(weeklyLossPercent * 100).toFixed(2)}% >= ${(this.riskConfig.weeklyLossLimit * 100).toFixed(0)}%`
                : `Weekly loss at ${(weeklyLossPercent * 100).toFixed(2)}% (hard limit: ${(this.riskConfig.weeklyLossLimit * 100).toFixed(0)}%)`,
            severity: exceeded ? 'blocker' : 'info',
        };
    }

    /**
     * Check weekly soft limit (8% - warning)
     */
    private checkWeeklySoftLimit(): RiskCheck {
        if (this.weeklyStartingValue === 0) {
            return { name: 'weekly_soft_limit', passed: true, message: 'Weekly soft limit check skipped', severity: 'info' };
        }
        const weeklyLossPercent = this.weeklyLoss / this.weeklyStartingValue;
        const exceeded = weeklyLossPercent >= this.riskConfig.weeklySoftLimit;

        return {
            name: 'weekly_soft_limit',
            passed: !exceeded,
            message: exceeded
                ? `WARNING: Weekly soft limit reached: ${(weeklyLossPercent * 100).toFixed(2)}% >= ${(this.riskConfig.weeklySoftLimit * 100).toFixed(0)}%`
                : `Weekly loss at ${(weeklyLossPercent * 100).toFixed(2)}% (soft limit: ${(this.riskConfig.weeklySoftLimit * 100).toFixed(0)}%)`,
            severity: exceeded ? 'warning' : 'info',
        };
    }

    /**
     * Check volatility circuit breaker
     */
    private checkVolatilityCircuitBreaker(): RiskCheck {
        if (this.currentVolatility === 0) {
            return {
                name: 'volatility_circuit_breaker',
                passed: true,
                message: 'Volatility data not available',
                severity: 'info',
            };
        }

        const exceeded = this.currentVolatility >= this.riskConfig.volatilityThreshold;
        return {
            name: 'volatility_circuit_breaker',
            passed: !exceeded,
            message: exceeded
                ? `VOLATILITY CIRCUIT BREAKER: Market volatility ${(this.currentVolatility * 100).toFixed(2)}% exceeds threshold ${(this.riskConfig.volatilityThreshold * 100).toFixed(0)}%`
                : `Market volatility ${(this.currentVolatility * 100).toFixed(2)}% within acceptable range`,
            severity: exceeded ? 'blocker' : 'info',
        };
    }

    /**
     * Check max open positions
     */
    private checkMaxOpenPositions(): RiskCheck {
        const exceeded = this.openPositions.size >= this.riskConfig.maxOpenPositions;
        return {
            name: 'max_open_positions',
            passed: !exceeded,
            message: exceeded
                ? `Max open positions reached: ${this.openPositions.size}/${this.riskConfig.maxOpenPositions}`
                : `Open positions: ${this.openPositions.size}/${this.riskConfig.maxOpenPositions}`,
            severity: exceeded ? 'blocker' : 'info',
        };
    }

    /**
     * Check cross-correlation between new position and existing positions
     */
    private checkCrossCorrelation(symbol: string): RiskCheck {
        const newGroup = CORRELATION_GROUPS[symbol] || 'uncorrelated';

        if (newGroup === 'uncorrelated' || this.openPositions.size === 0) {
            return {
                name: 'cross_correlation',
                passed: true,
                message: 'No correlation concerns',
                severity: 'info',
            };
        }

        let maxCorrelation = 0;
        let maxCorrelationPair = '';

        for (const [, position] of this.openPositions) {
            const existingGroup = CORRELATION_GROUPS[position.symbol] || 'uncorrelated';
            if (existingGroup === 'uncorrelated') continue;

            if (existingGroup === newGroup) {
                // Same group exposure is handled by checkCorrelationExposure
                continue;
            }

            const groupCorrelations = GROUP_CORRELATIONS[newGroup];
            if (groupCorrelations && groupCorrelations[existingGroup]) {
                const correlation = groupCorrelations[existingGroup];
                if (correlation > maxCorrelation) {
                    maxCorrelation = correlation;
                    maxCorrelationPair = position.symbol;
                }
            }
        }

        if (maxCorrelation >= this.riskConfig.maxCorrelation) {
            return {
                name: 'cross_correlation',
                passed: false,
                message: `High correlation (${(maxCorrelation * 100).toFixed(0)}%) with existing position ${maxCorrelationPair}`,
                severity: 'blocker',
            };
        }

        if (maxCorrelation >= this.riskConfig.maxCorrelation * 0.7) {
            return {
                name: 'cross_correlation',
                passed: true,
                message: `Moderate correlation (${(maxCorrelation * 100).toFixed(0)}%) with ${maxCorrelationPair}`,
                severity: 'warning',
            };
        }

        return {
            name: 'cross_correlation',
            passed: true,
            message: maxCorrelation > 0
                ? `Max correlation ${(maxCorrelation * 100).toFixed(0)}% within acceptable range`
                : 'No significant correlation with existing positions',
            severity: 'info',
        };
    }

    /**
     * Calculate ATR-adjusted stop loss and target
     */
    private calculateAtrAdjustedLevels(
        entryPrice: number,
        side: 'BUY' | 'SELL',
        atr: number
    ): { stopLoss: number; target: number } {
        const stopDistance = atr * this.riskConfig.atrStopMultiplier;
        const targetDistance = atr * this.riskConfig.atrTargetMultiplier;

        if (side === 'BUY') {
            return {
                stopLoss: entryPrice - stopDistance,
                target: entryPrice + targetDistance,
            };
        } else {
            return {
                stopLoss: entryPrice + stopDistance,
                target: entryPrice - targetDistance,
            };
        }
    }

    /**
     * Check correlation exposure before opening new position
     */
    private checkCorrelationExposure(symbol: string): { allowed: boolean; message?: string; warning?: string } {
        const group = CORRELATION_GROUPS[symbol] || 'uncorrelated';

        if (group === 'uncorrelated') {
            return { allowed: true };
        }

        // Calculate current exposure in this correlation group
        let groupExposure = 0;
        for (const [, position] of this.openPositions) {
            const posGroup = CORRELATION_GROUPS[position.symbol] || 'uncorrelated';
            if (posGroup === group) {
                groupExposure += position.value;
            }
        }

        const groupExposurePercent = groupExposure / this.currentPortfolioValue;

        if (groupExposurePercent >= this.riskConfig.maxCorrelatedExposure) {
            return {
                allowed: false,
                message: `${(groupExposurePercent * 100).toFixed(1)}% exposure in ${group}, max ${(this.riskConfig.maxCorrelatedExposure * 100).toFixed(0)}%`,
            };
        }

        // Warn if approaching limit
        if (groupExposurePercent >= this.riskConfig.maxCorrelatedExposure * 0.7) {
            return {
                allowed: true,
                warning: `Approaching correlation limit in ${group} (${(groupExposurePercent * 100).toFixed(1)}%)`,
            };
        }

        return { allowed: true };
    }

    /**
     * Check if circuit breaker should be active
     */
    private isCircuitBreakerActive(): boolean {
        if (!this.riskConfig.enableCircuitBreaker) return false;

        if (this.circuitBreakerActive && this.circuitBreakerUntil) {
            if (new Date() < this.circuitBreakerUntil) {
                return true;
            }
            // Circuit breaker expired
            this.resetCircuitBreaker();
        }

        // Check for rapid losses
        const windowMs = this.riskConfig.circuitBreakerWindowMinutes * 60 * 1000;
        const cutoffTime = new Date(Date.now() - windowMs);

        const recentLossesInWindow = this.recentLosses.filter(
            (loss) => loss.timestamp > cutoffTime
        );

        const totalRecentLoss = recentLossesInWindow.reduce(
            (sum, loss) => sum + loss.percentOfPortfolio,
            0
        );

        if (totalRecentLoss >= this.riskConfig.circuitBreakerThreshold) {
            this.activateCircuitBreaker();
            return true;
        }

        return false;
    }

    /**
     * Activate circuit breaker
     */
    private activateCircuitBreaker(): void {
        this.circuitBreakerActive = true;
        this.circuitBreakerUntil = new Date(
            Date.now() + this.riskConfig.circuitBreakerWindowMinutes * 60 * 1000
        );
        this.log('warn', 'CIRCUIT BREAKER ACTIVATED', {
            until: this.circuitBreakerUntil.toISOString(),
            reason: 'Rapid losses detected',
        });
        this.emit('circuit_breaker_activated', {
            until: this.circuitBreakerUntil,
        });
    }

    /**
     * Reset circuit breaker
     */
    private resetCircuitBreaker(): void {
        this.circuitBreakerActive = false;
        this.circuitBreakerUntil = null;
        this.log('info', 'Circuit breaker reset');
    }

    /**
     * Activate cooldown period after a loss
     */
    private activateCooldown(): void {
        this.cooldownActive = true;
        this.cooldownUntil = new Date(
            Date.now() + this.riskConfig.cooldownAfterLossMinutes * 60 * 1000
        );
        this.lastLossTime = new Date();
        this.log('info', `Cooldown activated until ${this.cooldownUntil.toISOString()}`);
        this.emit('cooldown_activated', {
            until: this.cooldownUntil,
            reason: 'Loss recorded',
        });
    }

    /**
     * Record a new position
     */
    recordPosition(position: PositionRecord): void {
        position.correlationGroup = CORRELATION_GROUPS[position.symbol];
        this.openPositions.set(position.symbol, position);
        this.log('info', 'Position recorded', position);
    }

    /**
     * Close a position and record P&L
     */
    closePosition(symbol: string, pnl: number): void {
        const position = this.openPositions.get(symbol);
        if (!position) return;

        this.openPositions.delete(symbol);

        // Record loss for circuit breaker
        if (pnl < 0) {
            const lossPercent = Math.abs(pnl) / this.currentPortfolioValue;
            this.recentLosses.push({
                timestamp: new Date(),
                amount: Math.abs(pnl),
                percentOfPortfolio: lossPercent,
            });

            // Clean up old losses
            const cutoffTime = new Date(
                Date.now() - this.riskConfig.circuitBreakerWindowMinutes * 60 * 1000
            );
            this.recentLosses = this.recentLosses.filter(
                (loss) => loss.timestamp > cutoffTime
            );

            this.dailyLoss += Math.abs(pnl);
            this.weeklyLoss += Math.abs(pnl);

            // Check and activate circuit breaker immediately if threshold breached
            this.isCircuitBreakerActive();

            // Activate cooldown after a loss
            this.activateCooldown();
        }

        this.log('info', `Position closed: ${symbol}`, { pnl });
    }

    /**
     * Update portfolio metrics from API
     */
    private async updatePortfolioMetrics(): Promise<void> {
        try {
            const portfolioEndpoint = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3003';
            const response = await fetch(`${portfolioEndpoint}/api/portfolio`);
            const data = await response.json() as { success?: boolean; data?: { totalValue: number } };

            if (data.success && data.data) {
                this.currentPortfolioValue = data.data.totalValue;

                if (this.dailyStartingValue === 0) {
                    this.dailyStartingValue = this.currentPortfolioValue;
                }
                if (this.weeklyStartingValue === 0) {
                    this.weeklyStartingValue = this.currentPortfolioValue;
                }

                this.dailyLoss = Math.max(0, this.dailyStartingValue - this.currentPortfolioValue);
                this.weeklyLoss = Math.max(0, this.weeklyStartingValue - this.currentPortfolioValue);

                this.log('info', 'Portfolio metrics updated', {
                    current: this.currentPortfolioValue,
                    dailyStart: this.dailyStartingValue,
                    weeklyStart: this.weeklyStartingValue,
                    dailyLoss: this.dailyLoss,
                    weeklyLoss: this.weeklyLoss,
                });
            }
        } catch (error) {
            this.log('error', 'Failed to update portfolio metrics', error);
            throw new Error('Cannot perform risk check without portfolio data');
        }
    }

    /**
     * Check if we need to reset daily metrics (at midnight UTC)
     */
    private async checkDailyReset(): Promise<void> {
        const now = new Date();
        const lastResetDay = this.lastDailyReset.getUTCDate();
        const currentDay = now.getUTCDate();

        if (lastResetDay !== currentDay) {
            await this.resetDailyMetrics();
        }
    }

    /**
     * Check if we need to reset weekly metrics (at week start - Monday midnight UTC)
     */
    private async checkWeeklyReset(): Promise<void> {
        const now = new Date();
        const daysSinceReset = (now.getTime() - this.lastWeekReset.getTime()) / (1000 * 60 * 60 * 24);

        // Reset every 7 days or on Monday (day 1)
        if (daysSinceReset >= 7 || (now.getUTCDay() === 1 && this.lastWeekReset.getUTCDay() !== 1)) {
            this.weeklyStartingValue = this.currentPortfolioValue;
            this.weeklyLoss = 0;
            this.lastWeekReset = now;
            this.log('info', 'Weekly metrics reset', {
                startingValue: this.weeklyStartingValue,
            });
        }
    }

    /**
     * Reset daily metrics
     */
    async resetDailyMetrics(): Promise<void> {
        await this.updatePortfolioMetrics();
        this.dailyStartingValue = this.currentPortfolioValue;
        this.dailyLoss = 0;
        this.recentLosses = [];
        this.cooldownActive = false;
        this.cooldownUntil = null;
        this.lastDailyReset = new Date();
        this.log('info', 'Daily metrics reset', {
            startingValue: this.dailyStartingValue,
        });
    }

    /**
     * Reject a signal with full check details
     */
    private rejectSignalWithChecks(
        reason: string,
        request: RiskCheckRequest,
        checks: RiskCheck[],
        warnings: string[],
        blockers: string[]
    ): RiskCheckResult {
        this.log('warn', `Signal REJECTED: ${reason}`, request);

        const dailyLossRemaining = this.dailyStartingValue > 0
            ? (this.riskConfig.dailyLossLimit - this.dailyLoss / this.dailyStartingValue) * 100
            : 0;
        const weeklyLossRemaining = this.weeklyStartingValue > 0
            ? (this.riskConfig.weeklyLossLimit - this.weeklyLoss / this.weeklyStartingValue) * 100
            : 0;

        return {
            approved: false,
            position_size: 0,
            position_value: 0,
            risk_amount: 0,
            kelly_fraction: 0,
            reasoning: `REJECTED: ${reason}`,
            checks,
            warnings,
            blockers,
            limits: {
                portfolio_exposure: '0%',
                daily_loss_remaining: `${dailyLossRemaining.toFixed(1)}%`,
                weekly_loss_remaining: `${weeklyLossRemaining.toFixed(1)}%`,
                open_positions: this.openPositions.size,
            },
        };
    }

    /**
     * Build human-readable reasoning
     */
    private buildReasoning(
        kellyInputs: KellyInputs,
        kellyFraction: number,
        riskAmount: number,
        positionValue: number,
        rrRatio: number,
        atr?: number,
        warnings?: string[]
    ): string {
        const lines = [
            `APPROVED`,
            ``,
            `Kelly Analysis:`,
            `- Win Probability: ${(kellyInputs.winProbability * 100).toFixed(0)}%`,
            `- Risk/Reward: ${rrRatio.toFixed(2)}:1`,
            `- ${this.riskConfig.useHalfKelly ? 'Half-Kelly' : 'Full Kelly'}: ${(kellyFraction * 100).toFixed(2)}%`,
            ``,
            `Position Sizing:`,
            `- Risk Amount: $${riskAmount.toFixed(2)} (${((riskAmount / this.currentPortfolioValue) * 100).toFixed(2)}% of portfolio)`,
            `- Position Value: $${positionValue.toFixed(2)} (${((positionValue / this.currentPortfolioValue) * 100).toFixed(1)}% of portfolio)`,
        ];

        if (atr) {
            lines.push(
                ``,
                `ATR Analysis:`,
                `- ATR: $${atr.toFixed(2)}`,
                `- Stop Distance: ${this.riskConfig.atrStopMultiplier}x ATR`,
                `- Target Distance: ${this.riskConfig.atrTargetMultiplier}x ATR`
            );
        }

        const dailyLossPercent = this.dailyStartingValue > 0
            ? (this.dailyLoss / this.dailyStartingValue) * 100
            : 0;
        const weeklyLossPercent = this.weeklyStartingValue > 0
            ? (this.weeklyLoss / this.weeklyStartingValue) * 100
            : 0;

        lines.push(
            ``,
            `Safety Limits:`,
            `- Max Risk/Trade: ${(this.riskConfig.maxPositionRisk * 100).toFixed(0)}%`,
            `- Max Position Size: ${(this.riskConfig.maxPositionSize * 100).toFixed(0)}%`,
            `- Daily Loss: ${dailyLossPercent.toFixed(1)}% / ${(this.riskConfig.dailyLossLimit * 100).toFixed(0)}% (soft: ${(this.riskConfig.dailySoftLimit * 100).toFixed(0)}%)`,
            `- Weekly Loss: ${weeklyLossPercent.toFixed(1)}% / ${(this.riskConfig.weeklyLossLimit * 100).toFixed(0)}% (soft: ${(this.riskConfig.weeklySoftLimit * 100).toFixed(0)}%)`,
            `- Open Positions: ${this.openPositions.size} / ${this.riskConfig.maxOpenPositions}`
        );

        if (this.riskConfig.enableCircuitBreaker) {
            lines.push(`- Circuit Breaker: ${this.circuitBreakerActive ? 'ACTIVE' : 'Inactive'}`);
        }

        if (this.cooldownActive) {
            lines.push(`- Cooldown: ACTIVE until ${this.cooldownUntil?.toISOString()}`);
        }

        if (warnings && warnings.length > 0) {
            lines.push(``, `Warnings:`, ...warnings.map(w => `- ${w}`));
        }

        return lines.join('\n');
    }

    /**
     * Get current risk status
     */
    getRiskStatus(): {
        dailyLoss: number;
        dailyLossPercent: number;
        dailySoftLimitBreached: boolean;
        weeklyLoss: number;
        weeklyLossPercent: number;
        weeklySoftLimitBreached: boolean;
        openPositions: number;
        circuitBreakerActive: boolean;
        circuitBreakerUntil: Date | null;
        cooldownActive: boolean;
        cooldownUntil: Date | null;
        currentVolatility: number;
    } {
        const dailyLossPercent = this.dailyStartingValue > 0 ? (this.dailyLoss / this.dailyStartingValue) * 100 : 0;
        const weeklyLossPercent = this.weeklyStartingValue > 0 ? (this.weeklyLoss / this.weeklyStartingValue) * 100 : 0;

        return {
            dailyLoss: this.dailyLoss,
            dailyLossPercent,
            dailySoftLimitBreached: dailyLossPercent >= this.riskConfig.dailySoftLimit * 100,
            weeklyLoss: this.weeklyLoss,
            weeklyLossPercent,
            weeklySoftLimitBreached: weeklyLossPercent >= this.riskConfig.weeklySoftLimit * 100,
            openPositions: this.openPositions.size,
            circuitBreakerActive: this.circuitBreakerActive,
            circuitBreakerUntil: this.circuitBreakerUntil,
            cooldownActive: this.cooldownActive,
            cooldownUntil: this.cooldownUntil,
            currentVolatility: this.currentVolatility,
        };
    }

    /**
     * Get risk limits configuration
     */
    getRiskLimits(): RiskLimits {
        return {
            dailyLossLimit: this.riskConfig.dailySoftLimit,
            dailyHardLimit: this.riskConfig.dailyLossLimit,
            weeklyLossLimit: this.riskConfig.weeklySoftLimit,
            weeklyHardLimit: this.riskConfig.weeklyLossLimit,
            maxOpenPositions: this.riskConfig.maxOpenPositions,
            maxCorrelation: this.riskConfig.maxCorrelation,
            volatilityThreshold: this.riskConfig.volatilityThreshold,
            cooldownMinutes: this.riskConfig.cooldownAfterLossMinutes,
        };
    }

    /**
     * Update volatility externally
     */
    setVolatility(volatility: number): void {
        this.currentVolatility = volatility;
        this.log('info', `Volatility updated to ${(volatility * 100).toFixed(2)}%`);
    }

    /**
     * Manual position count update (for backwards compatibility)
     */
    setOpenPositionsCount(count: number): void {
        this.log('info', `Open positions count manually set: ${count}`);
    }
}
