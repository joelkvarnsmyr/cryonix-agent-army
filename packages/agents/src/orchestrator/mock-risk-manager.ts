/**
 * Mock Risk Manager
 * 
 * Temporary placeholder until real Risk Manager (Agent 1) is implemented.
 * Provides conservative default approvals for testing the orchestrator trading cycle.
 */

export interface RiskCheckRequest {
    symbol: string;
    side: 'BUY' | 'SELL';
    confidence: number;
    entry: number;
    stop_loss: number;
    target: number;
}

export interface RiskApproval {
    approved: boolean;
    positionSize: number;
    reasoning: string;
}

export class MockRiskManager {
    /**
     * Mock risk check - returns conservative approvals for testing
     * 
     * Real implementation will use Kelly Criterion and portfolio analysis
     */
    async checkRisk(request: RiskCheckRequest): Promise<RiskApproval> {
        // Simple validation rules
        const { confidence, side } = request;

        // Reject low confidence signals
        if (confidence < 0.6) {
            return {
                approved: false,
                positionSize: 0,
                reasoning: `Confidence too low (${(confidence * 100).toFixed(0)}% < 60%)`,
            };
        }

        // Conservative position sizing (fixed 2% for mock)
        // Real implementation will use Kelly Criterion
        const positionSize = 0.02; // 2% of portfolio

        return {
            approved: true,
            positionSize,
            reasoning: `Mock approval: ${(confidence * 100).toFixed(0)}% confidence, ${side} signal validated`,
        };
    }
}
