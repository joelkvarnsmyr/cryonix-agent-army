import type { MarketAdapter } from './types';

export class AdapterRegistry {
  private adapters = new Map<string, MarketAdapter>();

  register(adapter: MarketAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): MarketAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }

  async connectAll(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      try {
        await adapter.connect();
        console.info(`[AdapterRegistry] Connected: ${id}`);
      } catch (err) {
        console.error(`[AdapterRegistry] Failed to connect ${id}:`, err);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      try { await adapter.disconnect(); } catch { /* swallow */ }
    }
  }

  async healthCheckAll(): Promise<Record<string, { connected: boolean; latencyMs: number }>> {
    const results: Record<string, { connected: boolean; latencyMs: number }> = {};
    for (const [id, adapter] of this.adapters) {
      try {
        results[id] = await adapter.healthCheck();
      } catch {
        results[id] = { connected: false, latencyMs: -1 };
      }
    }
    return results;
  }
}
