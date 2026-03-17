/**
 * BayesianWeightTracker — Adaptive signal source weighting.
 * Each source has a "reliability" posterior starting at prior=0.5.
 * After each trade, sources that aligned with profitable direction get boosted.
 * Uses exponential moving Bayesian update with decay.
 */

interface SourceState {
    posterior: number;   // Current reliability (0-1)
    hits: number;        // Correct predictions
    misses: number;      // Wrong predictions
    lastUpdate: number;  // Timestamp
}

export class BayesianWeightTracker {
    private sources = new Map<string, SourceState>();
    private decay: number;
    private prior = 0.5;
    private minWeight = 0.1;
    private maxWeight = 0.95;

    constructor(decay: number = 0.92) {
        this.decay = decay;
    }

    getWeight(sourceId: string): number {
        return this.sources.get(sourceId)?.posterior ?? this.prior;
    }

    update(sourceId: string, direction: number, profitable: boolean): void {
        const state = this.sources.get(sourceId) ?? {
            posterior: this.prior, hits: 0, misses: 0, lastUpdate: Date.now(),
        };

        const magnitude = Math.abs(direction);
        const likelihood = profitable ? 0.5 + 0.5 * magnitude : 0.5 - 0.5 * magnitude;

        state.posterior = this.decay * state.posterior + (1 - this.decay) * likelihood;
        state.posterior = Math.max(this.minWeight, Math.min(this.maxWeight, state.posterior));

        if (profitable) state.hits++;
        else state.misses++;

        state.lastUpdate = Date.now();
        this.sources.set(sourceId, state);
    }

    getAll(): Map<string, number> {
        const result = new Map<string, number>();
        for (const [id, state] of this.sources) {
            result.set(id, state.posterior);
        }
        return result;
    }

    serialize(): string {
        const data: Record<string, SourceState> = {};
        for (const [id, state] of this.sources) {
            data[id] = state;
        }
        return JSON.stringify(data);
    }

    static deserialize(json: string, decay?: number): BayesianWeightTracker {
        const tracker = new BayesianWeightTracker(decay);
        try {
            const data = JSON.parse(json) as Record<string, SourceState>;
            for (const [id, state] of Object.entries(data)) {
                tracker.sources.set(id, state);
            }
        } catch { /* ignore invalid JSON, start fresh */ }
        return tracker;
    }
}
