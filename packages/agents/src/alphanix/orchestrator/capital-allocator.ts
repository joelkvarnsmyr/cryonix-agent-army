// packages/agents/src/alphanix/orchestrator/capital-allocator.ts

export interface PodPerformance {
  podId: string;
  returns: number[];        // array of per-position PnL %
  currentBudget: number;
}

export interface RebalanceResult {
  podId: string;
  oldBudget: number;
  newBudget: number;
  score: number;
}

export class CapitalAllocator {
  private totalCapital: number;
  private baseBudgets = new Map<string, number>();

  constructor(totalCapital: number) {
    this.totalCapital = totalCapital;
  }

  setTotalCapital(amount: number): void {
    this.totalCapital = amount;
  }

  getTotalCapital(): number {
    return this.totalCapital;
  }

  allocate(percentages: Record<string, number>): Record<string, number> {
    const total = Object.values(percentages).reduce((s, v) => s + v, 0);
    const scale = total > 100 ? 100 / total : 1;
    const budgets: Record<string, number> = {};
    for (const [podId, pct] of Object.entries(percentages)) {
      budgets[podId] = Math.floor(this.totalCapital * (pct * scale) / 100);
      this.baseBudgets.set(podId, budgets[podId]);
    }
    return budgets;
  }

  getBaseBudget(podId: string): number {
    return this.baseBudgets.get(podId) ?? 0;
  }

  /**
   * Performance-based capital rebalancing.
   * Shifts capital from losers to winners using Sharpe-ratio-like scoring.
   * Total capital stays constant. Caps at 0.5x–2x base allocation.
   */
  rebalance(pods: PodPerformance[]): RebalanceResult[] {
    if (pods.length === 0) return [];

    // Score each pod: Sharpe approximation (mean/std), or -1 for losers, 0 for no data
    const scored = pods.map(p => {
      const base = this.baseBudgets.get(p.podId) ?? p.currentBudget;
      if (p.returns.length === 0) return { ...p, score: 0, base };

      const mean = p.returns.reduce((a, b) => a + b, 0) / p.returns.length;
      if (mean < 0) return { ...p, score: -1, base };

      const variance = p.returns.reduce((a, r) => a + (r - mean) ** 2, 0) / p.returns.length;
      const std = Math.sqrt(variance);
      const score = std > 0 ? mean / std : (mean > 0 ? 1 : 0);
      return { ...p, score, base };
    });

    // Normalize scores to multipliers: map [-1, max] → [0.5, 2.0]
    const minScore = Math.min(...scored.map(s => s.score));
    const maxScore = Math.max(...scored.map(s => s.score));
    const range = maxScore - minScore;

    const multipliers = scored.map(s => {
      if (range === 0) return { ...s, mult: 1.0 };
      const normalized = (s.score - minScore) / range;  // 0..1
      const mult = 0.5 + normalized * 1.5;              // 0.5..2.0
      return { ...s, mult };
    });

    // Compute raw budgets, then scale to keep total constant
    const rawBudgets = multipliers.map(m => m.base * m.mult);
    const rawTotal = rawBudgets.reduce((a, b) => a + b, 0);
    const scaleFactor = rawTotal > 0 ? this.totalCapital / rawTotal : 1;

    // Clamp each pod to [0.5x, 2x] base after scaling
    const results: RebalanceResult[] = multipliers.map((m, i) => {
      let newBudget = Math.round(rawBudgets[i] * scaleFactor);
      newBudget = Math.max(Math.round(m.base * 0.5), Math.min(Math.round(m.base * 2), newBudget));
      return {
        podId: m.podId,
        oldBudget: m.currentBudget,
        newBudget,
        score: Math.round(m.score * 100) / 100,
      };
    });

    // Final normalization: adjust proportionally so sum === totalCapital
    const clampedTotal = results.reduce((a, r) => a + r.newBudget, 0);
    if (clampedTotal > 0 && clampedTotal !== this.totalCapital) {
      const adjust = this.totalCapital / clampedTotal;
      for (const r of results) {
        r.newBudget = Math.round(r.newBudget * adjust);
      }
    }

    return results;
  }
}
