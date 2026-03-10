// packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.ts
import { OpenAI } from 'openai';
import { RespClient } from '../redis-client';
import type { CausalChain } from './macro-classifier-agent';
import type { CorroborationStatus } from './signal-merger';

export interface LiveEvent {
    event_id: string;
    phase: 'detected' | 'developing' | 'resolving' | 'resolved';
    causal_chain: CausalChain;
    sources: string[];
    corroboration: CorroborationStatus;
    confidence: number;
    detectedAt: string;
    expiresAt: string;
    lastEvaluatedAt: string;
    auditIds: string[];
}

const EVENTS_KEY = 'aktienix:macro:event_states';
const DECAY_FACTOR = 0.85;
const RESOLVED_THRESHOLD = 0.30;

export class EventLifecycleTracker {
    private redis: RespClient;
    private grok: OpenAI | null = null;

    constructor(redisUrl: string, xaiApiKey?: string) {
        this.redis = new RespClient(redisUrl);
        if (xaiApiKey) {
            this.grok = new OpenAI({ apiKey: xaiApiKey, baseURL: 'https://api.x.ai/v1' });
        }
    }

    async getAll(): Promise<LiveEvent[]> {
        if (!this.redis.isConnected()) await this.redis.connect();
        const all = await this.redis.hgetall(EVENTS_KEY);
        const now = Date.now();
        return Object.values(all)
            .map(v => { try { return JSON.parse(v) as LiveEvent; } catch { return null; } })
            .filter((e): e is LiveEvent => e !== null)
            .filter(e => new Date(e.expiresAt).getTime() > now);
    }

    async upsertEvent(event: LiveEvent): Promise<void> {
        if (!this.redis.isConnected()) await this.redis.connect();
        await this.redis.hset(EVENTS_KEY, event.event_id, JSON.stringify(event));
    }

    async confirmEvent(event_id: string): Promise<void> {
        const all = await this.getAll();
        const event = all.find(e => e.event_id === event_id);
        if (!event) return;
        if (event.phase === 'detected') {
            event.phase = 'developing';
            event.lastEvaluatedAt = new Date().toISOString();
            await this.upsertEvent(event);
        }
    }

    /** Called every 2 hours. Decays confidence and runs Grok re-evaluation. */
    async reEvaluate(): Promise<void> {
        const events = await this.getAll();
        await Promise.all(events.map(event => this.reEvaluateOne(event)));
    }

    private async reEvaluateOne(event: LiveEvent): Promise<void> {
        if (event.phase === 'resolved') return;

        const newConf = await this.evaluateOne(event);
        event.confidence = newConf;
        event.lastEvaluatedAt = new Date().toISOString();

        if (newConf < RESOLVED_THRESHOLD) {
            event.phase = 'resolved';
        } else if (newConf < 0.55 && event.phase === 'developing') {
            event.phase = 'resolving';
        }

        await this.upsertEvent(event);
    }

    private async evaluateOne(event: LiveEvent): Promise<number> {
        if (!this.grok) return event.confidence * DECAY_FACTOR;

        try {
            const hoursAgo = Math.round(
                (Date.now() - new Date(event.detectedAt).getTime()) / 3_600_000
            );
            const response = await (this.grok.chat.completions.create as any)({
                model: 'grok-3-mini',
                messages: [{
                    role: 'user',
                    content: `Current event: ${event.event_id}
Detected ${hoursAgo} hours ago with confidence ${event.confidence.toFixed(2)}.
Original reasoning: ${event.causal_chain.resolution_signal}

Search X and recent news for evidence of this event status.
Is it still developing, starting to resolve, or over?

Return JSON only: { "phase": "developing"|"resolving"|"resolved", "evidence": "...", "confidence": 0.0-1.0 }`,
                }],
                temperature: 0.1,
                search: { mode: 'on' },
            } as any);

            const content = response.choices[0]?.message?.content ?? '';
            const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '{}');

            if (parsed.phase === 'resolved') return 0.20; // force below threshold
            if (parsed.phase === 'resolving') return Math.min(event.confidence * 0.85, parsed.confidence ?? 0.45);
            return parsed.confidence ?? event.confidence;
        } catch {
            // API failed — apply decay passively
            return event.confidence * DECAY_FACTOR;
        }
    }
}
