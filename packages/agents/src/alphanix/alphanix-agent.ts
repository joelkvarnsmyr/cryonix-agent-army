import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import { loadAlphanixConfig, resetAlphanixConfig, toPodConfig, type AlphanixTomlConfig } from './config';
import { AdapterRegistry } from './adapters/adapter-registry';
import { BinanceAdapter } from './adapters/binance-adapter';
import { AlpacaAdapter } from './adapters/alpaca-adapter';
import { IbkrAdapter } from './adapters/ibkr-adapter';
import { Orchestrator } from './orchestrator/orchestrator';
import { CapitalAllocator } from './orchestrator/capital-allocator';
import { Pod } from './pod/pod';
import { AlphanixStatePublisher } from './state/state-publisher';
import { AlphanixDB } from './data/postgres';
import { ScheduleManager } from './orchestrator/schedule-manager';
import { SwarmSpawner } from './swarms/swarm-spawner';
import { registerAllWorkers } from './swarms/workers/index';
import type { SwarmRequest, SwarmResult } from './swarms/types';
import type { GeopoliticalSignal } from './data/feeds/news-feed';

export class AlphanixAgent extends BaseAgent {
  private static readonly ADAPTER_MARKET_MAP: Record<string, string[]> = {
    binance: ['crypto'],
    alpaca: ['us_stocks'],
    ibkr: ['eu_stocks', 'energy', 'defense'],
  };

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
  private cycleCount = 0;

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
    this.registry.register(new IbkrAdapter({ paper: paperTrading }));

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

    // Postgres — must init before pods so they can persist trades
    this.db = new AlphanixDB();
    await this.db.connect();

    // Allocate capital and create Pod instances
    const budgets = this.allocator.allocate(enabledPods);
    for (const [id, podToml] of Object.entries(this.toml.pods)) {
      if (!podToml.enabled || !budgets[id]) continue;
      const adapter = this.registry.get(podToml.adapter)!;
      const config = toPodConfig(id, podToml);
      const pod = new Pod(config, adapter, budgets[id], this.db);
      this.pods.set(id, pod);
      this.orchestrator.registerPod(id, 'starting');
      this.log('info', `Pod created: ${id} ($${budgets[id]})`);
    }

    // Initialize swarm system
    const maxWorkers = this.toml.swarms?.max_concurrent_workers ?? 5;
    this.swarmSpawner = new SwarmSpawner(maxWorkers);
    registerAllWorkers(this.swarmSpawner);
    this.log('info', `Swarm system: ${maxWorkers} max workers, ${this.swarmSpawner.getBudgetStatus().active} active`);

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
        this.log('info', '=== MACRO SCAN (scheduled) ===');
        const macroResult = await this.spawnAndPublish({
            id: `macro-${Date.now()}`,
            type: 'macro',
            requester: { podId: 'orchestrator', role: 'scheduler' },
            task: 'Fetch FRED macro data',
            params: {},
            workerCount: 1,
            maxDuration: 60000,
            priority: 'normal',
        });

        // Wire VIX data to pod macroBoost
        if (macroResult?.status === 'completed') {
          let vix: number | undefined;
          for (const workerData of (macroResult.data as any[] ?? [])) {
            if (workerData?.vix !== undefined && typeof workerData.vix === 'number') {
              vix = workerData.vix;
              break;
            }
          }
          if (vix !== undefined) {
            let macroBoost = 0;
            if (vix > 30) macroBoost = -25;
            else if (vix > 20) macroBoost = -10;
            else if (vix < 15) macroBoost = 15;

            for (const [, pod] of this.pods) {
              pod.setMacroBoost(macroBoost);
            }
            this.log('info', `Macro: VIX=${vix.toFixed(1)}, macroBoost=${macroBoost} applied to ${this.pods.size} pods`);

            // Publish macro intel to Redis for dashboard visibility
            await this.publisher?.publishIntel('macro', { vix, macroBoost, updatedAt: Date.now() }, 1800);
          }
        }
    });

    // --- Overnight risk reduction (22:00 UTC) ---
    const originalBudgets = new Map<string, number>();
    this.scheduler.on('overnight_risk_adjust', async () => {
        this.log('info', '=== OVERNIGHT RISK ADJUST ===');
        for (const [id, pod] of this.pods) {
            originalBudgets.set(id, pod.getCapitalBudget());
            pod.reduceExposure(0.5); // 50% reduction
            this.log('info', `[${id}] Overnight: capital halved to $${pod.getCapitalBudget()}`);
        }
    });

    // --- EU market open (07:00 UTC) ---
    this.scheduler.on('eu_market_open', async () => {
        this.log('info', '=== EU MARKET OPEN ===');
        for (const [id, pod] of this.pods) {
            if (pod.getAdapterType() === 'ibkr') {
                pod.resume();
                const orig = originalBudgets.get(id);
                if (orig) pod.restoreExposure(orig);
                this.log('info', `[${id}] EU pod resumed`);
            }
        }
    });

    // --- EU market close (15:30 UTC) ---
    this.scheduler.on('eu_market_close', async () => {
        this.log('info', '=== EU MARKET CLOSE ===');
        for (const [id, pod] of this.pods) {
            if (pod.getAdapterType() === 'ibkr') {
                pod.pause();
                this.log('info', `[${id}] EU pod paused`);
            }
        }
    });

    // --- US market open (14:30 UTC) ---
    this.scheduler.on('us_market_open', async () => {
        this.log('info', '=== US MARKET OPEN ===');
        for (const [id, pod] of this.pods) {
            if (pod.getAdapterType() === 'alpaca') {
                pod.resume();
                const orig = originalBudgets.get(id);
                if (orig) pod.restoreExposure(orig);
                this.log('info', `[${id}] US pod resumed`);
            }
        }
    });

    // --- US market close (21:00 UTC) ---
    this.scheduler.on('us_market_close', async () => {
        this.log('info', '=== US MARKET CLOSE ===');
        for (const [id, pod] of this.pods) {
            if (pod.getAdapterType() === 'alpaca') {
                pod.pause();
                this.log('info', `[${id}] US pod paused`);
            }
        }
    });

    this.log('info', `Alphanix initialized: ${this.pods.size} pod(s)`);
  }

  /**
   * Cross-pod risk aggregation — detects hidden correlated exposure
   * and triggers a portfolio-level kill switch if daily PnL breaches max drawdown.
   */
  private async aggregateRisk(): Promise<void> {
    let totalPnlToday = 0;
    let totalExposure = 0;
    const symbolExposure = new Map<string, number>();

    for (const [podId, pod] of this.pods) {
      const positions = pod.getPositions();
      for (const pos of positions) {
        const notional = pos.avgEntryPrice * pos.qty;
        totalExposure += notional;

        // Track duplicate exposure across pods
        const existing = symbolExposure.get(pos.symbol) || 0;
        symbolExposure.set(pos.symbol, existing + notional);

        // Daily P&L
        const pnl = (pos.currentPrice - pos.avgEntryPrice) * pos.qty;
        totalPnlToday += pnl;
      }
    }

    // Portfolio-level kill switch
    const maxDrawdownPct = this.toml.orchestrator.global_max_drawdown_pct / 100;
    const totalCapital = this.toml.orchestrator.capital_total_usd;

    if (totalPnlToday < -(totalCapital * maxDrawdownPct)) {
      this.log('error', `PORTFOLIO KILL SWITCH: daily PnL $${totalPnlToday.toFixed(2)} exceeds max drawdown ${(maxDrawdownPct * 100).toFixed(1)}%`);
      for (const [podId, pod] of this.pods) {
        pod.pause();
        this.orchestrator.updatePodState(podId, 'paused');
        this.log('warn', `Pod ${podId} PAUSED by kill switch`);
      }
    }

    // Warn on concentrated exposure (>25% of portfolio in one symbol)
    for (const [symbol, exposure] of symbolExposure) {
      if (exposure > totalCapital * 0.25) {
        this.log('warn', `CONCENTRATION: ${symbol} exposure $${exposure.toFixed(0)} = ${((exposure / totalCapital) * 100).toFixed(0)}% of portfolio`);
      }
    }

    // Publish risk summary to Redis
    await this.publisher?.publishIntel('risk', {
      totalPnlToday,
      totalExposure,
      exposurePct: totalCapital > 0 ? totalExposure / totalCapital : 0,
      concentrations: Array.from(symbolExposure.entries()).filter(([, v]) => v > totalCapital * 0.15),
      podCount: this.pods.size,
      timestamp: Date.now(),
    }, 300);
  }

  /** Spawn a swarm worker and publish results to Redis */
  private async spawnAndPublish(request: SwarmRequest): Promise<SwarmResult | null> {
    if (!this.swarmSpawner) return null;
    try {
      const result = await this.swarmSpawner.spawn(request);
      if (result.status === 'completed' && this.publisher) {
        await this.publisher.publishSwarmResult(request.type, result.data);
      }
      this.log('info', `Swarm [${request.type}]: ${result.status} (${result.durationMs}ms, ${result.workersUsed} workers${result.errors.length ? ', errors: ' + result.errors.join('; ') : ''})`);
      return result;
    } catch (err: any) {
      this.log('warn', `Swarm [${request.type}] failed: ${err.message}`);
      return null;
    }
  }

  private applyGeopoliticalSignals(signals: GeopoliticalSignal[]): void {
    const boostMap: Record<string, number> = { bullish: 50, bearish: -50, volatile: -20 };
    const severityMult: Record<string, number> = { critical: 1.0, high: 0.7, medium: 0.4, low: 0.2 };

    for (const signal of signals) {
      const rawBoost = boostMap[signal.tradingImplication] ?? 0;
      const mult = severityMult[signal.severity] ?? 0.2;
      const boost = Math.round(rawBoost * mult);

      for (const [podId, pod] of this.pods) {
        const adapterType = pod.getAdapterType();
        const markets = AlphanixAgent.ADAPTER_MARKET_MAP[adapterType] ?? [];
        if (signal.affectedMarkets.some(m => markets.includes(m))) {
          pod.setSentimentBoost(boost);
          this.log('info', `[${podId}] Geo signal: ${signal.type} (${signal.severity}) → boost=${boost}`);
        }
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
    this.setStatus('active');
    await this.publisher?.publishStatus('running');
    this.log('info', 'Alphanix started');

    while (this.running) {
      // Check scheduled events
      await this.scheduler.fireDueEvents();

      this.cycleCount++;

      // --- Swarm worker scheduling (cycle-based) ---

      // Sentiment: every 5 cycles (~5 min)
      if (this.cycleCount % 5 === 0 && this.swarmSpawner) {
        try {
          const symbols = [...new Set(
            Array.from(this.pods.values()).flatMap(p => p.getSymbols())
          )].slice(0, 10);  // Top 10 unique symbols

          if (symbols.length > 0) {
            const result = await this.spawnAndPublish({
              id: `sentiment-${Date.now()}`,
              type: 'sentiment',
              requester: { podId: 'orchestrator', role: 'scheduler' },
              task: 'Periodic sentiment scan',
              params: { symbols },
              workerCount: 1,
              maxDuration: 30000,
              priority: 'normal',
            });
            if (result?.status === 'completed') {
              // Wire sentiment scores to pod quant agents
              // result.data is an array of worker outputs; each may contain { scores: { SYMBOL: number } }
              const scores: Record<string, number> = {};
              for (const workerData of (result.data as any[] ?? [])) {
                if (workerData?.scores && typeof workerData.scores === 'object') {
                  Object.assign(scores, workerData.scores);
                }
              }
              if (Object.keys(scores).length > 0) {
                for (const [, pod] of this.pods) {
                  const podSymbols = pod.getSymbols();
                  const relevant = podSymbols.map(s => scores[s]).filter(v => v !== undefined);
                  if (relevant.length > 0) {
                    const avg = relevant.reduce((a, b) => a + b, 0) / relevant.length;
                    pod.getQuant().setSentimentBoost(avg);
                  }
                }
                this.log('info', `Sentiment wired to ${this.pods.size} pods (${Object.keys(scores).length} symbols)`);
              }
            }
          }
        } catch (err: any) {
          this.log('warn', `Sentiment scan failed: ${err.message}`);
        }
      }

      // News: every 10 cycles (~10 min)
      if (this.cycleCount % 10 === 0 && this.swarmSpawner) {
        const newsResult = await this.spawnAndPublish({
          id: `news-${Date.now()}`,
          type: 'news',
          requester: { podId: 'orchestrator', role: 'scheduler' },
          task: 'Periodic news + geopolitical signal scan',
          params: { query: 'crypto market fed rate' },
          workerCount: 1,
          maxDuration: 30000,
          priority: 'normal',
        });
        // Wire geopolitical signals to pod confidence
        if (newsResult?.status === 'completed' && newsResult.data) {
          const newsData = (newsResult.data as any[])[0];
          if (newsData?.signals?.length > 0) {
            this.applyGeopoliticalSignals(newsData.signals);
          }
        }
      }

      // OSINT: every 15 cycles (~15 min)
      if (this.cycleCount % 15 === 0 && this.swarmSpawner) {
        const firstSymbol = Array.from(this.pods.values())[0]?.getSymbols()[0] || 'AAPL';
        await this.spawnAndPublish({
          id: `osint-${Date.now()}`,
          type: 'osint',
          requester: { podId: 'orchestrator', role: 'scheduler' },
          task: 'Periodic OSINT scan (filings + sentiment)',
          params: { symbol: firstSymbol },
          workerCount: 1,
          maxDuration: 60000,
          priority: 'low',
        });
      }

      // Altdata: every 20 cycles (~20 min)
      if (this.cycleCount % 20 === 0 && this.swarmSpawner) {
        await this.spawnAndPublish({
          id: `altdata-${Date.now()}`,
          type: 'altdata',
          requester: { podId: 'orchestrator', role: 'scheduler' },
          task: 'Periodic alt-data scan (flights + rail)',
          params: { source: 'all' },
          workerCount: 1,
          maxDuration: 60000,
          priority: 'low',
        });
      }

      // Macro: every 30 cycles (~30 min) in addition to the scheduled morning scan
      if (this.cycleCount % 30 === 0 && this.swarmSpawner) {
        const periodicMacro = await this.spawnAndPublish({
          id: `macro-periodic-${Date.now()}`,
          type: 'macro',
          requester: { podId: 'orchestrator', role: 'scheduler' },
          task: 'Periodic macro data refresh',
          params: {},
          workerCount: 1,
          maxDuration: 60000,
          priority: 'low',
        });

        // Wire VIX to macroBoost (same logic as scheduled macro_scan)
        if (periodicMacro?.status === 'completed') {
          let vix: number | undefined;
          for (const workerData of (periodicMacro.data as any[] ?? [])) {
            if (workerData?.vix !== undefined && typeof workerData.vix === 'number') {
              vix = workerData.vix;
              break;
            }
          }
          if (vix !== undefined) {
            let macroBoost = 0;
            if (vix > 30) macroBoost = -25;
            else if (vix > 20) macroBoost = -10;
            else if (vix < 15) macroBoost = 15;

            for (const [, pod] of this.pods) {
              pod.setMacroBoost(macroBoost);
            }
            this.log('info', `Macro (periodic): VIX=${vix.toFixed(1)}, macroBoost=${macroBoost} applied to ${this.pods.size} pods`);
            await this.publisher?.publishIntel('macro', { vix, macroBoost, updatedAt: Date.now() }, 1800);
          }
        }
      }

      // Publish swarm active status to Redis every cycle
      if (this.swarmSpawner && this.publisher) {
        await this.publisher.publishSwarmActive(this.swarmSpawner.getActiveSwarms());
      }

      for (const [id, pod] of this.pods) {
        try {
          const result = await pod.runCycle();
          const podState = pod.getState();
          this.orchestrator.updatePodState(id, podState);

          // Publish full state
          await this.publisher?.publishPodState(id, podState);
          await this.publisher?.publishHeartbeat(id);
          await this.publisher?.publishPodPositions(id, pod.getPositions());
          await this.publisher?.publishPodRisk(id, pod.getRiskState());

          // Always log cycle summary
          this.log('info', `[${id}] cycle: scanned=${result.scannedSymbols} signals=${result.proposalsGenerated} approved=${result.approved} vetoed=${result.vetoed} executed=${result.executed} exited=${result.exited} errors=${result.errors.length}`);
          if (result.errors.length > 0) {
            for (const err of result.errors) this.log('warn', `[${id}] ${err}`);
          }
        } catch (err: any) {
          this.log('error', `Pod ${id} error: ${err.message}`);
          this.orchestrator.updatePodState(id, 'error');
        }
      }

      // Cross-pod risk aggregation (kill switch + concentration warnings)
      try {
        await this.aggregateRisk();
      } catch (err: any) {
        this.log('warn', `Risk aggregation failed: ${err.message}`);
      }

      // Refresh global status every cycle (TTL = 300s)
      await this.publisher?.publishStatus('running');
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
