// packages/agents/src/aktienix/intelligence/signal-merger.ts
import { MACRO_EVENT_MAP } from './macro-sector-map';
import type { ClassifiedEvent } from './macro-classifier-agent';

export type CorroborationStatus = 'confirmed' | 'confirmed_weak' | 'rss_only' | 'social_only' | 'conflicting';

export interface MergedSignal extends ClassifiedEvent {
    corroboration: CorroborationStatus;
    confidence_delta: number;
    sources: string[];
}

const CORROBORATION_DELTA: Record<CorroborationStatus, number> = {
    confirmed: 0.15,
    confirmed_weak: 0.08,
    rss_only: 0,
    social_only: -0.10,
    conflicting: -0.20,
};

/** Simple heuristic: events share a sector if both ids contain shared keywords */
function sameCategory(id1: string, id2: string): boolean {
    const CATEGORIES = [
        ['oil', 'energy', 'opec', 'crude', 'fuel', 'gas'],
        ['fed', 'rate', 'fomc', 'inflation', 'cpi'],
        ['china', 'taiwan', 'tariff', 'trade'],
        ['airline', 'transport', 'freight', 'ship'],
        ['health', 'pandemic', 'drug', 'virus'],
        ['tech', 'semi', 'chip', 'antitrust'],
    ];
    const combined = `${id1} ${id2}`.toLowerCase();
    return CATEGORIES.some(kws => kws.filter(kw => combined.includes(kw)).length >= 2);
}

export class SignalMerger {
    merge(rssEvents: ClassifiedEvent[], xEvents: ClassifiedEvent[]): MergedSignal[] {
        const matched = new Set<string>(); // x event_ids already matched
        const results: MergedSignal[] = [];

        for (const rssEvent of rssEvents) {
            // Step 1: exact event_id match
            let xMatch = xEvents.find(x => x.event_id === rssEvent.event_id);
            let corroboration: CorroborationStatus;

            if (xMatch) {
                matched.add(xMatch.event_id);
                corroboration = 'confirmed';
            } else {
                // Step 2: category match within 2h (both are fresh — ingestion filters ensure this)
                xMatch = xEvents.find(x => !matched.has(x.event_id) && sameCategory(rssEvent.event_id, x.event_id));
                if (xMatch) {
                    matched.add(xMatch.event_id);
                    corroboration = 'confirmed_weak';
                } else {
                    corroboration = 'rss_only';
                }
            }

            const delta = CORROBORATION_DELTA[corroboration];
            results.push({
                ...rssEvent,
                corroboration,
                confidence_delta: delta,
                sources: [
                    ...rssEvent.source_articles,
                    ...(xMatch?.source_articles ?? []),
                ],
            });
        }

        // Step 3: unmatched X events → social_only
        for (const xEvent of xEvents) {
            if (!matched.has(xEvent.event_id)) {
                results.push({
                    ...xEvent,
                    corroboration: 'social_only',
                    confidence_delta: CORROBORATION_DELTA.social_only,
                    sources: xEvent.source_articles,
                });
            }
        }

        return results;
    }
}
