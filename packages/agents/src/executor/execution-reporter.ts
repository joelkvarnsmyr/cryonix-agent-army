import type { OrderSide } from '@cryonix/types';
import { db, trades, agentActions, positionHistory } from '@cryonix/database';

// ============================================================================
// TYPES
// ============================================================================

export interface ExecutionRecord {
  orderId: string;
  signalId: string;
  symbol: string;
  side: OrderSide;
  orderType: 'market' | 'limit' | 'stop_loss';
  requestedQuantity: number;
  executedQuantity: number;
  requestedPrice: number;
  executedPrice: number;
  slippage: number;
  slippagePercent: number;
  fees: number;
  feePercent: number;
  latencyMs: number;
  success: boolean;
  errorMessage?: string;
  exchange: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface SlippageStats {
  averageSlippage: number;
  maxSlippage: number;
  minSlippage: number;
  slippageStdDev: number;
  totalSlippageCost: number;
  executionCount: number;
}

export interface ExecutionQualityMetrics {
  fillRate: number;
  averageLatency: number;
  slippageStats: SlippageStats;
  feeStats: {
    totalFees: number;
    averageFeePercent: number;
  };
  successRate: number;
  errorBreakdown: Map<string, number>;
}

export interface DailyExecutionSummary {
  date: string;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  totalVolume: number;
  totalFees: number;
  totalSlippageCost: number;
  averageSlippagePercent: number;
  averageLatencyMs: number;
}

export interface TradeReport {
  id: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  exitPrice?: number;
  stopLoss: number;
  takeProfit: number;
  pnl?: number;
  pnlPercent?: number;
  status: 'OPEN' | 'CLOSED';
  openedAt: Date;
  closedAt?: Date;
  closeReason?: string;
  pattern?: string;
  confidence: number;
  slippage: number;
  fees: number;
}

// ============================================================================
// EXECUTION REPORTER CLASS
// ============================================================================

export class ExecutionReporter {
  private executions: ExecutionRecord[] = [];
  private tradeReports: TradeReport[] = [];
  private dailySummaries: Map<string, DailyExecutionSummary> = new Map();
  private agentId: string;
  private logFn: (level: 'info' | 'warn' | 'error', message: string, data?: any) => void;
  private enableDatabaseLogging: boolean;

  constructor(
    agentId: string = 'executor',
    enableDatabaseLogging: boolean = true,
    logFn?: (level: 'info' | 'warn' | 'error', message: string, data?: any) => void
  ) {
    this.agentId = agentId;
    this.enableDatabaseLogging = enableDatabaseLogging;
    this.logFn = logFn || ((level, message, data) => {
      console[level](`[ExecutionReporter] ${message}`, data || '');
    });
  }

  /**
   * Record a trade execution
   */
  async recordExecution(record: Omit<ExecutionRecord, 'slippage' | 'slippagePercent' | 'feePercent'>): Promise<ExecutionRecord> {
    // Calculate slippage
    const slippage = record.executedPrice - record.requestedPrice;
    const slippagePercent = (slippage / record.requestedPrice) * 100;
    const feePercent = record.fees > 0 && record.executedQuantity > 0
      ? (record.fees / (record.executedQuantity * record.executedPrice)) * 100
      : 0;

    const fullRecord: ExecutionRecord = {
      ...record,
      slippage,
      slippagePercent,
      feePercent,
    };

    // Store in memory
    this.executions.push(fullRecord);

    // Keep only last 10000 executions in memory
    if (this.executions.length > 10000) {
      this.executions = this.executions.slice(-10000);
    }

    // Update daily summary
    this.updateDailySummary(fullRecord);

    // Log to database
    if (this.enableDatabaseLogging) {
      await this.logExecutionToDatabase(fullRecord);
    }

    this.logFn('info', `Execution recorded: ${record.orderId}`, {
      symbol: record.symbol,
      side: record.side,
      executed: record.executedQuantity,
      price: record.executedPrice,
      slippage: `${slippagePercent.toFixed(4)}%`,
      fees: `$${record.fees.toFixed(4)}`,
      latency: `${record.latencyMs}ms`,
    });

    return fullRecord;
  }

  /**
   * Record a trade opening
   */
  async recordTradeOpen(trade: Omit<TradeReport, 'status'>): Promise<TradeReport> {
    const report: TradeReport = {
      ...trade,
      status: 'OPEN',
    };

    this.tradeReports.push(report);

    // Log to database
    if (this.enableDatabaseLogging) {
      await this.logTradeOpenToDatabase(report);
    }

    this.logFn('info', `Trade opened: ${trade.symbol}`, {
      side: trade.side,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
    });

    return report;
  }

  /**
   * Record a trade closing
   */
  async recordTradeClose(
    tradeId: string,
    exitPrice: number,
    closeReason: string,
    fees: number = 0
  ): Promise<TradeReport | null> {
    const trade = this.tradeReports.find(t => t.id === tradeId);
    if (!trade) {
      this.logFn('warn', `Trade not found for closing: ${tradeId}`);
      return null;
    }

    // Calculate P&L
    let pnl: number;
    if (trade.side === 'BUY') {
      pnl = (exitPrice - trade.entryPrice) * trade.quantity;
    } else {
      pnl = (trade.entryPrice - exitPrice) * trade.quantity;
    }
    pnl -= fees;

    const pnlPercent = (pnl / (trade.entryPrice * trade.quantity)) * 100;

    // Update trade report
    trade.exitPrice = exitPrice;
    trade.pnl = pnl;
    trade.pnlPercent = pnlPercent;
    trade.status = 'CLOSED';
    trade.closedAt = new Date();
    trade.closeReason = closeReason;
    trade.fees += fees;

    // Log to database
    if (this.enableDatabaseLogging) {
      await this.logTradeCloseToDatabase(trade);
    }

    this.logFn('info', `Trade closed: ${trade.symbol}`, {
      exitPrice,
      closeReason,
      pnl: `$${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`,
    });

    return trade;
  }

  /**
   * Update daily execution summary
   */
  private updateDailySummary(record: ExecutionRecord): void {
    const date = record.timestamp.toISOString().split('T')[0];
    let summary = this.dailySummaries.get(date);

    if (!summary) {
      summary = {
        date,
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        totalVolume: 0,
        totalFees: 0,
        totalSlippageCost: 0,
        averageSlippagePercent: 0,
        averageLatencyMs: 0,
      };
      this.dailySummaries.set(date, summary);
    }

    summary.totalExecutions++;
    if (record.success) {
      summary.successfulExecutions++;
    } else {
      summary.failedExecutions++;
    }

    summary.totalVolume += record.executedQuantity * record.executedPrice;
    summary.totalFees += record.fees;
    summary.totalSlippageCost += Math.abs(record.slippage) * record.executedQuantity;

    // Recalculate averages
    const dayExecutions = this.executions.filter(
      e => e.timestamp.toISOString().split('T')[0] === date
    );
    summary.averageSlippagePercent = dayExecutions.reduce(
      (sum, e) => sum + Math.abs(e.slippagePercent), 0
    ) / dayExecutions.length;
    summary.averageLatencyMs = dayExecutions.reduce(
      (sum, e) => sum + e.latencyMs, 0
    ) / dayExecutions.length;
  }

  /**
   * Log execution to database
   */
  private async logExecutionToDatabase(record: ExecutionRecord): Promise<void> {
    try {
      await db.insert(agentActions).values({
        timestamp: record.timestamp,
        agentId: this.agentId,
        actionType: 'EXECUTION',
        data: {
          orderId: record.orderId,
          signalId: record.signalId,
          symbol: record.symbol,
          side: record.side,
          orderType: record.orderType,
          requestedQuantity: record.requestedQuantity,
          executedQuantity: record.executedQuantity,
          requestedPrice: record.requestedPrice,
          executedPrice: record.executedPrice,
          slippage: record.slippage,
          slippagePercent: record.slippagePercent,
          fees: record.fees,
          feePercent: record.feePercent,
          latencyMs: record.latencyMs,
          exchange: record.exchange,
          metadata: record.metadata,
        },
        success: record.success,
        errorMessage: record.errorMessage,
      });
    } catch (error) {
      this.logFn('error', 'Failed to log execution to database', { error: String(error) });
    }
  }

  /**
   * Log trade open to database
   */
  private async logTradeOpenToDatabase(trade: TradeReport): Promise<void> {
    try {
      await db.insert(trades).values({
        timestamp: trade.openedAt,
        symbol: trade.symbol,
        side: trade.side,
        quantity: trade.quantity.toString(),
        entryPrice: trade.entryPrice.toString(),
        confidence: trade.confidence.toString(),
        pattern: trade.pattern,
        status: 'PENDING',
        agentId: this.agentId,
      });
    } catch (error) {
      this.logFn('error', 'Failed to log trade open to database', { error: String(error) });
    }
  }

  /**
   * Log trade close to database
   */
  private async logTradeCloseToDatabase(trade: TradeReport): Promise<void> {
    try {
      // Log to position history
      await db.insert(positionHistory).values({
        symbol: trade.symbol,
        side: trade.side === 'BUY' ? 'LONG' : 'SHORT',
        quantity: trade.quantity.toString(),
        entryPrice: trade.entryPrice.toString(),
        exitPrice: trade.exitPrice?.toString(),
        avgEntryPrice: trade.entryPrice.toString(),
        stopLoss: trade.stopLoss.toString(),
        takeProfit: trade.takeProfit.toString(),
        pnl: trade.pnl?.toString(),
        pnlPercent: trade.pnlPercent?.toString(),
        fees: trade.fees.toString(),
        holdingPeriod: trade.closedAt && trade.openedAt
          ? Math.floor((trade.closedAt.getTime() - trade.openedAt.getTime()) / 1000)
          : 0,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        closeReason: trade.closeReason,
        pattern: trade.pattern,
        agentId: this.agentId,
      });
    } catch (error) {
      this.logFn('error', 'Failed to log trade close to database', { error: String(error) });
    }
  }

  /**
   * Get slippage statistics
   */
  getSlippageStats(symbol?: string, days?: number): SlippageStats {
    let filtered = this.executions;

    if (symbol) {
      filtered = filtered.filter(e => e.symbol === symbol);
    }

    if (days) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      filtered = filtered.filter(e => e.timestamp > cutoff);
    }

    if (filtered.length === 0) {
      return {
        averageSlippage: 0,
        maxSlippage: 0,
        minSlippage: 0,
        slippageStdDev: 0,
        totalSlippageCost: 0,
        executionCount: 0,
      };
    }

    const slippages = filtered.map(e => e.slippagePercent);
    const avgSlippage = slippages.reduce((sum, s) => sum + s, 0) / slippages.length;

    // Calculate standard deviation
    const variance = slippages.reduce((sum, s) => sum + Math.pow(s - avgSlippage, 2), 0) / slippages.length;
    const stdDev = Math.sqrt(variance);

    const totalCost = filtered.reduce((sum, e) => sum + Math.abs(e.slippage) * e.executedQuantity, 0);

    return {
      averageSlippage: avgSlippage,
      maxSlippage: Math.max(...slippages),
      minSlippage: Math.min(...slippages),
      slippageStdDev: stdDev,
      totalSlippageCost: totalCost,
      executionCount: filtered.length,
    };
  }

  /**
   * Get execution quality metrics
   */
  getExecutionQualityMetrics(days?: number): ExecutionQualityMetrics {
    let filtered = this.executions;

    if (days) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      filtered = filtered.filter(e => e.timestamp > cutoff);
    }

    if (filtered.length === 0) {
      return {
        fillRate: 0,
        averageLatency: 0,
        slippageStats: {
          averageSlippage: 0,
          maxSlippage: 0,
          minSlippage: 0,
          slippageStdDev: 0,
          totalSlippageCost: 0,
          executionCount: 0,
        },
        feeStats: {
          totalFees: 0,
          averageFeePercent: 0,
        },
        successRate: 0,
        errorBreakdown: new Map(),
      };
    }

    // Calculate fill rate
    const totalRequested = filtered.reduce((sum, e) => sum + e.requestedQuantity, 0);
    const totalExecuted = filtered.reduce((sum, e) => sum + e.executedQuantity, 0);
    const fillRate = totalRequested > 0 ? totalExecuted / totalRequested : 0;

    // Calculate average latency
    const avgLatency = filtered.reduce((sum, e) => sum + e.latencyMs, 0) / filtered.length;

    // Calculate fee stats
    const totalFees = filtered.reduce((sum, e) => sum + e.fees, 0);
    const avgFeePercent = filtered.reduce((sum, e) => sum + e.feePercent, 0) / filtered.length;

    // Calculate success rate
    const successCount = filtered.filter(e => e.success).length;
    const successRate = successCount / filtered.length;

    // Build error breakdown
    const errorBreakdown = new Map<string, number>();
    filtered.filter(e => !e.success && e.errorMessage).forEach(e => {
      const errorType = e.errorMessage?.split(':')[0] || 'Unknown';
      errorBreakdown.set(errorType, (errorBreakdown.get(errorType) || 0) + 1);
    });

    return {
      fillRate,
      averageLatency: avgLatency,
      slippageStats: this.getSlippageStats(undefined, days),
      feeStats: {
        totalFees,
        averageFeePercent: avgFeePercent,
      },
      successRate,
      errorBreakdown,
    };
  }

  /**
   * Get daily execution summary
   */
  getDailySummary(date?: string): DailyExecutionSummary | null {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.dailySummaries.get(targetDate) || null;
  }

  /**
   * Get all daily summaries
   */
  getAllDailySummaries(): DailyExecutionSummary[] {
    return Array.from(this.dailySummaries.values())
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Get open trade reports
   */
  getOpenTrades(): TradeReport[] {
    return this.tradeReports.filter(t => t.status === 'OPEN');
  }

  /**
   * Get closed trade reports
   */
  getClosedTrades(limit: number = 50): TradeReport[] {
    return this.tradeReports
      .filter(t => t.status === 'CLOSED')
      .slice(-limit);
  }

  /**
   * Get trade by ID
   */
  getTradeById(tradeId: string): TradeReport | undefined {
    return this.tradeReports.find(t => t.id === tradeId);
  }

  /**
   * Get execution report for a specific order
   */
  getExecutionByOrderId(orderId: string): ExecutionRecord | undefined {
    return this.executions.find(e => e.orderId === orderId);
  }

  /**
   * Get recent executions
   */
  getRecentExecutions(limit: number = 100): ExecutionRecord[] {
    return this.executions.slice(-limit);
  }

  /**
   * Generate performance report
   */
  generatePerformanceReport(): {
    period: { start: Date; end: Date };
    executions: {
      total: number;
      successful: number;
      failed: number;
      successRate: number;
    };
    trades: {
      total: number;
      open: number;
      closed: number;
      profitable: number;
      losing: number;
      winRate: number;
      totalPnl: number;
      averagePnl: number;
    };
    quality: ExecutionQualityMetrics;
    slippage: SlippageStats;
  } {
    const closedTrades = this.tradeReports.filter(t => t.status === 'CLOSED');
    const profitableTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    const timestamps = this.executions.map(e => e.timestamp.getTime());
    const startDate = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : new Date();
    const endDate = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date();

    const successful = this.executions.filter(e => e.success).length;

    return {
      period: {
        start: startDate,
        end: endDate,
      },
      executions: {
        total: this.executions.length,
        successful,
        failed: this.executions.length - successful,
        successRate: this.executions.length > 0 ? successful / this.executions.length : 0,
      },
      trades: {
        total: this.tradeReports.length,
        open: this.tradeReports.filter(t => t.status === 'OPEN').length,
        closed: closedTrades.length,
        profitable: profitableTrades.length,
        losing: closedTrades.length - profitableTrades.length,
        winRate: closedTrades.length > 0 ? profitableTrades.length / closedTrades.length : 0,
        totalPnl,
        averagePnl: closedTrades.length > 0 ? totalPnl / closedTrades.length : 0,
      },
      quality: this.getExecutionQualityMetrics(),
      slippage: this.getSlippageStats(),
    };
  }

  /**
   * Clear old records from memory
   */
  cleanup(keepDays: number = 30): void {
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);

    this.executions = this.executions.filter(e => e.timestamp > cutoff);
    this.tradeReports = this.tradeReports.filter(
      t => t.openedAt > cutoff || t.status === 'OPEN'
    );

    // Clean up daily summaries older than keepDays
    const cutoffDate = cutoff.toISOString().split('T')[0];
    for (const [date] of this.dailySummaries) {
      if (date < cutoffDate) {
        this.dailySummaries.delete(date);
      }
    }

    this.logFn('info', `Cleanup completed, kept records from last ${keepDays} days`);
  }
}
