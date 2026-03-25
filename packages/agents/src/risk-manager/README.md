# Risk Manager Agent

**Kelly Criterion Position Sizing & Portfolio Risk Management**

## Overview

The Risk Manager Agent uses the Kelly Criterion to calculate optimal position sizes while enforcing strict safety limits to prevent catastrophic losses.

## Features

- ✅ **Kelly Criterion** - Mathematically optimal position sizing
- ✅ **Half-Kelly Default** - Conservative 50% of full Kelly for safety
- ✅ **Portfolio Risk Limits** - Max 2% risk per trade, 10% daily drawdown
- ✅ **Emergency Stop** - Auto-halt all trading on 10% daily loss
- ✅ **Position Size Caps** - Max 30% of portfolio in single position
- ✅ **API Endpoint** - `/api/risk-check` for signal validation

## Quick Start

```typescript
import { RiskManagerAgent } from '@cryonix/agents';

// Create risk manager
const riskManager = new RiskManagerAgent({
  maxPortfolioRisk: 0.10,  // 10% max drawdown
  maxPositionRisk: 0.02,     // 2% per trade
  maxPositionSize: 0.30,     // 30% max position
  maxOpenPositions: 5,
  dailyLossLimit: 0.10,      // 10% emergency stop
  useHalfKelly: true,        // Conservative
});

await riskManager.initialize();
await riskManager.start();

// Check a signal
const result = await riskManager.checkSignalRisk({
  symbol: 'BTCUSDT',
  side: 'BUY',
  confidence: 0.75,          // From GROK AI
  entry_price: 45000,
  stop_loss: 44000,
  target_price: 48000,
});

console.log(result);
// {
//   approved: true,
//   position_size: 0.025,   // BTC
//   position_value: 1125,   // USD
//   risk_amount: 25,        // USD at risk
//   kelly_fraction: 0.15,
//   reasoning: "✅ APPROVED...",
//   limits: { ... }
// }
```

## API Usage

### POST /api/risk-check

Validate a trading signal and get position sizing:

```bash
curl -X POST http://localhost:3003/api/risk-check \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "side": "BUY",
    "confidence": 0.75,
    "entry_price": 45000,
    "stop_loss": 44000,
    "target_price": 48000
  }'
```

Response:

```json
{
  "success": true,
  "data": {
    "approved": true,
    "position_size": 0.025,
    "position_value": 1125,
    "risk_amount": 25,
    "kelly_fraction": 0.15,
    "reasoning": "✅ APPROVED\n\nKelly Analysis:\n• Win Probability: 75%\n• Risk/Reward: 3.00:1\n• Half-Kelly: 15.00%\n...",
    "limits": {
      "portfolio_exposure": "4.5%",
      "daily_loss_remaining": "9.5%",
      "open_positions": 2
    }
  }
}
```

### GET /api/risk-check

Get risk manager status:

```bash
curl http://localhost:3003/api/risk-check
```

## Kelly Criterion Explained

The [Kelly Criterion](https://en.wikipedia.org/wiki/Kelly_criterion) is a formula for bet sizing that maximizes long-term growth:

```
f = (bp - q) / b

Where:
  f = fraction of capital to risk
  b = odds (reward/risk ratio)
  p = probability of winning
  q = probability of losing (1 - p)
```

### Example Calculation

Given:
- Win probability: 75% (from GROK AI confidence)
- Entry: $45,000
- Stop loss: $44,000
- Target: $48,000

Calculations:
1. Risk per unit: $45,000 - $44,000 = $1,000
2. Reward per unit: $48,000 - $45,000 = $3,000
3. Risk/Reward ratio (b): 3,000 / 1,000 = 3
4. Kelly fraction: (3 × 0.75 - 0.25) / 3 = 0.67 = 67%
5. Half-Kelly: 67% × 0.5 = 33.5%

**Position sizing:**
- Portfolio: $25,000
- Kelly suggests: $25,000 × 0.335 = $8,375
- But max risk is 2%: $25,000 × 0.02 = $500 ← **APPLIED**
- Position size: $500 / $1,000 risk = 0.5 BTC

## Safety Limits

| Limit | Value | Reason |
|-------|-------|--------|
| **Max Position Risk** | 2% | HARD CAP - Never risk more than 2% on one trade |
| **Max Position Size** | 30% | Prevent overconcentration |
| **Max Open Positions** | 5 | Limit total exposure |
| **Daily Loss Limit** | 10% | Emergency stop triggers |
| **Half-Kelly** | Default: ON | 50% margin of safety vs full Kelly |

### Emergency Stop

If daily loss exceeds 10%:
- 🚨 **ALL NEW TRADES REJECTED**
- Existing positions remain open
- Manual intervention required
- Resets at start of new trading day

## Database Logging

All risk checks are logged to the `risk_checks` table:

```typescript
{
  timestamp, symbol, side, confidence,
  approved, positionSize, positionValue,
  riskAmount, kellyFraction, reasoning,
  portfolioValue, agentId
}
```

Use for:
- Audit trail
- Performance analysis
- Backtest validation

## Example Scenarios

### Scenario 1: High Confidence Signal

```typescript
// AI is 85% confident, great R:R of 5:1
const result = await checkSignalRisk({
  confidence: 0.85,
  entry_price: 45000,
  stop_loss: 44500,  // Tight stop
  target_price: 47500, // Big target
});

// Full Kelly: ~75%
// Half-Kelly: ~37.5%
// Capped at 2% portfolio risk
// APPROVED with good size
```

### Scenario 2: Low Confidence Signal

```typescript
// AI only 55% confident, R:R 1:1
const result = await checkSignalRisk({
  confidence: 0.55,
  entry_price: 45000,
  stop_loss: 44000,
  target_price: 46000,
});

// Full Kelly: ~10%
// Half-Kelly: ~5%
// Still capped at 2%
// APPROVED but smaller size
```

### Scenario 3: Rejected - Max Positions

```typescript
// Already 5 open positions
const result = await checkSignalRisk({
  confidence: 0.80,
  // ... other params
});

// result.approved = false
// result.reasoning = "❌ REJECTED: Max open positions reached (5)"
```

### Scenario 4: Emergency Stop

```typescript
// Portfolio down 10% today
const result = await checkSignalRisk({
  confidence: 0.90,
  // ... other params
});

// result.approved = false
// result.reasoning = "❌ REJECTED: EMERGENCY STOP: Daily loss limit exceeded"
// 🚨 NO MORE TRADES TODAY
```

## Integration with Orchestrator

```typescript
// In Orchestrator Agent
import { RiskManagerAgent } from '@cryonix/agents';

const riskManager = new RiskManagerAgent();
await riskManager.initialize();

// When Market Scout finds a signal -> GROK analyzes -> Risk Manager
const grokAnalysis = await grokAI.analyze(signal);

if (grokAnalysis.decision === 'BUY') {
  const riskCheck = await riskManager.checkSignalRisk({
    symbol: signal.symbol,
    side: 'BUY',
    confidence: grokAnalysis.confidence,
    entry_price: grokAnalysis.entry,
    stop_loss: grokAnalysis.stop_loss,
    target_price: grokAnalysis.target,
  });

  if (riskCheck.approved) {
    // Execute trade with riskCheck.position_size
    await executeTrade({
      symbol: signal.symbol,
      side: 'BUY',
      quantity: riskCheck.position_size,
    });
  }
}
```

## Testing

See test files in `__tests__/`:

```bash
cd packages/agents
pnpm test kelly-criterion
pnpm test risk-manager
```

## References

- [Kelly Criterion - Wikipedia](https://en.wikipedia.org/wiki/Kelly_criterion)
- [Fortune's Formula](https://en.wikipedia.org/wiki/Fortune%27s_Formula_(book))
- [Ed Thorp - The Kelly Criterion](https://www.eecs.harvard.edu/cs286r/courses/fall12/papers/Thorpe_KellyCriterion2007.pdf)

---

**⚠️ CRITICAL**: The Risk Manager is your last line of defense against catastrophic losses. Never bypass or disable it!
