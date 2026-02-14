import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import ccxt, { type Exchange } from 'ccxt';
import OpenAI from 'openai';

export const dynamic = 'force-dynamic';

// ============================================================================
// GRID CONFIGURATION TYPES
// ============================================================================

interface GridConfig {
  symbol: string;
  lowerBound: number;
  upperBound: number;
  buyLevels: number[];     // Price levels to place buy orders
  tpTargets: number[];     // Take-profit for each level
  orderSizeUsd: number;    // USD per grid level
  status: 'active' | 'completed' | 'cancelled';
  filledLevels: number[];  // Indices of filled buy levels
  reasoning: string;       // LLM reasoning for range selection
  createdAt: string;
  expiresAt: string;       // Auto-cancel after this time
}

// ============================================================================
// EXCHANGE + AI SINGLETONS
// ============================================================================

let exchange: Exchange | null = null;
function getExchange(): Exchange {
  if (exchange) return exchange;
  const config: any = {
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  };
  if (process.env.BINANCE_TESTNET === 'true') {
    config.urls = {
      api: {
        public: 'https://testnet.binance.vision/api',
        private: 'https://testnet.binance.vision/api',
      },
    };
  }
  exchange = new ccxt.binance(config);
  return exchange;
}

let grok: OpenAI | null = null;
function getGrok(): OpenAI | null {
  if (!process.env.XAI_API_KEY) return null;
  if (grok) return grok;
  grok = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: 'https://api.x.ai/v1',
  });
  return grok;
}

// ============================================================================
// POST /api/grid-config - Calculate grid ranges via LLM
// ============================================================================

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { symbol = 'BTC/USDC', budgetUsd = 12 } = body;

    const ex = getExchange();

    // Fetch 7 days of 4h candles for volatility analysis
    const ohlcv4h = await ex.fetchOHLCV(symbol, '4h', undefined, 42); // ~7 days
    const ohlcv1h = await ex.fetchOHLCV(symbol, '1h', undefined, 24); // last 24h
    const ticker = await ex.fetchTicker(symbol);

    if (!ohlcv4h.length) {
      return NextResponse.json({ error: 'Failed to fetch market data' }, { status: 500 });
    }

    // Calculate support/resistance and volatility
    // CCXT OHLCV: [timestamp, open, high, low, close, volume] - values can be undefined
    const highs = ohlcv4h.map(c => (c[2] as number) || 0);
    const lows = ohlcv4h.map(c => (c[3] as number) || 0);
    const closes = ohlcv4h.map(c => (c[4] as number) || 0);

    const high7d = Math.max(...highs);
    const low7d = Math.min(...lows.filter(l => l > 0));
    const currentPrice = (ticker.last || closes[closes.length - 1] || 0) as number;

    // Simple ATR calculation
    const trs = ohlcv4h.slice(1).map((c, i) => {
      const h = (c[2] as number) || 0;
      const l = (c[3] as number) || 0;
      const prevClose = (ohlcv4h[i]![4] as number) || 0;
      return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    });
    const atr4h = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;

    // 24h range from 1h data
    const high24h = Math.max(...ohlcv1h.map(c => (c[2] as number) || 0));
    const low24h = Math.min(...ohlcv1h.map(c => (c[3] as number) || 0).filter(l => l > 0));

    // Calculate how many levels we can afford ($5.50 min per level)
    const maxLevels = Math.floor(budgetUsd / 5.5);
    const levelsCount = Math.min(maxLevels, 3); // Cap at 3 for micro-budget

    if (levelsCount < 1) {
      return NextResponse.json({ error: 'Budget too small for grid (need $5.50+ per level)' }, { status: 400 });
    }

    if (!currentPrice || currentPrice <= 0) {
      return NextResponse.json({ error: 'Could not determine current price' }, { status: 500 });
    }

    // Ask Grok for optimal grid range
    const ai = getGrok();
    let gridConfig: GridConfig;

    if (ai) {
      const prompt = `You are a grid trading range calculator for crypto. Analyze this data and suggest optimal grid levels.

**Market Data for ${symbol}:**
- Current Price: $${currentPrice.toFixed(2)}
- 7-Day Range: $${low7d.toFixed(2)} - $${high7d.toFixed(2)} (${((high7d - low7d) / low7d * 100).toFixed(1)}% range)
- 24h Range: $${low24h.toFixed(2)} - $${high24h.toFixed(2)}
- ATR (4h): $${atr4h.toFixed(2)} (${(atr4h / currentPrice * 100).toFixed(2)}% of price)
- 24h Change: ${ticker.percentage?.toFixed(2)}%

**Constraints:**
- MICRO grid: only ${levelsCount} buy level(s), $${(budgetUsd / levelsCount).toFixed(2)} per level
- Minimum order: $5.50
- Total budget: $${budgetUsd}
- This is a "ladder buy in expected range" strategy, NOT traditional grid

**Your Task:**
1. Identify a price range where ${symbol} is likely to oscillate in the next 24-48h
2. Place ${levelsCount} buy level(s) BELOW current price where you'd want to buy dips
3. Set realistic take-profit targets for each level (where price is likely to bounce back to)
4. The range should be based on recent support/resistance and volatility

Respond with ONLY a minified JSON object:
{"lower": number, "upper": number, "buyLevels": [${Array(levelsCount).fill('number').join(', ')}], "tpTargets": [${Array(levelsCount).fill('number').join(', ')}], "reasoning": "one sentence explaining the range choice"}`;

      const response = await ai.chat.completions.create({
        model: 'grok-3-mini',
        messages: [
          { role: 'system', content: 'You are a grid trading analyst. Respond with a single minified JSON object.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 300,
      });

      const content = response.choices[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);

        gridConfig = {
          symbol,
          lowerBound: result.lower,
          upperBound: result.upper,
          buyLevels: result.buyLevels,
          tpTargets: result.tpTargets,
          orderSizeUsd: Math.floor((budgetUsd / levelsCount) * 100) / 100,
          status: 'active',
          filledLevels: [],
          reasoning: result.reasoning || 'LLM grid range',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // 48h
        };
      } else {
        // Fallback to algorithmic grid
        gridConfig = calculateFallbackGrid(symbol, currentPrice, atr4h, levelsCount, budgetUsd);
      }
    } else {
      // No AI available - use algorithmic fallback
      gridConfig = calculateFallbackGrid(symbol, currentPrice, atr4h, levelsCount, budgetUsd);
    }

    // Store in Redis
    await redis.set(`grid:config:${symbol}`, JSON.stringify(gridConfig));

    // Track active grids
    const activeGrids: string[] = JSON.parse(await redis.get('grid:active') || '[]');
    if (!activeGrids.includes(symbol)) {
      activeGrids.push(symbol);
      await redis.set('grid:active', JSON.stringify(activeGrids));
    }

    console.log(`[GRID] Created grid for ${symbol}: ${gridConfig.buyLevels.length} levels, range $${gridConfig.lowerBound}-$${gridConfig.upperBound}`);

    return NextResponse.json({
      success: true,
      grid: gridConfig,
      market: {
        currentPrice,
        high7d,
        low7d,
        atr4h,
        levelsCount,
      },
    });
  } catch (error) {
    console.error('[GRID] Error:', error);
    return NextResponse.json(
      { error: 'Grid config failed', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

// ============================================================================
// GET /api/grid-config - Get active grid configs
// ============================================================================

export async function GET() {
  try {
    const activeGrids: string[] = JSON.parse(await redis.get('grid:active') || '[]');
    const configs: GridConfig[] = [];

    for (const symbol of activeGrids) {
      const raw = await redis.get(`grid:config:${symbol}`);
      if (raw) {
        const config: GridConfig = JSON.parse(raw as string);
        // Auto-expire grids
        if (new Date(config.expiresAt) < new Date()) {
          config.status = 'cancelled';
          await redis.set(`grid:config:${symbol}`, JSON.stringify(config));
          const idx = activeGrids.indexOf(symbol);
          if (idx >= 0) activeGrids.splice(idx, 1);
          await redis.set('grid:active', JSON.stringify(activeGrids));
        } else {
          configs.push(config);
        }
      }
    }

    return NextResponse.json({ success: true, grids: configs });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to get grid configs' },
      { status: 500 }
    );
  }
}

// ============================================================================
// DELETE /api/grid-config - Cancel a grid
// ============================================================================

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');

    if (!symbol) {
      return NextResponse.json({ error: 'Symbol required' }, { status: 400 });
    }

    const raw = await redis.get(`grid:config:${symbol}`);
    if (raw) {
      const config: GridConfig = JSON.parse(raw as string);
      config.status = 'cancelled';
      await redis.set(`grid:config:${symbol}`, JSON.stringify(config));
    }

    const activeGrids: string[] = JSON.parse(await redis.get('grid:active') || '[]');
    const idx = activeGrids.indexOf(symbol);
    if (idx >= 0) {
      activeGrids.splice(idx, 1);
      await redis.set('grid:active', JSON.stringify(activeGrids));
    }

    console.log(`[GRID] Cancelled grid for ${symbol}`);
    return NextResponse.json({ success: true, cancelled: symbol });
  } catch (error) {
    return NextResponse.json({ error: 'Cancel failed' }, { status: 500 });
  }
}

// ============================================================================
// FALLBACK: Algorithmic grid when AI is unavailable
// ============================================================================

function calculateFallbackGrid(
  symbol: string,
  currentPrice: number,
  atr: number,
  levels: number,
  budgetUsd: number
): GridConfig {
  // Place buy levels at 1x, 2x ATR below current price
  const buyLevels: number[] = [];
  const tpTargets: number[] = [];

  for (let i = 1; i <= levels; i++) {
    const buyLevel = Math.round((currentPrice - atr * i) * 100) / 100;
    const tpTarget = Math.round((currentPrice - atr * (i - 0.5)) * 100) / 100; // TP halfway back
    buyLevels.push(buyLevel);
    tpTargets.push(tpTarget);
  }

  return {
    symbol,
    lowerBound: Math.round((currentPrice - atr * (levels + 1)) * 100) / 100,
    upperBound: Math.round((currentPrice + atr) * 100) / 100,
    buyLevels,
    tpTargets,
    orderSizeUsd: Math.floor((budgetUsd / levels) * 100) / 100,
    status: 'active',
    filledLevels: [],
    reasoning: `Algorithmic: ${levels} levels at ${atr.toFixed(0)} ATR spacing`,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  };
}
