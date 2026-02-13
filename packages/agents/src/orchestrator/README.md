# Orchestrator Agent - README

## Overview

The **Orchestrator Agent** is the master coordinator for the Cryonix AI trading system. It orchestrates the complete automated trading cycle by coordinating Market Scout, GROK AI analysis, Risk Manager, and Executor agents.

## Features

✅ **Automated Trading Cycle** - Coordinates signal detection → AI validation → risk approval → execution  
✅ **Agent Registry** - Health monitoring with auto-restart capabilities  
✅ **Safety First** - Auto-trading disabled by default, emergency stop on >5% daily loss  
✅ **Real-time Dashboard** - Monitor orchestrator status, agents, and daily P&L  
✅ **Portfolio Tracking** - Continuous portfolio syncing and daily performance metrics

## Architecture

```
┌─────────────────────────────────────────────┐
│           ORCHESTRATOR AGENT                │
│                                             │
│   ┌──────────────────────────────────┐    │
│   │  Coordination Loop (1s interval) │    │
│   └──────────────┬───────────────────┘    │
│                  │                         │
│       ┌──────────┼──────────┐             │
│       │          │          │             │
│   ┌───▼───┐  ┌──▼────┐  ┌──▼────┐        │
│   │Health │  │Trading│  │Portfolio│       │
│   │Check  │  │Cycle  │  │Sync   │        │
│   │60s    │  │5min   │  │30s    │        │
│   └───┬───┘  └──┬────┘  └───────┘        │
│       │         │                          │
└───────┼─────────┼──────────────────────────┘
        │         │
    ┌───▼─────────▼─────┐
    │  Registered Agents │
    ├───────────────────┤
    │ • Market Scout    │
    │ • Risk Manager    │
    │ • Claude AI       │
    └───────────────────┘
```

## Trading Cycle Flow

1. **Signal Detection** (every 5 minutes)
   - Market Scout scans for trading opportunities
   - Detects patterns (Bollinger Squeeze, Volume Spikes, etc.)

2. **AI Validation**
   - Send signals to GROK AI for analysis
   - Receive BUY/SELL/HOLD recommendation with confidence

3. **Risk Approval**
   - Mock Risk Manager validates signal (real implementation in progress)
   - Calculates appropriate position size
   - Applies portfolio risk limits

4. **Execution**
   - If `ENABLE_AUTO_TRADING=true`: Execute trade automatically
   - If `ENABLE_AUTO_TRADING=false` (default): Log trade for manual review

## Configuration

### Environment Variables

```bash
# Enable/disable auto-trading (default: false)
ENABLE_AUTO_TRADING=false

# Application URL for API calls
NEXT_PUBLIC_APP_URL=http://localhost:3003
```

### Timing Constants

Configured in `orchestrator-agent.ts`:

```typescript
SCAN_INTERVAL = 5 * 60 * 1000;           // 5 minutes
PORTFOLIO_SYNC_INTERVAL = 30 * 1000;     // 30 seconds
METRICS_INTERVAL = 60 * 60 * 1000;       // 1 hour
HEALTH_CHECK_INTERVAL = 60 * 1000;       // 1 minute
DAILY_LOSS_LIMIT = 0.05;                 // 5%
```

## API Endpoints

### Start Orchestrator

```bash
POST /api/orchestrator/start
```

**Response:**
```json
{
  "success": true,
  "message": "Orchestrator started successfully",
  "status": "running"
}
```

### Stop Orchestrator

```bash
POST /api/orchestrator/stop
```

**Response:**
```json
{
  "success": true,
  "message": "Orchestrator stopped successfully"
}
```

### Get Status

```bash
GET /api/orchestrator/status
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "running",
    "isRunning": true,
    "enableAutoTrading": false,
    "emergencyStop": false,
    "registeredAgents": [
      { "id": "market_scout", "name": "Market Scout Agent", "status": "running" }
    ],
    "lastScanTime": "2026-01-20T15:30:00.000Z",
    "dailyPnL": 125.50,
    "dailyPnLPercent": 2.35,
    "portfolioValue": 25420.00
  }
}
```

## Dashboard Usage

### Orchestrator Status Widget

The dashboard displays:

- **Running Status** - Green pulsing dot when active
- **Auto-Trading Mode** - Warning if disabled
- **Daily P&L** - Real-time performance tracking
- **Registered Agents** - Health status of all agents
- **Control Buttons** - Start/Stop orchestrator
- **Safety Warnings** - Emergency stop alerts

### Starting the Orchestrator

1. Open dashboard at `http://localhost:3003`
2. Locate "Orchestrator" widget in left sidebar
3. Click **"Start"** button
4. Monitor agent status and logs

### Monitoring

- **Last Scan Time** - Shows when Market Scout last checked for signals
- **Agent Health** - Color-coded status indicators:
  - 🟢 Green = Running
  - ⚫ Gray = Idle
  - 🔴 Red = Error (auto-restart triggered)

## Safety Features

### 1. Auto-Trading Disabled by Default

```bash
# Must explicitly enable in .env
ENABLE_AUTO_TRADING=true
```

When disabled, trades are **logged only**:

```
💰 TRADE OPPORTUNITY
symbol: BTCUSDT
side: BUY
confidence: 75%
positionSize: 2.0%
⚠️ AUTO-TRADING DISABLED - Trade logged for manual review
```

### 2. Emergency Stop

Automatically triggered when:
- Daily loss exceeds **5%** of starting portfolio value
- Stops all trading immediately
- Displays warning in dashboard

```
🚨 EMERGENCY STOP TRIGGERED - Daily loss limit exceeded
```

### 3. Conservative Defaults

Mock Risk Manager (until real implementation):
- Rejects signals with confidence < 60%
- Fixed 2% position size
- Validation before approval

## Agent Health Monitoring

The orchestrator monitors all registered agents:

```typescript
// Health check every 60 seconds
if (agent.status === 'error') {
  // Automatic restart attempt
  await agent.stop();
  await agent.initialize();
  await agent.start();
}
```

## Integration with Other Agents

### Market Scout
- Registers with orchestrator on startup
- Emits signals when patterns detected
- Orchestrator processes signals via trading cycle

### Risk Manager (Mock for now)
- Validates each trading signal
- Applies Kelly Criterion (in real implementation)
- Returns approval/rejection with position size

### GROK AI
- Called via `/api/analyze` endpoint
- Provides BUY/SELL/HOLD recommendations
- Returns confidence score and reasoning

## Database Schema

```sql
CREATE TABLE orchestrator_state (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  status VARCHAR(20),
  is_running BOOLEAN,
  daily_start_value DECIMAL(20, 8),
  emergency_stop_triggered BOOLEAN,
  metadata JSONB
);
```

## Troubleshooting

### Orchestrator Won't Start

**Issue:** "Failed to start orchestrator"

**Solutions:**
1. Check if `BINANCE_API_KEY` and `BINANCE_API_SECRET` are set
2. Verify `XAI_API_KEY` is configured for GROK
3. Check portfolio API is responding: `GET /api/portfolio`

### No Signals Detected

**Issue:** "No signals found in this cycle"

**Explanation:** This is normal. Market Scout only generates signals when:
- Patterns are detected (Bollinger Squeeze, Volume Spike)
- Confidence threshold is met (typically >60%)

Market conditions may not always produce signals.

### Emergency Stop Triggered

**Issue:** Trading automatically stopped

**Explanation:** Daily portfolio loss exceeded 5% threshold.

**Recovery:**
1. Review trades and market conditions
2. Adjust risk parameters if needed
3. Manual restart required (no auto-recovery)

## Development Notes

### Mock Risk Manager

Current implementation uses simplified risk management:

```typescript
// Location: packages/agents/src/orchestrator/mock-risk-manager.ts
export class MockRiskManager {
  async checkRisk(request: RiskCheckRequest): Promise<RiskApproval> {
    // Simple validation
    if (confidence < 0.6) return { approved: false, ... };
    
    // Fixed 2% position size
    return { approved: true, positionSize: 0.02, ... };
  }
}
```

**TODO:** Replace with real Risk Manager (Agent 1) using Kelly Criterion.

### Future Enhancements

- [ ] WebSocket support for real-time updates (Agent 4)
- [ ] Backtesting integration (Agent 5)
- [ ] Advanced pattern detection (Agent 2)
- [ ] Real Risk Manager with Kelly Criterion (Agent 1)
- [ ] Comprehensive unit tests

## Examples

### Starting Orchestrator Programmatically

```typescript
import { AgentFactory } from '@cryonix/agents';

const orchestrator = AgentFactory.createOrchestrator();
await orchestrator.initialize();

// Register agents
orchestrator.registerAgent(marketScout);
orchestrator.registerAgent(riskManager);

// Start coordination
await orchestrator.start();
```

### Checking Orchestrator State

```typescript
const state = orchestrator.getState();
console.log({
  isRunning: state.isRunning,
  dailyPnL: state.currentPortfolioValue - state.dailyStartValue,
  agents: state.registeredAgents.length
});
```

## Support

For issues or questions:
- Check server console logs for detailed errors
- Review implementation plan in `brain/` directory
- Open GitHub issue with error details

---

**Built for Cryonix AI Trading System**  
**Agent 3: Orchestrator Enhancement** ✅
