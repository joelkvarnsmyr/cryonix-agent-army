# Polynix Whale Detector Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing WhaleDetector into Polynix's directional trading loop so whale orderbook manipulation signals boost/penalize directional bets.

**Architecture:** WhaleDetector already exists and is fully functional. This plan adds it to the polynix-agent constructor, calls it during the directional scan (section 4b), and publishes whale signals to Redis. When a whale is detected accumulating one side, the directional signal for the opposite side (whale's real bet) gets a confidence boost.

**Tech Stack:** TypeScript, Polymarket CLOB API, Redis, existing Polynix agent patterns

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `packages/agents/src/polynix/polynix-agent.ts` | MODIFY | Add WhaleDetector to constructor, call in scan loop, publish to Redis |
| `packages/agents/src/polynix/whale-detector.ts` | MODIFY | Export WhaleSignal type |
| `packages/agents/src/polynix/index.ts` | MODIFY | Re-export WhaleDetector + WhaleSignal |
| `polynix.toml` | MODIFY | Add `[whale_detection]` config section |

---

### Task 1: Export WhaleSignal type and add to index

**Files:**
- Modify: `packages/agents/src/polynix/whale-detector.ts:16`
- Modify: `packages/agents/src/polynix/index.ts`

- [ ] **Step 1: Export WhaleSignal interface from whale-detector.ts**

In `whale-detector.ts`, change line 16 from:
```typescript
interface WhaleSignal {
```
to:
```typescript
export interface WhaleSignal {
```

- [ ] **Step 2: Add WhaleDetector + WhaleSignal to index.ts**

In `index.ts`, add these lines:
```typescript
export { WhaleDetector } from './whale-detector';
export type { WhaleSignal } from './whale-detector';
```

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/polynix/whale-detector.ts packages/agents/src/polynix/index.ts
git commit -m "feat(polynix): export WhaleDetector + WhaleSignal from index"
```

---

### Task 2: Add WhaleDetector to polynix-agent constructor and scan loop

**Files:**
- Modify: `packages/agents/src/polynix/polynix-agent.ts:3-53` (imports + constructor)
- Modify: `packages/agents/src/polynix/polynix-agent.ts:277-331` (section 4b directional scan)
- Modify: `packages/agents/src/polynix/polynix-agent.ts:289-306` (publishState)

- [ ] **Step 1: Add import**

At top of `polynix-agent.ts`, after the existing imports (line ~15), add:
```typescript
import { WhaleDetector } from './whale-detector';
import type { WhaleSignal } from './whale-detector';
```

- [ ] **Step 2: Add WhaleDetector as class member**

After line `private copyTracker: CopyTracker;` (line ~33), add:
```typescript
    private whaleDetector: WhaleDetector;
    private lastWhaleSignals: WhaleSignal[] = [];
```

- [ ] **Step 3: Initialize in constructor**

After `this.copyTracker = new CopyTracker(this.tomlConfig);` (line ~53), add:
```typescript
        this.whaleDetector = new WhaleDetector(this.tomlConfig.broker.clob_api_url);
```

- [ ] **Step 4: Add whale detection in section 4b (directional scan)**

In the directional scan loop (line ~284), AFTER the directional signal is evaluated but BEFORE the risk check, add whale detection. Replace the block from line 284 to ~310 with:

```typescript
            try {
                const signal = await this.directionalEngine.evaluate(market, this.spreadDetector, this.tomlConfig);
                if (signal && signal.edge > this.tomlConfig.strategy.min_edge_pct / 100) {
                    signalsFound++;

                    // Whale detection: check orderbook asymmetry
                    let whaleBoost = 0;
                    try {
                        const whale = await this.whaleDetector.detect(market);
                        if (whale && whale.confidence >= 40) {
                            this.lastWhaleSignals = this.lastWhaleSignals
                                .filter(w => w.conditionId !== whale.conditionId);
                            this.lastWhaleSignals.push(whale);
                            // Keep last 20
                            if (this.lastWhaleSignals.length > 20) {
                                this.lastWhaleSignals = this.lastWhaleSignals.slice(-20);
                            }

                            if (whale.realBet === signal.direction) {
                                // Whale agrees with our signal → boost
                                whaleBoost = Math.min(15, whale.confidence * 0.15);
                                this.log('info', `[WHALE] ${market.title}: +${whaleBoost.toFixed(0)}% boost (whale real bet=${whale.realBet}, asymmetry=${whale.asymmetryRatio}x, conf=${whale.confidence})`);
                            } else {
                                // Whale opposes our signal → penalize
                                whaleBoost = -Math.min(10, whale.confidence * 0.10);
                                this.log('info', `[WHALE] ${market.title}: ${whaleBoost.toFixed(0)}% penalty (whale real bet=${whale.realBet} vs our ${signal.direction}, asymmetry=${whale.asymmetryRatio}x)`);
                            }
                        }
                    } catch { /* whale detection non-critical */ }

                    // Apply whale boost to signal confidence
                    const adjustedConfidence = Math.max(5, Math.min(95, signal.confidence + whaleBoost));

                    const risk = this.riskManager.check(
                        signal.edge,
                        adjustedConfidence / 100,
                        this.tomlConfig,
                        this.positionTracker.getOpenCount(),
                        this.positionTracker.getExposure(),
                    );

                    if (risk.canTrade) {
                        // Bayesian check (existing)
                        const bayesAdj = this.bayesian.evaluate('directional', market.asset, signal.direction, signal.edge, market.timeToExpiry);
                        if (bayesAdj.veto) {
                            this.log('info', `DIRECTIONAL vetoed by Bayesian: ${market.title} ${signal.direction} (${bayesAdj.reasons.join(', ')})`);
                            continue;
                        }

                        const adjustedSize = risk.suggestedSize * bayesAdj.factor;
                        const tokenId = signal.direction === 'YES' ? market.yesTokenId : market.noTokenId;
                        const price = signal.direction === 'YES' ? signal.polymarketProb : (1 - signal.polymarketProb);
                        const order = await this.orderManager.placeOrder(tokenId, 'BUY', price, adjustedSize);

                        if (order.status === 'filled') {
                            const costBasis = price * adjustedSize;
                            this.positionTracker.addPosition(market, 'directional', signal.direction, price, adjustedSize, costBasis);
                            this.accountState.balance -= costBasis;
                            await this.dbLogger.logOpen(this.positionTracker.getLastAdded()!);
                            signalsExecuted++;
                            this.log('info', `DIRECTIONAL ${signal.direction}: ${market.title} | edge=${(signal.edge * 100).toFixed(2)}% | conf=${adjustedConfidence}${whaleBoost !== 0 ? ` (whale ${whaleBoost > 0 ? '+' : ''}${whaleBoost.toFixed(0)}%)` : ''} | size=$${adjustedSize.toFixed(2)}`);
                            await this.logSignal('directional', market.title, signal.edge, signal.direction, true);
                        }
                    } else {
                        this.log('info', `DIRECTIONAL blocked: ${market.title} ${signal.direction} (${risk.reason})`);
                    }
                }
            } catch (err: any) {
                this.log('warn', `Directional check error for ${market.title}: ${err.message}`);
            }
```

- [ ] **Step 5: Publish whale signals to Redis in publishState()**

In the `publishState()` method (around line ~295-318), after the existing `polynix:priors` publish, add:

```typescript
            if (this.lastWhaleSignals.length > 0) {
                await this.statePublisher.set(
                    'polynix:whale_signals',
                    JSON.stringify(this.lastWhaleSignals),
                );
            }
```

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/polynix/polynix-agent.ts
git commit -m "feat(polynix): wire WhaleDetector into directional scan loop

Whale orderbook asymmetry now boosts/penalizes directional signals:
- Whale agrees with signal → up to +15% confidence boost
- Whale opposes signal → up to -10% confidence penalty
- Signals published to Redis (polynix:whale_signals)
- Non-critical: failures silently skipped"
```

---

### Task 3: Add whale detection config to polynix.toml

**Files:**
- Modify: `polynix.toml`

- [ ] **Step 1: Add config section**

Add to end of `polynix.toml`:
```toml
[whale_detection]
enabled = true
min_confidence = 40             # Minimum whale signal confidence (0-100)
max_boost_pct = 15              # Max confidence boost when whale agrees
max_penalty_pct = 10            # Max confidence penalty when whale opposes
```

- [ ] **Step 2: Commit**

```bash
git add polynix.toml
git commit -m "chore(polynix): add whale_detection config section"
```

---

### Task 4: Deploy and verify

- [ ] **Step 1: Push code to VM**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
```

- [ ] **Step 2: Rebuild and restart Polynix**

```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build polynix"
```

- [ ] **Step 3: Verify whale detection in logs**

```bash
ssh azureuser@openclaw-vm "sleep 120 && docker logs polynix --tail 20 2>&1 | grep -E 'WHALE|whale'"
```

Expected: `[WHALE]` log lines showing asymmetry detection on directional markets.

- [ ] **Step 4: Verify Redis data**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli GET polynix:whale_signals"
```

Expected: JSON array of whale signals with conditionId, dominantSide, realBet, confidence.
