import { BaseAgent } from '../base-agent';
import type { AgentMessage, TradingSignal } from '@cryonix/types';
import ccxt, { Exchange } from 'ccxt';
import {
  BollingerSqueezeDetector,
  VolumeSpikeDetector,
  TriangleBreakoutDetector,
  RSIDivergenceDetector,
  type PatternDetector,
  type OhlcvData,
} from './pattern-detectors';
import { createSignal } from '@cryonix/database';

export class MarketScoutAgent extends BaseAgent {
  private exchange: Exchange | null = null;
  private watchlist: string[] = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
  private scanInterval: NodeJS.Timeout | null = null;
  private patternDetectors: PatternDetector[] = [];
  private top20Coins: string[] = [];
  private lastTop20Update: number = 0;
  private readonly TOP20_CACHE_DURATION = 60 * 60 * 1000; // 1 hour in ms

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

    // Initialize pattern detectors
    this.patternDetectors = [
      new BollingerSqueezeDetector(),
      new VolumeSpikeDetector(),
      new TriangleBreakoutDetector(),
      new RSIDivergenceDetector(),
    ];

    this.log('info', `Loaded ${this.patternDetectors.length} pattern detectors`);
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

  /**
   * Fetch top 20 coins by 24h volume (USDT pairs)
   * Cached for 1 hour to reduce API calls
   */
  private async getTop20Coins(): Promise<string[]> {
    const now = Date.now();

    // Return cached top 20 if still valid
    if (this.top20Coins.length > 0 && (now - this.lastTop20Update) < this.TOP20_CACHE_DURATION) {
      return this.top20Coins;
    }

    try {
      if (!this.exchange) {
        throw new Error('Exchange not initialized');
      }

      this.log('info', 'Fetching top 20 coins by volume...');

      // Fetch all tickers
      const tickers = await this.exchange.fetchTickers();

      // Filter USDT pairs and sort by 24h volume
      const usdtPairs = Object.keys(tickers)
        .filter(symbol => symbol.endsWith('/USDT') && tickers[symbol].quoteVolume)
        .map(symbol => ({
          symbol,
          volume: tickers[symbol].quoteVolume || 0
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 20)
        .map(pair => pair.symbol);

      this.top20Coins = usdtPairs;
      this.lastTop20Update = now;

      this.log('info', `Updated top 20 coins:`, usdtPairs.slice(0, 5).join(', ') + '...');
      return this.top20Coins;

    } catch (error) {
      this.log('error', 'Error fetching top 20 coins, using fallback watchlist', error);
      // Fallback to default watchlist if API fails
      return this.watchlist;
    }
  }

  private async scanMarkets(): Promise<void> {
    try {
      this.log('info', '🔍 Scanning markets for opportunities...');

      const signals: TradingSignal[] = [];

      // Get top 20 coins by volume
      const symbols = await this.getTop20Coins();

      // Process symbols in parallel batches of 5 to respect rate limits
      const batchSize = 5;
      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map(symbol => this.analyzeSymbol(symbol))
        );

        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value) {
            signals.push(result.value);
          }
        }

        // Small delay between batches to respect rate limits
        if (i + batchSize < symbols.length) {
          await this.sleep(200);
        }
      }

      // Save signals to database in parallel
      await Promise.allSettled(
        signals.map(async (signal) => {
          try {
            await createSignal({
              symbol: signal.symbol,
              action: signal.action,
              confidence: signal.confidence.toString(),
              pattern: signal.pattern,
              reasoning: signal.reasoning,
              entryPrice: signal.entry_price.toString(),
              targetPrice: signal.target_price.toString(),
              stopLoss: signal.stop_loss.toString(),
              timeframe: signal.timeframe,
              agentId: this.config.id,
              executed: false,
            });
            this.log('info', `💾 Saved signal: ${signal.pattern} on ${signal.symbol}`);
          } catch (dbError) {
            this.log('error', `Failed to save signal for ${signal.symbol}`, dbError);
          }
        })
      );

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

      // Fetch candlestick data (need 100 candles for reliable pattern detection)
      const timeframe = '15m';
      const limit = 100;
      const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

      // Convert to OhlcvData format for pattern detectors
      const ohlcvData: OhlcvData[] = ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
        timestamp: timestamp as number,
        open: open as number,
        high: high as number,
        low: low as number,
        close: close as number,
        volume: volume as number,
      }));

      // Run all pattern detectors
      const patternSignals: TradingSignal[] = [];

      for (const detector of this.patternDetectors) {
        try {
          const signal = detector.detect(ohlcvData, symbol);

          if (signal && signal.confidence > 0.6) {
            // Convert PatternSignal to TradingSignal
            const tradingSignal: TradingSignal = {
              id: crypto.randomUUID(),
              timestamp: new Date(),
              symbol: signal.symbol,
              action: signal.action,
              confidence: signal.confidence,
              pattern: signal.pattern,
              reasoning: signal.reasoning,
              entry_price: signal.entry_price,
              target_price: signal.target_price,
              stop_loss: signal.stop_loss,
              timeframe: signal.timeframe,
              agent_id: this.config.id,
            };

            patternSignals.push(tradingSignal);

            this.log('info', `Pattern detected: ${detector.name} on ${symbol}`, {
              confidence: signal.confidence,
              action: signal.action
            });
          }
        } catch (error) {
          this.log('error', `Error in ${detector.name} detector`, error);
          // Continue with other detectors
        }
      }

      // Return strongest signal if any found
      if (patternSignals.length > 0) {
        // Sort by confidence descending
        patternSignals.sort((a, b) => b.confidence - a.confidence);
        return patternSignals[0];
      }

      return null;
    } catch (error) {
      this.log('error', `Error analyzing ${symbol}`, error);
      return null;
    }
  }
}
