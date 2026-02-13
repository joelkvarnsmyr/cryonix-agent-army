import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import ccxt from 'ccxt';

// Initialize GROK (xAI)
const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || '',
  baseURL: 'https://api.x.ai/v1',
});

// Initialize Binance
const isTestnet = process.env.BINANCE_TESTNET === 'true';
const exchange = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_API_SECRET,
  enableRateLimit: true,
  sandbox: isTestnet,
});

// Set testnet URLs if using testnet
if (isTestnet) {
  exchange.setSandboxMode(true);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { symbol = 'BTC/USDT', action = 'full_analysis' } = body;

    // Fetch market data
    const [ticker, ohlcv] = await Promise.all([
      exchange.fetchTicker(symbol),
      exchange.fetchOHLCV(symbol, '1h', undefined, 24), // Last 24 hours
    ]);

    // Calculate basic indicators
    const closes = ohlcv.map((c) => c[4] as number);
    const volumes = ohlcv.map((c) => c[5] as number);

    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentPrice = ticker.last || 0;
    const priceVsSma = ((currentPrice - sma20) / sma20) * 100;

    const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
    const currentVolume = volumes[volumes.length - 1];
    const volumeRatio = currentVolume / avgVolume;

    // Calculate RSI
    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) {
        gains.push(change);
        losses.push(0);
      } else {
        gains.push(0);
        losses.push(Math.abs(change));
      }
    }
    const avgGain = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
    const avgLoss = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    // Build analysis prompt for GROK
    const analysisPrompt = `
Du är en expert crypto trading-analytiker. Analysera följande marknadsdata för ${symbol}:

**Aktuell Data:**
- Pris: $${currentPrice.toLocaleString()}
- 24h Förändring: ${ticker.percentage?.toFixed(2)}%
- 24h High: $${ticker.high?.toLocaleString()}
- 24h Low: $${ticker.low?.toLocaleString()}
- 24h Volym: ${ticker.baseVolume?.toLocaleString()} ${symbol.split('/')[0]}

**Tekniska Indikatorer:**
- RSI (14): ${rsi.toFixed(1)}
- Pris vs SMA20: ${priceVsSma.toFixed(2)}%
- Volym Ratio: ${volumeRatio.toFixed(2)}x genomsnitt

**Uppgift:**
Ge en kort men konkret trading-rekommendation på svenska. Inkludera:
1. **Signal:** BUY / SELL / HOLD
2. **Confidence:** 0-100%
3. **Entry:** Rekommenderat inköpspris
4. **Target:** Kursmål
5. **Stop Loss:** Stop loss-nivå
6. **Reasoning:** 2-3 bullet points med anledningar

Svara i JSON-format:
{
  "signal": "BUY|SELL|HOLD",
  "confidence": 75,
  "entry": 91000,
  "target": 95000,
  "stopLoss": 88000,
  "reasoning": ["anledning 1", "anledning 2"],
  "summary": "kort sammanfattning"
}
`;

    const response = await grok.chat.completions.create({
      model: 'grok-4-1-fast-reasoning',
      messages: [
        {
          role: 'system',
          content: 'Du är en professionell crypto trading-analytiker. Svara alltid med valid JSON.',
        },
        { role: 'user', content: analysisPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const aiContent = response.choices[0]?.message?.content || '{}';

    // Extract JSON from response
    let analysis;
    try {
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch {
      analysis = {
        signal: 'HOLD',
        confidence: 50,
        reasoning: ['Could not parse AI response'],
        summary: aiContent,
      };
    }

    return NextResponse.json({
      success: true,
      data: {
        symbol,
        timestamp: new Date().toISOString(),
        marketData: {
          price: currentPrice,
          change24h: ticker.percentage,
          volume24h: ticker.baseVolume,
          high24h: ticker.high,
          low24h: ticker.low,
        },
        indicators: {
          rsi: parseFloat(rsi.toFixed(1)),
          priceVsSma20: parseFloat(priceVsSma.toFixed(2)),
          volumeRatio: parseFloat(volumeRatio.toFixed(2)),
        },
        analysis,
      },
    });
  } catch (error: any) {
    console.error('Analysis API Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
