# Cryonix API Documentation

## Base URL

- **Development**: `http://localhost:3003`
- **Production**: `https://your-domain.vercel.app`

---

## Authentication

Currently, the API does not require authentication for local development. In production, implement appropriate authentication mechanisms.

---

## Endpoints

### Market Data

#### GET `/api/market`

Fetch live market data from Binance.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol` | string | No | `BTCUSDT` | Trading pair symbol |
| `interval` | string | No | `1h` | Candlestick interval |
| `limit` | number | No | `100` | Number of candles |

**Response:**
```json
{
  "status": "ok",
  "data": {
    "ticker": {
      "symbol": "BTCUSDT",
      "price": "50000.00",
      "change24h": "2.5%"
    },
    "ohlcv": [
      { "timestamp": 1704067200000, "open": 49000, "high": 50500, "low": 48500, "close": 50000, "volume": 1500000 }
    ]
  }
}
```

---

### Portfolio

#### GET `/api/portfolio`

Get current Binance account balances.

**Response:**
```json
{
  "status": "ok",
  "summary": {
    "totalValueUSD": 10500.00,
    "availableUSD": 5000.00,
    "positionsValueUSD": 5500.00
  },
  "balances": [
    { "asset": "USDT", "free": 5000, "locked": 0, "usdValue": 5000 },
    { "asset": "BTC", "free": 0.1, "locked": 0, "usdValue": 5000 },
    { "asset": "ETH", "free": 0.5, "locked": 0, "usdValue": 500 }
  ]
}
```

---

### Trading

#### POST `/api/trade`

Execute a trade on Binance.

**Request Body:**
```json
{
  "symbol": "BTCUSDT",
  "side": "BUY",
  "quantity": 0.001,
  "type": "MARKET"
}
```

**Response:**
```json
{
  "status": "ok",
  "order": {
    "orderId": "12345678",
    "symbol": "BTCUSDT",
    "side": "BUY",
    "type": "MARKET",
    "status": "FILLED",
    "executedQty": "0.001",
    "avgPrice": "50000.00"
  }
}
```

---

### AI Analysis

#### POST `/api/analyze`

Get GROK AI market analysis.

**Request Body:**
```json
{
  "symbol": "BTCUSDT",
  "action": "full_analysis"
}
```

**Response:**
```json
{
  "status": "ok",
  "data": {
    "analysis": {
      "signal": "BUY",
      "confidence": 75,
      "entry": 50000,
      "target": 55000,
      "stopLoss": 48000,
      "reasoning": ["Strong momentum", "Volume confirmation"],
      "summary": "Bullish setup with good risk/reward"
    }
  }
}
```

---

### Backtesting

#### POST `/api/backtest`

Run a backtest simulation.

**Request Body:**
```json
{
  "symbols": ["BTC/USDT", "ETH/USDT"],
  "startDate": "2024-01-01",
  "endDate": "2024-06-01",
  "initialCapital": 10000,
  "patterns": ["bollinger_squeeze", "volume_spike"],
  "timeframe": "1h",
  "positionSizing": "kelly",
  "maxPositionPercent": 20,
  "minConfidence": 0.6
}
```

**Response:**
```json
{
  "status": "ok",
  "result": {
    "metrics": {
      "totalReturn": 0.25,
      "sharpeRatio": 1.8,
      "sortinoRatio": 2.1,
      "maxDrawdown": 0.12,
      "winRate": 0.58,
      "profitFactor": 1.65,
      "totalTrades": 45
    },
    "trades": [...],
    "equity": [...]
  }
}
```

---

### Signal Validation

#### POST `/api/validate-signal`

Validate a trading signal with multi-source consensus.

**Request Body:**
```json
{
  "symbol": "BTC/USDT",
  "action": "BUY",
  "confidence": 0.75,
  "entryPrice": 50000,
  "stopLoss": 48000,
  "targetPrice": 55000,
  "pattern": "bollinger_squeeze"
}
```

**Response:**
```json
{
  "status": "ok",
  "validation": {
    "isValid": true,
    "consensusScore": 0.72,
    "adjustedConfidence": 0.68,
    "votes": {
      "pattern_detector": { "agrees": true, "confidence": 0.75, "weight": 0.25 },
      "technical_indicators": { "agrees": true, "confidence": 0.65, "weight": 0.20 },
      "ai_analysis": { "agrees": true, "confidence": 0.70, "weight": 0.25 },
      "market_structure": { "agrees": false, "confidence": 0.40, "weight": 0.15 },
      "volume_analysis": { "agrees": true, "confidence": 0.80, "weight": 0.15 }
    },
    "reasoning": ["Strong technical alignment", "Good volume support"]
  }
}
```

---

### Risk Management

#### GET `/api/risk`

Get current risk status.

**Response:**
```json
{
  "status": "ok",
  "risk": {
    "portfolio": {
      "total_capital": 10000,
      "available_capital": 7000,
      "open_positions": 2
    },
    "daily": {
      "pnl": -150,
      "limit": -500,
      "remaining": -350,
      "trades": 5,
      "max_trades": 10
    },
    "weekly": {
      "pnl": -200,
      "limit": -1000,
      "remaining": -800
    },
    "circuit_breaker": {
      "active": false,
      "reason": null,
      "until": null
    },
    "consecutive_losses": 1,
    "limits": {
      "max_daily_loss_pct": 0.05,
      "max_weekly_loss_pct": 0.10,
      "max_position_size_pct": 0.20,
      "min_confidence": 0.55
    }
  }
}
```

#### POST `/api/risk-check`

Check if a trade passes risk rules.

**Request Body:**
```json
{
  "symbol": "BTCUSDT",
  "side": "BUY",
  "confidence": 0.75,
  "entry_price": 50000,
  "stop_loss": 48000,
  "target_price": 55000
}
```

**Response:**
```json
{
  "status": "ok",
  "result": {
    "approved": true,
    "position_size": 0.05,
    "position_value": 2500,
    "risk_amount": 100,
    "kelly_fraction": 0.12,
    "reasoning": "Trade approved: Kelly 12%, Position 25% of capital",
    "adjustments": {
      "adjusted_stop_loss": 47500,
      "adjusted_target": 55500
    },
    "limits": {
      "portfolio_exposure": "25%",
      "daily_loss_remaining": "3.5%",
      "weekly_loss_remaining": "8%",
      "open_positions": 3
    }
  }
}
```

---

### Orchestrator

#### GET `/api/orchestrator/status`

Get orchestrator state.

**Response:**
```json
{
  "status": "ok",
  "orchestrator": {
    "status": "running",
    "isRunning": true,
    "enableAutoTrading": false,
    "emergencyStopTriggered": false,
    "lastScanTime": "2024-01-15T10:30:00Z",
    "dailyStartValue": 10000,
    "currentPortfolioValue": 10250,
    "registeredAgents": [
      { "id": "market_scout", "name": "Market Scout Agent", "status": "running" },
      { "id": "risk_manager", "name": "Risk Manager Agent", "status": "running" }
    ]
  }
}
```

#### POST `/api/orchestrator/start`

Start the orchestrator.

**Response:**
```json
{
  "status": "ok",
  "message": "Orchestrator started"
}
```

#### POST `/api/orchestrator/stop`

Stop the orchestrator.

**Response:**
```json
{
  "status": "ok",
  "message": "Orchestrator stopped"
}
```

---

### Signals

#### GET `/api/signals`

Get recent trading signals.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | No | `20` | Number of signals |
| `symbol` | string | No | - | Filter by symbol |

**Response:**
```json
{
  "status": "ok",
  "signals": [
    {
      "id": "uuid",
      "timestamp": "2024-01-15T10:30:00Z",
      "symbol": "BTC/USDT",
      "action": "BUY",
      "confidence": 0.75,
      "pattern": "bollinger_squeeze",
      "entry_price": 50000,
      "target_price": 55000,
      "stop_loss": 48000,
      "executed": false,
      "reasoning": ["Volatility compression", "Volume confirmation"]
    }
  ]
}
```

---

### Chat

#### POST `/api/chat`

Chat with GROK AI assistant.

**Request Body:**
```json
{
  "messages": [
    { "role": "user", "content": "Vad tycker du om BTC just nu?" }
  ]
}
```

**Response:**
```json
{
  "status": "ok",
  "response": {
    "role": "assistant",
    "content": "BTC visar styrka med..."
  }
}
```

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "status": "error",
  "error": "Error message description",
  "code": "ERROR_CODE"
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| `INVALID_PARAMS` | Missing or invalid parameters |
| `EXCHANGE_ERROR` | Binance API error |
| `RATE_LIMITED` | Too many requests |
| `RISK_REJECTED` | Trade rejected by risk manager |
| `INSUFFICIENT_BALANCE` | Not enough funds |
| `CIRCUIT_BREAKER_ACTIVE` | Trading halted |

---

## Rate Limits

- **Market data**: 10 requests/second
- **Trading**: 5 requests/second
- **Analysis**: 1 request/second

---

## WebSocket (Coming Soon)

Real-time updates will be available via WebSocket at `ws://localhost:3004`.

### Message Types

- `SIGNAL_ALERT` - New trading signal
- `TRADE_EXECUTED` - Trade completed
- `POSITION_UPDATE` - Position changed
- `RISK_WARNING` - Risk alert
- `CIRCUIT_BREAKER_TRIGGERED` - Trading halted
