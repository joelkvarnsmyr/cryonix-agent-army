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
      await this.redis.set(`alphanix:pod:${podId}:state`, JSON.stringify(state), 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] pod state error:', err); }
  }

  async publishPodPositions(podId: string, positions: NormalizedPosition[]): Promise<void> {
    try {
      await this.ensureConnected();
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

  async disconnect(): Promise<void> {
    try { await this.redis?.quit(); } catch { /* swallow */ }
  }
}
