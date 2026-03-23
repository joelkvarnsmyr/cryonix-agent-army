import type { SwarmRequest, SwarmPriority } from './types';

export class SwarmBudgetManager {
  private maxConcurrentWorkers: number;
  private activeWorkers = 0;
  private queue: Array<{ request: SwarmRequest; resolve: (canRun: boolean) => void }> = [];

  constructor(maxConcurrentWorkers: number) {
    this.maxConcurrentWorkers = maxConcurrentWorkers;
  }

  getActiveWorkers(): number { return this.activeWorkers; }
  getQueueLength(): number { return this.queue.length; }
  getMaxWorkers(): number { return this.maxConcurrentWorkers; }

  canSpawn(workerCount: number): boolean {
    return this.activeWorkers + workerCount <= this.maxConcurrentWorkers;
  }

  reserve(count: number): boolean {
    if (!this.canSpawn(count)) return false;
    this.activeWorkers += count;
    return true;
  }

  release(count: number): void {
    this.activeWorkers = Math.max(0, this.activeWorkers - count);
    this.processQueue();
  }

  async waitForCapacity(request: SwarmRequest): Promise<boolean> {
    if (this.canSpawn(request.workerCount)) {
      return this.reserve(request.workerCount);
    }

    // If critical priority, preempt lower priority work
    if (request.priority === 'critical') {
      // For now, just wait — preemption in Phase 3
    }

    return new Promise<boolean>((resolve) => {
      this.queue.push({ request, resolve });
      // Sort by priority
      this.queue.sort((a, b) => priorityValue(b.request.priority) - priorityValue(a.request.priority));
    });
  }

  private processQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (this.canSpawn(next.request.workerCount)) {
        this.queue.shift();
        this.reserve(next.request.workerCount);
        next.resolve(true);
      } else {
        break;
      }
    }
  }

  getStatus(): { active: number; queued: number; max: number } {
    return { active: this.activeWorkers, queued: this.queue.length, max: this.maxConcurrentWorkers };
  }
}

function priorityValue(p: SwarmPriority): number {
  const values: Record<SwarmPriority, number> = { low: 0, normal: 1, high: 2, critical: 3 };
  return values[p] ?? 0;
}
