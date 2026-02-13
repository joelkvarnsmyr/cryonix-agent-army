// Import agents
import { BaseAgent } from './base-agent';
import { OrchestratorAgent } from './orchestrator/orchestrator-agent';
import { MarketScoutAgent } from './market-scout/market-scout-agent';
import { ClaudeAssistantAgent } from './claude-assistant/claude-assistant-agent';
import { RiskManagerAgent } from './risk-manager';
import { BacktesterAgent } from './backtester';
import { SignalValidator } from './signal-validator';
import { ExecutorAgent } from './executor';

// Re-export agents
export { BaseAgent, OrchestratorAgent, MarketScoutAgent, ClaudeAssistantAgent, RiskManagerAgent, BacktesterAgent, SignalValidator, ExecutorAgent };
export type { RiskCheckRequest, RiskCheckResult } from './risk-manager';
export * from './backtester';
export * from './signal-validator';
export * from './executor';
export * from './utils';

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

  static createRiskManager(config?: any) {
    return new RiskManagerAgent(config);
  }

  static createBacktester() {
    return new BacktesterAgent();
  }

  static createExecutor(config?: any) {
    return new ExecutorAgent(config);
  }
}
