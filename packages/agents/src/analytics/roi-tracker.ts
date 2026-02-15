import { EventEmitter } from 'events';

export interface CostEvent {
    model: string;
    tokens: number;
    cost: number;
    timestamp: number;
    context?: string;
}

export interface ProfitEvent {
    symbol: string;
    pnl: number;
    timestamp: number;
}

export interface ValueMetrics {
    totalApiCost: number;
    totalTradingProfit: number;
    netValueCreated: number;
    roi: number;
    totalTokens: number;
    requestCount: number;
}

/**
 * Tracks the Return on Investment (ROI) of the agent.
 * Calculates Net Value Created = (Trading Profit - API Costs)
 */
export class RoiTracker extends EventEmitter {
    private metrics: ValueMetrics = {
        totalApiCost: 0,
        totalTradingProfit: 0,
        netValueCreated: 0,
        roi: 0,
        totalTokens: 0,
        requestCount: 0,
    };

    // Cost per 1M tokens (approximate for Grok/Claude)
    // Adjust based on actual model pricing
    private readonly PRICING = {
        'grok-4-1-fast-reasoning': 2.0, // $2.00 per 1M input tokens (estimated)
        'grok-output': 8.0,             // $8.00 per 1M output tokens (estimated)
        'default': 5.0,
    };

    constructor() {
        super();
    }

    /**
     * Track an API Call cost
     */
    trackCost(model: string, inputTokens: number, outputTokens: number, context?: string): void {
        const inputCost = (inputTokens / 1_000_000) * (this.PRICING['grok-4-1-fast-reasoning'] || 2.0);
        const outputCost = (outputTokens / 1_000_000) * (this.PRICING['grok-output'] || 8.0);
        const totalCost = inputCost + outputCost;

        this.metrics.totalApiCost += totalCost;
        this.metrics.totalTokens += (inputTokens + outputTokens);
        this.metrics.requestCount++;
        this.updateNetValue();

        const event: CostEvent = {
            model,
            tokens: inputTokens + outputTokens,
            cost: totalCost,
            timestamp: Date.now(),
            context
        };

        this.emit('cost_recorded', event);
        // console.log(`💸 Cost recorded: $${totalCost.toFixed(6)} (${context})`);
    }

    /**
     * Track a Realized Profit/Loss
     */
    trackProfit(symbol: string, pnl: number): void {
        this.metrics.totalTradingProfit += pnl;
        this.updateNetValue();

        const event: ProfitEvent = {
            symbol,
            pnl,
            timestamp: Date.now()
        };

        this.emit('profit_recorded', event);
        // console.log(`💰 Profit recorded: $${pnl.toFixed(2)} (${symbol})`);
    }

    private updateNetValue(): void {
        this.metrics.netValueCreated = this.metrics.totalTradingProfit - this.metrics.totalApiCost;

        if (this.metrics.totalApiCost > 0) {
            this.metrics.roi = (this.metrics.netValueCreated / this.metrics.totalApiCost) * 100;
        } else {
            this.metrics.roi = 0;
        }
    }

    getMetrics(): ValueMetrics {
        return { ...this.metrics };
    }
}

export const roiTracker = new RoiTracker();
