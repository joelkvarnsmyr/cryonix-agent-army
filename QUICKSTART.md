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

Visit **http://localhost:3000** 🎉

## 5️⃣ Test Agents

Open browser console and run:

```javascript
// Start agents
fetch('/api/agents', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'start' })
}).then(r => r.json()).then(console.log);

// Chat with GROK
fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'What is the current market sentiment?'
  })
}).then(r => r.json()).then(console.log);
```

## ✅ You're Done!

The dashboard should now show:
- ✅ Portfolio summary
- ✅ AI signals from Market Scout
- ✅ Live charts
- ✅ Active positions

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
