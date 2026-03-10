// scripts/aktienix/test-macro-intelligence.ts
/**
 * End-to-end smoke test for the Macro Intelligence v2 pipeline.
 * Uses mock articles — no real API calls unless XAI_API_KEY is set.
 *
 * Run: npx tsx scripts/aktienix/test-macro-intelligence.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });

import { MacroClassifierAgent } from '../../packages/agents/src/aktienix/intelligence/macro-classifier-agent';
import { SignalMerger } from '../../packages/agents/src/aktienix/intelligence/signal-merger';
import { CausalChainEngine } from '../../packages/agents/src/aktienix/intelligence/causal-chain-engine';
import { isValidTicker } from '../../packages/agents/src/aktienix/intelligence/ticker-universe';
import type { RawArticle } from '../../packages/agents/src/aktienix/intelligence/news-ingestion-service';
import type { LiveEvent } from '../../packages/agents/src/aktienix/intelligence/event-lifecycle-tracker';

const MOCK_RSS_ARTICLES: RawArticle[] = [
    {
        url: 'https://reuters.com/test/opec-cut',
        urlHash: 'abc1',
        headline: 'OPEC unexpectedly cuts oil production by 1.5M barrels per day',
        summary: 'Saudi Arabia led an OPEC+ agreement to cut output amid falling prices and weak demand.',
        source: 'reuters',
        sourceTrust: 'tier1',
        domain: 'energy',
        publishedAt: new Date(),
        pipeline: 'rss',
    },
];

const MOCK_X_ARTICLES: RawArticle[] = [
    {
        url: 'https://x.com/WalterBloomberg/status/123',
        urlHash: 'xyz1',
        headline: 'BREAKING: OPEC cuts 1.5M bpd — oil surges 4% on the news',
        summary: 'WalterBloomberg: OPEC announced surprise production cut. $XOM $CVX up premarket.',
        source: 'x_@WalterBloomberg',
        sourceTrust: 'tier1',
        domain: 'social',
        publishedAt: new Date(),
        pipeline: 'x',
    },
];

async function main() {
    console.log('===========================================');
    console.log('  Aktienix Macro Intelligence v2 Smoke Test');
    console.log('===========================================\n');

    const apiKey = process.env.XAI_API_KEY ?? '';
    if (!apiKey) {
        console.log('⚠️  No XAI_API_KEY found — using mock articles without LLM call\n');
    }

    // Step 1: Ticker universe check
    console.log('✅ Ticker Universe:');
    const testTickers = ['XOM', 'UAL', 'FAKE_CO', 'CVX', 'AAPL'];
    for (const t of testTickers) {
        console.log(`   ${isValidTicker(t) ? '✅' : '❌'} ${t}`);
    }
    console.log('');

    // Step 2: Classifier (if API key available)
    const classifier = new MacroClassifierAgent(apiKey);
    const merger = new SignalMerger();
    const engine = new CausalChainEngine();

    let rssEvents: any[] = [];
    let xEvents: any[] = [];

    if (apiKey) {
        console.log('📡 Running classifier against mock articles...\n');
        [rssEvents, xEvents] = await Promise.all([
            classifier.classify(MOCK_RSS_ARTICLES),
            classifier.classify(MOCK_X_ARTICLES),
        ]);
        console.log(`   RSS events classified: ${rssEvents.length}`);
        console.log(`   X events classified: ${xEvents.length}\n`);
    } else {
        // Inject fake classified event for smoke testing the merger + engine
        rssEvents = [{
            event_id: 'oil_supply_shock', category: 'known',
            causal_chain: {
                immediate: { bearish_tickers: ['UAL', 'DAL'], bullish_tickers: ['XOM', 'CVX'], reasoning: 'oil spike' },
                secondary: { recovery_watch_tickers: ['UAL'], watch_after_days: 4, reasoning: 'recovery' },
                resolution_signal: 'WTI falls',
            },
            confidence: 0.82, reasoning: 'OPEC cut 1.5M bpd', phase: 'developing',
            ttl_hours: 96, market_moving: true, source_articles: [MOCK_RSS_ARTICLES[0].url],
        }];
        xEvents = [{ ...rssEvents[0], source_articles: [MOCK_X_ARTICLES[0].url] }];
    }

    // Step 3: Merge
    const merged = merger.merge(rssEvents, xEvents);
    console.log(`🔗 Signal Merger:`);
    for (const s of merged) {
        console.log(`   ${s.event_id}: ${s.corroboration} (conf ${s.confidence.toFixed(2)}, delta ${s.confidence_delta >= 0 ? '+' : ''}${s.confidence_delta})`);
    }
    console.log('');

    // Step 4: Causal chain engine
    const fakeEvents: LiveEvent[] = merged.map(s => ({
        event_id: s.event_id,
        phase: 'developing' as const,
        causal_chain: s.causal_chain,
        sources: s.sources,
        corroboration: s.corroboration,
        confidence: s.confidence + s.confidence_delta,
        detectedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 96 * 3600_000).toISOString(),
        lastEvaluatedAt: new Date().toISOString(),
        auditIds: [],
    }));

    const macroSignals = engine.toMacroSignals(fakeEvents);
    console.log(`🎯 MacroSignals emitted: ${macroSignals.length}`);
    for (const s of macroSignals) {
        const dir = s.impact === 'bullish' ? '🟢 BULLISH' : s.impact === 'bearish' ? '🔴 BEARISH' : '🟡 NEUTRAL';
        console.log(`   ${dir} [${s.event}] conf=${(s.confidence * 100).toFixed(0)}% tickers=${s.tickers.join(', ')}`);
    }

    console.log('\n✅ Smoke test complete.');
}

main().catch(console.error);
