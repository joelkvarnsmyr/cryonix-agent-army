import { NextRequest, NextResponse } from 'next/server';
import { AgentFactory } from '@cryonix/agents';

// Initialize agents (singleton pattern)
let orchestrator: any = null;
let marketScout: any = null;
let claudeAssistant: any = null;

async function initializeAgents() {
  if (!orchestrator) {
    orchestrator = AgentFactory.createOrchestrator();
    marketScout = AgentFactory.createMarketScout();
    claudeAssistant = AgentFactory.createClaudeAssistant();

    await orchestrator.initialize();
    await marketScout.initialize();
    await claudeAssistant.initialize();

    orchestrator.registerAgent(marketScout);
    orchestrator.registerAgent(claudeAssistant);
  }
}

export async function GET(request: NextRequest) {
  try {
    await initializeAgents();

    const agentStatuses = {
      orchestrator: orchestrator?.getStatus(),
      market_scout: marketScout?.getStatus(),
      claude_assistant: claudeAssistant?.getStatus(),
    };

    return NextResponse.json({
      success: true,
      agents: agentStatuses,
    });
  } catch (error) {
    console.error('Error getting agent status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to get agent status' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    await initializeAgents();

    switch (action) {
      case 'start':
        await orchestrator?.start();
        await marketScout?.start();
        await claudeAssistant?.start();
        return NextResponse.json({ success: true, message: 'Agents started' });

      case 'stop':
        await orchestrator?.stop();
        await marketScout?.stop();
        await claudeAssistant?.stop();
        return NextResponse.json({ success: true, message: 'Agents stopped' });

      default:
        return NextResponse.json(
          { success: false, error: 'Invalid action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Error controlling agents:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to control agents' },
      { status: 500 }
    );
  }
}
