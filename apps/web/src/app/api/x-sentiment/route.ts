import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import OpenAI from 'openai';

export const dynamic = 'force-dynamic';

const WATCHLIST = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'NEAR', 'SUI', 'ARB', 'OP'];
const CACHE_TTL = 900; // 15 min cache

function getGrok(): OpenAI | null {
  const key = process.env.XAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.x.ai/v1' });
}

// GET: Return cached X sentiment
export async function GET() {
  try {
    const cached = await redis.get('x-sentiment:latest');
    if (cached) {
      return NextResponse.json({ status: 'ok', data: JSON.parse(cached) });
    }
    return NextResponse.json({ status: 'empty', data: {} });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST: Run X sentiment scan via GROK with live search
export async function POST() {
  const ai = getGrok();
  if (!ai) {
    return NextResponse.json({ error: 'XAI_API_KEY not configured' }, { status: 500 });
  }

  try {
    const symbols = WATCHLIST.join(', ');

    const response = await ai.chat.completions.create({
      model: 'grok-4-1-fast-non-reasoning',
      messages: [
        {
          role: 'system',
          content: 'You are a crypto market sentiment analyst with access to real-time X/Twitter data. Analyze current social sentiment for the requested cryptocurrencies. Be precise and data-driven.',
        },
        {
          role: 'user',
          content: `Analyze the current X/Twitter sentiment for these cryptocurrencies: ${symbols}

For each coin, provide:
1. Sentiment score (-3 to +3, where -3=extreme fear/bearish, +3=extreme greed/bullish)
2. Volume of discussion (low/medium/high)
3. Key narrative (one sentence: what are people talking about?)
4. Any breaking news or events

Return JSON only:
{
  "BTC": {"score": 1, "volume": "high", "narrative": "...", "alert": null},
  "ETH": {"score": -1, "volume": "medium", "narrative": "...", "alert": "hack reported"},
  ...
}

Only include coins with notable sentiment. Skip coins with no meaningful X activity.`,
        },
      ],
      temperature: 0.2,
      max_tokens: 800,
      // @ts-ignore - xAI search parameter
      search: { mode: 'on' },
    } as any);

    const content = response.choices[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return NextResponse.json({ error: 'Failed to parse GROK response', raw: content }, { status: 500 });
    }

    const sentimentData = JSON.parse(jsonMatch[0]);

    // Store in Redis
    const enriched = {
      timestamp: new Date().toISOString(),
      data: sentimentData,
      model: response.model,
      tokens: response.usage?.total_tokens || 0,
    };

    await redis.set('x-sentiment:latest', JSON.stringify(enriched), 'EX', CACHE_TTL);

    // Also update individual sentiment scores in Redis (used by auto-trade)
    for (const [symbol, info] of Object.entries(sentimentData)) {
      const s = info as any;
      if (s.score !== undefined) {
        await redis.setex(`sentiment:${symbol}`, 3600, String(s.score));

        // Store alert flag for high-priority events
        if (s.alert) {
          await redis.setex(`sentiment:alert:${symbol}`, 1800, s.alert);
        }
      }
    }

    console.log(`[X-SENTIMENT] Updated ${Object.keys(sentimentData).length} coins:`,
      Object.entries(sentimentData).map(([k, v]: [string, any]) => `${k}:${v.score}`).join(', ')
    );

    return NextResponse.json({ status: 'ok', ...enriched });
  } catch (error) {
    console.error('[X-SENTIMENT] Error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
