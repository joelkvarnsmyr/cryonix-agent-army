# ⚡ Quick Start Guide

Get up and running in **5 minutes**!

## 1️⃣ Install Dependencies

```bash
# Clone repo (if not already)
git clone <your-repo-url>
cd cryonix-agent-army

# Install pnpm if you don't have it
npm install -g pnpm

# Install dependencies
pnpm install
```

## 2️⃣ Setup Environment Variables

```bash
# Copy example env file
cp .env.example apps/web/.env.local

# Edit with your API keys
nano apps/web/.env.local
```

**Minimum required:**
```bash
# xAI GROK (get from: https://x.ai/api)
XAI_API_KEY="xai-..."

# Binance Testnet (get from: https://testnet.binance.vision/)
BINANCE_API_KEY="your-testnet-key"
BINANCE_API_SECRET="your-testnet-secret"
BINANCE_TESTNET=true
```

## 3️⃣ Setup Database (Vercel Postgres)

```bash
# Create database on Vercel
# 1. Go to: https://vercel.com/dashboard
# 2. Storage → Create Database → Postgres
# 3. Copy connection string

# Add to .env.local
POSTGRES_URL="postgres://..."

# Push schema
cd packages/database
pnpm db:push
```

## 4️⃣ Run Development Server

```bash
# From root
pnpm dev

# Or from apps/web
cd apps/web
pnpm dev
```

Visit **http://localhost:3003** 🎉

⚠️ **LIVE TRADING WARNING**: The system is now connected to REAL Binance trading. Make sure you:
- Start with Binance Testnet (`BINANCE_TESTNET=true`)
- OR use small amounts on real accounts
- Review all safety settings before trading

## 5️⃣ Verify Dashboard Features

You should now see:

### ✅ Portfolio Summary
- Real Binance account balances (USDC, BNB, etc.)
- USD values calculated automatically
- Stablecoins separated as "cash"
- Auto-refreshes every 30 seconds

### ✅ AI Signals Widget
- Click **"Analyze All"** to get GROK AI analysis for top coins
- Click individual coins (BTC, ETH, SOL) for specific analysis
- See BUY/SELL/HOLD signals with confidence levels
- Entry, target, and stop-loss prices from AI
- Analysis in Swedish (configurable)

### ✅ Quick Trade Panel ⚠️
**WARNING: This executes REAL trades!**
- Real-time price updates every 5 seconds
- Position size calculator based on portfolio risk %
- BUY/SELL buttons execute actual market orders
- Use testnet or be very careful!

### ✅ Active Positions
- Live P&L tracking from Binance
- Entry price vs current price
- Real-time updates

## 6️⃣ Test the System

### Test Portfolio Widget
Refresh the page - you should see your real Binance balances.

### Test AI Analysis
```javascript
// Open browser console and run:
fetch('/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ symbol: 'BTCUSDT' })
})
.then(r => r.json())
.then(console.log);
```

### Test Market Data
```javascript
fetch('/api/market?symbol=BTCUSDT')
.then(r => r.json())
.then(console.log);
```

## 🔧 Troubleshooting

**"Module not found" errors?**
```bash
pnpm install --force
```

**Database connection errors?**
```bash
# Verify POSTGRES_URL is set
echo $POSTGRES_URL

# Re-push schema
cd packages/database
pnpm db:push
```

**Agents not starting?**
- Check API keys in `.env.local`
- Verify XAI_API_KEY is valid
- Check browser console for errors

## 📚 Next Steps

- Read full [README.md](./README.md)
- Check [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
- Review agent code in `packages/agents/`

Happy trading! 🚀
