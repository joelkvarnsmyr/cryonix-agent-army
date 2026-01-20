import { BaseAgent } from '../base-agent';
import type { AgentMessage, TradingSignal, PatternType } from '@cryonix/types';
import ccxt from 'ccxt';

export class MarketScoutAgent extends BaseAgent {
  private exchange: ccxt.Exchange | null = null;
  private watchlist: string[] = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
  private scanInterval: NodeJS.Timeout | null = null;

  constructor() {
    super({
      id: 'market_scout',
      name: 'Market Scout Agent',
      description: 'Scans markets 24/7 for trading opportunities',
      enabled: true,
    });
  }

  async initialize(): Promise<void> {
    this.log('info', 'Initializing Market Scout Agent...');

    // Initialize Binance exchange
    this.exchange = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
      enableRateLimit: true,
    });

    this.setStatus('idle');
  }

  async start(): Promise<void> {
    this.log('info', 'Starting Market Scout Agent...');
    this.setStatus('running');

    // Start scanning every 15 seconds
    this.scanInterval = setInterval(() => {
      this.scanMarkets();
    }, 15000);

    // Initial scan
    await this.scanMarkets();
  }

  async stop(): Promise<void> {
    this.log('info', 'Stopping Market Scout Agent...');

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    this.setStatus('idle');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', 'Received message', message);
  }

  private async scanMarkets(): Promise<void> {
    try {
      this.log('info', '🔍 Scanning markets for opportunities...');

      const signals: TradingSignal[] = [];

      for (const symbol of this.watchlist) {
        const signal = await this.analyzeSymbol(symbol);
        if (signal) {
          signals.push(signal);
        }
      }

      if (signals.length > 0) {
        this.log('info', `Found ${signals.length} trading signals`);
        // Emit signals to orchestrator
        this.emit('signals_found', signals);
      }
    } catch (error) {
      this.log('error', 'Error scanning markets', error);
    }
  }

  private async analyzeSymbol(symbol: string): Promise<TradingSignal | null> {
    try {
      if (!this.exchange) {
        throw new Error('Exchange not initialized');
      }

      // Fetch candlestick data
      const timeframe = '15m';
      const limit = 100;
      const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

      // Convert to more usable format
      const candles = ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
      }));

      // Run pattern detectors
      const bollingerSignal = this.detectBollingerSqueeze(candles);
      const triangleSignal = this.detectTriangleBreakout(candles);
      const volumeSignal = this.detectVolumeSpike(candles);

      // Return strongest signal
      const signals = [bollingerSignal, triangleSignal, volumeSignal].filter(Boolean);

      if (signals.length > 0) {
        // Sort by confidence and return best
        signals.sort((a, b) => (b?.confidence || 0) - (a?.confidence || 0));
        return signals[0] || null;
      }

      return null;
    } catch (error) {
      this.log('error', `Error analyzing ${symbol}`, error);
      return null;
    }
  }

  private detectBollingerSqueeze(candles: any[]): TradingSignal | null {
    // Simplified Bollinger Squeeze detector
    // In production, use proper technical analysis library

    const closes = candles.map(c => c.close);
    const lastClose = closes[closes.length - 1];

    // Calculate simple moving average
    const sma20 = this.calculateSMA(closes, 20);
    const std20 = this.calculateStdDev(closes, 20);

    const upperBand = sma20 + (2 * std20);
    const lowerBand = sma20 - (2 * std20);
    const bandwidth = (upperBand - lowerBand) / sma20;

    // Historical average bandwidth
    const avgBandwidth = 0.05; // Simplified

    // Squeeze detected if bandwidth < 50% of average
    if (bandwidth < avgBandwidth * 0.5) {
      return {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        symbol: candles[0].symbol || 'BTC/USDT',
        action: 'BUY',
        confidence: 0.72,
        pattern: 'bollinger_squeeze',
        reasoning: [
          'Bollinger Bands squeeze detected',
          'Bandwidth compressed below threshold',
          'Breakout imminent (historically 68-75% probability)',
        ],
        entry_price: lastClose,
        target_price: lastClose * 1.05,
        stop_loss: lastClose * 0.98,
        timeframe: '1-4 days',
        agent_id: this.config.id,
      };
    }

    return null;
  }

  private detectTriangleBreakout(candles: any[]): TradingSignal | null {
    // Simplified triangle breakout detector
    // Real implementation would use proper pattern recognition
    return null;
  }

  private detectVolumeSpike(candles: any[]): TradingSignal | null {
    const volumes = candles.map(c => c.volume);
    const lastVolume = volumes[volumes.length - 1];
    const avgVolume = this.calculateSMA(volumes, 20);

    // Volume spike if > 2x average
    if (lastVolume > avgVolume * 2) {
      const lastClose = candles[candles.length - 1].close;

      return {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        symbol: candles[0].symbol || 'BTC/USDT',
        action: 'BUY',
        confidence: 0.65,
        pattern: 'volume_spike',
        reasoning: [
          `Volume spike detected (${(lastVolume / avgVolume).toFixed(2)}x average)`,
          'Indicates strong interest',
          'Potential breakout or breakdown',
        ],
        entry_price: lastClose,
        target_price: lastClose * 1.03,
        stop_loss: lastClose * 0.99,
        agent_id: this.config.id,
      };
    }

    return null;
  }

  private calculateSMA(values: number[], period: number): number {
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  private calculateStdDev(values: number[], period: number): number {
    const slice = values.slice(-period);
    const mean = this.calculateSMA(values, period);
    const squareDiffs = slice.map(value => Math.pow(value - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / slice.length;
    return Math.sqrt(avgSquareDiff);
  }
}
