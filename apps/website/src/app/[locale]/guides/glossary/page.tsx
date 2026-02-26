import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { TelegramBanner } from '@/components/telegram-banner';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'glossary' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

interface Term {
  term: string;
  abbr?: string;
  definition: string;
  related?: string[];
  category: 'indicators' | 'patterns' | 'risk' | 'architecture' | 'ai' | 'market';
}

const TERMS: Term[] = [
  // Indicators
  { term: 'RSI', abbr: 'Relative Strength Index', definition: 'A momentum oscillator (0-100) measuring the speed and magnitude of price changes. RSI below 30 indicates an asset is oversold (potential buy), above 70 indicates overbought (potential sell). Cryonix uses a 14-period RSI.', category: 'indicators', related: ['RSI_OVERSOLD', 'Mean Reversion'] },
  { term: 'MACD', abbr: 'Moving Average Convergence Divergence', definition: 'A trend-following momentum indicator showing the relationship between two moving averages. When the MACD line crosses above the signal line, it suggests bullish momentum. Cryonix uses 12/26/9 periods.', category: 'indicators', related: ['EMA', 'MACD_BULLISH_CROSS'] },
  { term: 'EMA', abbr: 'Exponential Moving Average', definition: 'A moving average that gives more weight to recent prices. Cryonix tracks EMA-9 (fast) and EMA-21 (slow). When EMA-9 crosses above EMA-21, it signals a potential uptrend.', category: 'indicators', related: ['MACD', 'EMA_BULLISH_CROSS'] },
  { term: 'Bollinger Bands', definition: 'Volatility bands placed above and below a 20-period moving average. The bands widen during high volatility and narrow (squeeze) during low volatility. A squeeze often precedes a major price move.', category: 'indicators', related: ['BOLLINGER_SQUEEZE', 'ATR'] },
  { term: 'ATR', abbr: 'Average True Range', definition: 'A volatility indicator measuring the average range between high and low prices over 14 periods. Cryonix uses ATR for dynamic stop-loss (3.5x ATR) and take-profit (6.0x ATR) placement.', category: 'indicators', related: ['Stop-Loss', 'Take-Profit', 'Volatile Regime'] },
  { term: 'ADX', abbr: 'Average Directional Index', definition: 'Measures trend strength on a 0-100 scale. ADX above 25 indicates a trending market, below 25 indicates ranging. Cryonix uses ADX to classify market regimes and allow trend exceptions in dip focus mode.', category: 'indicators', related: ['Market Regime', 'Trending'] },
  { term: 'Volume SMA', definition: 'Simple Moving Average of trading volume over 20 periods. Used to detect volume spikes when current volume exceeds 2x the average, indicating unusual market activity.', category: 'indicators' },

  // Patterns
  { term: 'DIP_BUY', definition: 'A mean-reversion pattern triggered when price drops 5%+ from the 20-bar high with RSI below 50. Cryonix\'s highest-conviction pattern family with 80-100% backtest win rate.', category: 'patterns', related: ['Mean Reversion', 'Smart Dip Hunter', 'RSI'] },
  { term: 'DEEP_VALUE_CRASH', definition: 'An extreme dip pattern requiring 8%+ drawdown with multi-timeframe confirmation. Includes rug pull velocity check (rejects drops faster than 20%/hour). Uses wider stop-loss (6x ATR) to give recovery room.', category: 'patterns', related: ['DIP_BUY', 'ATR', 'Multi-Timeframe'] },
  { term: 'BOLLINGER_SQUEEZE', definition: 'Detected when Bollinger Band width falls in the bottom 20% of its range, signaling compressed volatility. Often precedes explosive price moves. Requires 1-hour timeframe squeeze confirmation.', category: 'patterns', related: ['Bollinger Bands', 'Volatility'] },
  { term: 'RSI_OVERSOLD', definition: 'Triggered when RSI drops below 30 (configurable). A weak solo signal in Cryonix (0% win rate alone) — only traded when combined with other patterns like DIP_BUY or BOLLINGER_SQUEEZE.', category: 'patterns', related: ['RSI', 'Consensus Gate'] },
  { term: 'MACD_BULLISH_CROSS', definition: 'When the MACD line crosses above its signal line, suggesting bullish momentum. Requires 1-hour MACD histogram alignment for confirmation. Classified as a weak solo pattern.', category: 'patterns', related: ['MACD', 'Multi-Timeframe'] },
  { term: 'EMA_BULLISH_CROSS', definition: 'When EMA-9 crosses above EMA-21, indicating a potential uptrend. Requires 1-hour EMA confirmation. Weakest solo signal — only traded with dip pattern companions.', category: 'patterns', related: ['EMA', 'Consensus Gate'] },
  { term: 'MOMENTUM_GAINER', definition: 'Detected by the GainerScanner when a symbol shows 3%+ price increase in 1 hour. Provides a +10% confidence boost when aligned with a technical signal.', category: 'patterns', related: ['GainerScanner'] },
  { term: 'Mean Reversion', definition: 'A trading strategy based on the idea that prices tend to return to their average. Dip buying is a mean-reversion strategy: buying after a drop, expecting a bounce back. Opposite of trend-following.', category: 'patterns', related: ['DIP_BUY', 'BOLLINGER_SQUEEZE', 'Smart Dip Hunter'] },

  // Risk
  { term: 'Stop-Loss (SL)', definition: 'A pre-set price level where a losing position is automatically closed to limit losses. Cryonix uses native exchange STOP_LOSS_LIMIT orders at 3.5x ATR below entry (6x for deep value).', category: 'risk', related: ['ATR', 'Take-Profit'] },
  { term: 'Take-Profit (TP)', definition: 'A pre-set price level where a winning position is automatically closed to lock in gains. Set at 6.0x ATR above entry (8.0x for deep value), giving a 1.7:1 risk-reward ratio.', category: 'risk', related: ['ATR', 'Stop-Loss', 'Risk-Reward'] },
  { term: 'Trailing Stop', definition: 'A dynamic stop-loss that follows the price upward. Activates when profit reaches +3%, then trails at 3% below the highest price reached. Locks in gains while allowing upside.', category: 'risk', related: ['Stop-Loss', 'High Water Mark'] },
  { term: 'High Water Mark (HWM)', definition: 'The highest price a position has reached since entry. Used by the trailing stop system — the trailing stop is always set at HWM minus the trailing percentage.', category: 'risk', related: ['Trailing Stop'] },
  { term: 'Circuit Breaker', definition: 'Automatic trading pause triggered by adverse conditions. Cryonix has 5: daily loss (5%), weekly loss (10%), consecutive losses (5+), ATR volatility pause, and per-symbol cooldown.', category: 'risk', related: ['Drawdown', 'Loss Cooldown'] },
  { term: 'Kelly Criterion', definition: 'A mathematical formula for optimal bet sizing based on win rate and payoff ratio. Cryonix uses half-Kelly (0.5x) for extra safety. No single position exceeds 35% of capital.', category: 'risk', related: ['Position Sizing'] },
  { term: 'Drawdown', definition: 'The decline from a peak portfolio value to a trough. A 10% drawdown means the portfolio dropped 10% from its highest point. Circuit breakers activate at 5% daily and 10% weekly drawdown.', category: 'risk', related: ['Circuit Breaker', 'Max Drawdown'] },
  { term: 'Risk-Reward Ratio (R:R)', definition: 'The ratio of potential profit to potential loss on a trade. Cryonix targets minimum 1.3:1 R:R — for every $1 risked, at least $1.30 potential gain. Typical ratio is 1.7:1.', category: 'risk', related: ['Stop-Loss', 'Take-Profit'] },
  { term: 'Slippage', definition: 'The difference between expected trade price and actual execution price. Caused by market movement during order processing. Cryonix rejects trades with >0.5% expected slippage.', category: 'risk', related: ['Spread'] },
  { term: 'Spread', definition: 'The difference between the best bid (buy) and ask (sell) price. A wider spread means higher trading costs. Cryonix rejects trades with >0.3% spread to ensure liquidity.', category: 'risk', related: ['Slippage', 'Order Book'] },
  { term: 'NOTIONAL', definition: 'The minimum order value required by Binance (typically $5-10 USD). If a trade value falls below this, the exchange rejects it. Cryonix uses a 1.5x safety buffer above the minimum.', category: 'risk', related: ['Dust Prevention'] },
  { term: 'Loss Cooldown', definition: 'A per-symbol pause after a losing trade (default 2 hours). Prevents revenge trading — the tendency to immediately re-enter a position after a loss.', category: 'risk', related: ['Circuit Breaker'] },

  // Architecture
  { term: 'Fail-Closed', definition: 'A safety design where the system defaults to inaction when uncertain. If the AI validation service is unavailable, signals are rejected (not approved). Opposite of fail-open.', category: 'architecture', related: ['Grok AI', 'Circuit Breaker'] },
  { term: 'HTF Veto', abbr: 'Higher Timeframe Veto', definition: 'A filter that blocks signals contradicting higher timeframe trends. If 1-hour and 4-hour charts both show EMA bearish alignment, BUY signals on the 15-minute chart are vetoed.', category: 'architecture', related: ['Multi-Timeframe', 'EMA'] },
  { term: 'Smart Dip Hunter', definition: 'Cryonix\'s core strategy (since 2026-02-25). Requires every signal to contain at least one value pattern (DIP_BUY, DEEP_VALUE_CRASH, or BOLLINGER_SQUEEZE). Pure trend signals are rejected. Backtest-validated.', category: 'architecture', related: ['DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE'] },
  { term: 'Consensus Gate', definition: 'A multi-pattern validation system. Single patterns get a 35% confidence penalty. Two patterns get +8% boost, three or more get +15%. Prevents trading on weak lone signals.', category: 'architecture', related: ['Confidence'] },
  { term: 'EV Model', abbr: 'Expected Value Model', definition: 'A self-calibrating filter that analyzes 30 days of historical trades to compute per-pattern profitability. Patterns with negative expected value are automatically blocked from generating signals.', category: 'architecture', related: ['Calibration', 'Pattern'] },
  { term: 'Market Regime', definition: 'Classification of current market conditions: Trending (ADX >= 25), Ranging (ADX < 25), or Volatile (ATR > 2x average). Capital allocation shifts automatically — volatile markets increase reserve pool to 30%.', category: 'architecture', related: ['ADX', 'ATR', 'Capital Allocator'] },
  { term: 'Capital Allocator', definition: 'Splits total capital into pools: Signal (85%), Grid (0%), Reserve (15%). Allocation shifts based on market regime. Only the signal pool is used for active trading.', category: 'architecture', related: ['Market Regime', 'Kelly Criterion'] },
  { term: 'Confidence Blending', definition: 'The final confidence score is a weighted average: 60% technical analysis + 40% AI validation. Both must agree for a signal to pass the minimum threshold (default 70%).', category: 'architecture', related: ['Grok AI', 'Consensus Gate'] },
  { term: 'Config Versioning', definition: 'Every trade is tagged with an 8-character SHA-256 hash of the active cryonix.toml config file. Enables measuring the impact of parameter changes on trading performance.', category: 'architecture', related: ['Evolution Engine'] },

  // AI
  { term: 'Grok AI', definition: 'xAI\'s language model (Grok-4.1) used for signal validation. Receives full market context and returns a confidence score. Cryonix uses "high" reasoning effort for thorough multi-step analysis. Cost: ~$0.04 per signal.', category: 'ai', related: ['Fail-Closed', 'Confidence Blending'] },
  { term: 'Evolution Engine', definition: 'An autonomous parameter mutation system using Claude Code CLI. Every 2 hours, it analyzes trading performance, generates a mutation plan, applies changes to cryonix.toml, and verifies the result. Respects baseline freeze.', category: 'ai', related: ['AI Brain', 'Config Versioning'] },
  { term: 'AI Brain', definition: 'A strategic analysis system running every 6 hours (+ acute trigger on 3+ losses). Uses Grok to analyze trades, calibration data, and configuration — then recommends parameter adjustments within safety bounds.', category: 'ai', related: ['Evolution Engine', 'Calibration'] },
  { term: 'Calibration', definition: 'Daily automated analysis of all closed trades (30-day window). Computes per-pattern win rate, average P&L, and expected value. Results feed the EV model filter and evolution engine.', category: 'ai', related: ['EV Model', 'Evolution Engine'] },
  { term: 'Baseline Freeze', definition: 'A mode where all parameter mutations (Evolution Engine + AI Brain) are paused to measure clean trading performance. Calibration continues (read-only). Used to isolate the impact of parameter changes.', category: 'ai', related: ['Evolution Engine', 'AI Brain'] },
  { term: 'QuantGuild', definition: 'The core technical analysis engine written in Python. Calculates 13 indicators and detects 8 patterns on OHLCV candle data. Runs inside the Docker engine container.', category: 'ai', related: ['RSI', 'MACD', 'Bollinger Bands'] },
  { term: 'GainerScanner', definition: 'A background scanner that ranks all symbols by price change every 15 minutes. When a technical signal aligns with a top mover (3%+ in 1h), confidence gets a +10% boost.', category: 'ai', related: ['MOMENTUM_GAINER'] },

  // Market
  { term: 'OHLCV', definition: 'Open, High, Low, Close, Volume — the five data points in a candlestick chart. Each candle represents one time period (e.g., 15 minutes). Cryonix fetches 100 candles per scan cycle.', category: 'market' },
  { term: 'Spot Trading', definition: 'Buying and selling actual cryptocurrency (not derivatives). No leverage, no borrowing. Cryonix operates in spot-only mode — lower risk than futures or margin trading.', category: 'market', related: ['NOTIONAL'] },
  { term: 'Fear & Greed Index', definition: 'A CoinMarketCap metric (0-100) measuring overall market sentiment. Extreme Fear (0-20) often signals buying opportunities. Extreme Greed (80-100) signals overheating. Cryonix adjusts confidence accordingly.', category: 'market', related: ['CoinMarketCap'] },
  { term: 'BTC Dominance', definition: 'Bitcoin\'s market cap as a percentage of total crypto market cap. Rising BTC dominance means capital is flowing from altcoins to Bitcoin. Cryonix penalizes altcoin signals when BTC dominance is rising.', category: 'market', related: ['Fear & Greed Index'] },
  { term: 'FDV/MC Ratio', abbr: 'Fully Diluted Valuation / Market Cap', definition: 'Ratio of a token\'s theoretical max value (all tokens released) to current market cap. A ratio >4x indicates massive token unlocks ahead, diluting value. Cryonix rejects these tokens.', category: 'market' },
  { term: 'Order Book', definition: 'A list of all open buy and sell orders for a trading pair, organized by price. Cryonix checks order book depth (5 levels) and spread before executing trades.', category: 'market', related: ['Spread', 'Slippage'] },
  { term: 'Dust', definition: 'Tiny amounts of cryptocurrency too small to sell (below exchange minimum order value). Cryonix proactively sells positions approaching dust level to prevent capital from getting permanently locked.', category: 'market', related: ['NOTIONAL', 'Dust Prevention'] },
];

const CATEGORY_LABELS: Record<string, { en: string; color: string }> = {
  indicators: { en: 'Technical Indicators', color: 'text-primary border-primary/20 bg-primary/5' },
  patterns: { en: 'Trading Patterns', color: 'text-success border-success/20 bg-success/5' },
  risk: { en: 'Risk Management', color: 'text-warning border-warning/20 bg-warning/5' },
  architecture: { en: 'System Architecture', color: 'text-violet-400 border-violet-400/20 bg-violet-400/5' },
  ai: { en: 'AI & Automation', color: 'text-pink-400 border-pink-400/20 bg-pink-400/5' },
  market: { en: 'Market Concepts', color: 'text-muted-foreground border-border bg-muted/30' },
};

export default async function GlossaryPage() {
  const t = await getTranslations('glossary');

  const grouped = TERMS.reduce((acc, term) => {
    if (!acc[term.category]) acc[term.category] = [];
    acc[term.category].push(term);
    return acc;
  }, {} as Record<string, Term[]>);

  const categoryOrder = ['indicators', 'patterns', 'risk', 'architecture', 'ai', 'market'];

  return (
    <div className="py-12 md:py-16">
      <div className="container max-w-4xl space-y-12">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-glow-cyan">
            {t('title')}
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl leading-relaxed">
            {t('subtitle')}
          </p>
        </div>

        {/* Category jump links */}
        <div className="flex flex-wrap gap-2">
          {categoryOrder.map((cat) => {
            const meta = CATEGORY_LABELS[cat];
            return (
              <a
                key={cat}
                href={`#${cat}`}
                className={`inline-flex px-3 py-1 rounded-full text-xs font-medium border transition-opacity hover:opacity-80 ${meta.color}`}
              >
                {meta.en}
              </a>
            );
          })}
        </div>

        {/* Terms by category */}
        {categoryOrder.map((cat) => {
          const terms = grouped[cat] || [];
          const meta = CATEGORY_LABELS[cat];

          return (
            <section key={cat} id={cat} className="scroll-mt-24">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <span className={`inline-flex px-2.5 py-0.5 rounded text-xs font-mono border ${meta.color}`}>
                  {meta.en}
                </span>
                <span className="text-xs text-muted-foreground font-mono">
                  {terms.length} terms
                </span>
              </h2>

              <div className="space-y-1">
                {terms.map((term) => (
                  <div
                    key={term.term}
                    id={term.term.toLowerCase().replace(/[^a-z0-9]/g, '-')}
                    className="glass-card rounded-lg p-4 scroll-mt-24 hover:border-primary/15 transition-colors"
                  >
                    <div className="flex items-baseline gap-2 mb-1.5">
                      <h3 className="font-semibold text-sm font-mono">{term.term}</h3>
                      {term.abbr && (
                        <span className="text-xs text-muted-foreground">({term.abbr})</span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {term.definition}
                    </p>
                    {term.related && term.related.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        <span className="text-[10px] text-muted-foreground/50 mr-1">See also:</span>
                        {term.related.map((rel) => (
                          <a
                            key={rel}
                            href={`#${rel.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
                            className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-mono text-primary/60 border border-primary/10 hover:border-primary/30 hover:text-primary transition-colors"
                          >
                            {rel}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        <TelegramBanner />
      </div>
    </div>
  );
}
