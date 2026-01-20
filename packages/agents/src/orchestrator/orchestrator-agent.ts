import { BaseAgent } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';

export class OrchestratorAgent extends BaseAgent {
  private agents: Map<string, BaseAgent> = new Map();
  private messageQueue: AgentMessage[] = [];
  private isRunning: boolean = false;

  constructor() {
    super({
      id: 'orchestrator',
      name: 'Orchestrator Agent',
      description: 'Master coordinator for all trading agents',
      enabled: true,
    });
  }

  async initialize(): Promise<void> {
    this.log('info', 'Initializing Orchestrator Agent...');
    this.setStatus('idle');
  }

  async start(): Promise<void> {
    this.log('info', 'Starting Orchestrator Agent...');
    this.setStatus('running');
    this.isRunning = true;

    // Start main coordination loop
    this.coordinationLoop();
  }

  async stop(): Promise<void> {
    this.log('info', 'Stopping Orchestrator Agent...');
    this.isRunning = false;
    this.setStatus('idle');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', `Received message from ${message.agent_id}`, message);
    this.messageQueue.push(message);
  }

  registerAgent(agent: BaseAgent): void {
    this.agents.set(agent.getId(), agent);
    this.log('info', `Registered agent: ${agent.getName()}`);
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.log('info', `Unregistered agent: ${agentId}`);
  }

  private async coordinationLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        // Process message queue
        if (this.messageQueue.length > 0) {
          const message = this.messageQueue.shift();
          if (message) {
            await this.routeMessage(message);
          }
        }

        // Health check all agents
        await this.healthCheck();

        // Coordinate trading cycle (every 15 seconds)
        await this.coordinateTradingCycle();

        // Wait before next iteration
        await this.sleep(1000);
      } catch (error) {
        this.log('error', 'Error in coordination loop', error);
      }
    }
  }

  private async routeMessage(message: AgentMessage): Promise<void> {
    this.log('info', `Routing message: ${message.message_type}`, message);

    // Route based on message type
    switch (message.message_type) {
      case 'SIGNAL':
        // Forward to analyst and risk manager
        break;
      case 'ANALYSIS':
        // Forward to risk manager
        break;
      case 'RISK_APPROVED':
        // Forward to executor
        break;
      default:
        this.log('warn', `Unknown message type: ${message.message_type}`);
    }
  }

  private async healthCheck(): Promise<void> {
    for (const [agentId, agent] of this.agents) {
      const status = agent.getStatus();
      if (status === 'error') {
        this.log('error', `Agent ${agentId} is in error state`);
        // Attempt restart or notify user
      }
    }
  }

  private async coordinateTradingCycle(): Promise<void> {
    // This will orchestrate the full trading cycle:
    // 1. Market Scout scans for opportunities
    // 2. Analyst validates signals
    // 3. Risk Manager approves/rejects
    // 4. Executor places trades
    // 5. Reporter logs everything
    // 6. Learning Agent updates models
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
