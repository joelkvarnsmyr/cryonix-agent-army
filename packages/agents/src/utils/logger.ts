/**
 * Structured logging utility for Cryonix agents
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  agentId: string;
  message: string;
  data?: Record<string, unknown>;
  traceId?: string;
}

export interface MetricEntry {
  timestamp: string;
  name: string;
  value: number;
  unit: string;
  tags?: Record<string, string>;
}

// Log level priority
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Get minimum log level from environment
function getMinLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel as LogLevel;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const MIN_LOG_LEVEL = getMinLogLevel();

/**
 * Logger class for structured logging
 */
export class Logger {
  private agentId: string;
  private traceId?: string;

  constructor(agentId: string, traceId?: string) {
    this.agentId = agentId;
    this.traceId = traceId;
  }

  /**
   * Set trace ID for request tracking
   */
  setTraceId(traceId: string): void {
    this.traceId = traceId;
  }

  /**
   * Log a message
   */
  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[MIN_LOG_LEVEL]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      agentId: this.agentId,
      message,
      data,
      traceId: this.traceId,
    };

    // In production, output JSON for log aggregation
    if (process.env.NODE_ENV === 'production') {
      console[level === 'debug' ? 'log' : level](JSON.stringify(entry));
    } else {
      // In development, use formatted output
      const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${this.agentId}]`;
      if (data) {
        console[level === 'debug' ? 'log' : level](prefix, message, data);
      } else {
        console[level === 'debug' ? 'log' : level](prefix, message);
      }
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  /**
   * Log with emoji prefix for visual clarity
   */
  success(message: string, data?: Record<string, unknown>): void {
    this.info(`✅ ${message}`, data);
  }

  failure(message: string, data?: Record<string, unknown>): void {
    this.error(`❌ ${message}`, data);
  }

  trade(message: string, data?: Record<string, unknown>): void {
    this.info(`💰 ${message}`, data);
  }

  signal(message: string, data?: Record<string, unknown>): void {
    this.info(`📊 ${message}`, data);
  }

  risk(message: string, data?: Record<string, unknown>): void {
    this.warn(`🛡️ ${message}`, data);
  }
}

/**
 * Metrics collector for trading performance
 */
export class MetricsCollector {
  private agentId: string;
  private metrics: MetricEntry[] = [];
  private readonly MAX_BUFFER_SIZE = 1000;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /**
   * Record a metric
   */
  record(name: string, value: number, unit: string, tags?: Record<string, string>): void {
    const entry: MetricEntry = {
      timestamp: new Date().toISOString(),
      name: `cryonix.${this.agentId}.${name}`,
      value,
      unit,
      tags,
    };

    this.metrics.push(entry);

    // Prevent memory leak by trimming buffer
    if (this.metrics.length > this.MAX_BUFFER_SIZE) {
      this.metrics = this.metrics.slice(-this.MAX_BUFFER_SIZE / 2);
    }

    // In production, could send to metrics service
    if (process.env.NODE_ENV === 'production') {
      // Could integrate with DataDog, CloudWatch, etc.
      console.log('METRIC:', JSON.stringify(entry));
    }
  }

  /**
   * Record trade execution time
   */
  recordTradeExecution(durationMs: number, success: boolean, symbol: string): void {
    this.record('trade.execution_time', durationMs, 'ms', { success: String(success), symbol });
  }

  /**
   * Record signal detection
   */
  recordSignalDetected(pattern: string, confidence: number, symbol: string): void {
    this.record('signal.detected', 1, 'count', { pattern, symbol });
    this.record('signal.confidence', confidence, 'ratio', { pattern, symbol });
  }

  /**
   * Record risk check
   */
  recordRiskCheck(approved: boolean, kellyFraction: number): void {
    this.record('risk.check', 1, 'count', { approved: String(approved) });
    this.record('risk.kelly_fraction', kellyFraction, 'ratio');
  }

  /**
   * Record portfolio value
   */
  recordPortfolioValue(value: number): void {
    this.record('portfolio.value', value, 'usd');
  }

  /**
   * Record daily P&L
   */
  recordDailyPnL(pnl: number, pnlPercent: number): void {
    this.record('portfolio.daily_pnl', pnl, 'usd');
    this.record('portfolio.daily_pnl_percent', pnlPercent, 'percent');
  }

  /**
   * Record API latency
   */
  recordApiLatency(endpoint: string, durationMs: number, status: number): void {
    this.record('api.latency', durationMs, 'ms', { endpoint, status: String(status) });
  }

  /**
   * Get all metrics (for dashboards)
   */
  getMetrics(): MetricEntry[] {
    return [...this.metrics];
  }

  /**
   * Get metrics summary
   */
  getSummary(): Record<string, number> {
    const summary: Record<string, number> = {};

    for (const metric of this.metrics) {
      if (!summary[metric.name]) {
        summary[metric.name] = 0;
      }
      summary[metric.name] += metric.value;
    }

    return summary;
  }

  /**
   * Clear metrics buffer
   */
  clear(): void {
    this.metrics = [];
  }
}

/**
 * Create a logger instance for an agent
 */
export function createLogger(agentId: string): Logger {
  return new Logger(agentId);
}

/**
 * Create a metrics collector for an agent
 */
export function createMetricsCollector(agentId: string): MetricsCollector {
  return new MetricsCollector(agentId);
}
