import type { SwarmRequest, SwarmResult, SwarmType, SwarmWorkerTask, SwarmWorkerResult } from './types';
import { SwarmBudgetManager } from './swarm-budget-manager';

type WorkerFn = (task: SwarmWorkerTask) => Promise<SwarmWorkerResult>;

export class SwarmSpawner {
  private budget: SwarmBudgetManager;
  private workers = new Map<SwarmType, WorkerFn>();
  private activeSwarms = new Map<string, { request: SwarmRequest; startedAt: number }>();

  constructor(maxWorkers: number) {
    this.budget = new SwarmBudgetManager(maxWorkers);
  }

  registerWorker(type: SwarmType, fn: WorkerFn): void {
    this.workers.set(type, fn);
  }

  async spawn(request: SwarmRequest): Promise<SwarmResult> {
    const worker = this.workers.get(request.type);
    if (!worker) {
      return {
        requestId: request.id, status: 'failed', data: null,
        workersUsed: 0, durationMs: 0, errors: [`No worker registered for type: ${request.type}`],
      };
    }

    const canRun = await this.budget.waitForCapacity(request);
    if (!canRun) {
      return {
        requestId: request.id, status: 'failed', data: null,
        workersUsed: 0, durationMs: 0, errors: ['Could not acquire worker capacity'],
      };
    }

    this.activeSwarms.set(request.id, { request, startedAt: Date.now() });
    const startTime = Date.now();
    const results: SwarmWorkerResult[] = [];
    const errors: string[] = [];

    try {
      // Spawn N workers in parallel
      const tasks: SwarmWorkerTask[] = Array.from({ length: request.workerCount }, (_, i) => ({
        id: `${request.id}-w${i}`,
        swarmId: request.id,
        type: request.type,
        params: { ...request.params, workerIndex: i, totalWorkers: request.workerCount },
      }));

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Swarm timeout')), request.maxDuration)
      );

      const work = Promise.all(tasks.map(t => worker(t).catch(err => ({
        taskId: t.id, success: false, data: null, error: err.message, durationMs: 0,
      } as SwarmWorkerResult))));

      const workerResults = await Promise.race([work, timeout]) as SwarmWorkerResult[];
      results.push(...workerResults);

      for (const r of workerResults) {
        if (!r.success && r.error) errors.push(r.error);
      }
    } catch (err: any) {
      errors.push(err.message);
    } finally {
      this.budget.release(request.workerCount);
      this.activeSwarms.delete(request.id);
    }

    return {
      requestId: request.id,
      status: errors.length > 0 && results.every(r => !r.success) ? 'failed' : 'completed',
      data: results.filter(r => r.success).map(r => r.data),
      workersUsed: request.workerCount,
      durationMs: Date.now() - startTime,
      errors,
    };
  }

  getActiveSwarms(): Array<{ id: string; type: SwarmType; workers: number; runningMs: number }> {
    return Array.from(this.activeSwarms.entries()).map(([id, s]) => ({
      id, type: s.request.type, workers: s.request.workerCount,
      runningMs: Date.now() - s.startedAt,
    }));
  }

  getBudgetStatus() { return this.budget.getStatus(); }
}
