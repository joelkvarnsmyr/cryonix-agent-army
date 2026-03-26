# APEX Signal Flow Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three structural problems preventing APEX from receiving confluence signals: (A) Cryonix signals consumed before APEX reads them, (B) no cross-market ecosystem mapping, (C) ambient scores too low to reach threshold.

**Architecture:** Engine publishes a broadcast copy of signals to a separate Redis key with TTL. APEX aggregator reads this instead of `trades:pending`. Copynix publishes ecosystem-level signals. Scoring weights rebalanced.

**Tech Stack:** Python (engine), TypeScript (APEX aggregator, Copynix agent), TOML config

**Spec:** Identified in audit 2026-03-22. See conversation context.

---

## File Map

```
MODIFY packages/engine/src/core/state_sync.py          # Add signals:broadcast publish
MODIFY packages/agents/src/apex/signal-aggregator.ts    # Read signals:broadcast instead of trades:pending
MODIFY packages/agents/src/copynix/copynix-agent.ts     # Add ecosystem signal to copynix:signals
MODIFY packages/agents/src/apex/confluence-scorer.ts     # Add ecosystem signal type + rebalance weights
MODIFY apex.toml                                        # Update weights + threshold
```

---

### Task 1: Engine Signal Broadcast (Fix A — CRITICAL)

**Files:**
- Modify: `packages/engine/src/core/state_sync.py:31-39`

The engine's `StateManager.request_approval()` currently does `RPUSH trades:pending`. Add a parallel write to `signals:broadcast` — a JSON array of recent signals with 5min TTL that APEX reads but nobody consumes.

- [ ] **Step 1: Read `state_sync.py`**

Verify the current `request_approval()` method at line 31-39 looks like:
```python
async def request_approval(self, signal: Dict[str, Any]):
    await self.redis.rpush("trades:pending", json.dumps(signal))
    await self.redis.publish('signals:new', json.dumps({...}))
```

- [ ] **Step 2: Add broadcast logic to `request_approval()`**

After the existing `rpush`, add a broadcast to `signals:broadcast`:

```python
async def request_approval(self, signal: Dict[str, Any]):
    """Push a trade to the approval queue and broadcast for meta-consumers."""
    signal_json = json.dumps(signal)
    await self.redis.rpush("trades:pending", signal_json)
    await self.redis.publish('signals:new', json.dumps({
        'symbol': signal.get('symbol'),
        'action': signal.get('action'),
        'confidence': signal.get('confidence'),
        'timestamp': time.time(),
    }))

    # Broadcast for APEX and other meta-consumers.
    # Unlike trades:pending (consumed by auto-trader via LREM),
    # this key persists for 5 minutes so downstream readers always
    # see the latest signals.
    try:
        existing_raw = await self.redis.get("signals:broadcast")
        existing: list = json.loads(existing_raw) if existing_raw else []
        cutoff = time.time() - 300  # 5 min window
        existing = [s for s in existing if s.get("_ts", 0) > cutoff]
        signal_copy = {**signal, "_ts": time.time()}
        existing.append(signal_copy)
        await self.redis.set("signals:broadcast", json.dumps(existing), ex=300)
    except Exception:
        pass  # Broadcast failure must never block trading
```

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/core/state_sync.py
git commit -m "feat(engine): broadcast signals to signals:broadcast for APEX consumption"
```

---

### Task 2: APEX Aggregator — Read Broadcast Key (Fix A continued)

**Files:**
- Modify: `packages/agents/src/apex/signal-aggregator.ts:94-157`

Change the Cryonix signal source from `trades:pending` (LIST, always empty) to `signals:broadcast` (STRING, JSON array, 5min TTL).

- [ ] **Step 1: Update the Redis pipeline slot**

At line 98, change:
```typescript
// BEFORE:
pipe.lrange('trades:pending', 0, -1);  // 0: CRYONIX (LIST, not string!)

// AFTER:
pipe.get('signals:broadcast');  // 0: CRYONIX (broadcast key, not consumed queue)
```

- [ ] **Step 2: Update the Cryonix parsing block (lines 122-157)**

The old code uses `val<string[]>` (list result from LRANGE). The new key is a JSON string containing an array. Replace:

```typescript
// ── 1. Cryonix — signals:broadcast (STRING with JSON array, momentary) ──
try {
    const raw = val<string>(SLOT.CRYONIX);
    if (raw) {
        const entries: unknown[] = JSON.parse(raw);
        let hasStale = false;

        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            try {
                const e = entry as Record<string, unknown>;
                const ts = (e._ts as number) ?? (e.timestamp as number) ?? now / 1000;
                if (now - toMs(ts) > momentaryMs) { hasStale = true; continue; }

                const symbol = normalizeSymbol((e.symbol as string) ?? '');
                const confidence = (e.confidence as number) ?? 0;
                const patterns: string[] = Array.isArray(e.patterns) ? e.patterns as string[] : [];

                for (const pattern of patterns) {
                    signals.push({
                        symbol, direction: 'bullish', source: 'cryonix',
                        signalType: String(pattern).toUpperCase(),
                        confidence, score: confidence, timestamp: toMs(ts),
                        temporality: 'momentary', raw: e,
                    });
                }
            } catch { /* skip malformed entry */ }
        }
        staleness['cryonix'] = hasStale && signals.filter(s => s.source === 'cryonix').length === 0;
    } else {
        staleness['cryonix'] = false;
    }
} catch (err) {
    console.warn('[apex/aggregator] Cryonix parse error:', err instanceof Error ? err.message : err);
    staleness['cryonix'] = true;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/apex/signal-aggregator.ts
git commit -m "feat(apex): read signals:broadcast instead of trades:pending"
```

---

### Task 3: Copynix Ecosystem Signal (Fix B)

**Files:**
- Modify: `packages/agents/src/copynix/copynix-agent.ts` (near line 588-607, where `copynix:signals` is published)
- Modify: `packages/agents/src/apex/signal-aggregator.ts` (Copynix parsing, lines 159-188)
- Modify: `packages/agents/src/apex/confluence-scorer.ts` (add `ecosystem_bullish` signal type)

- [ ] **Step 1: Add ecosystem field to Copynix signal publication**

In `copynix-agent.ts`, find the `copynix:signals` publish block (around line 588). Add an `ecosystem` field to each signal event:

```typescript
const signalEvent = {
    token: signal.tokenMint,
    symbol: signal.tokenSymbol,
    score: this.tomlConfig.wallets.scores[signal.wallets[0]] ?? 0,
    direction: 'buy',
    consensusLevel: signal.consensusLevel,
    walletCount: signal.walletCount,
    ecosystem: 'solana',  // NEW: ecosystem tag for cross-market mapping
    timestamp: Date.now(),
};
```

- [ ] **Step 2: Add ecosystem aggregation in APEX signal-aggregator**

After the existing Copynix per-token signal parsing (around line 180), add ecosystem-level aggregation. Insert after the `for (const entry of entries)` loop closes:

```typescript
// Ecosystem-level signal: if 2+ Solana whale buys in window → SOL bullish
const solanaSignals = signals.filter(
    s => s.source === 'copynix' && s.temporality === 'momentary'
);
if (solanaSignals.length >= 2) {
    signals.push({
        symbol: 'SOL', direction: 'bullish', source: 'copynix',
        signalType: 'ecosystem_bullish',
        confidence: Math.min(100, solanaSignals.length * 30),
        score: Math.min(100, solanaSignals.length * 30),
        timestamp: now,
        temporality: 'momentary',
        raw: { ecosystemTokens: solanaSignals.map(s => s.symbol), count: solanaSignals.length },
    });
}
```

- [ ] **Step 3: Add `ecosystem_bullish` to confluence scorer weight map**

In `confluence-scorer.ts`, find the bullish weight map and add:

```typescript
'ecosystem_bullish': { weight: 'copynix_single_whale', minField: 'confidence', minValue: 50 },
```

This reuses the `copynix_single_whale` weight (25 points) for ecosystem signals — whale activity across the Solana ecosystem signals SOL strength.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/copynix/copynix-agent.ts packages/agents/src/apex/signal-aggregator.ts packages/agents/src/apex/confluence-scorer.ts
git commit -m "feat(apex): cross-market ecosystem mapping — Solana whale activity → SOL signal"
```

---

### Task 4: Rebalance Scoring Weights (Fix C)

**Files:**
- Modify: `apex.toml` (weights + threshold)

- [ ] **Step 1: Update weights in apex.toml**

Find `[confluence.weights]` section and change these values:

```toml
# BEFORE → AFTER
psinix_coherence = 10           # → 15 (Ψnix convergence is a strong signal)
orakel_regime = 10              # → 15 (ORAKEL regime is ML-validated)
```

Find `[confluence]` section and change threshold:

```toml
# BEFORE → AFTER
min_score_half_kelly = 40       # → 35 (allow ambient-only confluence)
```

**Rationale:** With Ψnix at 15 + ORAKEL regime at 15 + BTC dom 5 = 35, pure ambient confluence can now trigger half-Kelly trades on symbols where 3 independent macro systems agree.

- [ ] **Step 2: Verify the scorer reads these weights dynamically**

Confirm in `confluence-scorer.ts` that weights are read from `config.confluence.weights` (not hardcoded). The scorer should already use config-driven weights.

- [ ] **Step 3: Commit**

```bash
git add apex.toml
git commit -m "feat(apex): rebalance scoring — increase psinix/orakel weights, lower threshold to 35"
```

---

### Task 5: Deploy and Verify

- [ ] **Step 1: Deploy engine + APEX**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build engine apex"
```

- [ ] **Step 2: Verify `signals:broadcast` is populated**

Wait 30 seconds for engine to scan, then:

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli GET signals:broadcast | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(len(d), \"signals in broadcast\")' 2>/dev/null || echo 'empty'"
```

Expected: 1+ signals in broadcast (engine scans every 10s, approved signals appear within 60s).

- [ ] **Step 3: Verify APEX reads broadcast signals**

```bash
ssh azureuser@openclaw-vm "docker logs apex --tail 10 2>&1 | grep tick"
```

Expected: `signals: N` should show Cryonix signals (previously always 0 from Cryonix source). Look for `cryonix:DIP_BUY` or `cryonix:BOLLINGER_SQUEEZE` in the signal list.

- [ ] **Step 4: Verify new threshold works**

Check if APEX now generates confluence opportunities:

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli GET apex:state | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); b=d.get(\"confluenceBoard\",[]); print(len(b), \"opportunities\"); [print(\"  >>>\", i.get(\"symbol\"), \"score=\", i.get(\"score\")) for i in b]'"
```

Expected: With broadcast signals + rebalanced weights, opportunities should appear when Cryonix detects DIP_BUY (25p) + ORAKEL bull (15p) = 40p → above new threshold of 35.

- [ ] **Step 5: Commit any deployment fixes**

```bash
git add -A && git commit -m "fix(apex): deployment adjustments"
```

---

## Review Notes

### What changes in APEX behavior after these fixes:

1. **Before:** APEX never saw Cryonix signals (consumed by auto-trader first). Now it sees them via `signals:broadcast`.
2. **Before:** Copynix whale buys on SOL memecoins gave 0 confluence to SOL/USDC. Now 2+ Solana whale buys → SOL ecosystem bullish (+25p).
3. **Before:** Ambient-only signals maxed at ~25p (below 40 threshold). Now Ψnix (15) + ORAKEL (15) + BTC dom (5) = 35 → half-Kelly trade.

### Expected trade frequency after fixes:

- **Dip Sniper mode:** When Cryonix detects DIP_BUY (25p) + ORAKEL bull regime (15p) = 40p → trade. Estimated 3-8 trades/week.
- **Ambient confluence:** Ψnix + ORAKEL + BTC dom = 35p → half-Kelly. Estimated 1-3 trades/week.
- **Ecosystem cross-market:** 2+ Solana whale buys + ORAKEL bull = 40p for SOL. Rare but valuable.

### Safety considerations:

- `signals:broadcast` write is wrapped in try/except — broadcast failure never blocks auto-trader
- New threshold 35 (from 40) uses half-Kelly sizing — conservative position sizes
- Ecosystem signal requires 2+ independent whale buys — not triggered by single transactions
