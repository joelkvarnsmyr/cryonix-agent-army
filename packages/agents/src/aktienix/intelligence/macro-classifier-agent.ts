// packages/agents/src/aktienix/intelligence/macro-classifier-agent.ts
import { OpenAI } from 'openai';
import { MACRO_EVENT_MAP } from './macro-sector-map';
import type { RawArticle } from './news-ingestion-service';

export interface CausalChain {
    immediate: {
        bearish_tickers: string[];
        bullish_tickers: string[];
        reasoning: string;
    };
    secondary: {
        recovery_watch_tickers: string[];
        watch_after_days: number;
        reasoning: string;
    };
    resolution_signal: string;
}

export interface ClassifiedEvent {
    event_id: string;
    category: 'known' | 'emergent';
    causal_chain: CausalChain;
    confidence: number;
    reasoning: string;
    phase: 'detected' | 'developing' | 'resolving' | 'resolved';
    ttl_hours: number;
    market_moving: boolean;
    source_articles: string[];  // article URLs
}

const BATCH_SIZE = 8;
const KNOWN_EVENTS = Object.keys(MACRO_EVENT_MAP).map(k =>
    `- ${k}: ${MACRO_EVENT_MAP[k].description}`
).join('\n');

const SYSTEM_PROMPT = `You are a macro economist and portfolio strategist for an automated US equity trading fund.

Known event IDs we can trade (use these exact slugs when applicable):
${KNOWN_EVENTS}

For NEW events not in this list, create a descriptive snake_case slug (e.g. "bird_flu_outbreak", "port_strike_us_east").

Analyze the provided news articles and identify market-moving events.

For each event return JSON:
{
  "event_id": "snake_case_slug",
  "category": "known" | "emergent",
  "causal_chain": {
    "immediate": { "bearish_tickers": ["UAL"], "bullish_tickers": ["XOM"], "reasoning": "..." },
    "secondary": { "recovery_watch_tickers": ["UAL"], "watch_after_days": 4, "reasoning": "..." },
    "resolution_signal": "WTI falls below spike level"
  },
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentences citing the source article",
  "phase": "developing" | "resolving" | "resolved",
  "ttl_hours": 24-168,
  "market_moving": true | false
}

Rules:
- Only NYSE/NASDAQ tickers (max 10 per event)
- market_moving=false if event would NOT cause >1% sector move
- Return [] if nothing is market-moving
- Return JSON array only, no markdown`;

export class MacroClassifierAgent {
    private grok: OpenAI | null = null;

    constructor(apiKey: string) {
        if (apiKey) {
            this.grok = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
        }
    }

    async classify(articles: RawArticle[]): Promise<ClassifiedEvent[]> {
        if (!this.grok || articles.length === 0) return [];

        const results: ClassifiedEvent[] = [];
        for (let i = 0; i < articles.length; i += BATCH_SIZE) {
            const batch = articles.slice(i, i + BATCH_SIZE);
            const batchResults = await this.classifyBatch(batch);
            results.push(...batchResults);
        }
        return results;
    }

    private async classifyBatch(articles: RawArticle[]): Promise<ClassifiedEvent[]> {
        const articleText = articles.map((a, i) =>
            `[${i + 1}] Source: ${a.source} (${a.domain})\nHeadline: ${a.headline}\nSummary: ${a.summary}`
        ).join('\n\n');

        try {
            const response = await this.grok!.chat.completions.create({
                model: 'grok-3-mini',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: `Analyze these ${articles.length} articles:\n\n${articleText}` },
                ],
                temperature: 0.1,
            });

            const content = response.choices[0]?.message?.content ?? '[]';
            const parsed = this.parseResponse(content);

            return parsed
                .filter(e => e.market_moving !== false)
                .map(e => ({
                    ...e,
                    source_articles: articles.map(a => a.url),
                }));
        } catch {
            return [];
        }
    }

    private parseResponse(text: string): any[] {
        try { return JSON.parse(text); } catch { /* try fallback */ }
        const m = text.match(/\[[\s\S]*\]/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
        return [];
    }
}
