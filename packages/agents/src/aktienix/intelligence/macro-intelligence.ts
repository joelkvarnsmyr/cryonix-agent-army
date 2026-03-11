// packages/agents/src/aktienix/intelligence/macro-intelligence.ts
import { NewsIngestionService } from './news-ingestion-service';
import { XIngestionService } from './x-ingestion-service';
import { MacroClassifierAgent } from './macro-classifier-agent';
import { SignalMerger } from './signal-merger';
import { EventLifecycleTracker, LiveEvent } from './event-lifecycle-tracker';
import { CausalChainEngine } from './causal-chain-engine';
import { AuditLogger } from './audit-logger';
import { filterValidTickers } from './ticker-universe';
import type { MacroSignal } from './news-scanner';
import type { MergedSignal } from './signal-merger';

const CONFIDENCE_THRESHOLDS = {
    known_confirmed: 0.50,
    known_confirmed_weak: 0.50,
    known_rss_only: 0.50,
    known_social_only: 0.60,
    emergent_confirmed: 0.75,
    emergent_other: 0.80,
    any_conflicting: 0.85,
} as const;

export class MacroIntelligence {
    private rss: NewsIngestionService;
    private x: XIngestionService;
    private classifier: MacroClassifierAgent;
    private merger: SignalMerger;
    private lifecycle: EventLifecycleTracker;
    private engine: CausalChainEngine;
    private audit: AuditLogger;
    private lastReEvalAt = 0;
    private readonly RE_EVAL_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

    constructor(redisUrl: string, xaiApiKey: string) {
        this.rss = new NewsIngestionService();
        this.x = new XIngestionService(xaiApiKey);
        this.classifier = new MacroClassifierAgent(xaiApiKey);
        this.merger = new SignalMerger();
        this.lifecycle = new EventLifecycleTracker(redisUrl, xaiApiKey);
        this.engine = new CausalChainEngine();
        this.audit = new AuditLogger(redisUrl);
    }

    /**
     * Returns MacroSignal[] for current active events.
     * Fast path — reads from Redis, no Grok calls.
     * Called every poll cycle by AktienixAgent.
     */
    async getLiveSignals(): Promise<MacroSignal[]> {
        const events = await this.lifecycle.getAll();
        return this.engine.toMacroSignals(events);
    }

    /**
     * Full ingestion → classify → merge → validate → store pipeline.
     * Expensive (Grok calls). Called every 15min by AktienixAgent's signal scan timer.
     */
    async runIntelligenceCycle(): Promise<void> {
        try {
            // 1. Ingest from both pipelines in parallel
            const [rssArticles, xArticles] = await Promise.all([
                this.rss.scanAll(),
                this.x.scan(),
            ]);

            // 2. Classify each pipeline separately
            const [rssEvents, xEvents] = await Promise.all([
                this.classifier.classify(rssArticles),
                this.classifier.classify(xArticles),
            ]);

            // 3. Cross-validate
            const merged = this.merger.merge(rssEvents, xEvents);

            // 4. Validate and store accepted events
            for (const signal of merged) {
                await this.validateAndStore(signal);
            }

            // 5. Re-evaluate existing events every 2 hours
            if (Date.now() - this.lastReEvalAt > this.RE_EVAL_INTERVAL_MS) {
                await this.lifecycle.reEvaluate();
                this.lastReEvalAt = Date.now();
            }
        } catch (err) {
            console.error('[MACRO INTELLIGENCE] Cycle error:', err);
        }
    }

    private async validateAndStore(signal: MergedSignal): Promise<void> {
        const steps: { step: string; passed: boolean; reason?: string }[] = [];

        // Step 1: Ticker universe — filter causal_chain tickers against known universe
        const rawBearish = signal.causal_chain?.immediate?.bearish_tickers ?? [];
        const rawBullish = signal.causal_chain?.immediate?.bullish_tickers ?? [];
        const filteredBearish = filterValidTickers(rawBearish);
        const filteredBullish = filterValidTickers(rawBullish);

        const tickersPassed = filteredBearish.length > 0 || filteredBullish.length > 0;
        steps.push({
            step: 'ticker_universe',
            passed: tickersPassed,
            reason: tickersPassed
                ? undefined
                : `All tickers invalid — bearish: [${rawBearish.join(', ')}], bullish: [${rawBullish.join(', ')}]`,
        });

        if (!tickersPassed) {
            await this.audit.log({
                event_id: signal.event_id,
                sources: signal.sources,
                corroboration: signal.corroboration,
                validation_steps: steps,
                final_decision: 'rejected',
                confidence_raw: signal.confidence,
                confidence_trust_adjusted: signal.confidence,
                confidence_corroboration_adjusted: signal.confidence,
                confidence_final: signal.confidence,
            });
            return;
        }

        // Replace with filtered tickers so downstream only sees validated ones
        signal.causal_chain.immediate.bearish_tickers = filteredBearish;
        signal.causal_chain.immediate.bullish_tickers = filteredBullish;

        // Step 2: Source trust multiplier
        // MergedSignal doesn't carry sourceTrust — infer from corroboration:
        // confirmed/confirmed_weak means tier1 sources corroborated, rss_only likely tier1 RSS,
        // social_only is tier2. Default to tier2 for safety.
        const trustMultiplier = signal.corroboration === 'confirmed' ? 1.0
            : signal.corroboration === 'confirmed_weak' ? 0.95
            : signal.corroboration === 'rss_only' ? 0.90
            : 0.80; // social_only or conflicting
        const confAfterTrust = signal.confidence * trustMultiplier;
        steps.push({ step: 'source_trust', passed: true });

        // Step 3: Cross-validation delta (clamped to 1.0)
        const confAfterDelta = Math.min(confAfterTrust + signal.confidence_delta, 1.0);
        steps.push({ step: 'cross_validation', passed: true });

        // Step 4: Confidence gate
        const key = `${signal.category}_${signal.corroboration}` as keyof typeof CONFIDENCE_THRESHOLDS;
        const conflicting = signal.corroboration === 'conflicting';
        const threshold = conflicting
            ? CONFIDENCE_THRESHOLDS.any_conflicting
            : (CONFIDENCE_THRESHOLDS[key] ?? CONFIDENCE_THRESHOLDS.emergent_other);

        const passed = confAfterDelta >= threshold;
        steps.push({ step: 'confidence_gate', passed, reason: passed ? undefined : `${confAfterDelta.toFixed(2)} < ${threshold}` });

        const auditId = await this.audit.log({
            event_id: signal.event_id,
            sources: signal.sources,
            corroboration: signal.corroboration,
            validation_steps: steps,
            final_decision: passed ? 'accepted' : 'rejected',
            confidence_raw: signal.confidence,
            confidence_trust_adjusted: confAfterTrust,
            confidence_corroboration_adjusted: confAfterDelta,
            confidence_final: confAfterDelta,
        });

        if (!passed) return;

        // Store as LiveEvent
        const now = new Date();
        const ttlHours = signal.ttl_hours ?? 48;
        const event: LiveEvent = {
            event_id: signal.event_id,
            phase: 'detected',
            causal_chain: signal.causal_chain,
            sources: signal.sources,
            corroboration: signal.corroboration,
            confidence: confAfterDelta,
            detectedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + ttlHours * 3_600_000).toISOString(),
            lastEvaluatedAt: now.toISOString(),
            auditIds: [auditId],
        };

        // Check if we already have this event — if so, confirm it (detected → developing)
        const existing = (await this.lifecycle.getAll()).find(e => e.event_id === signal.event_id);
        if (existing) {
            await this.lifecycle.confirmEvent(signal.event_id);
        } else {
            await this.lifecycle.upsertEvent(event);
        }
    }
}
