import { BaseAgent } from '../base-agent';
import type { AgentMessage, TradingSignal, GrokAnalysis, RiskApproval } from '@cryonix/types';
import { RiskManagerAgent, type RiskCheckRequest, type RiskCheckResult } from '../risk-manager';
import { ExecutorAgent, type ExecuteOrderRequest, type ExecutionResult } from '../executor';
import { SignalValidator, type ValidationResult } from '../signal-validator';
import { WebSocket } from 'ws';

export class OrchestratorAgent extends BaseAgent {
  private agents: Map<string, BaseAgent> = new Map();
  private orchestratorQueue: AgentMessage[] = [];
  private isRunning: boolean = false;

  // Trading cycle properties
  private lastScanTime: Date | null = null;
  private lastPortfolioSync: Date | null = null;
  private lastMetricsCollection: Date | null = null;
  private dailyStartValue: number = 0;
  private currentPortfolioValue: number = 0;
  private enableAutoTrading: boolean = false;
  private emergencyStopTriggered: boolean = false;

  // Real Risk Manager with Kelly Criterion
  private riskManager: RiskManagerAgent;

  // Executor Agent for trade execution
  private executor: ExecutorAgent;

  // Signal Validator for multi-source consensus
  private signalValidator: SignalValidator;

  // WebSocket for real-time updates
  private ws: WebSocket | null = null;
  private wsReconnectTimeout: NodeJS.Timeout | undefined;

  // Timing constants (in milliseconds)
  private readonly SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly PORTFOLIO_SYNC_INTERVAL = 30 * 1000; // 30 seconds
  private readonly METRICS_INTERVAL = 60 * 60 * 1000; // 1 hour
  private readonly HEALTH_CHECK_INTERVAL = 60 * 1000; // 1 minute
  private readonly DAILY_LOSS_LIMIT = 0.05; // 5%

  constructor() {
    super({
      id: 'orchestrator',
      name: 'Orchestrator Agent',
      description: 'Master coordinator for all trading agents',
      enabled: true,
    });

    // Initialize Real Risk Manager - tuned for $100 micro-budget
    this.riskManager = new RiskManagerAgent({
      maxPortfolioRisk: 0.06,   // 6% ($6)
      maxPositionRisk: 0.01,    // 1% ($1) per trade
      maxPositionSize: 0.20,    // 20% ($20) max per position
      maxOpenPositions: 2,      // Max 2 open positions
      dailyLossLimit: 0.03,     // 3% ($3) daily loss limit
      weeklyLossLimit: 0.08,    // 8% ($8) weekly loss limit
      useHalfKelly: true,       // Conservative half-Kelly
      enableCircuitBreaker: true,
    });

    // Initialize Executor Agent
    this.executor = new ExecutorAgent({
      exchange: process.env.BINANCE_TESTNET === 'true' ? 'binance_testnet' : 'binance',
      maxSlippagePercent: 0.5,
      retryAttempts: 3,
      useOcoOrders: true,
    });

    // Initialize Signal Validator
    this.signalValidator = new SignalValidator({
      minConsensusLevel: 0.6,
      minConfidence: 0.55,
      enableAiAnalysis: true,
    });

    this.enableAutoTrading = process.env.ENABLE_AUTO_TRADING === 'true';
  }

  async initialize(): Promise<void> {
    this.log('info', 'Initializing Orchestrator Agent...');

    // Initialize Risk Manager
    await this.riskManager.initialize();
    this.log('info', '✅ Risk Manager initialized');

    // Initialize Executor
    try {
      await this.executor.initialize();
      this.log('info', '✅ Executor Agent initialized');
    } catch (error) {
      this.log('warn', '⚠️  Executor initialization failed - auto-trading will be disabled', error);
      this.enableAutoTrading = false;
    }

    // Connect to WebSocket
    this.connectToWebSocket();

    // Initialize daily portfolio value
    await this.syncPortfolio();
    this.dailyStartValue = this.currentPortfolioValue;

    this.setStatus('idle');

    if (!this.enableAutoTrading) {
      this.log('warn', '⚠️  AUTO-TRADING DISABLED - Trades will be logged for manual review');
    }
  }

  async start(): Promise<void> {
    this.log('info', 'Starting Orchestrator Agent...');
    this.setStatus('running');
    this.isRunning = true;

    // Start Risk Manager
    await this.riskManager.start();
    this.log('info', '✅ Risk Manager started');

    // Start Executor (only if auto-trading is enabled)
    if (this.enableAutoTrading) {
      await this.executor.start();
      this.log('info', '✅ Executor Agent started');
    }

    // Reset emergency stop
    this.emergencyStopTriggered = false;

    // Start main coordination loop
    this.coordinationLoop();
  }

  async stop(): Promise<void> {
    this.log('info', 'Stopping Orchestrator Agent...');
    this.isRunning = false;

    // Stop Executor
    if (this.enableAutoTrading) {
      await this.executor.stop();
      this.log('info', '✅ Executor Agent stopped');
    }

    // Stop Risk Manager
    await this.riskManager.stop();
    this.log('info', '✅ Risk Manager stopped');

    this.setStatus('idle');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', `Received message from ${message.agent_id}`, message);
    this.orchestratorQueue.push(message);
  }

  registerAgent(agent: BaseAgent): void {
    this.agents.set(agent.getId(), agent);
    this.log('info', `✅ Registered agent: ${agent.getName()}`);
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.log('info', `❌ Unregistered agent: ${agentId}`);
  }

  getState() {
    return {
      status: this.status,
      isRunning: this.isRunning,
      enableAutoTrading: this.enableAutoTrading,
      emergencyStopTriggered: this.emergencyStopTriggered,
      lastScanTime: this.lastScanTime,
      dailyStartValue: this.dailyStartValue,
      currentPortfolioValue: this.currentPortfolioValue,
      registeredAgents: Array.from(this.agents.entries()).map(([id, agent]) => ({
        id,
        name: agent.getName(),
        status: agent.getStatus(),
      })),
    };
  }

  private async coordinationLoop(): Promise<void> {
    let lastHealthCheck = Date.now();

    while (this.isRunning) {
      try {
        const now = Date.now();

        // Process message queue
        if (this.orchestratorQueue.length > 0) {
          const message = this.orchestratorQueue.shift();
          if (message) {
            await this.routeMessage(message);
          }
        }

        // Health check all agents (every minute)
        if (now - lastHealthCheck >= this.HEALTH_CHECK_INTERVAL) {
          await this.healthCheck();
          lastHealthCheck = now;
        }

        // Portfolio sync (every 30 seconds)
        if (!this.lastPortfolioSync || now - this.lastPortfolioSync.getTime() >= this.PORTFOLIO_SYNC_INTERVAL) {
          await this.syncPortfolio();
        }

        // Check for emergency stop conditions
        if (await this.checkDailyLoss()) {
          this.log('error', '🚨 EMERGENCY STOP TRIGGERED - Daily loss limit exceeded');
          this.emergencyStopTriggered = true;
          await this.stop();
          break;
        }

        // Coordinate trading cycle (every 5 minutes)
        if (!this.lastScanTime || now - this.lastScanTime.getTime() >= this.SCAN_INTERVAL) {
          if (!this.emergencyStopTriggered) {
            await this.coordinateTradingCycle();
          }
        }

        // Collect metrics (every hour)
        if (!this.lastMetricsCollection || now - this.lastMetricsCollection.getTime() >= this.METRICS_INTERVAL) {
          await this.collectMetrics();
        }

        // Wait before next iteration
        await this.sleep(1000);
      } catch (error) {
        this.log('error', 'Error in coordination loop', error);
      }
    }
  }

  private async routeMessage(message: AgentMessage): Promise<void> {
    this.log('info', `📨 Routing message: ${message.message_type}`, message);

    // Route based on message type
    switch (message.message_type) {
      case 'SIGNAL':
        // Signal from Market Scout -> Analyze with GROK
        this.log('info', '🔄 Signal received, routing to GROK for analysis');
        await this.handleSignal(message.data as TradingSignal);
        break;

      case 'ANALYSIS':
        // Analysis complete -> Check with Risk Manager
        this.log('info', '🔄 Analysis received, routing to Risk Manager');
        break;

      case 'RISK_APPROVED':
        // Risk approved -> Execute trade (if auto-trading enabled)
        this.log('info', '🔄 Risk approved, routing to Executor');
        break;

      default:
        this.log('warn', `⚠️  Unknown message type: ${message.message_type}`);
    }
  }

  private async healthCheck(): Promise<void> {
    for (const [agentId, agent] of this.agents) {
      const status = agent.getStatus();

      if (status === 'error') {
        this.log('error', `❌ Agent ${agentId} is in error state`);
        await this.restartAgent(agentId, agent);
      } else {
        this.log('info', `✅ Agent ${agentId} health: ${status}`);
      }
    }
  }

  private async restartAgent(agentId: string, agent: BaseAgent): Promise<void> {
    try {
      this.log('info', `🔄 Attempting to restart agent: ${agentId}`);
      await agent.stop();
      await agent.initialize();
      await agent.start();
      this.log('info', `✅ Successfully restarted agent: ${agentId}`);
    } catch (error) {
      this.log('error', `❌ Failed to restart agent ${agentId}`, error);
    }
  }

  private async coordinateTradingCycle(): Promise<void> {
    try {
      this.log('info', '🔍 Starting trading cycle...');
      this.lastScanTime = new Date();

      // Get Market Scout signals
      const marketScout = this.agents.get('market_scout');
      if (!marketScout) {
        this.log('warn', '⚠️  Market Scout not registered, skipping scan');
        return;
      }

      // For now, we'll call the analyze API directly
      // In future, Market Scout will emit signals that we catch
      const signals = await this.getMarketSignals();

      if (!signals || signals.length === 0) {
        this.log('info', '📭 No signals found in this cycle');
        return;
      }

      this.log('info', `📊 Found ${signals.length} signal(s) to analyze`);

      // Process each signal
      for (const signal of signals) {
        await this.processSignal(signal);
      }

      this.log('info', '✅ Trading cycle complete');
    } catch (error) {
      this.log('error', '❌ Error in trading cycle', error);
    }
  }

  private async getMarketSignals(): Promise<TradingSignal[]> {
    // This is a placeholder - in production, Market Scout will emit signals
    // For now, return empty array since Market Scout handles its own scanning
    return [];
  }

  private async processSignal(signal: TradingSignal): Promise<void> {
    try {
      this.log('info', `🔍 Processing signal for ${signal.symbol}`, signal);

      // Step 1: Analyze with GROK
      const analysis = await this.callGrokAnalysis(signal);

      if (analysis.signal === 'HOLD') {
        this.log('info', `⏸️  GROK recommends HOLD for ${signal.symbol}`);
        return;
      }

      // Step 2: Check with Risk Manager
      const riskCheck = await this.checkRiskManager(analysis, signal);

      if (!riskCheck.approved) {
        this.log('warn', `❌ Risk check REJECTED for ${signal.symbol}: ${riskCheck.reasoning}`);
        return;
      }

      // Step 3: Log trade opportunity (execute if auto-trading enabled)
      this.log('info', '💰 TRADE OPPORTUNITY', {
        symbol: signal.symbol,
        side: analysis.signal,
        confidence: `${(analysis.confidence * 100).toFixed(0)}%`,
        positionSize: `${riskCheck.position_size} units`,
      });

      // Broadcast signal to UI
      this.broadcast('NEW_SIGNAL', {
        symbol: signal.symbol,
        side: analysis.signal,
        confidence: analysis.confidence,
        timestamp: Date.now(),
        reasoning: riskCheck.reasoning
      });

      if (this.enableAutoTrading) {
        this.log('info', '🤖 AUTO-TRADING ENABLED - Executing trade...');

        // Execute trade via Executor Agent
        const executeRequest: ExecuteOrderRequest = {
          signalId: signal.id,
          symbol: signal.symbol,
          side: analysis.signal as 'BUY' | 'SELL',
          quantity: riskCheck.position_size,
          entryPrice: analysis.entry,
          stopLoss: riskCheck.adjustments?.adjusted_stop_loss || analysis.stopLoss,
          takeProfit: riskCheck.adjustments?.adjusted_target || analysis.target,
          orderType: 'market',
          confidence: analysis.confidence,
          pattern: signal.pattern,
        };

        const executionResult = await this.executor.executeOrder(executeRequest);

        if (executionResult.success) {
          this.log('info', '✅ TRADE EXECUTED', {
            orderId: executionResult.orderId,
            symbol: executionResult.symbol,
            side: executionResult.side,
            quantity: executionResult.executedQuantity,
            price: executionResult.averagePrice,
            slippage: `${executionResult.slippage?.toFixed(3)}%`,
          });

          // Notify Risk Manager of new position
          this.riskManager.recordPosition({
            symbol: executionResult.symbol,
            side: executionResult.side,
            entryPrice: executionResult.averagePrice,
            quantity: executionResult.executedQuantity,
            value: executionResult.executedQuantity * executionResult.averagePrice,
            entryTime: executionResult.timestamp,
          });

          // Broadcast trade execution to UI
          this.broadcast('TRADE_EXECUTED', {
            orderId: executionResult.orderId,
            symbol: executionResult.symbol,
            side: executionResult.side,
            quantity: executionResult.executedQuantity,
            price: executionResult.averagePrice,
            timestamp: executionResult.timestamp,
          });
        } else {
          this.log('error', '❌ TRADE EXECUTION FAILED', {
            symbol: executionResult.symbol,
            error: executionResult.error,
          });

          // Broadcast failure to UI
          this.broadcast('TRADE_FAILED', {
            symbol: executionResult.symbol,
            error: executionResult.error,
            timestamp: executionResult.timestamp,
          });
        }
      } else {
        this.log('warn', '⚠️  AUTO-TRADING DISABLED - Trade logged for manual review');
      }

    } catch (error) {
      this.log('error', `❌ Error processing signal for ${signal.symbol}`, error);
    }
  }

  private async handleSignal(signal: TradingSignal): Promise<void> {
    await this.processSignal(signal);
  }

  private async callGrokAnalysis(signal: TradingSignal): Promise<GrokAnalysis> {
    try {
      // Call the analyze API endpoint with timeout
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3003';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: signal.symbol.replace('/', ''),
          action: 'full_analysis',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`GROK analysis failed: ${response.statusText}`);
      }

      const result = await response.json() as any;
      const analysis = result.data?.analysis;

      if (!analysis) {
        throw new Error('No analysis data in response');
      }

      return {
        signal: analysis.signal || 'HOLD',
        confidence: (analysis.confidence || 50) / 100,
        entry: analysis.entry || signal.entry_price,
        target: analysis.target || signal.target_price,
        stopLoss: analysis.stopLoss || signal.stop_loss,
        reasoning: analysis.reasoning || [],
        summary: analysis.summary,
      };
    } catch (error) {
      this.log('error', '❌ GROK analysis error', error);
      // Return safe default
      return {
        signal: 'HOLD',
        confidence: 0,
        entry: signal.entry_price,
        target: signal.target_price,
        stopLoss: signal.stop_loss,
        reasoning: ['Analysis failed'],
      };
    }
  }

  private async checkRiskManager(analysis: GrokAnalysis, signal: TradingSignal): Promise<RiskCheckResult> {
    try {
      const request: RiskCheckRequest = {
        symbol: signal.symbol.replace('/', ''),
        side: analysis.signal as 'BUY' | 'SELL',
        confidence: analysis.confidence,
        entry_price: analysis.entry,
        stop_loss: analysis.stopLoss,
        target_price: analysis.target,
      };

      // Call real Risk Manager with Kelly Criterion
      const result = await this.riskManager.checkSignalRisk(request);

      this.log('info', `🔍 Risk check for ${signal.symbol}:`, {
        approved: result.approved,
        kellyFraction: `${(result.kelly_fraction * 100).toFixed(2)}%`,
        positionSize: result.position_size,
        positionValue: `$${result.position_value.toFixed(2)}`,
      });

      return result;
    } catch (error) {
      this.log('error', '❌ Risk check error', error);
      // Return rejected result on error
      return {
        approved: false,
        position_size: 0,
        position_value: 0,
        risk_amount: 0,
        kelly_fraction: 0,
        reasoning: '❌ REJECTED: Risk check failed due to error',
        checks: [],
        warnings: [],
        blockers: ['Risk check failed due to error'],
        limits: {
          portfolio_exposure: '0%',
          daily_loss_remaining: '0%',
          weekly_loss_remaining: '0%',
          open_positions: 0,
        },
      };
    }
  }

  private async syncPortfolio(): Promise<void> {
    try {
      // Call portfolio API to get current value with timeout
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3003';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(`${baseUrl}/api/portfolio`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error('Failed to fetch portfolio');
      }

      const data = await response.json() as any;
      this.currentPortfolioValue = data.summary?.totalValueUSD || 0;
      this.lastPortfolioSync = new Date();

      // Broadcast portfolio update
      this.broadcast('PORTFOLIO_UPDATE', data);

      // Reset daily value at midnight
      const now = new Date();
      if (this.lastPortfolioSync && this.lastPortfolioSync.getDate() !== now.getDate()) {
        this.dailyStartValue = this.currentPortfolioValue;
        this.log('info', '📅 New day - Reset daily start value');
      }

    } catch (error) {
      this.log('error', '❌ Portfolio sync error', error);
    }
  }

  private async checkDailyLoss(): Promise<boolean> {
    if (this.dailyStartValue === 0 || this.currentPortfolioValue === 0) {
      return false;
    }

    const dailyChange = (this.currentPortfolioValue - this.dailyStartValue) / this.dailyStartValue;

    if (dailyChange <= -this.DAILY_LOSS_LIMIT) {
      this.log('error', `🚨 Daily loss limit exceeded: ${(dailyChange * 100).toFixed(2)}%`);
      return true;
    }

    return false;
  }

  private async collectMetrics(): Promise<void> {
    this.log('info', '📊 Collecting performance metrics...');
    this.lastMetricsCollection = new Date();

    // Calculate daily P&L
    const dailyPnL = this.currentPortfolioValue - this.dailyStartValue;
    const dailyPnLPercent = this.dailyStartValue > 0
      ? (dailyPnL / this.dailyStartValue) * 100
      : 0;

    this.log('info', '📈 Daily Performance', {
      startValue: this.dailyStartValue.toFixed(2),
      currentValue: this.currentPortfolioValue.toFixed(2),
      pnl: dailyPnL.toFixed(2),
      pnlPercent: `${dailyPnLPercent.toFixed(2)}%`,
    });
  }

  private connectToWebSocket(): void {
    try {
      const WS_URL = 'ws://localhost:3004';
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        this.log('info', '✅ Connected to WebSocket Server');
        this.broadcast('REGISTER_AGENT', { agentId: this.getId() });
      });

      this.ws.on('error', (error) => {
        this.log('error', '⚠️ WebSocket error:', error.message);
      });

      this.ws.on('close', () => {
        this.log('warn', '❌ WebSocket connection closed. Reconnecting in 5s...');
        this.ws = null;
        clearTimeout(this.wsReconnectTimeout);
        this.wsReconnectTimeout = setTimeout(() => this.connectToWebSocket(), 5000);
      });
    } catch (error) {
      this.log('error', 'Failed to connect to WebSocket:', error);
    }
  }

  private broadcast(type: string, data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'BROADCAST',
        payload: { type, data }
      }));
    }
  }
}
