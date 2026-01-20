// Export base agent
export { BaseAgent } from './base-agent';

// Export all agents
export { OrchestratorAgent } from './orchestrator/orchestrator-agent';
export { MarketScoutAgent } from './market-scout/market-scout-agent';
export { ClaudeAssistantAgent } from './claude-assistant/claude-assistant-agent';

// Agent factory
export class AgentFactory {
  static createOrchestrator() {
    return new OrchestratorAgent();
  }

  static createMarketScout() {
    return new MarketScoutAgent();
  }

  static createClaudeAssistant() {
    return new ClaudeAssistantAgent();
  }
}
