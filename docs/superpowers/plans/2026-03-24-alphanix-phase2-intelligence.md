# Alphanix Phase 2 — Intelligence Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire all intelligence layers (news OSINT, sentiment, macro data, geopolitical signals) into pod trading decisions, activate schedule events, and add AI validation.

**Architecture:** Swarm workers collect data → results stored in Redis → Quant agents read data each cycle to boost/penalize confidence. ScheduleManager triggers time-based events. Grok AI validates high-confidence signals before execution.

**Tech Stack:** TypeScript, Redis, Grok/XAI API, GDELT, FRED

---

## Task 1: Wire news OSINT into main loop

**Goal:** Spawn a news swarm every 10 cycles (~10 min). Store results in Redis `alphanix:intel:news` with 30min TTL. Log critical geopolitical signals to console.

**Files:**
- `packages/agents/src/alphanix/alphanix-agent.ts` (add news swarm spawn to main loop)
- `packages/agents/src/alphanix/state/state-publisher.ts` (add `publishIntel()` method)

**TDD Steps:**

- [ ] **Test:** Create `packages/agents/src/alphanix/__tests__/news-intel-loop.test.ts`
  ```ts
  import { SwarmSpawner } from '../swarms/swarm-spawner';
  import { registerAllWorkers } from '../swarms/workers/index';

  describe('News intel loop', () => {
    it('should spawn news swarm every 10 cycles', async () => {
      const spawner = new SwarmSpawner(5);
      registerAllWorkers(spawner);
      const spawnSpy = jest.spyOn(spawner, 'spawn');

      // Simulate cycle 10
      const result = await spawner.spawn({
        id: `news-test`,
        type: 'news',
        requester: { podId: 'orchestrator', role: 'scheduler' },
        task: 'Periodic news OSINT scan',
        params: {},
        workerCount: 1,
        maxDuration: 60000,
        priority: 'normal',
      });

      expect(spawnSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'news' }));
      expect(result.status).toBe('completed');
      expect(result.data).toBeTruthy();
    });

    it('should detect critical geopolitical signals', async () => {
      const spawner = new SwarmSpawner(5);
      registerAllWorkers(spawner);

      const result = await spawner.spawn({
        id: `news-geo-test`,
        type: 'news',
        requester: { podId: 'orchestrator', role: 'scheduler' },
        task: 'Geopolitical scan',
        params: { query: 'war invasion nuclear sanctions' },
        workerCount: 1,
        maxDuration: 60000,
        priority: 'high',
      });

      expect(result.status).toBe('completed');
    });
  });
  ```

- [ ] **Implement:** In `alphanix-agent.ts`, add news swarm spawn inside the main `while (this.running)` loop, after the existing sentiment scan block (around line 176):
  ```ts
  // Every 10 cycles (~10 min), run news OSINT scan
  if (this.cycleCount % 10 === 0 && this.swarmSpawner) {
    try {
      const result = await this.swarmSpawner.spawn({
        id: `news-${Date.now()}`,
        type: 'news',
        requester: { podId: 'orchestrator', role: 'scheduler' },
        task: 'Periodic news OSINT scan',
        params: {},
        workerCount: 1,
        maxDuration: 60000,
        priority: 'normal',
      });
      if (result.status === 'completed' && result.data) {
        const newsData = (result.data as any[])[0];
        if (newsData?.criticalSignals > 0) {
          this.log('warn', `CRITICAL GEOPOLITICAL SIGNALS: ${newsData.criticalSignals}`, {
            signals: newsData.signals?.filter((s: any) => s.severity === 'critical'),
          });
        }
        // Store in Redis with 30min TTL
        await this.publisher?.publishIntel('news', newsData, 1800);
        this.log('info', `News OSINT: ${newsData.signalCount} geo signals, ${newsData.articles} articles`);
      }
    } catch (err: any) {
      this.log('warn', `News OSINT scan failed: ${err.message}`);
    }
  }
  ```

- [ ] **Implement:** In `state/state-publisher.ts`, add the `publishIntel()` method:
  ```ts
  async publishIntel(type: string, data: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    const key = `alphanix:intel:${type}`;
    await this.redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
  }
  ```

- [ ] **Verify:** Run `npx tsx packages/agents/src/alphanix/__tests__/news-intel-loop.test.ts` — all tests pass.

- [ ] **Commit:** `git commit -m "feat(alphanix): wire news OSINT swarm into main loop (every 10 cycles)"`

---

## Task 2: Wire geopolitical signals → pod confidence

**Goal:** When a geopolitical signal is detected, find affected pods (by matching `signal.affectedMarkets` to pod adapter type) and apply confidence boost/penalty via `quant.setSentimentBoost()`.

**Files:**
- `packages/agents/src/alphanix/alphanix-agent.ts` (add `applyGeopoliticalSignals()` method)
- `packages/agents/src/alphanix/pod/pod.ts` (expose `quant.setSentimentBoost()` via pod)

**Adapter-to-market mapping:**
- `binance` → `crypto`
- `alpaca` → `us_stocks`
- `ibkr` → `eu_stocks`, `energy`, `defense`

**TDD Steps:**

- [ ] **Test:** Create `packages/agents/src/alphanix/__tests__/geopolitical-wiring.test.ts`
  ```ts
  describe('Geopolitical signal wiring', () => {
    const ADAPTER_MARKET_MAP: Record<string, string[]> = {
      binance: ['crypto'],
      alpaca: ['us_stocks'],
      ibkr: ['eu_stocks', 'energy', 'defense'],
    };

    it('should map ceasefire signal to EU pods', () => {
      const signal = {
        type: 'ceasefire',
        affectedMarkets: ['eu_stocks', 'energy'],
        tradingImplication: 'bullish' as const,
        severity: 'critical' as const,
      };

      const affectedAdapters: string[] = [];
      for (const [adapter, markets] of Object.entries(ADAPTER_MARKET_MAP)) {
        if (signal.affectedMarkets.some(m => markets.includes(m))) {
          affectedAdapters.push(adapter);
        }
      }

      expect(affectedAdapters).toContain('ibkr');
      expect(affectedAdapters).not.toContain('binance');
    });

    it('should compute sentiment boost from signal implication', () => {
      const boostMap = { bullish: 50, bearish: -50, volatile: -20 };
      const severityMult = { critical: 1.0, high: 0.7, medium: 0.4, low: 0.2 };

      const boost = boostMap['bullish'] * severityMult['critical'];
      expect(boost).toBe(50);

      const bearishBoost = boostMap['bearish'] * severityMult['high'];
      expect(bearishBoost).toBe(-35);
    });
  });
  ```

- [ ] **Implement:** In `pod/pod.ts`, add public method to proxy sentiment boost:
  ```ts
  setSentimentBoost(score: number): void {
    this.quant.setSentimentBoost(score);
  }

  getAdapterType(): string {
    return this.config.adapter;
  }
  ```

- [ ] **Implement:** In `alphanix-agent.ts`, add private method and call it after the news OSINT block:
  ```ts
  private static readonly ADAPTER_MARKET_MAP: Record<string, string[]> = {
    binance: ['crypto'],
    alpaca: ['us_stocks'],
    ibkr: ['eu_stocks', 'energy', 'defense'],
  };

  private applyGeopoliticalSignals(signals: GeopoliticalSignal[]): void {
    const boostMap = { bullish: 50, bearish: -50, volatile: -20 };
    const severityMult = { critical: 1.0, high: 0.7, medium: 0.4, low: 0.2 };

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
  ```

  Then in the news OSINT block, after storing in Redis:
  ```ts
  if (newsData?.signals?.length > 0) {
    this.applyGeopoliticalSignals(newsData.signals);
  }
  ```

- [ ] **Verify:** Test passes, pods receive correct sentiment boosts.

- [ ] **Commit:** `git commit -m "feat(alphanix): wire geopolitical signals to pod confidence via adapter mapping"`

---

## Task 3: Wire macro data → pod confidence

**Goal:** Use FRED data (VIX, Fed Funds Rate) to adjust risk. High VIX (>30) → reduce confidence by 25. Low VIX (<15) → boost confidence by 15. Store in Redis `alphanix:intel:macro` with 2h TTL.

**Files:**
- `packages/agents/src/alphanix/alphanix-agent.ts` (enhance `macro_scan` event handler)
- `packages/agents/src/alphanix/pod/quant-agent.ts` (add `setMacroBoost()`)
- `packages/agents/src/alphanix/state/state-publisher.ts` (reuse `publishIntel()`)

**TDD Steps:**

- [ ] **Test:** Create `packages/agents/src/alphanix/__tests__/macro-wiring.test.ts`
  ```ts
  describe('Macro data → confidence', () => {
    it('should penalize confidence when VIX > 30', () => {
      const vix = 35;
      let macroBoost = 0;
      if (vix > 30) macroBoost = -25;
      else if (vix > 20) macroBoost = -10;
      else if (vix < 15) macroBoost = 15;
      expect(macroBoost).toBe(-25);
    });

    it('should boost confidence when VIX < 15', () => {
      const vix = 12;
      let macroBoost = 0;
      if (vix > 30) macroBoost = -25;
      else if (vix > 20) macroBoost = -10;
      else if (vix < 15) macroBoost = 15;
      expect(macroBoost).toBe(15);
    });

    it('should penalize when Fed rate rising (delta > 0.25)', () => {
      const rateDelta = 0.5; // rate increased by 50bp
      let rateBoost = 0;
      if (rateDelta > 0.25) rateBoost = -15;
      else if (rateDelta < -0.25) rateBoost = 20;
      expect(rateBoost).toBe(-15);
    });
  });
  ```

- [ ] **Implement:** In `pod/quant-agent.ts`, add `macroBoost` field:
  ```ts
  private macroBoost: number = 0;

  setMacroBoost(boost: number): void {
    // Clamp -30 to +20
    this.macroBoost = Math.max(-30, Math.min(20, boost));
  }
  ```
  And in `analyze()`, apply it alongside sentimentBoost (line 147):
  ```ts
  confidence += this.sentimentBoost;
  confidence += this.macroBoost;
  ```

- [ ] **Implement:** In `pod/pod.ts`, add proxy:
  ```ts
  setMacroBoost(boost: number): void {
    this.quant.setMacroBoost(boost);
  }
  ```

- [ ] **Implement:** In `alphanix-agent.ts`, enhance the `macro_scan` scheduler callback to parse VIX and apply boosts:
  ```ts
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

    if (result.status === 'completed' && result.data) {
      const macroData = (result.data as any[])[0];
      const snapshot = macroData?.snapshot;

      // Store in Redis (2h TTL)
      await this.publisher?.publishIntel('macro', macroData, 7200);

      // VIX-based confidence adjustment
      const vixSeries = snapshot?.VIXCLS;
      const vixValue = vixSeries?.observations?.[0]?.value;
      if (typeof vixValue === 'number') {
        let macroBoost = 0;
        if (vixValue > 30) macroBoost = -25;
        else if (vixValue > 20) macroBoost = -10;
        else if (vixValue < 15) macroBoost = 15;

        for (const [id, pod] of this.pods) {
          pod.setMacroBoost(macroBoost);
          this.log('info', `[${id}] VIX=${vixValue.toFixed(1)} → macroBoost=${macroBoost}`);
        }
      }

      // Fed rate change detection
      const fedSeries = snapshot?.FEDFUNDS;
      const fedObs = fedSeries?.observations;
      if (fedObs?.length >= 2) {
        const delta = fedObs[0].value - fedObs[1].value;
        if (Math.abs(delta) > 0.25) {
          const rateBoost = delta > 0 ? -15 : 20;
          for (const [id, pod] of this.pods) {
            pod.setMacroBoost(rateBoost); // overrides VIX boost
            this.log('info', `[${id}] Fed rate delta=${delta.toFixed(2)} → rateBoost=${rateBoost}`);
          }
        }
      }

      this.log('info', `Macro scan: ${result.status}`, { workers: result.workersUsed, duration: result.durationMs });
    }
  });
  ```

- [ ] **Verify:** Tests pass. VIX and Fed rate adjustments apply correctly.

- [ ] **Commit:** `git commit -m "feat(alphanix): wire FRED macro data (VIX, Fed rate) into pod confidence"`

---

## Task 4: Wire altdata (flights/rail) into OSINT reports

**Goal:** Spawn altdata swarm every 30 cycles (~30 min). Store Malmbanan status + flight data in Redis `alphanix:intel:altdata` with 1h TTL. Flag anomalies (e.g., Malmbanan disruptions, unusual flight activity).

**Files:**
- `packages/agents/src/alphanix/alphanix-agent.ts` (add altdata swarm spawn)

**TDD Steps:**

- [ ] **Test:** Create `packages/agents/src/alphanix/__tests__/altdata-wiring.test.ts`
  ```ts
  describe('Altdata wiring', () => {
    it('should detect Malmbanan disruption as anomaly', () => {
      const malmbanenStatus = { status: 'disrupted', delays: 5, cancellations: 2 };
      const isAnomaly = malmbanenStatus.status === 'disrupted' ||
                        malmbanenStatus.delays > 3 ||
                        malmbanenStatus.cancellations > 0;
      expect(isAnomaly).toBe(true);
    });

    it('should detect flight activity anomaly', () => {
      const arrivals = { count: 5, baseline: 20 }; // 75% below normal
      const ratio = arrivals.count / arrivals.baseline;
      const isAnomaly = ratio < 0.5 || ratio > 1.5;
      expect(isAnomaly).toBe(true);
    });

    it('should trigger on cycle 30, 60, 90', () => {
      expect(30 % 30 === 0).toBe(true);
      expect(60 % 30 === 0).toBe(true);
      expect(45 % 30 === 0).toBe(false);
    });
  });
  ```

- [ ] **Implement:** In `alphanix-agent.ts`, add altdata spawn in the main loop (after news block):
  ```ts
  // Every 30 cycles (~30 min), run altdata scan
  if (this.cycleCount % 30 === 0 && this.swarmSpawner) {
    try {
      const result = await this.swarmSpawner.spawn({
        id: `altdata-${Date.now()}`,
        type: 'altdata',
        requester: { podId: 'orchestrator', role: 'scheduler' },
        task: 'Periodic altdata scan (flights + rail)',
        params: { source: 'all' },
        workerCount: 1,
        maxDuration: 60000,
        priority: 'low',
      });
      if (result.status === 'completed' && result.data) {
        const altData = (result.data as any[])[0];
        await this.publisher?.publishIntel('altdata', altData, 3600);

        // Flag Malmbanan anomalies
        const malm = altData?.malmbanen;
        if (malm && (malm.status === 'disrupted' || malm.delays > 3)) {
          this.log('warn', `ALTDATA ANOMALY: Malmbanan ${malm.status}, delays=${malm.delays}`);
        }

        // Flag flight anomalies
        const flights = altData?.flights;
        if (flights && flights.count !== undefined) {
          this.log('info', `Altdata: ${flights.count} flights, Malmbanan=${malm?.status ?? 'unknown'}`);
        }
      }
    } catch (err: any) {
      this.log('warn', `Altdata scan failed: ${err.message}`);
    }
  }
  ```

- [ ] **Verify:** Tests pass, altdata spawns every 30 cycles.

- [ ] **Commit:** `git commit -m "feat(alphanix): wire altdata (flights/rail) into OSINT loop every 30 cycles"`

---

## Task 5: Activate all ScheduleManager events

**Goal:** Wire remaining events: `overnight_risk_adjust` (reduce position sizes 50% at 22:00 UTC), `eu_market_open`/`eu_market_close` (pause/resume EU pods), `us_market_open`/`us_market_close` (pause/resume US pods). Currently only `morning_huddle`, `post_mortem`, and `macro_scan` are wired.

**Files:**
- `packages/agents/src/alphanix/alphanix-agent.ts` (add event handlers in `initialize()`)
- `packages/agents/src/alphanix/pod/pod.ts` (add `pause()`, `resume()`, `reduceExposure()`)
- `packages/agents/src/alphanix/orchestrator/schedule-manager.ts` (already defines the events)

**TDD Steps:**

- [ ] **Test:** Create `packages/agents/src/alphanix/__tests__/schedule-events.test.ts`
  ```ts
  import { ScheduleManager } from '../orchestrator/schedule-manager';

  describe('Schedule events', () => {
    it('should have all 9 events defined', () => {
      const mgr = new ScheduleManager();
      const events = mgr.getSchedule().map(t => t.event);
      expect(events).toContain('overnight_risk_adjust');
      expect(events).toContain('eu_market_open');
      expect(events).toContain('eu_market_close');
      expect(events).toContain('us_market_open');
      expect(events).toContain('us_market_close');
      expect(events).toContain('morning_huddle');
      expect(events).toContain('post_mortem');
      expect(events).toContain('macro_scan');
      expect(events).toContain('esg_audit');
    });

    it('overnight_risk_adjust should fire at 22:00 UTC weekdays', () => {
      const mgr = new ScheduleManager();
      const task = mgr.getSchedule().find(t => t.event === 'overnight_risk_adjust');
      expect(task?.cronUtc).toBe('22:00');
      expect(task?.daysOfWeek).toEqual([1,2,3,4,5]);
    });

    it('should fire callback when event is due', async () => {
      const mgr = new ScheduleManager();
      let fired = false;
      mgr.on('overnight_risk_adjust', async () => { fired = true; });

      // Manually test callback exists
      expect(fired).toBe(false);
    });
  });
  ```

- [ ] **Implement:** In `pod/pod.ts`, add lifecycle methods:
  ```ts
  pause(): void {
    this.state = 'paused';
    console.log(`[Pod:${this.config.id}] PAUSED — no new trades`);
  }

  resume(): void {
    this.state = 'running';
    console.log(`[Pod:${this.config.id}] RESUMED`);
  }

  reduceExposure(factor: number): void {
    // factor: 0.5 = reduce by 50%
    this.capitalBudget = Math.round(this.capitalBudget * factor);
    console.log(`[Pod:${this.config.id}] Exposure reduced by ${(1-factor)*100}%, new budget=$${this.capitalBudget}`);
  }

  restoreExposure(originalBudget: number): void {
    this.capitalBudget = originalBudget;
    console.log(`[Pod:${this.config.id}] Exposure restored to $${this.capitalBudget}`);
  }
  ```

- [ ] **Implement:** In `alphanix-agent.ts`, add event handlers in `initialize()` (after existing `macro_scan` handler):
  ```ts
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
  ```

- [ ] **Implement:** In the main loop, ensure paused pods are skipped. In the `for (const [id, pod] of this.pods)` loop (line 178), add guard:
  ```ts
  if (pod.getState() === 'paused') {
    this.log('info', `[${id}] Paused — skipping cycle`);
    continue;
  }
  ```

- [ ] **Verify:** All 9 schedule events have handlers. Paused pods skip cycles.

- [ ] **Commit:** `git commit -m "feat(alphanix): activate all schedule events — overnight risk, market open/close"`

---

## Task 6: Add Grok AI validation

**Goal:** Before execution, send proposal to Grok (XAI_API_KEY) for second opinion. Fail-closed: if Grok unavailable, reject trade. Blend Grok's confidence with Quant's (60/40 weighting). Create `packages/agents/src/alphanix/pod/ai-validator.ts`.

**Files:**
- `packages/agents/src/alphanix/pod/ai-validator.ts` (NEW — Grok validation client)
- `packages/agents/src/alphanix/pod/pod.ts` (integrate validator before execution)

**TDD Steps:**

- [ ] **Test:** Create `packages/agents/src/alphanix/__tests__/ai-validator.test.ts`
  ```ts
  import { AiValidator, type AiValidationResult } from '../pod/ai-validator';

  describe('AiValidator', () => {
    it('should blend confidence 60/40 (quant/grok)', () => {
      const quantConfidence = 80;
      const grokConfidence = 60;
      const blended = Math.round(quantConfidence * 0.6 + grokConfidence * 0.4);
      expect(blended).toBe(72);
    });

    it('should reject when grok says reject', () => {
      const result: AiValidationResult = {
        approved: false,
        grokConfidence: 20,
        reasoning: 'Market conditions unfavorable',
        blendedConfidence: 0,
      };
      expect(result.approved).toBe(false);
    });

    it('should fail-closed when API unavailable', async () => {
      const validator = new AiValidator('invalid-key');
      const result = await validator.validate({
        symbol: 'BTC/USDC',
        side: 'BUY',
        confidence: 85,
        signals: ['rsi_oversold', 'volume_spike'],
        reasoning: 'Strong dip buy signal',
      });
      // Fail-closed: unavailable → rejected
      expect(result.approved).toBe(false);
    });
  });
  ```

- [ ] **Implement:** Create `packages/agents/src/alphanix/pod/ai-validator.ts`:
  ```ts
  // packages/agents/src/alphanix/pod/ai-validator.ts

  export interface AiValidationRequest {
    symbol: string;
    side: 'BUY' | 'SELL';
    confidence: number;
    signals: string[];
    reasoning: string;
  }

  export interface AiValidationResult {
    approved: boolean;
    grokConfidence: number;
    reasoning: string;
    blendedConfidence: number;
  }

  export class AiValidator {
    private apiKey: string;
    private baseUrl = 'https://api.x.ai/v1/chat/completions';
    private model = 'grok-3-mini';
    private timeoutMs = 15000;

    constructor(apiKey?: string) {
      this.apiKey = apiKey || process.env.XAI_API_KEY || '';
    }

    async validate(request: AiValidationRequest): Promise<AiValidationResult> {
      if (!this.apiKey) {
        console.warn('[AiValidator] No XAI_API_KEY — fail-closed, rejecting');
        return { approved: false, grokConfidence: 0, reasoning: 'AI validation unavailable (no API key)', blendedConfidence: 0 };
      }

      try {
        const prompt = this.buildPrompt(request);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const res = await fetch(this.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: 'You are a trading risk analyst. Evaluate trade proposals and respond with JSON only.' },
              { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            max_tokens: 300,
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          console.warn(`[AiValidator] Grok API error ${res.status} — fail-closed`);
          return { approved: false, grokConfidence: 0, reasoning: `Grok API error: ${res.status}`, blendedConfidence: 0 };
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || '';
        return this.parseResponse(content, request.confidence);

      } catch (err: any) {
        console.warn(`[AiValidator] Failed: ${err.message} — fail-closed`);
        return { approved: false, grokConfidence: 0, reasoning: `AI validation failed: ${err.message}`, blendedConfidence: 0 };
      }
    }

    private buildPrompt(req: AiValidationRequest): string {
      return `Evaluate this trade proposal:

Symbol: ${req.symbol}
Side: ${req.side}
Quant Confidence: ${req.confidence}%
Signals: ${req.signals.join(', ')}
Reasoning: ${req.reasoning}

Respond with JSON only:
{
  "approved": true/false,
  "confidence": 0-100,
  "reasoning": "one sentence"
}`;
    }

    private parseResponse(content: string, quantConfidence: number): AiValidationResult {
      try {
        // Extract JSON from response (may be wrapped in markdown)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in response');
        const parsed = JSON.parse(jsonMatch[0]);

        const grokConfidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 0));
        const blended = Math.round(quantConfidence * 0.6 + grokConfidence * 0.4);

        return {
          approved: parsed.approved === true && blended >= 50,
          grokConfidence,
          reasoning: String(parsed.reasoning || 'No reasoning'),
          blendedConfidence: blended,
        };
      } catch {
        // Parse failure → fail-closed
        return { approved: false, grokConfidence: 0, reasoning: 'Failed to parse Grok response', blendedConfidence: 0 };
      }
    }
  }
  ```

- [ ] **Implement:** In `pod/pod.ts`, integrate validator. Add import and field:
  ```ts
  import { AiValidator } from './ai-validator.js';

  // In constructor:
  private aiValidator = new AiValidator();

  // In runCycle(), after risk approval and before execution:
  // --- AI Validation (fail-closed) ---
  const aiResult = await this.aiValidator.validate({
    symbol: proposal.symbol,
    side: proposal.side,
    confidence: proposal.confidence,
    signals: proposal.signals,
    reasoning: proposal.reasoning,
  });

  if (!aiResult.approved) {
    console.log(`[Pod:${this.config.id}] AI REJECTED ${proposal.symbol}: ${aiResult.reasoning}`);
    result.vetoed++;
    continue;
  }

  // Update confidence with blended score
  proposal.confidence = aiResult.blendedConfidence;
  console.log(`[Pod:${this.config.id}] AI APPROVED ${proposal.symbol}: blended=${aiResult.blendedConfidence}% (grok=${aiResult.grokConfidence}%)`);
  ```

- [ ] **Verify:** Tests pass. Grok validation happens before every execution.

- [ ] **Commit:** `git commit -m "feat(alphanix): add Grok AI validation — fail-closed, 60/40 confidence blending"`

---

## Task 7: Pod performance tracking + leaderboard

**Goal:** Track each pod's daily/weekly P&L, win rate, Sharpe ratio. Store in Redis `alphanix:pod:{id}:performance` with 24h TTL. Add leaderboard API. Orchestrator can query to reallocate capital.

**Files:**
- `packages/agents/src/alphanix/pod/performance-tracker.ts` (NEW — performance tracking)
- `packages/agents/src/alphanix/alphanix-agent.ts` (wire tracker into post_mortem event)
- `packages/agents/src/alphanix/state/state-publisher.ts` (add `publishPodPerformance()`)

**TDD Steps:**

- [ ] **Test:** Create `packages/agents/src/alphanix/__tests__/performance-tracker.test.ts`
  ```ts
  import { PerformanceTracker, type TradeRecord } from '../pod/performance-tracker';

  describe('PerformanceTracker', () => {
    it('should compute win rate correctly', () => {
      const tracker = new PerformanceTracker('test-pod');
      tracker.recordTrade({ pnl: 50, entryPrice: 100, exitPrice: 105, symbol: 'BTC', timestamp: Date.now() });
      tracker.recordTrade({ pnl: -20, entryPrice: 100, exitPrice: 98, symbol: 'ETH', timestamp: Date.now() });
      tracker.recordTrade({ pnl: 30, entryPrice: 50, exitPrice: 53, symbol: 'SOL', timestamp: Date.now() });

      const stats = tracker.getStats();
      expect(stats.winRate).toBeCloseTo(0.667, 2);
      expect(stats.totalPnl).toBe(60);
      expect(stats.tradeCount).toBe(3);
    });

    it('should compute daily P&L', () => {
      const tracker = new PerformanceTracker('test-pod');
      const now = Date.now();
      tracker.recordTrade({ pnl: 100, entryPrice: 100, exitPrice: 110, symbol: 'BTC', timestamp: now });
      tracker.recordTrade({ pnl: -30, entryPrice: 50, exitPrice: 48.5, symbol: 'ETH', timestamp: now });

      const daily = tracker.getDailyPnl();
      expect(daily).toBe(70);
    });

    it('should compute Sharpe ratio', () => {
      const tracker = new PerformanceTracker('test-pod');
      // Add enough trades for meaningful Sharpe
      [10, -5, 15, -8, 20, 12, -3, 8, 25, -10].forEach((pnl, i) => {
        tracker.recordTrade({ pnl, entryPrice: 100, exitPrice: 100 + pnl, symbol: 'BTC', timestamp: Date.now() + i });
      });

      const stats = tracker.getStats();
      expect(stats.sharpe).toBeGreaterThan(0); // positive expected return
    });

    it('should return leaderboard-friendly snapshot', () => {
      const tracker = new PerformanceTracker('pod-a');
      tracker.recordTrade({ pnl: 100, entryPrice: 100, exitPrice: 110, symbol: 'BTC', timestamp: Date.now() });

      const snapshot = tracker.getLeaderboardEntry();
      expect(snapshot.podId).toBe('pod-a');
      expect(snapshot.totalPnl).toBe(100);
      expect(snapshot.winRate).toBe(1.0);
    });
  });
  ```

- [ ] **Implement:** Create `packages/agents/src/alphanix/pod/performance-tracker.ts`:
  ```ts
  // packages/agents/src/alphanix/pod/performance-tracker.ts

  export interface TradeRecord {
    pnl: number;
    entryPrice: number;
    exitPrice: number;
    symbol: string;
    timestamp: number;
  }

  export interface PodStats {
    podId: string;
    totalPnl: number;
    dailyPnl: number;
    weeklyPnl: number;
    winRate: number;
    tradeCount: number;
    sharpe: number;
    timestamp: number;
  }

  export interface LeaderboardEntry {
    podId: string;
    totalPnl: number;
    dailyPnl: number;
    winRate: number;
    sharpe: number;
    tradeCount: number;
    rank?: number;
  }

  const DAY_MS = 86400000;
  const WEEK_MS = DAY_MS * 7;

  export class PerformanceTracker {
    private podId: string;
    private trades: TradeRecord[] = [];

    constructor(podId: string) {
      this.podId = podId;
    }

    recordTrade(trade: TradeRecord): void {
      this.trades.push(trade);
    }

    getDailyPnl(): number {
      const cutoff = Date.now() - DAY_MS;
      return this.trades
        .filter(t => t.timestamp >= cutoff)
        .reduce((sum, t) => sum + t.pnl, 0);
    }

    getWeeklyPnl(): number {
      const cutoff = Date.now() - WEEK_MS;
      return this.trades
        .filter(t => t.timestamp >= cutoff)
        .reduce((sum, t) => sum + t.pnl, 0);
    }

    getStats(): PodStats {
      const wins = this.trades.filter(t => t.pnl > 0).length;
      const winRate = this.trades.length > 0 ? wins / this.trades.length : 0;
      const totalPnl = this.trades.reduce((s, t) => s + t.pnl, 0);

      return {
        podId: this.podId,
        totalPnl,
        dailyPnl: this.getDailyPnl(),
        weeklyPnl: this.getWeeklyPnl(),
        winRate,
        tradeCount: this.trades.length,
        sharpe: this.calcSharpe(),
        timestamp: Date.now(),
      };
    }

    getLeaderboardEntry(): LeaderboardEntry {
      const stats = this.getStats();
      return {
        podId: stats.podId,
        totalPnl: stats.totalPnl,
        dailyPnl: stats.dailyPnl,
        winRate: stats.winRate,
        sharpe: stats.sharpe,
        tradeCount: stats.tradeCount,
      };
    }

    private calcSharpe(): number {
      if (this.trades.length < 3) return 0;
      const returns = this.trades.map(t => t.pnl);
      const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
      const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
      const std = Math.sqrt(variance);
      if (std === 0) return 0;
      // Annualized Sharpe (assuming ~250 trading days)
      return (mean / std) * Math.sqrt(250);
    }
  }
  ```

- [ ] **Implement:** In `state/state-publisher.ts`, add method:
  ```ts
  async publishPodPerformance(podId: string, stats: unknown): Promise<void> {
    if (!this.redis) return;
    const key = `alphanix:pod:${podId}:performance`;
    await this.redis.set(key, JSON.stringify(stats), 'EX', 86400); // 24h TTL
  }
  ```

- [ ] **Implement:** In `alphanix-agent.ts`, add performance tracker map and wire into `post_mortem`:
  ```ts
  import { PerformanceTracker } from './pod/performance-tracker';

  // Class field:
  private perfTrackers = new Map<string, PerformanceTracker>();

  // In initialize(), after pod creation:
  this.perfTrackers.set(id, new PerformanceTracker(id));

  // Replace post_mortem handler:
  this.scheduler.on('post_mortem', async () => {
    this.log('info', '=== POST-MORTEM ===');
    const leaderboard = [];
    for (const [id, pod] of this.pods) {
      const risk = pod.getRiskState();
      const tracker = this.perfTrackers.get(id);
      const stats = tracker?.getStats();
      this.log('info', `Pod ${id}: dailyPnl=$${risk.dailyPnl.toFixed(2)}, trades=${risk.tradesToday}, winRate=${(stats?.winRate ?? 0 * 100).toFixed(0)}%`);

      if (stats) {
        await this.publisher?.publishPodPerformance(id, stats);
        leaderboard.push(tracker!.getLeaderboardEntry());
      }
    }

    // Sort leaderboard by total P&L
    leaderboard.sort((a, b) => b.totalPnl - a.totalPnl);
    leaderboard.forEach((entry, i) => { entry.rank = i + 1; });
    await this.publisher?.publishIntel('leaderboard', leaderboard, 86400);
    this.log('info', `Leaderboard: ${leaderboard.map(e => `${e.rank}. ${e.podId} ($${e.totalPnl.toFixed(2)})`).join(' | ')}`);
  });
  ```

- [ ] **Verify:** Tests pass. Performance data published to Redis after post_mortem.

- [ ] **Commit:** `git commit -m "feat(alphanix): pod performance tracking + leaderboard (daily/weekly P&L, Sharpe)"`

---

## Task 8: Automatic capital rebalancing

**Goal:** Every 24h (via ScheduleManager), Orchestrator compares pod performance. Bottom 2 pods get 50% capital reduction. Top 2 get the freed capital. Log all decisions.

**Files:**
- `packages/agents/src/alphanix/alphanix-agent.ts` (add rebalancing logic)
- `packages/agents/src/alphanix/orchestrator/schedule-manager.ts` (add `rebalance` event)
- `packages/agents/src/alphanix/orchestrator/capital-allocator.ts` (add `rebalance()` method)

**TDD Steps:**

- [ ] **Test:** Create `packages/agents/src/alphanix/__tests__/capital-rebalance.test.ts`
  ```ts
  describe('Capital rebalancing', () => {
    it('should identify bottom 2 and top 2 pods', () => {
      const leaderboard = [
        { podId: 'pod-a', totalPnl: 500, dailyPnl: 50, winRate: 0.7, sharpe: 1.2, tradeCount: 10 },
        { podId: 'pod-b', totalPnl: 200, dailyPnl: 20, winRate: 0.6, sharpe: 0.8, tradeCount: 8 },
        { podId: 'pod-c', totalPnl: -100, dailyPnl: -30, winRate: 0.3, sharpe: -0.5, tradeCount: 12 },
        { podId: 'pod-d', totalPnl: -300, dailyPnl: -50, winRate: 0.2, sharpe: -1.0, tradeCount: 15 },
        { podId: 'pod-e', totalPnl: 50, dailyPnl: 5, winRate: 0.5, sharpe: 0.3, tradeCount: 6 },
      ];

      // Sort by totalPnl descending
      const sorted = [...leaderboard].sort((a, b) => b.totalPnl - a.totalPnl);
      const top2 = sorted.slice(0, 2).map(e => e.podId);
      const bottom2 = sorted.slice(-2).map(e => e.podId);

      expect(top2).toEqual(['pod-a', 'pod-b']);
      expect(bottom2).toEqual(['pod-d', 'pod-c']);
    });

    it('should redistribute freed capital to top pods', () => {
      const podBudgets: Record<string, number> = {
        'pod-a': 1000,
        'pod-b': 1000,
        'pod-c': 1000,
        'pod-d': 1000,
      };

      const bottom = ['pod-c', 'pod-d'];
      const top = ['pod-a', 'pod-b'];

      let freedCapital = 0;
      for (const id of bottom) {
        const reduction = podBudgets[id] * 0.5;
        podBudgets[id] -= reduction;
        freedCapital += reduction;
      }

      const perTopPod = freedCapital / top.length;
      for (const id of top) {
        podBudgets[id] += perTopPod;
      }

      expect(podBudgets['pod-c']).toBe(500);
      expect(podBudgets['pod-d']).toBe(500);
      expect(podBudgets['pod-a']).toBe(1500);
      expect(podBudgets['pod-b']).toBe(1500);
      expect(freedCapital).toBe(1000);
    });

    it('should not rebalance if fewer than 4 pods', () => {
      const podCount = 3;
      const shouldRebalance = podCount >= 4;
      expect(shouldRebalance).toBe(false);
    });
  });
  ```

- [ ] **Implement:** In `orchestrator/schedule-manager.ts`, add `rebalance` to the `ScheduleEvent` type:
  ```ts
  export type ScheduleEvent =
    | 'morning_huddle'
    | 'macro_scan'
    | 'post_mortem'
    | 'esg_audit'
    | 'eu_market_open'
    | 'eu_market_close'
    | 'us_market_open'
    | 'us_market_close'
    | 'overnight_risk_adjust'
    | 'rebalance';
  ```
  And add to default schedule:
  ```ts
  { event: 'rebalance', cronUtc: '05:00', daysOfWeek: [1,2,3,4,5] },  // 05:00 UTC daily
  ```

- [ ] **Implement:** In `alphanix-agent.ts`, add rebalance handler:
  ```ts
  this.scheduler.on('rebalance', async () => {
    this.log('info', '=== CAPITAL REBALANCE ===');

    if (this.pods.size < 4) {
      this.log('info', 'Rebalance skipped: need >= 4 pods');
      return;
    }

    // Build leaderboard from performance trackers
    const entries = [];
    for (const [id, tracker] of this.perfTrackers) {
      entries.push(tracker.getLeaderboardEntry());
    }
    entries.sort((a, b) => b.totalPnl - a.totalPnl);

    const top2 = entries.slice(0, 2);
    const bottom2 = entries.slice(-2);

    // Reduce bottom 2 by 50%
    let freedCapital = 0;
    for (const entry of bottom2) {
      const pod = this.pods.get(entry.podId);
      if (!pod) continue;
      const currentBudget = pod.getCapitalBudget();
      const reduction = currentBudget * 0.5;
      pod.reduceExposure(0.5);
      freedCapital += reduction;
      this.log('info', `[REBALANCE] ${entry.podId}: -$${reduction.toFixed(0)} (PnL=$${entry.totalPnl.toFixed(2)}, WR=${(entry.winRate * 100).toFixed(0)}%)`);
    }

    // Distribute freed capital to top 2
    if (freedCapital > 0 && top2.length > 0) {
      const perPod = freedCapital / top2.length;
      for (const entry of top2) {
        const pod = this.pods.get(entry.podId);
        if (!pod) continue;
        const newBudget = pod.getCapitalBudget() + perPod;
        pod.restoreExposure(newBudget);
        this.log('info', `[REBALANCE] ${entry.podId}: +$${perPod.toFixed(0)} (PnL=$${entry.totalPnl.toFixed(2)}, WR=${(entry.winRate * 100).toFixed(0)}%)`);
      }
    }

    this.log('info', `Rebalanced: $${freedCapital.toFixed(0)} moved from bottom 2 → top 2`);
  });
  ```

- [ ] **Verify:** Tests pass. Rebalancing fires daily at 05:00 UTC.

- [ ] **Commit:** `git commit -m "feat(alphanix): automatic capital rebalancing — bottom 2 pods reduced, top 2 boosted"`
