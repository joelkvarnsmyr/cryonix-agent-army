# Alphanix Phase 1 Fixes — Critical Production Issues

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 critical issues blocking production-quality operation: trade persistence, Nordic SL-loop, dashboard rendering, and Alpaca auth.

**Architecture:** Targeted fixes to existing files. No new architecture — just wiring missing connections and fixing data flow bugs.

**Tech Stack:** TypeScript, Postgres (pg), Next.js, Alpaca SDK

---

## Task 1: Wire trade logging to Postgres

**Problem:** Pod executes trades but never calls `db.logTrade()`. The `AlphanixDB` instance is created in `alphanix-agent.ts` (line 101) but never passed to any Pod. Every trade is lost on restart — zero persistence.

**Root cause:** `Pod` constructor only accepts `(config, adapter, capitalBudget)`. The `db` reference exists one level up in `AlphanixAgent` but is never threaded through.

### Steps

- [ ] **1.1** Modify `Pod` constructor to accept optional `AlphanixDB` parameter

  **File:** `packages/agents/src/alphanix/pod/pod.ts`

  Add import at top:
  ```typescript
  import type { AlphanixDB } from '../data/postgres.js';
  ```

  Change constructor signature and add field:
  ```typescript
  private db: AlphanixDB | null;

  constructor(config: PodConfig, adapter: MarketAdapter, capitalBudget: number, db?: AlphanixDB | null) {
    this.config = config;
    this.adapter = adapter;
    this.capitalBudget = capitalBudget;
    this.db = db ?? null;
    // ... rest unchanged
  }
  ```

- [ ] **1.2** Log every proposal (approved or vetoed) via `db.logSignal()`

  **File:** `packages/agents/src/alphanix/pod/pod.ts`

  After the veto branch (line 113-115), add signal logging:
  ```typescript
  if (decision.action === 'veto') {
    result.vetoed++;
    console.log(`[Pod:${this.config.id}] VETO ${symbol}: ${decision.vetoReason} ...`);
    // Log vetoed signal to Postgres
    this.db?.logSignal({
      podId: this.config.id,
      symbol,
      adapter: this.adapter.id,
      side: sized.side,
      confidence: sized.confidence,
      signals: sized.signals,
      models: sized.models,
      reasoning: sized.reasoning,
      riskAction: 'veto',
      riskReason: decision.vetoReason,
      proposalId: sized.id,
    });
    continue;
  }
  ```

  After successful execution (inside the `if (execResult.orderId)` block, after `this.risk.recordTrade()` on line 142), add:
  ```typescript
  // Log approved signal
  this.db?.logSignal({
    podId: this.config.id,
    symbol,
    adapter: this.adapter.id,
    side: sized.side,
    confidence: sized.confidence,
    signals: sized.signals,
    models: sized.models,
    reasoning: sized.reasoning,
    riskAction: decision.action,
    proposalId: sized.id,
  });

  // Log executed trade
  this.db?.logTrade({
    podId: this.config.id,
    symbol,
    adapter: this.adapter.id,
    side: sized.side,
    qty: execResult.fillQty,
    fillPrice: execResult.fillPrice,
    notional: execResult.fillQty * execResult.fillPrice,
    slippage: execResult.slippage,
    fees: execResult.fees,
    confidence: sized.confidence,
    reasoning: sized.reasoning,
    signals: sized.signals,
    models: sized.models,
    orderId: execResult.orderId,
    proposalId: sized.id,
  });
  ```

- [ ] **1.3** Also log EXIT trades to Postgres

  **File:** `packages/agents/src/alphanix/pod/pod.ts`

  After successful exit (inside the `if (exitResult.success)` block, after `result.exited++` on line 186), add:
  ```typescript
  // Log exit trade
  this.db?.logTrade({
    podId: this.config.id,
    symbol: sym,
    adapter: this.adapter.id,
    side: 'SELL',
    qty: pos?.qty || 0,
    fillPrice: currentPrice,
    notional: (pos?.qty || 0) * currentPrice,
    slippage: 0,
    fees: currentPrice * (pos?.qty || 0) * 0.001,
    confidence: 0,
    reasoning: `Exit: ${exitSignal.reason} (${exitSignal.pnlPct.toFixed(2)}%)`,
    signals: [exitSignal.reason],
    models: [],
    orderId: exitResult.orderId || `exit-${Date.now()}`,
    proposalId: `exit-${sym}-${Date.now()}`,
  });
  ```

  Note: `exitResult` comes from `this.adapter.submitOrder()` which returns `OrderResult`. The `orderId` field exists on `OrderResult` (see `types.ts` line 91). For exits, use fallback ID if adapter doesn't return one.

- [ ] **1.4** Pass `db` from AlphanixAgent to Pod constructor

  **File:** `packages/agents/src/alphanix/alphanix-agent.ts`

  Move the DB initialization BEFORE pod creation. Currently `this.db` is initialized at line 101-102, but pods are created at line 84-92. Reorder:

  ```typescript
  // Postgres — move BEFORE pod creation
  this.db = new AlphanixDB();
  await this.db.connect();

  // Allocate capital and create Pod instances
  const budgets = this.allocator.allocate(enabledPods);
  for (const [id, podToml] of Object.entries(this.toml.pods)) {
    if (!podToml.enabled || !budgets[id]) continue;
    const adapter = this.registry.get(podToml.adapter)!;
    const config = toPodConfig(id, podToml);
    const pod = new Pod(config, adapter, budgets[id], this.db);  // <-- pass db
    this.pods.set(id, pod);
    this.orchestrator.registerPod(id, 'starting');
    this.log('info', `Pod created: ${id} ($${budgets[id]})`);
  }
  ```

  Remove the old DB initialization block (lines 101-102) since it's now earlier.

- [ ] **1.5** Verify — after deploy, check Postgres

  ```bash
  docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c 'SELECT count(*) FROM alphanix_trades'
  docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c 'SELECT count(*) FROM alphanix_signals'
  docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "SELECT pod_id, symbol, side, fill_price, confidence FROM alphanix_trades ORDER BY timestamp DESC LIMIT 5"
  ```

**Commit:** `fix(alphanix): wire trade+signal logging to Postgres via Pod`

---

## Task 2: Fix Nordic pods SL-loop

**Problem:** IBKR adapter's `submitOrder()` calls `this.getOHLCV(symbol, '1day', 1)` to get the fill price. This returns a cached daily candle whose close price is the previous day's close. When the exit monitor checks the same symbol, it calls `getOHLCV(symbol, '15Min', 5)` which may return a different price (intraday vs daily). The mismatch between `avgEntryPrice` (from daily candle) and `currentPrice` (from 15m candle) causes phantom PnL spikes, triggering immediate stop-loss exits.

Additionally, Yahoo Finance 15m data only updates every 15-30 minutes for Stockholm stocks, so exit checks within minutes of entry will always see stale data.

### Steps

- [ ] **2.1** Fix `submitOrder` in IBKR adapter to fetch the latest intraday price

  **File:** `packages/agents/src/alphanix/adapters/ibkr-adapter.ts`

  Replace the `submitOrder` method (lines 99-129):
  ```typescript
  async submitOrder(order: NormalizedOrder): Promise<OrderResult> {
    // Paper simulation: get the LATEST available price (prefer intraday over daily)
    try {
      // Try 15m candles first for a fresher price
      let candles = await this.getOHLCV(order.symbol, '15Min', 2);
      if (candles.length === 0) {
        // Fallback to daily if intraday not available
        candles = await this.getOHLCV(order.symbol, '1day', 1);
      }
      const price = candles.length > 0 ? candles[candles.length - 1].close : 0;
      if (price === 0) return { success: false, message: 'No price data available' };

      const orderId = `ibkr-paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fillQty = order.qty;

      const existing = this.paperPositions.get(order.symbol);
      if (order.side === 'BUY') {
        this.paperPositions.set(order.symbol, {
          qty: (existing?.qty || 0) + fillQty,
          avgPrice: price,
        });
        this.paperBalance -= price * fillQty;
      } else {
        this.paperPositions.set(order.symbol, {
          qty: Math.max(0, (existing?.qty || 0) - fillQty),
          avgPrice: existing?.avgPrice || price,
        });
        this.paperBalance += price * fillQty;
      }

      console.log(`[IbkrAdapter:PAPER] ${order.side} ${fillQty} ${order.symbol} @ ${price.toFixed(2)} SEK`);
      return { success: true, orderId, status: 'filled', filledQty: fillQty, filledAvgPrice: price };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }
  ```

  The key change: `getOHLCV(order.symbol, '15Min', 2)` instead of `getOHLCV(order.symbol, '1day', 1)`. This ensures entry price and exit price come from the same timeframe.

- [ ] **2.2** Increase minimum holding time to 30 minutes for stock adapters

  **File:** `packages/agents/src/alphanix/pod/pod.ts`

  Replace the existing minimum holding time check (lines 167-170):
  ```typescript
  // Enforce minimum holding time
  // Stock adapters (IBKR/Alpaca) have slow-updating data — need 30min minimum
  // Crypto adapters have real-time data — 5min is sufficient
  const pos = this.positions.get(sym);
  const holdingMs = pos?.enteredAt ? Date.now() - pos.enteredAt : Infinity;
  const minHoldMs = this.adapter.assetClass === 'stock' ? 30 * 60 * 1000 : 5 * 60 * 1000;
  if (holdingMs < minHoldMs && exitSignal.reason !== 'stop_loss') {
    continue;  // Too soon for non-SL exits
  }
  ```

  This changes the `5 * 60 * 1000` hard-coded value to a conditional: 30 minutes for stocks, 5 minutes for crypto. The `assetClass` property is already available on `MarketAdapter` (defined in `adapters/types.ts`).

- [ ] **2.3** Verify — check Nordic pod logs for SL-loop elimination

  ```bash
  docker logs alphanix --tail 100 | grep -E "(nordic|IBKR|EXIT|SL)"
  ```

  Before fix: repeated `EXIT ... stop_loss` lines within seconds of entry.
  After fix: exits should only appear after 30+ minutes, or on genuine stop-loss triggers.

**Commit:** `fix(alphanix): fix Nordic SL-loop — use intraday price + 30min min hold for stocks`

---

## Task 3: Fix dashboard React hydration error

**Problem:** The Alphanix dashboard (`apps/web/src/app/alphanix/page.tsx`) uses `DashboardLayout` and renders dynamic time-dependent content (e.g., `timeAgo()` which calls `Date.now()`). This causes server/client HTML mismatch because `Date.now()` returns different values on server vs client, triggering Next.js hydration errors.

The `toLocaleString()` calls on numbers also produce different output on server (Node.js ICU) vs client (browser Intl), causing additional mismatches.

### Steps

- [ ] **3.1** Add mount guard to prevent hydration mismatch

  **File:** `apps/web/src/app/alphanix/page.tsx`

  Add mounted state after the existing useState declarations (after line 106):
  ```typescript
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);
  ```

  Add early return before the main JSX (before line 132, after the variable declarations):
  ```typescript
  if (!mounted) {
    return (
      <DashboardLayout>
        <div className="max-w-2xl mx-auto space-y-4">
          {/* Loading skeleton */}
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 h-20 animate-pulse" />
            ))}
          </div>
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 h-32 animate-pulse" />
            ))}
          </div>
          <div className="flex items-center justify-center py-1 text-[10px] font-mono text-muted-foreground/40">
            Alphanix Alpha Intelligence Engine &middot; Loading...
          </div>
        </div>
      </DashboardLayout>
    );
  }
  ```

  This ensures:
  1. Server renders a static skeleton (no `Date.now()`, no `toLocaleString()`)
  2. Client first render matches the skeleton
  3. After mount, real data is displayed (fetched via `useEffect`)

- [ ] **3.2** Verify — open `/alphanix` in browser, check console for hydration errors

  Open browser DevTools console. Before fix: red "Hydration failed" warnings. After fix: clean console, skeleton flashes briefly then real data appears.

**Commit:** `fix(alphanix): add mount guard to dashboard — fix React hydration error`

---

## Task 4: Fix Alpaca authentication for US pods

**Problem:** Current `ALPACA_API_KEY` and `ALPACA_API_SECRET` env vars return 401 Unauthorized. The `AlpacaAdapter.connect()` catches the error and falls back to simulation mode (line 41), so US pods run but never actually trade on Alpaca paper.

**Root cause:** Alpaca paper trading uses different API keys than live trading. The keys must be generated at [https://app.alpaca.markets/paper/dashboard/overview](https://app.alpaca.markets/paper/dashboard/overview) specifically for the paper environment. The current env vars likely point to live keys or expired keys.

### Steps

- [ ] **4.1** Add separate paper trading env vars to Alpaca adapter

  **File:** `packages/agents/src/alphanix/adapters/alpaca-adapter.ts`

  Update the `connect()` method to try paper-specific keys first:
  ```typescript
  async connect(): Promise<void> {
    // Determine which keys to use:
    // 1. Paper-specific keys (ALPACA_PAPER_*) take priority when paper=true
    // 2. Fall back to constructor options or generic ALPACA_* keys
    // 3. If all fail, enter simulation mode
    const apiKey = this.options.paper
      ? (process.env.ALPACA_PAPER_API_KEY || this.options.apiKey || process.env.ALPACA_API_KEY)
      : (this.options.apiKey || process.env.ALPACA_API_KEY);
    const apiSecret = this.options.paper
      ? (process.env.ALPACA_PAPER_API_SECRET || this.options.apiSecret || process.env.ALPACA_API_SECRET)
      : (this.options.apiSecret || process.env.ALPACA_API_SECRET);

    if (!apiKey || !apiSecret) {
      console.warn('[AlpacaAdapter] No API keys configured, using paper simulation mode');
      this.simulationMode = true;
      return;
    }

    try {
      const Alpaca = (await import('@alpacahq/alpaca-trade-api')).default;
      this.client = new Alpaca({
        keyId: apiKey,
        secretKey: apiSecret,
        paper: this.options.paper,
      });
      // Test connection — will throw if keys are invalid
      const account = await this.client.getAccount();
      console.log(`[AlpacaAdapter] Connected to Alpaca ${this.options.paper ? 'PAPER' : 'LIVE'} (buying_power: $${account.buying_power})`);
    } catch (err: any) {
      console.warn(`[AlpacaAdapter] Connection failed (${err.message}), using paper simulation mode`);
      this.client = null;
      this.simulationMode = true;
    }
  }
  ```

- [ ] **4.2** Add paper env vars to docker-compose.prod.yml

  **File:** `docker-compose.prod.yml`

  In the `alphanix` service environment section (after line 684), add:
  ```yaml
      - ALPACA_PAPER_API_KEY=${ALPACA_PAPER_API_KEY:-}
      - ALPACA_PAPER_API_SECRET=${ALPACA_PAPER_API_SECRET:-}
  ```

  Also add the same to the `alphanix-brain` service if it needs Alpaca access.

- [ ] **4.3** Document: user action required

  The user (Joel) needs to:
  1. Go to [https://app.alpaca.markets/paper/dashboard/overview](https://app.alpaca.markets/paper/dashboard/overview)
  2. Navigate to API Keys section
  3. Generate a new Paper Trading API key pair
  4. Add to `~/cryonix/.env` on the VM:
     ```
     ALPACA_PAPER_API_KEY=PK...
     ALPACA_PAPER_API_SECRET=...
     ```
  5. Redeploy Alphanix: `bash scripts/deploy/safe-deploy.sh alphanix`

- [ ] **4.4** Verify — check adapter connection log

  ```bash
  docker logs alphanix --tail 50 | grep -i alpaca
  ```

  Before fix: `[AlpacaAdapter] Connection failed (401 Unauthorized), using paper simulation mode`
  After fix: `[AlpacaAdapter] Connected to Alpaca PAPER (buying_power: $100000.00)`

**Commit:** `fix(alphanix): support ALPACA_PAPER_* env vars for paper trading auth`

---

## Deployment Order

Execute tasks in order (1 through 4). Each task is independent and should be committed separately.

1. **Task 1** (trade persistence) — highest value, enables all future analytics
2. **Task 2** (Nordic SL-loop) — stops the bleeding on Nordic pods
3. **Task 3** (dashboard hydration) — cosmetic but affects user experience
4. **Task 4** (Alpaca auth) — requires user action (new API keys), so deploy code first

After all 4 commits, deploy:
```bash
bash scripts/deploy/safe-deploy.sh alphanix
```

Then verify all fixes:
```bash
# Task 1: trades persisted
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c 'SELECT count(*) FROM alphanix_trades'

# Task 2: no SL-loop
docker logs alphanix --tail 200 | grep -c "EXIT.*stop_loss"

# Task 3: open /alphanix in browser, check console

# Task 4: Alpaca connected (after user adds paper keys)
docker logs alphanix --tail 50 | grep -i "alpaca"
```
