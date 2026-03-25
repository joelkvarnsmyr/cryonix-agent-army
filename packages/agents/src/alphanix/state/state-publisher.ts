import type { PodState, NormalizedPosition } from '../types';
import type { RiskState } from '../pod/risk-agent';

const TTL = 300;

export class AlphanixStatePublisher {
  private redis: any = null;
  private connecting: Promise<void> | null = null;

  constructor(private kvUrl: string) {}

  private async ensureConnected(): Promise<void> {
    if (this.redis?.status === 'ready') return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const Redis = (await import('ioredis')).default;
        this.redis = new Redis(this.kvUrl);
      })().finally(() => { this.connecting = null; });
    }
    await this.connecting;
  }

  async publishOrchestratorState(state: Record<string, any>): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set('alphanix:orchestrator:state', JSON.stringify(state), 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] orchestrator error:', err); }
  }

  async publishPodState(podId: string, state: PodState): Promise<void> {
    try {
      await this.ensureConnected();
      // PodState is a plain string — store without JSON.stringify to avoid double-encoding
      await this.redis.set(`alphanix:pod:${podId}:state`, state, 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] pod state error:', err); }
  }

  async publishPodPositions(podId: string, positions: NormalizedPosition[]): Promise<void> {
    try {
      await this.ensureConnected();
      // Debug: log positions with zero entry price before writing to Redis
      for (const pos of positions) {
        if (!pos.avgEntryPrice || pos.avgEntryPrice <= 0) {
          console.error(`[AlphanixState] WARNING: publishing ${pos.symbol} with avgEntryPrice=${pos.avgEntryPrice} to Redis — this will show $0 on dashboard`);
        }
      }
      await this.redis.set(`alphanix:pod:${podId}:positions`, JSON.stringify(positions), 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] positions error:', err); }
  }

  async publishPodRisk(podId: string, risk: RiskState): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set(`alphanix:pod:${podId}:risk`, JSON.stringify(risk), 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] risk error:', err); }
  }

  async publishHeartbeat(podId: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set(`alphanix:pod:${podId}:heartbeat`, Date.now().toString(), 'EX', 90);
    } catch (err) { console.error('[AlphanixState] heartbeat error:', err); }
  }

  async publishStatus(status: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set('alphanix:status', status, 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] status error:', err); }
  }

  async publishSwarmResult(type: string, data: unknown): Promise<void> {
    try {
      await this.ensureConnected();
      const payload = JSON.stringify({ data, updatedAt: Date.now() });
      await this.redis.set(`alphanix:swarm:${type}`, payload, 'EX', TTL);
    } catch (err) { console.error(`[AlphanixState] swarm ${type} error:`, err); }
  }

  async publishSwarmActive(swarms: Array<{ id: string; type: string; workers: number; runningMs: number }>): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set('alphanix:swarm:active', JSON.stringify(swarms), 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] swarm active error:', err); }
  }

  async disconnect(): Promise<void> {
    try { await this.redis?.quit(); } catch { /* swallow */ }
  }
}
