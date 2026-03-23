import { describe, it, expect } from 'vitest';
import { SwarmBudgetManager } from '../swarms/swarm-budget-manager';
import { SwarmSpawner } from '../swarms/swarm-spawner';
import type { SwarmRequest, SwarmWorkerTask } from '../swarms/types';

describe('SwarmBudgetManager', () => {
  it('should track active workers', () => {
    const budget = new SwarmBudgetManager(5);
    expect(budget.canSpawn(3)).toBe(true);
    budget.reserve(3);
    expect(budget.getActiveWorkers()).toBe(3);
    expect(budget.canSpawn(3)).toBe(false);
    expect(budget.canSpawn(2)).toBe(true);
  });

  it('should release workers', () => {
    const budget = new SwarmBudgetManager(5);
    budget.reserve(5);
    expect(budget.canSpawn(1)).toBe(false);
    budget.release(3);
    expect(budget.canSpawn(3)).toBe(true);
  });
});

describe('SwarmSpawner', () => {
  const makeRequest = (overrides: Partial<SwarmRequest> = {}): SwarmRequest => ({
    id: 'swarm-1', type: 'macro', requester: { podId: 'crypto', role: 'quant' },
    task: 'Fetch FRED data', params: {}, workerCount: 2, maxDuration: 5000, priority: 'normal',
    ...overrides,
  });

  it('should fail if no worker registered for type', async () => {
    const spawner = new SwarmSpawner(5);
    const result = await spawner.spawn(makeRequest());
    expect(result.status).toBe('failed');
    expect(result.errors[0]).toContain('No worker registered');
  });

  it('should run workers and collect results', async () => {
    const spawner = new SwarmSpawner(5);
    spawner.registerWorker('macro', async (task: SwarmWorkerTask) => ({
      taskId: task.id, success: true, data: { gdp: 3.2 }, durationMs: 10,
    }));
    const result = await spawner.spawn(makeRequest());
    expect(result.status).toBe('completed');
    expect(result.workersUsed).toBe(2);
    expect((result.data as any[]).length).toBe(2);
  });

  it('should timeout slow workers', async () => {
    const spawner = new SwarmSpawner(5);
    spawner.registerWorker('macro', async () => {
      await new Promise(r => setTimeout(r, 10000));  // 10s — will timeout
      return { taskId: 'x', success: true, data: null, durationMs: 0 };
    });
    const result = await spawner.spawn(makeRequest({ maxDuration: 100 }));
    expect(result.errors.length).toBeGreaterThan(0);
  }, 5000);

  it('should track active swarms', async () => {
    const spawner = new SwarmSpawner(5);
    spawner.registerWorker('macro', async () => {
      await new Promise(r => setTimeout(r, 200));
      return { taskId: 'x', success: true, data: null, durationMs: 200 };
    });
    const promise = spawner.spawn(makeRequest());
    // Check while running
    await new Promise(r => setTimeout(r, 50));
    const active = spawner.getActiveSwarms();
    expect(active.length).toBe(1);
    expect(active[0].type).toBe('macro');
    await promise;
  });

  it('should report budget status', () => {
    const spawner = new SwarmSpawner(5);
    const status = spawner.getBudgetStatus();
    expect(status.max).toBe(5);
    expect(status.active).toBe(0);
  });
});
