// packages/agents/src/aktienix/intelligence/macro-intelligence.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MacroIntelligence } from './macro-intelligence';

// Mock all sub-modules
vi.mock('./news-ingestion-service', () => ({
    NewsIngestionService: vi.fn(function() {
        return { scanAll: vi.fn().mockResolvedValue([]) };
    }),
}));
vi.mock('./x-ingestion-service', () => ({
    XIngestionService: vi.fn(function() {
        return { scan: vi.fn().mockResolvedValue([]) };
    }),
}));
vi.mock('./macro-classifier-agent', () => ({
    MacroClassifierAgent: vi.fn(function() {
        return { classify: vi.fn().mockResolvedValue([]) };
    }),
}));
vi.mock('./signal-merger', () => ({
    SignalMerger: vi.fn(function() {
        return { merge: vi.fn().mockReturnValue([]) };
    }),
}));
vi.mock('./event-lifecycle-tracker', () => ({
    EventLifecycleTracker: vi.fn(function() {
        return {
            getAll: vi.fn().mockResolvedValue([]),
            upsertEvent: vi.fn().mockResolvedValue(undefined),
            confirmEvent: vi.fn().mockResolvedValue(undefined),
            reEvaluate: vi.fn().mockResolvedValue(undefined),
        };
    }),
}));
vi.mock('./causal-chain-engine', () => ({
    CausalChainEngine: vi.fn(function() {
        return { toMacroSignals: vi.fn().mockReturnValue([]) };
    }),
}));
vi.mock('./audit-logger', () => ({
    AuditLogger: vi.fn(function() {
        return { log: vi.fn().mockResolvedValue('audit_123') };
    }),
}));

describe('MacroIntelligence', () => {
    let intel: MacroIntelligence;

    beforeEach(() => {
        vi.clearAllMocks();
        intel = new MacroIntelligence('redis://localhost:6379', 'xai-key');
    });

    it('getLiveSignals returns empty array when no active events', async () => {
        const signals = await intel.getLiveSignals();
        expect(signals).toEqual([]);
    });

    it('runIntelligenceCycle completes without throwing', async () => {
        await expect(intel.runIntelligenceCycle()).resolves.not.toThrow();
    });
});
