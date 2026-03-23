import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import { loadAlphanixConfig, resetAlphanixConfig, toPodConfig, type AlphanixTomlConfig } from './config';
import { AdapterRegistry } from './adapters/adapter-registry';
import { BinanceAdapter } from './adapters/binance-adapter';
import { Orchestrator } from './orchestrator/orchestrator';
import { CapitalAllocator } from './orchestrator/capital-allocator';
import { Pod } from './pod/pod';
import { AlphanixStatePublisher } from './state/state-publisher';

export class AlphanixAgent extends BaseAgent {
  private toml!: AlphanixTomlConfig;
  private registry = new AdapterRegistry();
  private orchestrator!: Orchestrator;
  private allocator!: CapitalAllocator;
  private pods = new Map<string, Pod>();
  private publisher: AlphanixStatePublisher | null = null;
  private running = false;

  async initialize(): Promise<void> {
    this.log('info', 'Initializing Alphanix...');

    resetAlphanixConfig();
    this.toml = loadAlphanixConfig();

    this.orchestrator = new Orchestrator({
      totalCapital: this.toml.orchestrator.capital_total_usd,
      maxPods: this.toml.orchestrator.max_pods,
      maxDrawdownPct: this.toml.orchestrator.global_max_drawdown_pct,
    });
    this.allocator = new CapitalAllocator(this.toml.orchestrator.capital_total_usd);

    // Register adapters
    this.registry.register(new BinanceAdapter({ paper: true }));

    // Connect adapters (non-fatal if fails)
    try {
      await this.registry.connectAll();
    } catch (err) {
      this.log('warn', 'Some adapters failed to connect', { error: String(err) });
    }

    // State publisher (requires Redis)
    const kvUrl = process.env.KV_URL;
    if (kvUrl) {
      this.publisher = new AlphanixStatePublisher(kvUrl);
    }

    // Build enabled-pod map for capital allocation
    const enabledPods: Record<string, number> = {};
    for (const [id, podToml] of Object.entries(this.toml.pods)) {
      if (!podToml.enabled) continue;
      const adapter = this.registry.get(podToml.adapter);
      if (!adapter) {
        this.log('warn', `Pod ${id}: adapter "${podToml.adapter}" not found, skipping`);
        continue;
      }
      enabledPods[id] = podToml.capital_pct;
    }

    // Allocate capital and create Pod instances
    const budgets = this.allocator.allocate(enabledPods);
    for (const [id, podToml] of Object.entries(this.toml.pods)) {
      if (!podToml.enabled || !budgets[id]) continue;
      const adapter = this.registry.get(podToml.adapter)!;
      const config = toPodConfig(id, podToml);
      const pod = new Pod(config, adapter, budgets[id]);
      this.pods.set(id, pod);
      this.orchestrator.registerPod(id, 'starting');
      this.log('info', `Pod created: ${id} ($${budgets[id]})`);
    }

    this.log('info', `Alphanix initialized: ${this.pods.size} pod(s)`);
  }

  async start(): Promise<void> {
    this.running = true;
    this.setStatus('active');
    await this.publisher?.publishStatus('running');
    this.log('info', 'Alphanix started');

    while (this.running) {
      for (const [id, pod] of this.pods) {
        try {
          const result = await pod.runCycle();
          this.orchestrator.updatePodState(id, 'running');
          await this.publisher?.publishPodState(id, 'running');
          await this.publisher?.publishHeartbeat(id);
          if (result.executed > 0) {
            this.log('info', `Pod ${id}: ${result.executed} trade(s)`, result);
          }
        } catch (err: any) {
          this.log('error', `Pod ${id} error: ${err.message}`);
          this.orchestrator.updatePodState(id, 'error');
        }
      }

      await this.publisher?.publishOrchestratorState({
        pods: this.orchestrator.getPodStates(),
        totalCapital: this.allocator.getTotalCapital(),
        timestamp: Date.now(),
      });

      await this.sleep(this.toml.timing.orchestrator_loop_ms);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const [, pod] of this.pods) await pod.stop();
    await this.registry.disconnectAll();
    await this.publisher?.publishStatus('stopped');
    await this.publisher?.disconnect();
    this.setStatus('paused');
    this.log('info', 'Alphanix stopped');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', `Message: ${message.message_type}`, message.data);
  }
}
