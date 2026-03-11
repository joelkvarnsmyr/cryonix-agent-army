#!/usr/bin/env npx tsx
// scripts/aktienix/live-pipeline-test.ts
// Live end-to-end test of Macro Intelligence v2 pipeline
// Usage: npx tsx scripts/aktienix/live-pipeline-test.ts

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env from multiple locations (first match wins for each var)
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });
dotenv.config({ path: path.resolve(__dirname, '../../apps/web/.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { NewsIngestionService } from '../../packages/agents/src/aktienix/intelligence/news-ingestion-service';
import { MacroClassifierAgent, ClassifiedEvent } from '../../packages/agents/src/aktienix/intelligence/macro-classifier-agent';
import { SignalMerger } from '../../packages/agents/src/aktienix/intelligence/signal-merger';
import { CausalChainEngine } from '../../packages/agents/src/aktienix/intelligence/causal-chain-engine';
import { isValidTicker, filterValidTickers } from '../../packages/agents/src/aktienix/intelligence/ticker-universe';
import { MACRO_EVENT_MAP } from '../../packages/agents/src/aktienix/intelligence/macro-sector-map';
import type { LiveEvent } from '../../packages/agents/src/aktienix/intelligence/event-lifecycle-tracker';
import type { RawArticle } from '../../packages/agents/src/aktienix/intelligence/news-ingestion-service';

const XAI_API_KEY = process.env.XAI_API_KEY ?? '';
const hr = () => console.log('─'.repeat(80));

async function main() {
    console.log('\n🔬 MACRO INTELLIGENCE v2 — LIVE PIPELINE TEST');
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log(`   Grok API: ${XAI_API_KEY ? 'AVAILABLE' : 'NOT SET (mock mode)'}`);
    hr();

    // ═══════════════════════════════════════════════════════
    // STAGE 1: RSS INGESTION (live)
    // ═══════════════════════════════════════════════════════
    console.log('\n📡 STAGE 1: RSS Feed Ingestion (live fetch)');
    const rss = new NewsIngestionService();
    const startRss = Date.now();
    const rssArticles = await rss.scanAll();
    const rssMs = Date.now() - startRss;

    console.log(`   Fetched ${rssArticles.length} articles in ${rssMs}ms`);

    // Group by source
    const bySource = new Map<string, RawArticle[]>();
    for (const a of rssArticles) {
        const arr = bySource.get(a.source) ?? [];
        arr.push(a);
        bySource.set(a.source, arr);
    }
    for (const [source, articles] of bySource) {
        console.log(`   ${source}: ${articles.length} articles (${articles[0]?.sourceTrust})`);
    }

    // Group by domain
    const byDomain = new Map<string, number>();
    for (const a of rssArticles) byDomain.set(a.domain, (byDomain.get(a.domain) ?? 0) + 1);
    console.log(`   Domains: ${[...byDomain].map(([d, n]) => `${d}(${n})`).join(', ')}`);

    // Show sample headlines
    if (rssArticles.length > 0) {
        console.log('\n   Sample headlines:');
        for (const a of rssArticles.slice(0, 8)) {
            const age = Math.round((Date.now() - a.publishedAt.getTime()) / 3600000);
            console.log(`   [${a.source}/${a.domain}] ${age}h ago — ${a.headline.slice(0, 100)}`);
        }
    }

    hr();

    // ═══════════════════════════════════════════════════════
    // STAGE 2: LLM CLASSIFICATION
    // ═══════════════════════════════════════════════════════
    console.log('\n🧠 STAGE 2: LLM Classification');

    let rssEvents: ClassifiedEvent[] = [];

    if (XAI_API_KEY) {
        console.log('   Calling Grok with real articles...');
        const classifier = new MacroClassifierAgent(XAI_API_KEY);
        const startClassify = Date.now();
        rssEvents = await classifier.classify(rssArticles);
        const classifyMs = Date.now() - startClassify;
        console.log(`   Grok classified ${rssArticles.length} articles → ${rssEvents.length} events in ${classifyMs}ms`);
    } else {
        console.log('   No API key — creating synthetic events from real headlines...');
        rssEvents = createSyntheticEvents(rssArticles);
        console.log(`   Synthesized ${rssEvents.length} events from headline keyword matching`);
    }

    for (const e of rssEvents) {
        const bearish = e.causal_chain.immediate.bearish_tickers.join(', ');
        const bullish = e.causal_chain.immediate.bullish_tickers.join(', ');
        console.log(`\n   EVENT: ${e.event_id} (${e.category}, phase=${e.phase}, conf=${e.confidence.toFixed(2)})`);
        console.log(`   Reasoning: ${e.reasoning.slice(0, 120)}`);
        console.log(`   Bearish: [${bearish}] | Bullish: [${bullish}]`);
        console.log(`   Resolution: ${e.causal_chain.resolution_signal}`);
    }

    hr();

    // ═══════════════════════════════════════════════════════
    // STAGE 3: TICKER VALIDATION
    // ═══════════════════════════════════════════════════════
    console.log('\n✅ STAGE 3: Ticker Universe Validation');

    for (const e of rssEvents) {
        const rawBearish = e.causal_chain.immediate.bearish_tickers;
        const rawBullish = e.causal_chain.immediate.bullish_tickers;
        const filteredBearish = filterValidTickers(rawBearish);
        const filteredBullish = filterValidTickers(rawBullish);

        const rejectedBearish = rawBearish.filter(t => !filteredBearish.includes(t));
        const rejectedBullish = rawBullish.filter(t => !filteredBullish.includes(t));

        console.log(`   ${e.event_id}:`);
        if (rejectedBearish.length > 0) {
            console.log(`     ❌ Rejected bearish: [${rejectedBearish.join(', ')}]`);
        }
        if (rejectedBullish.length > 0) {
            console.log(`     ❌ Rejected bullish: [${rejectedBullish.join(', ')}]`);
        }
        console.log(`     ✅ Valid bearish: [${filteredBearish.join(', ')}] | bullish: [${filteredBullish.join(', ')}]`);

        // Update events with filtered tickers
        e.causal_chain.immediate.bearish_tickers = filteredBearish;
        e.causal_chain.immediate.bullish_tickers = filteredBullish;
    }

    // Remove events where all tickers are invalid
    const validEvents = rssEvents.filter(e =>
        e.causal_chain.immediate.bearish_tickers.length > 0 ||
        e.causal_chain.immediate.bullish_tickers.length > 0
    );
    console.log(`\n   ${rssEvents.length} events → ${validEvents.length} after ticker validation`);

    hr();

    // ═══════════════════════════════════════════════════════
    // STAGE 4: SIGNAL MERGER (simulating dual-pipeline)
    // ═══════════════════════════════════════════════════════
    console.log('\n🔀 STAGE 4: Signal Merger (RSS vs X cross-validation)');
    console.log('   Simulating X pipeline with subset of RSS events...');

    // Simulate X events by taking a subset (in production, these come from XIngestionService)
    const xEvents: ClassifiedEvent[] = validEvents.length > 1
        ? [validEvents[0]] // Simulate one overlapping event from X
        : [];

    const merger = new SignalMerger();
    const merged = merger.merge(validEvents, xEvents);

    for (const m of merged) {
        console.log(`   ${m.event_id}: corroboration=${m.corroboration}, delta=${m.confidence_delta >= 0 ? '+' : ''}${m.confidence_delta.toFixed(2)}`);
        const finalConf = m.confidence + m.confidence_delta;
        console.log(`     Confidence: ${m.confidence.toFixed(2)} → ${finalConf.toFixed(2)} (after ${m.corroboration})`);
    }

    hr();

    // ═══════════════════════════════════════════════════════
    // STAGE 5: CONFIDENCE GATES
    // ═══════════════════════════════════════════════════════
    console.log('\n🚦 STAGE 5: Confidence Gate Evaluation');

    const THRESHOLDS = {
        known_confirmed: 0.50,
        known_confirmed_weak: 0.50,
        known_rss_only: 0.50,
        known_social_only: 0.60,
        emergent_confirmed: 0.75,
        emergent_other: 0.80,
        any_conflicting: 0.85,
    } as const;

    const accepted = [];
    const rejected = [];
    for (const m of merged) {
        const trustMult = 1.0; // All RSS = tier1
        const confAfterTrust = m.confidence * trustMult;
        const confFinal = confAfterTrust + m.confidence_delta;
        const conflicting = m.corroboration === 'conflicting';
        const key = `${m.category}_${m.corroboration}` as keyof typeof THRESHOLDS;
        const threshold = conflicting
            ? THRESHOLDS.any_conflicting
            : (THRESHOLDS[key] ?? THRESHOLDS.emergent_other);

        const pass = confFinal >= threshold;
        const entry = { event_id: m.event_id, confFinal, threshold, pass, corroboration: m.corroboration, category: m.category };
        if (pass) accepted.push(entry);
        else rejected.push(entry);

        const icon = pass ? '✅' : '❌';
        console.log(`   ${icon} ${m.event_id}: ${confFinal.toFixed(2)} vs threshold ${threshold} (${m.category}/${m.corroboration})`);
    }

    console.log(`\n   Accepted: ${accepted.length} | Rejected: ${rejected.length}`);

    hr();

    // ═══════════════════════════════════════════════════════
    // STAGE 6: CAUSAL CHAIN → MACRO SIGNALS
    // ═══════════════════════════════════════════════════════
    console.log('\n📊 STAGE 6: Causal Chain Engine → MacroSignals');

    // Create LiveEvents from accepted merged signals
    const liveEvents: LiveEvent[] = accepted.map(a => {
        const m = merged.find(x => x.event_id === a.event_id)!;
        return {
            event_id: m.event_id,
            phase: 'developing' as const,
            causal_chain: m.causal_chain,
            sources: m.sources,
            corroboration: m.corroboration,
            confidence: a.confFinal,
            detectedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + (m.ttl_hours ?? 48) * 3_600_000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(),
            auditIds: ['test-run'],
        };
    });

    const engine = new CausalChainEngine();
    const signals = engine.toMacroSignals(liveEvents);

    if (signals.length === 0) {
        console.log('   No MacroSignals emitted (all events may be in detected/resolved phase)');
    }

    for (const s of signals) {
        console.log(`\n   SIGNAL: ${s.event} (${s.impact})`);
        console.log(`   Tickers: [${s.tickers.join(', ')}]`);
        console.log(`   Confidence: ${s.confidence.toFixed(2)}`);
        console.log(`   Reasoning: ${s.reasoning.slice(0, 120)}`);
    }

    hr();

    // ═══════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════
    console.log('\n📋 PIPELINE SUMMARY');
    console.log(`   RSS articles ingested:   ${rssArticles.length}`);
    console.log(`   Events classified:       ${rssEvents.length}`);
    console.log(`   After ticker validation: ${validEvents.length}`);
    console.log(`   After merger:            ${merged.length}`);
    console.log(`   Accepted (gate passed):  ${accepted.length}`);
    console.log(`   MacroSignals emitted:    ${signals.length}`);

    const bearishSignals = signals.filter(s => s.impact === 'bearish');
    const bullishSignals = signals.filter(s => s.impact === 'bullish');
    if (bearishSignals.length > 0) {
        const allBearishTickers = [...new Set(bearishSignals.flatMap(s => s.tickers))];
        console.log(`   BLOCK_BUY tickers:       [${allBearishTickers.join(', ')}]`);
    }
    if (bullishSignals.length > 0) {
        const allBullishTickers = [...new Set(bullishSignals.flatMap(s => s.tickers))];
        console.log(`   BOOST_BUY tickers:       [${allBullishTickers.join(', ')}]`);
    }

    console.log('\n✅ Pipeline test complete.\n');
}

/**
 * Create synthetic ClassifiedEvents from real RSS headlines using keyword matching.
 * This lets us test the full pipeline without Grok API access.
 */
function createSyntheticEvents(articles: RawArticle[]): ClassifiedEvent[] {
    const events: ClassifiedEvent[] = [];
    const seenEventIds = new Set<string>();

    const patterns: Array<{
        keywords: string[];
        event_id: string;
        category: 'known' | 'emergent';
    }> = [
        { keywords: ['oil', 'opec', 'crude', 'barrel', 'petroleum'], event_id: 'oil_supply_shock', category: 'known' },
        { keywords: ['fed', 'rate', 'fomc', 'powell', 'interest rate', 'basis point'], event_id: 'fed_rate_cut', category: 'known' },
        { keywords: ['tariff', 'trade war', 'import duty', 'sanctions'], event_id: 'trade_war_tariffs', category: 'known' },
        { keywords: ['china', 'taiwan', 'beijing', 'xi jinping'], event_id: 'china_taiwan_escalation', category: 'known' },
        { keywords: ['pandemic', 'virus', 'outbreak', 'covid', 'bird flu', 'h5n1', 'who emergency'], event_id: 'pandemic_fear', category: 'known' },
        { keywords: ['drug approval', 'fda', 'clinical trial', 'pharma'], event_id: 'drug_approval_major', category: 'known' },
        { keywords: ['recession', 'gdp contract', 'economic downturn', 'slowdown'], event_id: 'recession_fear', category: 'known' },
        { keywords: ['earnings miss', 'revenue miss', 'profit warning', 'guidance cut'], event_id: 'sector_earnings_miss', category: 'known' },
        { keywords: ['housing', 'mortgage', 'home sales', 'real estate'], event_id: 'housing_slowdown', category: 'known' },
        { keywords: ['natural gas', 'lng', 'gas price', 'pipeline'], event_id: 'gas_price_surge', category: 'known' },
        { keywords: ['airline', 'flight', 'aviation', 'jet fuel'], event_id: 'airline_fuel_shock', category: 'known' },
        { keywords: ['port', 'dock', 'shipping', 'freight', 'supply chain'], event_id: 'port_strike', category: 'known' },
        { keywords: ['consumer confidence', 'spending', 'retail sales'], event_id: 'consumer_confidence_drop', category: 'known' },
        { keywords: ['middle east', 'israel', 'iran', 'gaza', 'conflict'], event_id: 'middle_east_conflict', category: 'known' },
        { keywords: ['chip', 'semiconductor', 'nvidia', 'tsmc', 'ai chip'], event_id: 'tech_antitrust_ruling', category: 'known' },
    ];

    for (const article of articles) {
        const text = `${article.headline} ${article.summary}`.toLowerCase();

        for (const pattern of patterns) {
            const matchCount = pattern.keywords.filter(kw => text.includes(kw)).length;
            // Require 2+ keyword matches to avoid false positives (e.g. "housing" in unrelated article)
            if (matchCount >= 2 && !seenEventIds.has(pattern.event_id)) {
                seenEventIds.add(pattern.event_id);

                const mapping = MACRO_EVENT_MAP[pattern.event_id];
                if (!mapping) continue;

                events.push({
                    event_id: pattern.event_id,
                    category: pattern.category,
                    causal_chain: {
                        immediate: {
                            bearish_tickers: mapping.bearishTickers ?? [],
                            bullish_tickers: mapping.bullishTickers ?? [],
                            reasoning: `Headline match: "${article.headline.slice(0, 80)}"`,
                        },
                        secondary: {
                            recovery_watch_tickers: mapping.bearishTickers?.slice(0, 3) ?? [],
                            watch_after_days: 3,
                            reasoning: 'Recovery watch after initial impact subsides',
                        },
                        resolution_signal: `${pattern.event_id} situation normalizes`,
                    },
                    confidence: Math.min(0.50 + matchCount * 0.15, 0.85),
                    reasoning: `Keyword match (${matchCount} keywords) in "${article.headline.slice(0, 100)}" from ${article.source}`,
                    phase: 'developing',
                    ttl_hours: 48,
                    market_moving: true,
                    source_articles: [article.url],
                });
            }
        }
    }

    return events;
}

main().catch(console.error);
