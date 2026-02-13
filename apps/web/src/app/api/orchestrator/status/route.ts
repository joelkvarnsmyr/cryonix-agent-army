import { NextRequest, NextResponse } from 'next/server';
import { AgentFactory } from '@cryonix/agents';

// Initialize agents (singleton pattern)
let orchestrator: any = null;

async function initializeAgents() {
    if (!orchestrator) {
        orchestrator = AgentFactory.createOrchestrator();
        await orchestrator.initialize();
    }
}

export async function GET(request: NextRequest) {
    try {
        await initializeAgents();

        const state = orchestrator.getState();

        // Calculate daily P&L
        const dailyPnL = state.currentPortfolioValue - state.dailyStartValue;
        const dailyPnLPercent = state.dailyStartValue > 0
            ? (dailyPnL / state.dailyStartValue) * 100
            : 0;

        return NextResponse.json({
            success: true,
            data: {
                status: state.status,
                isRunning: state.isRunning,
                enableAutoTrading: state.enableAutoTrading,
                emergencyStop: state.emergencyStopTriggered,
                registeredAgents: state.registeredAgents,
                lastScanTime: state.lastScanTime,
                dailyPnL,
                dailyPnLPercent,
                portfolioValue: state.currentPortfolioValue,
            },
        });
    } catch (error: any) {
        console.error('Error getting orchestrator status:', error);
        return NextResponse.json(
            { success: false, error: error.message || 'Failed to get orchestrator status' },
            { status: 500 }
        );
    }
}
