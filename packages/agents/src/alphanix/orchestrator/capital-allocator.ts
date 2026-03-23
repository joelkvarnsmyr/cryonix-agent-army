// packages/agents/src/alphanix/orchestrator/capital-allocator.ts

export class CapitalAllocator {
  private totalCapital: number;

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
    }
    return budgets;
  }
}
