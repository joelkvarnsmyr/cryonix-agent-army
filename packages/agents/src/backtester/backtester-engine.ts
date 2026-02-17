import type { TradingSignal, PatternType } from '@cryonix/types';
import type { OhlcvData, PatternDetector } from '../market-scout/pattern-detectors';
import {
  BollingerSqueezeDetector,
  VolumeSpikeDetector,
  TriangleBreakoutDetector,
  RSIDivergenceDetector,
} from '../market-scout/pattern-detectors';
import {
  calculateKellyFraction,
  calculateHalfKelly,
  calculateRiskRewardRatio,
  calculatePositionSize,
} from '../risk-manager/kelly-criterion';
import { calculatePerformanceMetrics } from './performance-metrics';
import {
  runMonteCarloSimulation,
  type MonteCarloResult,
  type MonteCarloConfig as MCConfig,
} from './monte-carlo';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestState,
  BacktestPosition,
  BacktestTrade,
  EquityPoint,
  SkippedSignal,
  HistoricalDataResult,
  WalkForwardResult,
  PerformanceMetrics,
} from './types';

export class BacktesterEngine {
  private config: BacktestConfig;
  private patternDetectors: Map<PatternType, PatternDetector>;
  private historicalData: Map<string, OhlcvData[]> = new Map();

  constructor(config: BacktestConfig) {
    this.config = config;
    this.patternDetectors = this.initializePatternDetectors();
  }

  private initializePatternDetectors(): Map<PatternType, PatternDetector> {
    const detectors = new Map<PatternType, PatternDetector>();

    const allDetectors: { type: PatternType; detector: PatternDetector }[] = [
      { type: 'bollinger_squeeze', detector: new BollingerSqueezeDetector() },
      { type: 'volume_spike', detector: new VolumeSpikeDetector() },
      { type: 'triangle_breakout', detector: new TriangleBreakoutDetector() },
      { type: 'custom', detector: new RSIDivergenceDetector() }, // RSI maps to custom
    ];

    for (const { type, detector } of allDetectors) {
      if (this.config.patterns.includes(type) || this.config.patterns.length === 0) {
        detectors.set(type, detector);
      }
    }

    return detectors;
  }

  /**
   * Load historical data from provided sources
   */
  public loadHistoricalData(data: HistoricalDataResult[]): void {
    for (const result of data) {
      const key = `${result.symbol}:${result.timeframe}`;
      this.historicalData.set(key, result.candles);
    }
  }

  /**
   * Run the backtest
   */
  public async run(): Promise<BacktestResult> {
    const startedAt = new Date();

    // Initialize state
    const state: BacktestState = {
      currentTime: this.config.startDate,
      currentCandle: 0,
      equity: this.config.initialCapital,
      cash: this.config.initialCapital,
      positions: new Map(),
      trades: [],
      equityCurve: [],
      peakEquity: this.config.initialCapital,
      dailyPnL: [],
      skippedSignals: [],
    };

    // Record initial equity
    state.equityCurve.push({
      timestamp: this.config.startDate,
      equity: state.equity,
      drawdown: 0,
      drawdownPercent: 0,
    });

    // Check if walk-forward is enabled
    if (this.config.walkForward) {
      return this.runWalkForward(state, startedAt);
    }

    // Run standard backtest
    await this.runBacktest(state);

    return this.createResult(state, startedAt);
  }

  /**
   * Run standard backtest simulation
   */
  private async runBacktest(state: BacktestState): Promise<void> {
    // Get all symbols' data
    for (const symbol of this.config.symbols) {
      const key = `${symbol}:${this.config.timeframe}`;
      const candles = this.historicalData.get(key);

      if (!candles || candles.length === 0) {
        console.warn(`No data for ${symbol}, skipping`);
        continue;
      }

      // Filter candles to backtest period
      const filteredCandles = candles.filter((c) => {
        const candleTime = new Date(c.timestamp);
        return candleTime >= this.config.startDate && candleTime <= this.config.endDate;
      });

      if (filteredCandles.length < 100) {
        console.warn(`Insufficient data for ${symbol} (need 100 candles, have ${filteredCandles.length})`);
        continue;
      }

      // Process each candle
      for (let i = 100; i < filteredCandles.length; i++) {
        const lookbackCandles = filteredCandles.slice(i - 100, i);
        const currentCandle = filteredCandles[i];
        const candleTime = new Date(currentCandle.timestamp);

        state.currentTime = candleTime;
        state.currentCandle = i;

        // Check for stop-loss/take-profit on existing positions
        this.checkExits(state, symbol, currentCandle);

        // Run pattern detection
        const signals = this.detectPatterns(lookbackCandles, symbol);

        // Process signals
        for (const signal of signals) {
          this.processSignal(state, signal, currentCandle);
        }

        // Update equity curve periodically (every 10 candles to avoid huge arrays)
        if (i % 10 === 0) {
          this.updateEquityCurve(state, currentCandle);
        }
      }
    }

    // Close all remaining positions at end of backtest
    this.closeAllPositions(state, 'end_of_backtest');
  }

  /**
   * Run walk-forward optimization
   */
  private async runWalkForward(state: BacktestState, startedAt: Date): Promise<BacktestResult> {
    const walkForwardResults: WalkForwardResult[] = [];
    const wf = this.config.walkForward!;

    const totalDays = Math.floor(
      (this.config.endDate.getTime() - this.config.startDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    const windowSize = wf.inSampleDays + wf.outOfSampleDays;
    const effectiveWindows = Math.min(wf.windows, Math.floor(totalDays / windowSize));

    for (let w = 0; w < effectiveWindows; w++) {
      const windowStartMs = this.config.startDate.getTime() + w * wf.outOfSampleDays * 24 * 60 * 60 * 1000;

      const inSampleStart = new Date(windowStartMs);
      const inSampleEnd = new Date(windowStartMs + wf.inSampleDays * 24 * 60 * 60 * 1000);
      const outOfSampleStart = inSampleEnd;
      const outOfSampleEnd = new Date(outOfSampleStart.getTime() + wf.outOfSampleDays * 24 * 60 * 60 * 1000);

      // Skip if out-of-sample would exceed backtest end date
      if (outOfSampleEnd > this.config.endDate) break;

      // Run in-sample optimization (simplified - just run backtest and get metrics)
      const inSampleState = this.createFreshState();
      const inSampleConfig = { ...this.config, startDate: inSampleStart, endDate: inSampleEnd };
      const inSampleEngine = new BacktesterEngine(inSampleConfig);
      inSampleEngine.loadHistoricalData(Array.from(this.historicalData.entries()).map(([key, candles]) => {
        const [symbol, timeframe] = key.split(':');
        return { symbol, timeframe, candles, fetchedAt: new Date() };
      }));

      await inSampleEngine.runBacktest(inSampleState);
      const inSampleMetrics = this.calculateMetrics(inSampleState, wf.inSampleDays);

      // Run out-of-sample test
      const outOfSampleState = this.createFreshState();
      const outOfSampleConfig = { ...this.config, startDate: outOfSampleStart, endDate: outOfSampleEnd };
      const outOfSampleEngine = new BacktesterEngine(outOfSampleConfig);
      outOfSampleEngine.loadHistoricalData(Array.from(this.historicalData.entries()).map(([key, candles]) => {
        const [symbol, timeframe] = key.split(':');
        return { symbol, timeframe, candles, fetchedAt: new Date() };
      }));

      await outOfSampleEngine.runBacktest(outOfSampleState);
      const outOfSampleMetrics = this.calculateMetrics(outOfSampleState, wf.outOfSampleDays);

      // Calculate robustness score
      const robustnessScore = this.calculateRobustnessScore(inSampleMetrics, outOfSampleMetrics);

      walkForwardResults.push({
        windowIndex: w,
        inSampleStart,
        inSampleEnd,
        outOfSampleStart,
        outOfSampleEnd,
        optimizedParams: {}, // Simplified - no param optimization yet
        inSampleMetrics,
        outOfSampleMetrics,
        robustnessScore,
      });

      // Accumulate out-of-sample trades to main state
      state.trades.push(...outOfSampleState.trades);
      state.equityCurve.push(...outOfSampleState.equityCurve);
      state.skippedSignals.push(...outOfSampleState.skippedSignals);
    }

    // Recalculate final equity based on accumulated trades
    const totalPnl = state.trades.reduce((sum, t) => sum + t.pnl, 0);
    state.equity = this.config.initialCapital + totalPnl;
    state.cash = state.equity;

    const result = this.createResult(state, startedAt);
    result.walkForwardResults = walkForwardResults;

    return result;
  }

  /**
   * Calculate robustness score comparing in-sample to out-of-sample
   */
  private calculateRobustnessScore(inSample: PerformanceMetrics, outOfSample: PerformanceMetrics): number {
    // Score based on how well out-of-sample matches in-sample
    const factors: number[] = [];

    // Win rate similarity (within 20% is good)
    if (inSample.winRate > 0) {
      const winRateRatio = Math.min(outOfSample.winRate / inSample.winRate, inSample.winRate / outOfSample.winRate);
      factors.push(Math.max(0, winRateRatio));
    }

    // Profit factor similarity
    if (inSample.profitFactor > 0 && inSample.profitFactor !== Infinity) {
      const pfRatio = Math.min(
        outOfSample.profitFactor / inSample.profitFactor,
        inSample.profitFactor / outOfSample.profitFactor
      );
      factors.push(Math.max(0, Math.min(1, pfRatio)));
    }

    // Sharpe similarity
    if (inSample.sharpeRatio > 0) {
      const sharpeRatio = outOfSample.sharpeRatio / inSample.sharpeRatio;
      factors.push(Math.max(0, Math.min(1, sharpeRatio)));
    }

    // Out-of-sample should still be profitable
    if (outOfSample.totalReturnPercent > 0) {
      factors.push(1);
    } else {
      factors.push(0);
    }

    // Average all factors
    return factors.length > 0 ? factors.reduce((a, b) => a + b, 0) / factors.length : 0;
  }

  /**
   * Detect patterns in candle data
   */
  private detectPatterns(candles: OhlcvData[], symbol: string): TradingSignal[] {
    const signals: TradingSignal[] = [];

    for (const [, detector] of this.patternDetectors) {
      try {
        const signal = detector.detect(candles, symbol);

        if (signal && signal.confidence >= this.config.minConfidence) {
          signals.push({
            id: crypto.randomUUID(),
            timestamp: new Date(candles[candles.length - 1].timestamp),
            symbol: signal.symbol,
            action: signal.action,
            confidence: signal.confidence,
            pattern: signal.pattern,
            reasoning: signal.reasoning,
            entry_price: signal.entry_price,
            target_price: signal.target_price,
            stop_loss: signal.stop_loss,
            timeframe: signal.timeframe,
            agent_id: 'backtester',
          });
        }
      } catch (error) {
        // Detector failed, continue with others
      }
    }

    return signals;
  }

  /**
   * Process a trading signal
   */
  private processSignal(state: BacktestState, signal: TradingSignal, currentCandle: OhlcvData): void {
    // Skip if already in position for this symbol
    if (state.positions.has(signal.symbol)) {
      state.skippedSignals.push({
        signal,
        reason: 'already_in_position',
        timestamp: state.currentTime,
      });
      return;
    }

    // Skip if max positions reached
    if (state.positions.size >= this.config.maxConcurrentPositions) {
      state.skippedSignals.push({
        signal,
        reason: 'max_positions',
        timestamp: state.currentTime,
      });
      return;
    }

    // Skip WAIT signals
    if (signal.action === 'WAIT') {
      return;
    }

    // Calculate position size
    const positionSize = this.calculatePositionSize(state, signal);

    if (positionSize <= 0) {
      state.skippedSignals.push({
        signal,
        reason: 'risk_exceeded',
        timestamp: state.currentTime,
      });
      return;
    }

    // Check if we have enough cash
    const entryPrice = this.applySlippage(signal.entry_price, signal.action);
    const positionValue = positionSize * entryPrice;
    const fees = positionValue * (this.config.feePercent / 100);

    if (positionValue + fees > state.cash) {
      state.skippedSignals.push({
        signal,
        reason: 'insufficient_capital',
        timestamp: state.currentTime,
      });
      return;
    }

    // Open position
    const position: BacktestPosition = {
      id: crypto.randomUUID(),
      symbol: signal.symbol,
      side: signal.action === 'BUY' ? 'LONG' : 'SHORT',
      entryPrice,
      entryTime: state.currentTime,
      quantity: positionSize,
      stopLoss: signal.stop_loss,
      takeProfit: signal.target_price,
      confidence: signal.confidence,
      pattern: signal.pattern as PatternType,
      signalId: signal.id,
    };

    state.positions.set(signal.symbol, position);
    state.cash -= positionValue + fees;
  }

  /**
   * Calculate position size using configured method
   */
  private calculatePositionSize(state: BacktestState, signal: TradingSignal): number {
    if (this.config.positionSizing === 'fixed') {
      const positionValue = state.equity * ((this.config.fixedPositionPercent ?? 2) / 100);
      return positionValue / signal.entry_price;
    }

    if (this.config.positionSizing === 'kelly') {
      try {
        const riskRewardRatio = calculateRiskRewardRatio(
          signal.entry_price,
          signal.stop_loss,
          signal.target_price
        );

        const kellyFraction = this.config.useHalfKelly
          ? calculateHalfKelly(signal.confidence, riskRewardRatio)
          : calculateKellyFraction(signal.confidence, riskRewardRatio);

        if (kellyFraction <= 0) return 0;

        const positionValue = calculatePositionSize({
          portfolioValue: state.equity,
          kellyFraction,
          maxRiskPercent: this.config.maxRiskPercent,
          maxPositionPercent: this.config.maxPositionPercent,
        });

        return positionValue / signal.entry_price;
      } catch {
        return 0;
      }
    }

    // ATR-based sizing (simplified)
    const positionValue = state.equity * this.config.maxRiskPercent;
    return positionValue / signal.entry_price;
  }

  /**
   * Apply slippage to price
   */
  private applySlippage(price: number, action: 'BUY' | 'SELL' | 'WAIT'): number {
    const slippageFactor = 1 + this.config.slippagePercent / 100;
    if (action === 'BUY') {
      return price * slippageFactor; // Worse fill for buys
    }
    return price / slippageFactor; // Worse fill for sells
  }

  /**
   * Check for stop-loss and take-profit exits
   */
  private checkExits(state: BacktestState, symbol: string, candle: OhlcvData): void {
    const position = state.positions.get(symbol);
    if (!position) return;

    let exitPrice: number | null = null;
    let exitReason: 'stop_loss' | 'take_profit' | null = null;

    if (position.side === 'LONG') {
      // Check stop-loss
      if (candle.low <= position.stopLoss) {
        exitPrice = position.stopLoss;
        exitReason = 'stop_loss';
      }
      // Check take-profit
      else if (candle.high >= position.takeProfit) {
        exitPrice = position.takeProfit;
        exitReason = 'take_profit';
      }
    } else {
      // SHORT position
      if (candle.high >= position.stopLoss) {
        exitPrice = position.stopLoss;
        exitReason = 'stop_loss';
      } else if (candle.low <= position.takeProfit) {
        exitPrice = position.takeProfit;
        exitReason = 'take_profit';
      }
    }

    if (exitPrice && exitReason) {
      this.closePosition(state, position, exitPrice, exitReason, new Date(candle.timestamp));
    }
  }

  /**
   * Close a position
   */
  private closePosition(
    state: BacktestState,
    position: BacktestPosition,
    exitPrice: number,
    exitReason: 'stop_loss' | 'take_profit' | 'signal' | 'end_of_backtest',
    exitTime: Date
  ): void {
    // Apply slippage to exit
    const finalExitPrice = position.side === 'LONG'
      ? exitPrice * (1 - this.config.slippagePercent / 100)
      : exitPrice * (1 + this.config.slippagePercent / 100);

    // Calculate P&L
    let pnl: number;
    if (position.side === 'LONG') {
      pnl = (finalExitPrice - position.entryPrice) * position.quantity;
    } else {
      pnl = (position.entryPrice - finalExitPrice) * position.quantity;
    }

    // Subtract fees
    const positionValue = position.quantity * finalExitPrice;
    const fees = positionValue * (this.config.feePercent / 100);
    pnl -= fees;

    const pnlPercent = (pnl / (position.entryPrice * position.quantity)) * 100;

    // Calculate holding period
    const holdingPeriodMs = exitTime.getTime() - position.entryTime.getTime();
    const candleMs = this.getTimeframePeriodMs();
    const holdingPeriodCandles = Math.round(holdingPeriodMs / candleMs);

    // Create trade record
    const trade: BacktestTrade = {
      id: crypto.randomUUID(),
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: finalExitPrice,
      entryTime: position.entryTime,
      exitTime,
      quantity: position.quantity,
      pnl,
      pnlPercent,
      fees,
      slippage: Math.abs(exitPrice - finalExitPrice),
      exitReason,
      pattern: position.pattern,
      confidence: position.confidence,
      holdingPeriodCandles,
    };

    state.trades.push(trade);

    // Update cash
    state.cash += positionValue - fees;
    state.positions.delete(position.symbol);

    // Update equity
    state.equity = state.cash + this.calculateOpenPositionsValue(state);
  }

  /**
   * Close all open positions
   */
  private closeAllPositions(state: BacktestState, reason: 'end_of_backtest'): void {
    for (const [, position] of state.positions) {
      // Use last known price (simplified - use entry as approximation)
      const key = `${position.symbol}:${this.config.timeframe}`;
      const candles = this.historicalData.get(key);
      const lastPrice = candles && candles.length > 0
        ? candles[candles.length - 1].close
        : position.entryPrice;

      this.closePosition(state, position, lastPrice, reason, state.currentTime);
    }
  }

  /**
   * Calculate current value of open positions
   */
  private calculateOpenPositionsValue(state: BacktestState): number {
    let value = 0;

    for (const [symbol, position] of state.positions) {
      const key = `${symbol}:${this.config.timeframe}`;
      const candles = this.historicalData.get(key);
      const currentPrice = candles && candles.length > 0
        ? candles[candles.length - 1].close
        : position.entryPrice;

      value += position.quantity * currentPrice;
    }

    return value;
  }

  /**
   * Update equity curve
   */
  private updateEquityCurve(state: BacktestState, candle: OhlcvData): void {
    const equity = state.cash + this.calculateOpenPositionsValue(state);
    state.equity = equity;

    if (equity > state.peakEquity) {
      state.peakEquity = equity;
    }

    const drawdown = state.peakEquity - equity;
    const drawdownPercent = state.peakEquity > 0 ? (drawdown / state.peakEquity) * 100 : 0;

    state.equityCurve.push({
      timestamp: new Date(candle.timestamp),
      equity,
      drawdown,
      drawdownPercent,
    });
  }

  /**
   * Get timeframe period in milliseconds
   */
  private getTimeframePeriodMs(): number {
    const tf = this.config.timeframe;
    const unit = tf.slice(-1);
    const value = parseInt(tf.slice(0, -1));

    switch (unit) {
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      default:
        return 15 * 60 * 1000; // Default 15m
    }
  }

  /**
   * Create fresh backtest state
   */
  private createFreshState(): BacktestState {
    return {
      currentTime: this.config.startDate,
      currentCandle: 0,
      equity: this.config.initialCapital,
      cash: this.config.initialCapital,
      positions: new Map(),
      trades: [],
      equityCurve: [],
      peakEquity: this.config.initialCapital,
      dailyPnL: [],
      skippedSignals: [],
    };
  }

  /**
   * Calculate metrics from state
   */
  private calculateMetrics(state: BacktestState, tradingDays: number): PerformanceMetrics {
    return calculatePerformanceMetrics(
      state.trades,
      state.equityCurve,
      this.config.initialCapital,
      tradingDays
    );
  }

  /**
   * Create final backtest result
   */
  private createResult(state: BacktestState, startedAt: Date): BacktestResult {
    const completedAt = new Date();
    const tradingDays = Math.floor(
      (this.config.endDate.getTime() - this.config.startDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    const result: BacktestResult = {
      id: crypto.randomUUID(),
      config: this.config,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      finalEquity: state.equity,
      metrics: this.calculateMetrics(state, tradingDays),
      trades: state.trades,
      skippedSignals: state.skippedSignals,
    };

    // Run Monte Carlo simulation if enabled
    if (this.config.monteCarlo?.enabled && state.trades.length > 0) {
      result.monteCarloResult = this.runMonteCarloAnalysis(state.trades);
    }

    return result;
  }

  /**
   * Run Monte Carlo simulation for robustness analysis
   */
  private runMonteCarloAnalysis(trades: BacktestTrade[]): MonteCarloResult {
    const mcConfig: MCConfig = {
      numSimulations: this.config.monteCarlo?.numSimulations ?? 1000,
      method: this.config.monteCarlo?.method ?? 'both',
      confidenceLevels: this.config.monteCarlo?.confidenceLevels ?? [0.90, 0.95, 0.99],
      initialCapital: this.config.initialCapital,
    };

    return runMonteCarloSimulation(trades, mcConfig);
  }
}
