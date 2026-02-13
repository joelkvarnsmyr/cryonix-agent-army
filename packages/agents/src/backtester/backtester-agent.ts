import { BaseAgent } from '../base-agent';
import type { AgentMessage, PatternType } from '@cryonix/types';
import { BacktesterEngine } from './backtester-engine';
import { formatMetricsReport } from './performance-metrics';
import { formatMonteCarloReport } from './monte-carlo';
import type {
  BacktestConfig,
  BacktestResult,
  HistoricalDataResult,
} from './types';
import type { OhlcvData } from '../market-scout/pattern-detectors';
import ccxt, { Exchange } from 'ccxt';

export interface BacktestRequest {
  symbols?: string[];
  startDate?: Date;
  endDate?: Date;
  timeframe?: string;
  patterns?: PatternType[];
  initialCapital?: number;
  positionSizing?: 'fixed' | 'kelly' | 'atr';
  useHalfKelly?: boolean;
  walkForward?: {
    enabled: boolean;
    windows?: number;
    inSampleDays?: number;
    outOfSampleDays?: number;
  };
  monteCarlo?: {
    enabled: boolean;
    numSimulations?: number;
    method?: 'shuffle' | 'bootstrap' | 'both';
    confidenceLevels?: number[];
  };
}

export class BacktesterAgent extends BaseAgent {
  private exchange: Exchange | null = null;
  private results: Map<string, BacktestResult> = new Map();

  constructor() {
    super({
      id: 'market_scout', // Reuse market_scout ID since backtesting is related
      name: 'Backtester Agent',
      description: 'Runs historical backtests on trading strategies',
      enabled: true,
    });
  }

  async initialize(): Promise<void> {
    this.log('info', 'Initializing Backtester Agent...');

    // Initialize exchange for fetching historical data
    this.exchange = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
      enableRateLimit: true,
    });

    this.setStatus('idle');
    this.log('info', 'Backtester Agent initialized');
  }

  async start(): Promise<void> {
    this.log('info', 'Backtester Agent ready');
    this.setStatus('running');
  }

  async stop(): Promise<void> {
    this.log('info', 'Stopping Backtester Agent...');
    this.setStatus('idle');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', 'Received message', message);

    if (message.message_type === 'RUN_BACKTEST') {
      const request = message.data as BacktestRequest;
      try {
        const result = await this.runBacktest(request);
        this.emit('backtest_complete', { requestId: message.agent_id, result });
      } catch (error) {
        this.emit('backtest_error', { requestId: message.agent_id, error });
      }
    }
  }

  /**
   * Run a backtest with the given parameters
   */
  async runBacktest(request: BacktestRequest): Promise<BacktestResult> {
    this.log('info', 'Starting backtest...', request);
    this.setStatus('running');

    // Build config with defaults
    const config: BacktestConfig = {
      initialCapital: request.initialCapital ?? 10000,
      symbols: request.symbols ?? ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      startDate: request.startDate ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days ago
      endDate: request.endDate ?? new Date(),
      timeframe: request.timeframe ?? '15m',
      patterns: request.patterns ?? ['bollinger_squeeze', 'volume_spike', 'triangle_breakout'],
      positionSizing: request.positionSizing ?? 'kelly',
      useHalfKelly: request.useHalfKelly ?? true,
      fixedPositionPercent: 0.02,
      maxPositionPercent: 0.30,
      maxRiskPercent: 0.02,
      slippagePercent: 0.1,
      feePercent: 0.1,
      minConfidence: 0.6,
      maxConcurrentPositions: 5,
      walkForward: request.walkForward?.enabled
        ? {
            windows: request.walkForward.windows ?? 4,
            inSampleDays: request.walkForward.inSampleDays ?? 60,
            outOfSampleDays: request.walkForward.outOfSampleDays ?? 15,
            optimizeParams: ['minConfidence', 'maxPositionPercent'],
          }
        : undefined,
      monteCarlo: request.monteCarlo?.enabled
        ? {
            enabled: true,
            numSimulations: request.monteCarlo.numSimulations ?? 1000,
            method: request.monteCarlo.method ?? 'both',
            confidenceLevels: request.monteCarlo.confidenceLevels ?? [0.90, 0.95, 0.99],
          }
        : undefined,
    };

    // Create engine
    const engine = new BacktesterEngine(config);

    // Fetch historical data
    this.log('info', 'Fetching historical data...');
    const historicalData = await this.fetchHistoricalData(
      config.symbols,
      config.timeframe,
      config.startDate,
      config.endDate
    );

    // Load data into engine
    engine.loadHistoricalData(historicalData);

    // Run backtest
    this.log('info', 'Running backtest simulation...');
    const result = await engine.run();

    // Store result
    this.results.set(result.id, result);

    // Log summary
    this.log('info', 'Backtest complete', {
      trades: result.metrics.totalTrades,
      winRate: result.metrics.winRate.toFixed(1) + '%',
      sharpe: result.metrics.sharpeRatio.toFixed(2),
      return: result.metrics.totalReturnPercent.toFixed(2) + '%',
    });

    // Print formatted report
    console.log(formatMetricsReport(result.metrics));

    // Print Monte Carlo report if available
    if (result.monteCarloResult) {
      console.log(formatMonteCarloReport(result.monteCarloResult));
    }

    this.setStatus('idle');
    return result;
  }

  /**
   * Fetch historical OHLCV data from exchange
   */
  private async fetchHistoricalData(
    symbols: string[],
    timeframe: string,
    startDate: Date,
    endDate: Date
  ): Promise<HistoricalDataResult[]> {
    const results: HistoricalDataResult[] = [];

    if (!this.exchange) {
      throw new Error('Exchange not initialized');
    }

    for (const symbol of symbols) {
      try {
        this.log('info', `Fetching ${symbol} data...`);

        // Calculate required candles
        const timeframePeriodMs = this.getTimeframePeriodMs(timeframe);
        const totalPeriodMs = endDate.getTime() - startDate.getTime();
        const requiredCandles = Math.ceil(totalPeriodMs / timeframePeriodMs) + 100; // Extra for lookback

        // Binance limits to 1000 candles per request, so we may need multiple
        const allCandles: OhlcvData[] = [];
        let since = startDate.getTime() - 100 * timeframePeriodMs; // Start earlier for lookback

        while (since < endDate.getTime()) {
          const limit = Math.min(1000, requiredCandles - allCandles.length);
          if (limit <= 0) break;

          const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, since, limit);

          if (ohlcv.length === 0) break;

          for (const [timestamp, open, high, low, close, volume] of ohlcv) {
            allCandles.push({
              timestamp: timestamp as number,
              open: open as number,
              high: high as number,
              low: low as number,
              close: close as number,
              volume: volume as number,
            });
          }

          // Move to next batch
          since = (ohlcv[ohlcv.length - 1][0] as number) + timeframePeriodMs;

          // Rate limiting
          await this.sleep(100);
        }

        // Remove duplicates and sort
        const uniqueCandles = this.deduplicateCandles(allCandles);

        results.push({
          symbol,
          timeframe,
          candles: uniqueCandles,
          fetchedAt: new Date(),
        });

        this.log('info', `Fetched ${uniqueCandles.length} candles for ${symbol}`);
      } catch (error) {
        this.log('error', `Failed to fetch ${symbol} data`, error);
      }
    }

    return results;
  }

  /**
   * Remove duplicate candles and sort by timestamp
   */
  private deduplicateCandles(candles: OhlcvData[]): OhlcvData[] {
    const seen = new Set<number>();
    const unique: OhlcvData[] = [];

    for (const candle of candles) {
      if (!seen.has(candle.timestamp)) {
        seen.add(candle.timestamp);
        unique.push(candle);
      }
    }

    return unique.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get timeframe period in milliseconds
   */
  private getTimeframePeriodMs(timeframe: string): number {
    const unit = timeframe.slice(-1);
    const value = parseInt(timeframe.slice(0, -1));

    switch (unit) {
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      default:
        return 15 * 60 * 1000;
    }
  }

  /**
   * Get a previous backtest result
   */
  getResult(id: string): BacktestResult | undefined {
    return this.results.get(id);
  }

  /**
   * Get all backtest results
   */
  getAllResults(): BacktestResult[] {
    return Array.from(this.results.values());
  }

  /**
   * Clear stored results
   */
  clearResults(): void {
    this.results.clear();
  }

  /**
   * Run quick backtest with default settings (useful for validation)
   */
  async runQuickBacktest(days: number = 30): Promise<BacktestResult> {
    return this.runBacktest({
      symbols: ['BTC/USDT'],
      startDate: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
      endDate: new Date(),
      timeframe: '1h', // Faster with hourly
      initialCapital: 10000,
    });
  }
}
