# Market Scout Pattern Detectors

Comprehensive pattern detection system for identifying trading opportunities using technical analysis.

## Overview

The Market Scout Agent uses four specialized pattern detectors to analyze cryptocurrency markets and generate trading signals:

1. **Bollinger Squeeze** - Low volatility compression patterns
2. **Volume Spike** - Abnormal volume activity patterns
3. **Triangle Breakout** - Chart pattern breakouts
4. **RSI Divergence** - Momentum divergence patterns

## Pattern Detectors

### 1. Bollinger Squeeze Detector

**Pattern**: Bollinger Bands compression indicating low volatility and potential breakout.

**Strategy**:
- Calculates 20-period Bollinger Bands (2 standard deviations)
- Measures bandwidth as percentage of middle band
- Compares to 50-period average bandwidth
- Signals when bandwidth < 50% of average

**Confidence**: 0.65 - 0.75 (higher for stronger compression)

**Timeframe**: 1-4 days

**Example Signal**:
```typescript
{
  pattern: 'bollinger_squeeze',
  symbol: 'BTC/USDT',
  action: 'BUY',
  confidence: 0.72,
  entry_price: 45000,
  stop_loss: 44500,  // Lower Bollinger Band
  target_price: 46000,  // 2x bandwidth from entry
  reasoning: [
    'Bollinger Bands squeeze detected (bandwidth: 1.23%)',
    'Compression ratio: 42.5% of average',
    'Breakout imminent - historically 68-75% probability within 1-4 days',
    'Current volatility 58% below normal'
  ]
}
```

### 2. Volume Spike Detector

**Pattern**: Significant volume increase indicating strong market interest.

**Strategy**:
- Calculates 20-period volume moving average
- Detects volume > 2x average
- Requires price movement > 1% to filter noise
- Direction determined by price action (up/down)

**Confidence**: 0.60 - 0.70 (scales with volume ratio, capped at 3x)

**Timeframe**: 6-24 hours

**Example Signal**:
```typescript
{
  pattern: 'volume_spike',
  symbol: 'ETH/USDT',
  action: 'BUY',
  confidence: 0.68,
  entry_price: 2500,
  stop_loss: 2462.5,  // 1.5% below entry
  target_price: 2575,  // 3% above entry
  reasoning: [
    'Volume spike detected: 2.85x average volume',
    'Price up 2.34% on high volume',
    'Indicates strong buying pressure',
    'Potential continuation if momentum continues'
  ]
}
```

### 3. Triangle Breakout Detector

**Pattern**: Converging trendlines (triangle) with volume-confirmed breakout.

**Strategy**:
- Identifies swing highs and lows
- Fits trendlines using linear regression
- Detects convergence (R² > 0.7 for quality)
- Waits for breakout with volume > 1.5x average
- Projects target using triangle height

**Triangle Types**:
- **Ascending**: Flat resistance + rising support (bullish bias)
- **Descending**: Falling resistance + flat support (bearish bias)  
- **Symmetric**: Both lines converging (neutral, breakout determines direction)

**Confidence**: 0.70 - 0.80 (based on trendline quality and volume)

**Timeframe**: 1-3 days

**Example Signal**:
```typescript
{
  pattern: 'triangle_breakout',
  symbol: 'SOL/USDT',
  action: 'BUY',
  confidence: 0.76,
  entry_price: 105,
  stop_loss: 100,  // Support trendline
  target_price: 110,  // Triangle height projected
  reasoning: [
    'Symmetric triangle breakout detected',
    'Trendline quality: 84.3% (R²)',
    'Breakout confirmed with 2.15x volume',
    'Target based on triangle height projection: 4.76%'
  ],
  metadata: {
    triangleType: 'symmetric',
    triangleHeight: 5,
    trendlineR2: 0.843
  }
}
```

### 4. RSI Divergence Detector

**Pattern**: Price and RSI moving in opposite directions at swing points (reversal signal).

**Strategy**:
- Calculates 14-period RSI
- Identifies swing highs/lows in both price and RSI
- **Bullish**: Price lower low + RSI higher low → Reversal up
- **Bearish**: Price higher high + RSI lower high → Reversal down
- Requires RSI in extreme zones for confirmation

**Confidence**: 0.60 - 0.75 (higher in oversold/overbought zones)

**Timeframe**: 2-5 days

**Example Signal**:
```typescript
{
  pattern: 'rsi_divergence',
  symbol: 'BNB/USDT',
  action: 'BUY',
  confidence: 0.71,
  entry_price: 310,
  stop_loss: 301,  // 3% below recent swing low
  target_price: 335,  // Previous swing high
  reasoning: [
    'Bullish RSI divergence detected',
    'Price made lower low (3.12% down), RSI made higher low (+8.4)',
    'RSI at 28.3 - oversold territory',
    'Potential reversal to upside - risk/reward 2.83:1'
  ],
  metadata: {
    divergenceType: 'bullish',
    rsiSwingLow: 28.3,
    priceSwingLow: 305
  }
}
```

## Usage

### Basic Example

```typescript
import { MarketScoutAgent } from '@cryonix/agents';

// Initialize agent
const agent = new MarketScoutAgent();
await agent.initialize();

// Start scanning (every 15 seconds)
await agent.start();

// Listen for signals
agent.on('signals_found', (signals) => {
  console.log(`Found ${signals.length} trading signals`);
  signals.forEach(signal => {
    console.log(`${signal.pattern}: ${signal.symbol} ${signal.action} @ ${signal.entry_price}`);
    console.log(`Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
    console.log(`Risk/Reward: ${((signal.target_price - signal.entry_price) / (signal.entry_price - signal.stop_loss)).toFixed(2)}:1`);
  });
});
```

### Using Individual Pattern Detectors

```typescript
import {
  BollingerSqueezeDetector,
  VolumeSpikeDetector,
  TriangleBreakoutDetector,
  RSIDivergenceDetector,
  type OhlcvData
} from '@cryonix/agents/market-scout/pattern-detectors';

// Get OHLCV data (e.g., from Binance API)
const ohlcvData: OhlcvData[] = [...]; // 100 candles

// Run specific detector
const bbDetector = new BollingerSqueezeDetector();
const signal = bbDetector.detect(ohlcvData, 'BTC/USDT');

if (signal) {
  console.log(`Bollinger Squeeze detected!`);
  console.log(`Confidence: ${signal.confidence}`);
  console.log(`Entry: ${signal.entry_price}`);
  console.log(`Target: ${signal.target_price}`);
  console.log(`Stop: ${signal.stop_loss}`);
}
```

## Configuration

### Scan Interval

Default: Every 15 seconds (configured in `market-scout-agent.ts`)

```typescript
// Modify scan interval
this.scanInterval = setInterval(() => {
  this.scanMarkets();
}, 15000); // Change to desired interval in milliseconds
```

### Top 20 Coins

The agent automatically fetches the top 20 coins by 24h volume (USDT pairs) from Binance.

**Cache Duration**: 1 hour (to reduce API calls)

```typescript
private readonly TOP20_CACHE_DURATION = 60 * 60 * 1000; // 1 hour
```

### Confidence Threshold

Default: Signals with `confidence > 0.6` are emitted

```typescript
if (signal && signal.confidence > 0.6) {
  // Emit signal
}
```

## Pattern Detection Requirements

| Pattern | Min Candles | Optimal Candles | Timeframe |
|---------|-------------|-----------------|-----------|
| Bollinger Squeeze | 70 | 100+ | 15m+ |
| Volume Spike | 21 | 50+ | 5m+ |
| Triangle Breakout | 50 | 100+ | 15m+ |
| RSI Divergence | 50 | 100+ | 15m+ |

**Recommendation**: Use at least 100 candles of 15-minute data for reliable pattern detection.

## Signal Quality Metrics

### Expected Signal Frequency (per day, top 20 coins)

- **Bollinger Squeeze**: 2-5 signals (low frequency, high quality)
- **Volume Spike**: 10-20 signals (high frequency, filter carefully)
- **Triangle Breakout**: 1-3 signals (low frequency, high quality)
- **RSI Divergence**: 3-8 signals (medium frequency, good quality)

### Historical Accuracy (backtested)

*Note: Backtesting data pending - these are estimated values*

- **Bollinger Squeeze**: ~68-75% win rate
- **Volume Spike**: ~55-65% win rate (highly dependent on market conditions)
- **Triangle Breakout**: ~70-80% win rate (when trendline R² > 0.8)
- **RSI Divergence**: ~60-70% win rate (best in oversold/overbought zones)

## Database Schema

Signals are stored in the `signals` table:

```sql
CREATE TABLE signals (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  symbol VARCHAR(20) NOT NULL,
  action VARCHAR(10) NOT NULL,  -- 'BUY', 'SELL', 'WAIT'
  confidence DECIMAL(5, 4),
  pattern VARCHAR(50),
  reasoning JSONB,
  entry_price DECIMAL(20, 8),
  target_price DECIMAL(20, 8),
  stop_loss DECIMAL(20, 8),
  timeframe VARCHAR(20),
  metadata JSONB,  -- Pattern-specific data
  agent_id VARCHAR(50),
  executed BOOLEAN DEFAULT FALSE
);
```

## Testing

Run pattern detector tests:

```bash
cd packages/agents
pnpm test src/market-scout/pattern-detectors/__tests__
```

## Best Practices

1. **Combine Patterns**: Use multiple pattern confirmations for higher confidence
2. **Volume Confirmation**: Always require volume confirmation for breakouts
3. **Risk Management**: Never risk more than 2% of portfolio per signal
4. **Filter by Confidence**: Only trade signals with confidence > 0.65
5. **Backtest First**: Always backtest on historical data before live trading
6. **Monitor Performance**: Track win rate and adjust confidence thresholds

## Troubleshooting

### No Signals Generated

- Verify Binance API connection
- Check if top 20 coins are loading (see logs)
- Ensure sufficient OHLCV data (need 100+ candles)
- Lower confidence threshold temporarily for debugging

### Too Many Signals

- Increase confidence threshold (e.g., > 0.7)
- Reduce scan frequency
- Filter by specific patterns only

### TypeScript Errors

Ensure you have the latest `technicalindicators` package:

```bash
pnpm add technicalindicators --filter @cryonix/agents
```

## References

- [Bollinger Bands](https://www.investopedia.com/terms/b/bollingerbands.asp)
- [Volume Analysis](https://www.investopedia.com/articles/technical/02/010702.asp)
- [Triangle Patterns](https://www.investopedia.com/articles/trading/03/091003.asp)
- [RSI Divergence](https://www.investopedia.com/articles/active-trading/042114/overbought-or-oversold-use-relative-strength-index-find-out.asp)

## License

MIT
