// packages/agents/src/alphanix/orchestrator/orchestrator.ts

import type { PodState } from '../types';

interface OrchestratorConfig {
  totalCapital: number;
  maxPods: number;
  maxDrawdownPct: number;
}

export class Orchestrator {
  private config: OrchestratorConfig;
  private podStates = new Map<string, PodState>();

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  registerPod(podId: string, state: PodState): void {
    this.podStates.set(podId, state);
  }

  updatePodState(podId: string, state: PodState): void {
    this.podStates.set(podId, state);
  }

  getPodStates(): Record<string, PodState> {
    return Object.fromEntries(this.podStates);
  }

  isGlobalDrawdownBreached(currentDrawdownPct: number): boolean {
    return currentDrawdownPct >= this.config.maxDrawdownPct;
  }

  canAddPod(): boolean {
    return this.podStates.size < this.config.maxPods;
  }
}
