// packages/agents/src/alphanix/__tests__/orchestrator.test.ts

import { describe, it, expect } from 'vitest';
import { CapitalAllocator } from '../orchestrator/capital-allocator';
import { Orchestrator } from '../orchestrator/orchestrator';

describe('CapitalAllocator', () => {
  it('should allocate capital by percentage', () => {
    const allocator = new CapitalAllocator(10_000);
    const budgets = allocator.allocate({ crypto: 60, stocks: 40 });
    expect(budgets).toEqual({ crypto: 6000, stocks: 4000 });
  });

  it('should handle single pod at 100%', () => {
    const allocator = new CapitalAllocator(5000);
    const budgets = allocator.allocate({ solo: 100 });
    expect(budgets).toEqual({ solo: 5000 });
  });

  it('should cap at total capital when >100% requested', () => {
    const allocator = new CapitalAllocator(10_000);
    const budgets = allocator.allocate({ a: 80, b: 80 });
    // 80+80=160, scale=100/160=0.625 -> a=5000, b=5000
    expect(budgets.a + budgets.b).toBeLessThanOrEqual(10_000);
    expect(budgets.a).toBe(5000);
    expect(budgets.b).toBe(5000);
  });
});

describe('Orchestrator', () => {
  it('should track pod states', () => {
    const orch = new Orchestrator({ totalCapital: 10_000, maxPods: 5, maxDrawdownPct: 5 });
    orch.registerPod('crypto-1', 'running');
    orch.registerPod('stock-1', 'paused');
    expect(orch.getPodStates()).toEqual({ 'crypto-1': 'running', 'stock-1': 'paused' });
  });

  it('should detect global drawdown breach', () => {
    const orch = new Orchestrator({ totalCapital: 10_000, maxPods: 5, maxDrawdownPct: 5 });
    expect(orch.isGlobalDrawdownBreached(4.9)).toBe(false);
    expect(orch.isGlobalDrawdownBreached(5.0)).toBe(true);
    expect(orch.isGlobalDrawdownBreached(5.1)).toBe(true);
  });

  it('should respect maxPods limit', () => {
    const orch = new Orchestrator({ totalCapital: 10_000, maxPods: 2, maxDrawdownPct: 5 });
    expect(orch.canAddPod()).toBe(true);
    orch.registerPod('pod-1', 'running');
    expect(orch.canAddPod()).toBe(true);
    orch.registerPod('pod-2', 'running');
    expect(orch.canAddPod()).toBe(false);
  });
});
