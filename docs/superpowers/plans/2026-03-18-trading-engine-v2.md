# Trading Engine V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 critical gaps in the Cryonix trading engine to improve win rate from 18.8% to 35%+

**Architecture:** Surgical changes to auto-trade/route.ts (gaps 2, 3, 5), bayesian.ts (bug fix), market_scout.py (gap 1), and monitorPositions (gap 4). All changes gated by TOML config flags.

**Tech Stack:** TypeScript (Next.js API route), Python (FastAPI engine), Redis, CCXT, Binance

**Spec:** `docs/superpowers/specs/2026-03-18-trading-engine-v2-design.md`

---

## File Map

| File | Changes | Tasks |
|------|---------|-------|
| `apps/web/src/app/api/auto-trade/route.ts` | Multiplicative confidence, softmax ranking, vol-sizing, dynamic SL | 1, 2, 3, 4 |
| `apps/web/src/lib/trading/bayesian.ts` | Fix softmax bug (confidence/100 → confidence) | 2 |
| `packages/engine/src/tanks/market_scout.py` | 5m parallel scan | 5 |
| `packages/engine/src/guilds/quant.py` | No changes (already has ATR, price_change_4h) | — |
| `cryonix.toml` | New config sections for all 5 gaps | 1-5 |

---

## Task 1: Multiplicative Confidence Model (Gap 2)

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:3498-3592`
- Modify: `cryonix.toml` (add `[confidence_model]` section)

- [ ] **Step 1: Add TOML config section**

Add to `cryonix.toml` (and on VM):
```toml
[confidence_model]
mode = "multiplicative"
max_group_modifier = 0.15
```

- [ ] **Step 2: Replace additive confidence chain with multiplicative groups**

In `auto-trade/route.ts`, replace lines 3498-3592 (the X sentiment → Smart Money → Macro → Solanix chain) with:

```typescript
      // ══════════════════════════════════════════════════════════════
      // MULTIPLICATIVE CONFIDENCE MODEL (V2)
      // Groups correlated intelligence sources. Takes max within each
      // group, then multiplies across groups. Prevents double-counting.
      // ══════════════════════════════════════════════════════════════
      if (signal.action === 'BUY') {
        const confMode = (TOML as any)?.confidence_model?.mode ?? 'multiplicative';
        const maxMod = (TOML as any)?.confidence_model?.max_group_modifier ?? 0.15;
        const baseAsset = signal.symbol.split('/')[0];

        // Collect modifiers per group
        const groupA: number[] = []; // Market Sentiment (correlated)
        const groupB: number[] = []; // Macro/Structural (correlated)
        const groupC: number[] = []; // Historical Edge (independent)

        // --- Group A: Market Sentiment ---
        // X/Twitter sentiment
        try {
          const xScore = parseInt((await redis.get(`sentiment:${baseAsset}`)) || '0');
          const strongBoost = TOML?.sentiment?.strong_bullish_boost ?? 0.08;
          const boost = TOML?.sentiment?.bullish_boost ?? 0.05;
          const penalty = TOML?.sentiment?.bearish_penalty ?? 0.05;
          if (xScore >= 3) groupA.push(strongBoost);
          else if (xScore >= 2) groupA.push(boost);
          else if (xScore <= -2) groupA.push(-penalty);
        } catch { /* unavailable */ }

        // Smart Money (Copynix)
        try {
          const smRaw = await redis.get(`smartmoney:${baseAsset}`) as string | null;
          if (smRaw) {
            const sm = JSON.parse(smRaw);
            if ((sm.score ?? 0) >= 50 && (sm.uniqueWallets ?? 0) >= 2) groupA.push(0.05);
            else if ((sm.score ?? 0) <= -50 && (sm.uniqueWallets ?? 0) >= 2) groupA.push(-0.05);
          }
        } catch { /* unavailable */ }

        // Solanix DEX (SOL-specific)
        if (signal.symbol.includes('SOL')) {
          try {
            const solanixPos = await redis.get('solanix:positions') as string | null;
            if (solanixPos) {
              const positions = JSON.parse(solanixPos);
              const solPos = positions.find((p: any) => p.symbol === 'SOL');
              if (solPos?.currentPrice && solPos?.avgEntryPrice) {
                const pnl = ((solPos.currentPrice - solPos.avgEntryPrice) / solPos.avgEntryPrice) * 100;
                if (pnl > 2) groupA.push(0.03);
                else if (pnl < -3) groupA.push(-0.03);
              }
            }
          } catch { /* unavailable */ }
        }

        // --- Group B: Macro/Structural ---
        // Polymarket
        try {
          const [pmCrypto, pmFed] = await Promise.all([
            redis.get('polymarket:crypto') as Promise<string | null>,
            redis.get('polymarket:fed') as Promise<string | null>,
          ]);
          if (pmCrypto) {
            const pc = JSON.parse(pmCrypto);
            const score = pc.score ?? 50;
            if (score < 30 && signal.patterns?.some((p: string) => ['DIP_BUY', 'DEEP_VALUE_CRASH'].includes(p))) {
              groupB.push(TOML?.polymarket?.bearish_dv_boost ?? 0.06);
            } else if (score > 75) {
              groupB.push(-(TOML?.polymarket?.euphoria_penalty ?? 0.05));
            }
          }
          if (pmFed) {
            const pf = JSON.parse(pmFed);
            const fedScore = pf.score ?? 50;
            if (fedScore > 60) groupB.push(TOML?.polymarket?.dovish_boost ?? 0.04);
            else if (fedScore < 30) groupB.push(-(TOML?.polymarket?.hawkish_penalty ?? 0.05));
          }
        } catch { /* unavailable */ }

        // Aktienix macro events
        try {
          const macroEvents = await redis.hgetall('aktienix:macro:event_states');
          if (macroEvents && Object.keys(macroEvents).length > 0) {
            for (const [, raw] of Object.entries(macroEvents)) {
              try {
                const event = JSON.parse(raw as string);
                if (event.phase === 'developing' || event.phase === 'escalating') {
                  groupB.push(-0.03);
                  break;
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* unavailable */ }

        // --- Group C: Historical Edge ---
        // Bayesian adjustment (already computed at line ~3356)
        // We read it here for the multiplicative model
        try {
          const bayesAdj = await getBayesianAdjustment(
            redis, 'cryonix',
            signal.patterns?.join(', ') || '',
            signal.symbol,
            new Date().getUTCHours(),
            String(signal.indicators?.market_regime ?? ''),
          );
          if (bayesAdj.sampleSize >= 10) {
            groupC.push(bayesAdj.confidenceModifier / 100); // convert from ±15 to ±0.15
          }
        } catch { /* unavailable */ }

        // --- Apply model ---
        if (confMode === 'multiplicative') {
          const clampMod = (v: number) => Math.max(-maxMod, Math.min(maxMod, v));
          const modA = clampMod(groupA.length > 0 ? groupA.reduce((best, v) => Math.abs(v) > Math.abs(best) ? v : best, 0) : 0);
          const modB = clampMod(groupB.length > 0 ? groupB.reduce((best, v) => Math.abs(v) > Math.abs(best) ? v : best, 0) : 0);
          const modC = clampMod(groupC.length > 0 ? groupC[0] : 0);

          const oldConf = signal.confidence;
          signal.confidence = signal.confidence * (1 + modA) * (1 + modB) * (1 + modC);
          signal.confidence = Math.max(0, Math.min(0.95, signal.confidence));

          if (Math.abs(signal.confidence - oldConf) > 0.001) {
            console.log(`[CONF-V2] ${signal.symbol}: ${(oldConf * 100).toFixed(0)}% → ${(signal.confidence * 100).toFixed(0)}% (A=${(modA * 100).toFixed(1)}% B=${(modB * 100).toFixed(1)}% C=${(modC * 100).toFixed(1)}%)`);
          }
        } else {
          // Fallback: additive (old behavior) — keep existing chain
          // ... (preserve old code as dead path behind config flag)
        }
      }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts cryonix.toml
git commit -m "feat(cryonix): multiplicative confidence model (V2 Gap 2)"
```

---

## Task 2: Bayesian Signal Ranking + Kelly Sizing (Gap 5)

**Files:**
- Modify: `apps/web/src/lib/trading/bayesian.ts:237` (bug fix)
- Modify: `apps/web/src/app/api/auto-trade/route.ts:3333` (ranking)
- Modify: `apps/web/src/app/api/auto-trade/route.ts:2452` (Kelly sizing)
- Modify: `cryonix.toml` (add `[bayesian]` config)

- [ ] **Step 1: Fix softmax bug in bayesian.ts**

In `bayesian.ts` line 237, change:
```typescript
// BEFORE (bug: confidence is 0-1, not 0-100):
return { sig, ev: sig.confidence / 100 };

// AFTER:
return { sig, ev: sig.confidence };
```

- [ ] **Step 2: Add TOML config**

```toml
[bayesian]
use_softmax_ranking = true
use_kelly_sizing = true
softmax_temperature = 2.0
min_observations_for_kelly = 10
```

- [ ] **Step 3: Wire softmax ranking into signal processing**

In `auto-trade/route.ts`, replace line 3333:
```typescript
// BEFORE:
parsed.sort((a, b) => (b.signal.confidence || 0) - (a.signal.confidence || 0));

// AFTER:
const useSoftmax = (TOML as any)?.bayesian?.use_softmax_ranking ?? false;
if (useSoftmax) {
  try {
    const ranked = await rankSignalsBySoftmax(
      redis, 'cryonix',
      parsed.map(p => ({ ...p.signal, pattern: p.signal.patterns?.join(', ') || '' })),
      (TOML as any)?.bayesian?.softmax_temperature ?? 2.0,
    );
    // Re-map ranked signals back to parsed format
    const rankedSymbols = ranked.map(s => s.symbol);
    parsed.sort((a, b) => {
      const idxA = rankedSymbols.indexOf(a.signal.symbol);
      const idxB = rankedSymbols.indexOf(b.signal.symbol);
      return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
    });
    console.log(`[BAYES-RANK] Softmax order: ${parsed.slice(0, 5).map(p => p.signal.symbol).join(' > ')}`);
  } catch (e) {
    console.warn('[BAYES-RANK] Softmax failed, falling back to confidence sort:', e);
    parsed.sort((a, b) => (b.signal.confidence || 0) - (a.signal.confidence || 0));
  }
} else {
  parsed.sort((a, b) => (b.signal.confidence || 0) - (a.signal.confidence || 0));
}
```

- [ ] **Step 4: Wire Bayesian Kelly into position sizing**

In `calculatePositionSize()` (line 2452), after the RR-Kelly calculation:
```typescript
  const kellyFraction = Math.max(0, ((p * b - q) / b) * (TOML?.capital.kelly_fraction_multiplier ?? 0.5));

  // Bayesian Kelly: use historical win rate if sufficient data
  const useBayesKelly = (TOML as any)?.bayesian?.use_kelly_sizing ?? false;
  if (useBayesKelly) {
    try {
      const bayesAdj = await getBayesianAdjustment(
        redis, 'cryonix',
        signal.patterns?.join(', ') || '',
        signal.symbol,
      );
      const minObs = (TOML as any)?.bayesian?.min_observations_for_kelly ?? 10;
      if (bayesAdj.kellyFraction > 0 && bayesAdj.sampleSize >= minObs) {
        const bayesKelly = bayesAdj.kellyFraction;
        const effectiveKelly = Math.min(bayesKelly, kellyFraction);
        console.log(`[KELLY] ${signal.symbol}: RR-Kelly=${(kellyFraction * 100).toFixed(1)}% Bayes-Kelly=${(bayesKelly * 100).toFixed(1)}% → ${(effectiveKelly * 100).toFixed(1)}%`);
        // Use the more conservative of the two
        let positionValue = Math.min(capital * effectiveKelly, maxPositionValue);
        if (positionValue < CONFIG.MIN_ORDER_VALUE && availableBudget >= CONFIG.MIN_ORDER_VALUE) {
          positionValue = CONFIG.MIN_ORDER_VALUE;
        }
        if (!signal.entry_price || signal.entry_price <= 0) return 0;
        return positionValue / signal.entry_price;
      }
    } catch { /* Bayesian unavailable, fall through to RR-Kelly */ }
  }

  let positionValue = Math.min(capital * kellyFraction, maxPositionValue);
```

- [ ] **Step 5: Add import for rankSignalsBySoftmax**

Verify line 10 of route.ts already imports it:
```typescript
import { updatePosterior, getBayesianAdjustment } from '@/lib/trading/bayesian';
```
Add `rankSignalsBySoftmax`:
```typescript
import { updatePosterior, getBayesianAdjustment, rankSignalsBySoftmax } from '@/lib/trading/bayesian';
```

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit --project apps/web/tsconfig.json
git add apps/web/src/lib/trading/bayesian.ts apps/web/src/app/api/auto-trade/route.ts cryonix.toml
git commit -m "feat(cryonix): Bayesian softmax ranking + Kelly sizing (V2 Gap 5)"
```

---

## Task 3: Volatility-Adjusted Position Sizing (Gap 3)

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:2453` (in calculatePositionSize)
- Modify: `cryonix.toml` (add `[sizing]` section)

- [ ] **Step 1: Add TOML config**

```toml
[sizing]
vol_adjusted = true
baseline_atr_pct = 0.3
min_vol_factor = 0.5
max_vol_factor = 1.5
```

- [ ] **Step 2: Add vol-factor after Kelly sizing**

In `calculatePositionSize()`, after `let positionValue = ...` (line ~2453), add:

```typescript
  // Volatility-adjusted sizing: scale inversely with ATR
  const volAdjusted = (TOML as any)?.sizing?.vol_adjusted ?? false;
  if (volAdjusted) {
    const atrPct = Number(signal.indicators?.atr_percent ?? 0);
    const baseline = (TOML as any)?.sizing?.baseline_atr_pct ?? 0.3;
    const minFactor = (TOML as any)?.sizing?.min_vol_factor ?? 0.5;
    const maxFactor = (TOML as any)?.sizing?.max_vol_factor ?? 1.5;

    let volFactor: number;
    if (atrPct <= 0) {
      volFactor = 1.0; // no data = no adjustment (safe default)
    } else {
      volFactor = baseline / atrPct;
      volFactor = Math.max(minFactor, Math.min(maxFactor, volFactor));
    }

    const beforeVol = positionValue;
    positionValue = positionValue * volFactor;
    if (volFactor !== 1.0) {
      console.log(`[VOL-SIZE] ${signal.symbol}: ATR=${atrPct.toFixed(2)}% factor=${volFactor.toFixed(2)} $${beforeVol.toFixed(2)} → $${positionValue.toFixed(2)}`);
    }
  }
```

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit --project apps/web/tsconfig.json
git add apps/web/src/app/api/auto-trade/route.ts cryonix.toml
git commit -m "feat(cryonix): volatility-adjusted position sizing (V2 Gap 3)"
```

---

## Task 4: Dynamic Stop-Loss (Gap 4)

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:1300-1315` (monitorPositions)
- Modify: `cryonix.toml` (add dynamic_sl config)

- [ ] **Step 1: Add TOML config**

```toml
[exits]
dynamic_sl = true
max_sl_move_per_cycle_pct = 0.5
atr_cache_ttl_seconds = 60
```

- [ ] **Step 2: Add ATR fetch helper**

Add near the top of auto-trade/route.ts (after other helper functions):

```typescript
// ATR cache for dynamic SL (avoids hammering Binance API)
const atrCache = new Map<string, { atr: number; timestamp: number }>();

async function fetchCurrentATR(symbol: string): Promise<number | null> {
  const ttl = (TOML as any)?.exits?.atr_cache_ttl_seconds ?? 60;
  const cached = atrCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < ttl * 1000) return cached.atr;

  try {
    const ex = getExchange();
    const ohlcv = await ex.fetchOHLCV(symbol, '15m', undefined, 15);
    if (!ohlcv || ohlcv.length < 14) return null;

    // Calculate ATR from OHLCV
    let atrSum = 0;
    for (let i = 1; i < ohlcv.length; i++) {
      const high = ohlcv[i][2];
      const low = ohlcv[i][3];
      const prevClose = ohlcv[i - 1][4];
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      atrSum += tr;
    }
    const atr = atrSum / (ohlcv.length - 1);
    atrCache.set(symbol, { atr, timestamp: Date.now() });
    return atr;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Add dynamic SL logic in monitorPositions**

In monitorPositions, BEFORE the SL check at line 1306, add:

```typescript
          // Dynamic SL: recalculate with current ATR (V2 Gap 4)
          const dynamicSlEnabled = (TOML as any)?.exits?.dynamic_sl ?? false;
          if (dynamicSlEnabled && pos.side !== 'SELL') {
            try {
              const currentATR = await fetchCurrentATR(pos.symbol);
              if (currentATR && currentATR > 0) {
                const slMultiplier = TOML?.exits?.sl_atr_multiplier ?? 5.0;
                const dynamicSL = pos.entryPrice - (currentATR * slMultiplier);
                const maxMovePct = (TOML as any)?.exits?.max_sl_move_per_cycle_pct ?? 0.5;
                const maxMove = pos.entryPrice * (maxMovePct / 100);

                // SL ratchets UP only, max movement per cycle
                if (dynamicSL > pos.stopLoss) {
                  const newSL = Math.min(dynamicSL, pos.stopLoss + maxMove);
                  if (newSL > pos.stopLoss) {
                    console.log(`[DYNAMIC-SL] ${pos.symbol}: SL ${pos.stopLoss.toFixed(4)} → ${newSL.toFixed(4)} (ATR=$${currentATR.toFixed(4)})`);
                    pos.stopLoss = newSL;
                  }
                }
              }
            } catch { /* ATR unavailable — keep static SL */ }
          }
```

- [ ] **Step 4: Store original SL at position creation**

In `executeBuy()` where position is created (~line 2570), add `originalSL` field:
```typescript
originalSL: signal.stop_loss,  // audit trail for dynamic SL
entryATR: signal.indicators?.atr ?? 0,
```

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit --project apps/web/tsconfig.json
git add apps/web/src/app/api/auto-trade/route.ts cryonix.toml
git commit -m "feat(cryonix): dynamic stop-loss with ATR recalculation (V2 Gap 4)"
```

---

## Task 5: 5-Minute Parallel Scan (Gap 1)

**Files:**
- Modify: `packages/engine/src/tanks/market_scout.py:43-87` (scan_market)
- Modify: `cryonix.toml` (add fast_scan config)

- [ ] **Step 1: Add TOML config**

```toml
[engine]
fast_scan_enabled = true
fast_scan_timeframe = "5m"
fast_scan_patterns = ["DIP_BUY", "BOLLINGER_SQUEEZE"]
fast_scan_min_confidence = 0.70
fast_scan_cooldown_seconds = 300
fast_scan_min_atr_pct = 0.2
fast_scan_max_signals_per_cycle = 3
```

- [ ] **Step 2: Add fast scan in market_scout.py**

In `analyze_signal()` method, after the primary 15m analysis (line ~120), add:

```python
        # ── Fast 5m scan (V2 Gap 1) ──────────────────────────────────────
        fast_enabled = get_toml('engine', 'fast_scan_enabled', False)
        if fast_enabled and analysis['status'] == 'success':
            fast_tf = get_toml('engine', 'fast_scan_timeframe', '5m')
            fast_patterns = get_toml('engine', 'fast_scan_patterns', ['DIP_BUY', 'BOLLINGER_SQUEEZE'])
            fast_min_conf = get_toml('engine', 'fast_scan_min_confidence', 0.70)
            fast_min_atr = get_toml('engine', 'fast_scan_min_atr_pct', 0.2)

            try:
                fast_ohlcv = market_data.fetch_ohlcv(symbol=symbol, timeframe=fast_tf, limit=50)
                if fast_ohlcv and len(fast_ohlcv) >= 30:
                    fast_analysis = quant.analyze(fast_ohlcv, symbol)
                    if fast_analysis.get('status') == 'success':
                        fast_signal = fast_analysis.get('signal', {})
                        fast_pattern_names = [p['pattern'] for p in fast_analysis.get('patterns', [])]
                        fast_atr_pct = fast_analysis.get('indicators', {}).get('atr_percent', 0)

                        # Filter: only allowed patterns, min confidence, min ATR
                        eligible = [p for p in fast_pattern_names if p in fast_patterns]
                        if (eligible
                            and fast_signal.get('confidence', 0) >= fast_min_conf
                            and fast_atr_pct >= fast_min_atr
                            and fast_signal.get('action') == 'BUY'):
                            # Tag as fast scan signal
                            fast_signal['source'] = 'fast_5m'
                            fast_signal['patterns'] = eligible
                            print(f"[{self.name}] {symbol} FAST 5m: {'+'.join(eligible)} conf={fast_signal['confidence']:.0%}")
                            # Store as alternative signal if stronger than 15m
                            state['fast_signal'] = fast_signal
                            state['fast_indicators'] = fast_analysis.get('indicators', {})
            except Exception as e:
                print(f"[{self.name}] Fast scan failed for {symbol}: {e}")
```

- [ ] **Step 3: Emit fast signals to Redis queue**

In the `execute_action` method (or wherever signals are pushed to Redis), add logic to also push `fast_signal` if present:

```python
        # Push fast signal if present and different from primary
        fast_signal = state.get('fast_signal')
        if fast_signal and fast_signal.get('action') == 'BUY':
            fast_signal['symbol'] = symbol
            fast_signal['indicators'] = state.get('fast_indicators', {})
            fast_signal['source'] = 'fast_5m'
            # Use cooldown to prevent flooding
            cooldown_key = f"fast_scan_cooldown:{symbol}"
            cooldown = get_toml('engine', 'fast_scan_cooldown_seconds', 300)
            # Check cooldown via Redis
            if not await self.redis_client.exists(cooldown_key):
                await self.redis_client.lpush('trades:pending', json.dumps(fast_signal))
                await self.redis_client.set(cooldown_key, '1', ex=cooldown)
                print(f"[{self.name}] {symbol} FAST signal queued: {fast_signal['patterns']}")
```

- [ ] **Step 4: Verify Python syntax**

```bash
docker exec cryonix-engine-1 python3 -c "import ast; ast.parse(open('/app/src/tanks/market_scout.py').read()); print('OK')"
```

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/tanks/market_scout.py cryonix.toml
git commit -m "feat(engine): 5-minute parallel scan for fast dip detection (V2 Gap 1)"
```

---

## Deploy Sequence

- [ ] **Step 1: Push all code to VM**
```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
```

- [ ] **Step 2: Update TOML on VM** (ensure git archive doesn't overwrite VM-specific values)
```bash
ssh azureuser@openclaw-vm "grep max_position_size_pct ~/cryonix/cryonix.toml"
# Verify 0.45 (not reverted to 0.35)
```

- [ ] **Step 3: Rebuild and restart**
```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build web engine && docker exec cryonix-redis-1 redis-cli DEL instance:trading_lock && docker compose -f docker-compose.prod.yml restart auto-trader"
```

- [ ] **Step 4: Verify deployment**
```bash
ssh azureuser@openclaw-vm "docker logs cryonix-auto-trader-1 --tail 10"
# Look for: [CONF-V2], [BAYES-RANK], [VOL-SIZE], [DYNAMIC-SL]
ssh azureuser@openclaw-vm "docker logs cryonix-engine-1 --tail 10"
# Look for: FAST 5m
```

- [ ] **Step 5: Monitor for 30 minutes**
```bash
# Watch for any errors or unexpected behavior
ssh azureuser@openclaw-vm "docker logs cryonix-auto-trader-1 -f --since 1m"
```
