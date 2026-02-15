import { NextRequest, NextResponse } from 'next/server';
import { RiskManagerAgent, type RiskCheckRequest } from '@cryonix/agents';
import { db, riskChecks } from '@cryonix/database';
import { publishToWebSocket } from '@/lib/ws-publisher';
import type { WSPayloadRisk } from '@cryonix/types';
import { RiskCheckRequestSchema } from '@cryonix/types';

// Singleton Risk Manager instance
let riskManager: RiskManagerAgent | null = null;

function getRiskManager(): RiskManagerAgent {
    if (!riskManager) {
        riskManager = new RiskManagerAgent({
            maxPortfolioRisk: 0.10, // 10%
            maxPositionRisk: 0.02, // 2%
            maxPositionSize: 0.30, // 30%
            maxOpenPositions: 5,
            dailyLossLimit: 0.10, // 10%
            useHalfKelly: true, // Conservative
        });

        // Initialize the agent
        riskManager.initialize();
        riskManager.start();
    }

    return riskManager;
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        // Validate request with Zod
        const validation = RiskCheckRequestSchema.safeParse(body);

        if (!validation.success) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Validation failed',
                    details: validation.error.format(),
                },
                { status: 400 }
            );
        }

        const data = validation.data;

        // Build risk check request
        const riskRequest: RiskCheckRequest = {
            symbol: data.symbol,
            side: data.side,
            confidence: data.confidence,
            entry_price: data.entry_price,
            stop_loss: data.stop_loss,
            target_price: data.target_price,
        };

        // Get risk manager and perform check
        const manager = getRiskManager();
        const result = await manager.checkSignalRisk(riskRequest);

        // Save to database
        try {
            await db.insert(riskChecks).values({
                symbol: data.symbol,
                side: data.side,
                confidence: data.confidence.toString(),
                approved: result.approved,
                positionSize: result.position_size.toString(),
                positionValue: result.position_value.toString(),
                riskAmount: result.risk_amount.toString(),
                kellyFraction: result.kelly_fraction?.toString(),
                reasoning: result.reasoning,
                portfolioValue: (result as any).portfolio_value?.toString() || '0',
                agentId: 'risk-manager',
            });
        } catch (dbError) {
            console.error('Failed to save risk check to database:', dbError);
            // Continue even if database save fails
        }

        // Notify frontend if request is rejected
        if (!result.approved) {
            const payload: WSPayloadRisk = {
                type: 'exposure', // Generalizing for now, could be specific based on reasoning
                severity: 'medium',
                message: `Risk Check Failed: ${result.reasoning}`,
                data: {
                    symbol: data.symbol,
                    riskAmount: result.risk_amount,
                }
            };
            await publishToWebSocket('RISK_WARNING', payload);
        }

        return NextResponse.json({
            success: true,
            data: result,
        });
    } catch (error: any) {
        console.error('Risk Check API Error:', error);

        return NextResponse.json(
            {
                success: false,
                error: error.message || 'Internal server error',
            },
            { status: 500 }
        );
    }
}

// GET endpoint to get risk manager status
export async function GET(request: NextRequest) {
    try {
        const manager = getRiskManager();

        return NextResponse.json({
            success: true,
            data: {
                status: manager.getStatus(),
                config: {
                    maxPortfolioRisk: '10%',
                    maxPositionRisk: '2%',
                    maxPositionSize: '30%',
                    maxOpenPositions: 5,
                    dailyLossLimit: '10%',
                    useHalfKelly: true,
                },
            },
        });
    } catch (error: any) {
        console.error('Risk Check Status Error:', error);

        return NextResponse.json(
            {
                success: false,
                error: error.message,
            },
            { status: 500 }
        );
    }
}
