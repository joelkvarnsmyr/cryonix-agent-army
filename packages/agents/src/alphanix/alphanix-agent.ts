import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import { loadAlphanixConfig, resetAlphanixConfig, toPodConfig, type AlphanixTomlConfig } from './config';
import { AdapterRegistry } from './adapters/adapter-registry';
import { BinanceAdapter } from './adapters/binance-adapter';
import { AlpacaAdapter } from './adapters/alpaca-adapter';
import { Orchestrator } from './orchestrator/orchestrator';
import { CapitalAllocator } from './orchestrator/capital-allocator';
import { Pod } from './pod/pod';
import { AlphanixStatePublisher } from './state/state-publisher';
import { AlphanixDB } from './data/postgres';
import { ScheduleManager } from './orchestrator/schedule-manager';
import { SwarmSpawner } from './swarms/swarm-spawner';
import { registerAllWorkers } from './swarms/workers/index';

export class AlphanixAgent extends BaseAgent {
  private toml!: AlphanixTomlConfig;
  private registry = new AdapterRegistry();
  private orchestrator!: Orchestrator;
  private allocator!: CapitalAllocator;
  private pods = new Map<string, Pod>();
  private publisher: AlphanixStatePublisher | null = null;
  private db: AlphanixDB | null = null;
  private scheduler = new ScheduleManager();
  private swarmSpawner: SwarmSpawner | null = null;
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
    const paperTrading = this.toml.broker?.paper_trading ?? true;
    this.registry.register(new BinanceAdapter({
        paper: paperTrading,
        apiKey: process.env.BINANCE_API_KEY,
        apiSecret: process.env.BINANCE_API_SECRET,
    }));
    this.registry.register(new AlpacaAdapter({
        paper: paperTrading,
        apiKey: process.env.ALPACA_API_KEY,
        apiSecret: process.env.ALPACA_API_SECRET,
    }));

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

    // Initialize swarm system
    const maxWorkers = this.toml.swarms?.max_concurrent_workers ?? 5;
    this.swarmSpawner = new SwarmSpawner(maxWorkers);
    registerAllWorkers(this.swarmSpawner);
    this.log('info', `Swarm system: ${maxWorkers} max workers, ${this.swarmSpawner.getBudgetStatus().active} active`);

    // Postgres
    this.db = new AlphanixDB();
    await this.db.connect();

    // Schedule events
    this.scheduler.on('morning_huddle', async () => {
        this.log('info', '=== MORNING HUDDLE ===');
        for (const [id, pod] of this.pods) {
            this.log('info', `Pod ${id}: state=${pod.getState()}, capital=$${pod.getCapitalBudget()}`);
        }
    });

    this.scheduler.on('post_mortem', async () => {
        this.log('info', '=== POST-MORTEM ===');
        for (const [id, pod] of this.pods) {
            const risk = pod.getRiskState();
            this.log('info', `Pod ${id}: dailyPnl=$${risk.dailyPnl.toFixed(2)}, trades=${risk.tradesToday}`);
        }
    });

    this.scheduler.on('macro_scan', async () => {
        if (!this.swarmSpawner) return;
        this.log('info', '=== MACRO SCAN ===');
        const result = await this.swarmSpawner.spawn({
            id: `macro-${Date.now()}`,
            type: 'macro',
            requester: { podId: 'orchestrator', role: 'scheduler' },
            task: 'Fetch FRED macro data',
            params: {},
            workerCount: 1,
            maxDuration: 60000,
            priority: 'normal',
        });
        this.log('info', `Macro scan: ${result.status}`, { workers: result.workersUsed, duration: result.durationMs });
    });

    this.log('info', `Alphanix initialized: ${this.pods.size} pod(s)`);
  }

  async start(): Promise<void> {
    this.running = true;
    this.setStatus('active');
    await this.publisher?.publishStatus('running');
    this.log('info', 'Alphanix started');

    while (this.running) {
      // Check scheduled events
      await this.scheduler.fireDueEvents();

      for (const [id, pod] of this.pods) {
        try {
          const result = await pod.runCycle();
          this.orchestrator.updatePodState(id, 'running');

          // Publish full state
          await this.publisher?.publishPodState(id, 'running');
          await this.publisher?.publishHeartbeat(id);
          await this.publisher?.publishPodPositions(id, pod.getPositions());
          await this.publisher?.publishPodRisk(id, pod.getRiskState());

          if (result.executed > 0) {
            this.log('info', `Pod ${id}: ${result.executed} trade(s)`, result);
          }
          if (result.exited > 0) {
            this.log('info', `Pod ${id}: ${result.exited} exit(s)`, result);
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
    await this.db?.close();
    this.setStatus('paused');
    this.log('info', 'Alphanix stopped');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', `Message: ${message.message_type}`, message.data);
  }
}
