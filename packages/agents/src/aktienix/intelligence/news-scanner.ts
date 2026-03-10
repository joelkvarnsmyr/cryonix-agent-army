import { OpenAI } from 'openai';
import { MACRO_EVENT_MAP } from './macro-sector-map';
import { buildXSearchQuery } from './x-accounts';

export interface MacroSignal {
    event: string;              // e.g., 'middle_east_conflict'
    impact: 'bullish' | 'bearish' | 'neutral';
    sectors: string[];          // Affected sectors
    tickers: string[];          // Specifically affected tickers
    confidence: number;         // 0.0 to 1.0 (how sure is the AI that this event is happening NOW and affects markets?)
    reasoning: string;          // Brief explanation of why
    sourceUrl?: string;         // Link to the X post or news article
}

export class StockNewsScanner {
    private grok: OpenAI | null = null;
    private initialized = false;

    constructor() {
        const apiKey = process.env.XAI_API_KEY;
        if (apiKey) {
            this.grok = new OpenAI({
                apiKey,
                baseURL: 'https://api.x.ai/v1'
            });
            this.initialized = true;
        } else {
            console.warn('[NEWS SCANNER] XAI_API_KEY not found in environment. Macro intelligence will be disabled.');
        }
    }

    public isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Scans recent X/Twitter posts for geopolitical and macroeconomic events.
     * Uses Grok's live search integration.
     */
    public async scanMacroEvents(): Promise<MacroSignal[]> {
        if (!this.grok || !this.initialized) {
            return [];
        }

        try {
            // Build a targeted search query for breaking news and fed watchers
            // Grok will use this internally if we ask it to search.
            const targetAccounts = buildXSearchQuery(['breaking_market', 'fed_watchers']);

            // Provide Grok with the list of events we actually know how to trade
            const possibleEventsText = Object.keys(MACRO_EVENT_MAP)
                .map(key => `- ${key}: ${MACRO_EVENT_MAP[key].description} (Keywords: ${MACRO_EVENT_MAP[key].triggerKeywords.join(', ')})`)
                .join('\n');

            const systemPrompt = `You are an elite geopolitical and macroeconomic intelligence analyst for an automated trading fund. 
You have access to live X (Twitter) search.

Your job is to identify if any of our predefined "Macro Events" are CURRENTLY BREAKING or ESCALATING based on the very latest news.
We only care about actionable, market-moving news (e.g., actual attacks, actual rate decisions, major leaks) — NOT opinion pieces or old news.

PREDEFINED MACRO EVENTS:
${possibleEventsText}

INSTRUCTIONS:
1. Search X for breaking news related to these events from top financial/geopolitical accounts. Use query: ${targetAccounts} AND related keywords.
2. If NOTHING major is happening, return an empty array [].
3. If an event IS happening, map it strictly to one of the event IDs provided above.
4. Determine the impact (bullish/bearish) for the broader market or specific sectors.
5. Provide a confidence score (0.0 to 1.0) on how likely this is to move the market today.

Return ONLY pure JSON in this format:
[
  {
    "event": "fed_rate_cut",
    "impact": "bullish",
    "sectors": ["technology"],
    "tickers": ["QQQ"],
    "confidence": 0.85,
    "reasoning": "WSJ Nick Timiraos just leaked that Fed is considering 50bps cut tomorrow."
  }
]
No markdown wrapping, no thinking text, just the JSON array.`;

            const response = await this.grok.chat.completions.create({
                model: 'grok-3-mini', // Fast, reasoning model
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: 'Execute a live X search now for breaking macro events and return the JSON array.' }
                ],
                temperature: 0.1, // Keep it factual and deterministic
                // @ts-ignore - search param is an xAI extension
                search: { mode: 'on' },
            } as any);

            const content = response.choices[0]?.message?.content || '[]';
            const parsed = this.parseResponse(content);

            // Enrich with static mapping data (ensure we get all the hardcoded tickers even if Grok missed some)
            return this.enrichSignals(parsed);

        } catch (error) {
            console.error('[NEWS SCANNER] Failed to scan macro events:', error);
            return [];
        }
    }

    /**
     * Extraherar JSON ur Groks eventuella markdown-svar.
     */
    private parseResponse(text: string): MacroSignal[] {
        try {
            // Try direct parse
            return JSON.parse(text);
        } catch {
            // Try extracting from ```json ... ``` block
            const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (match) {
                try {
                    return JSON.parse(match[1]);
                } catch (e) {
                    console.error('[NEWS SCANNER] Failed to parse JSON block:', e);
                }
            }

            // Try finding first [ to last ]
            const start = text.indexOf('[');
            const end = text.lastIndexOf(']');
            if (start >= 0 && end > start) {
                try {
                    return JSON.parse(text.substring(start, end + 1));
                } catch (e) {
                    console.error('[NEWS SCANNER] Failed to parse bracketed JSON:', e);
                }
            }

            return [];
        }
    }

    /**
     * Enriches AI signals with our hardcoded sector/ticker knowledge.
     * Prevents the AI from hallucinating tickers we don't want to trade.
     */
    private enrichSignals(signals: Partial<MacroSignal>[]): MacroSignal[] {
        const enriched: MacroSignal[] = [];

        for (const sig of signals) {
            if (!sig.event || !MACRO_EVENT_MAP[sig.event]) {
                continue; // Skip invalid or unknown events
            }

            const map = MACRO_EVENT_MAP[sig.event];

            enriched.push({
                event: sig.event,
                impact: sig.impact || 'neutral',
                sectors: map.bullishSectors.concat(map.bearishSectors),
                // Only trade our predefined liquid tickers for this event type
                tickers: sig.impact === 'bullish' ? map.bullishTickers : map.bearishTickers,
                confidence: sig.confidence || 0.5,
                reasoning: sig.reasoning || map.description,
            });
        }

        return enriched;
    }
}
