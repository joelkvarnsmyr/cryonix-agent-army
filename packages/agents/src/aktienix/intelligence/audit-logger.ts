// packages/agents/src/aktienix/intelligence/audit-logger.ts
import { RespClient } from '../redis-client';

export interface AuditEntry {
    id: string;
    timestamp: string;
    event_id: string;
    sources: string[];
    corroboration: 'confirmed' | 'confirmed_weak' | 'rss_only' | 'social_only' | 'conflicting';
    validation_steps: { step: string; passed: boolean; reason?: string }[];
    final_decision: 'accepted' | 'rejected';
    confidence_raw: number;
    confidence_trust_adjusted: number;
    confidence_corroboration_adjusted: number;
    confidence_final: number;
}

const AUDIT_KEY = 'aktienix:intelligence:audit';
const MAX_ENTRIES = 10_000;

let _counter = 0;
function generateId(): string {
    return `audit_${Date.now()}_${(++_counter).toString(36)}`;
}

export class AuditLogger {
    private redis: RespClient;

    constructor(redisUrl: string) {
        this.redis = new RespClient(redisUrl);
    }

    async log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<string> {
        const full: AuditEntry = {
            ...entry,
            id: generateId(),
            timestamp: new Date().toISOString(),
        };

        if (!this.redis.isConnected()) await this.redis.connect();
        await this.redis.lpush(AUDIT_KEY, JSON.stringify(full));
        await this.redis.ltrim(AUDIT_KEY, 0, MAX_ENTRIES - 1);

        return full.id;
    }
}
