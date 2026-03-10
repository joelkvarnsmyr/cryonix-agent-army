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

const SYSTEM_PROMPT = `You are a macro economist and portfolio strategist for an automated US equity trading fund (long-only, paper trading).

Known event IDs we can trade (use these exact slugs when applicable):
${KNOWN_EVENTS}

For NEW events not in this list, create a descriptive snake_case slug (e.g. "bird_flu_outbreak", "port_strike_us_east").

Analyze the provided news articles and identify market-moving macro events.

IMPORTANT RULES:
1. Group related articles about the SAME event into ONE entry. Multiple articles about OPEC = one "oil_supply_shock", not three.
2. Reference which articles support each event using their [N] index numbers in "source_indices".
3. Only NYSE/NASDAQ-listed tickers (max 8 per side). No OTC, no crypto, no forex.
4. Set market_moving=false if the event would NOT cause >1% move in any affected sector ETF.
5. Return [] if nothing is market-moving.
6. Return JSON array only, no markdown fences.

Confidence calibration:
- 0.90-1.0: Confirmed fact from official source (Fed statement, EIA data release, signed executive order)
- 0.75-0.89: Strong signal from multiple credible sources (Reuters+Bloomberg agree)
- 0.60-0.74: Single credible source reporting, not yet confirmed elsewhere
- 0.40-0.59: Rumor, unnamed sources, or speculation from credible outlet
- Below 0.40: Social media chatter, unverified claims

Phase definitions:
- "detected": First report, single source, not yet confirmed
- "developing": Confirmed by multiple sources, situation ongoing
- "resolving": De-escalation signals (ceasefire talks, policy reversal hints)
- "resolved": Event concluded (deal signed, conflict ended, data revised)

For each event return:
{
  "event_id": "snake_case_slug",
  "category": "known" | "emergent",
  "source_indices": [1, 3],
  "causal_chain": {
    "immediate": { "bearish_tickers": ["UAL"], "bullish_tickers": ["XOM"], "reasoning": "1-2 sentences on WHY these tickers are affected" },
    "secondary": { "recovery_watch_tickers": ["UAL"], "watch_after_days": 3, "reasoning": "what would trigger recovery" },
    "resolution_signal": "specific observable condition that ends this event"
  },
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentences citing source articles by [N] index",
  "phase": "detected" | "developing" | "resolving" | "resolved",
  "ttl_hours": 24-168,
  "market_moving": true | false
}`;

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
                .map(e => {
                    // Map source_indices back to actual article URLs
                    const indices: number[] = Array.isArray(e.source_indices)
                        ? e.source_indices.filter((i: number) => i >= 1 && i <= articles.length)
                        : [];
                    const urls = indices.length > 0
                        ? indices.map((i: number) => articles[i - 1].url)
                        : articles.map(a => a.url); // fallback: all articles
                    const { source_indices: _, ...rest } = e;
                    return { ...rest, source_articles: urls };
                });
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
