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

export async function POST(request: NextRequest) {
    try {
        await initializeAgents();

        await orchestrator.stop();

        return NextResponse.json({
            success: true,
            message: 'Orchestrator stopped successfully',
        });
    } catch (error: any) {
        console.error('Error stopping orchestrator:', error);
        return NextResponse.json(
            { success: false, error: error.message || 'Failed to stop orchestrator' },
            { status: 500 }
        );
    }
}
