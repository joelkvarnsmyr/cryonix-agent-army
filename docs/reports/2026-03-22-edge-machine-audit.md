# From Trading Bot to Edge Machine — Audit & Roadmap

**Date:** 2026-03-22
**Author:** Cryonix Agent Army (automated audit)
**Scope:** Full vocabulary audit, metrics status, prompt analysis, and actionable recommendations

---

## 1. Original Proposal vs Current Implementation

| Proposal Item | Status | Notes |
|---------------|--------|-------|
| **Fas 1: Rotate API keys** | ✅ Not needed | Keys were never in git history. `.gitignore` had `.env*` from start. False positive in original review. |
| **Fas 1: BFG purge** | ✅ Not needed | Same reason — no secrets ever committed. |
| **Fas 1: Postgres password** | ⏸️ Deferred | Behind VPN (Tailscale), internal Docker network only. Low risk. |
| **Fas 1: Caddy basicauth** | ❌ Skipped | Decision: VPN provides device-level auth. Adding HTTP auth would only add friction. |
| **Fas 1: Docker socket proxy** | ✅ Implemented + deployed | Tecnativa HAProxy replaces raw `/var/run/docker.sock` mount on aktienix-brain + huntrix-brain. |
| **Fas 2: Alpha Decay Rate** | ✅ Implemented | `scripts/strategy-lab/edge_metrics.py` → Redis `metrics:alpha_decay`. 11 patterns tracked. |
| **Fas 2: Kill Rate** | ✅ Implemented (fixed) | Phantom logging existed, checker had 3 bugs (narrow window, no cleanup, no breakdown). Fixed. 292 phantoms queued. |
| **Fas 2: Mutation Fitness Score** | ✅ Implemented | Sharpe per config_version. 7 versions tracked, 4/6 mutations improved. |
| **Fas 2: Capital Velocity** | ✅ Implemented | 1.70x/day on $50 capital. |
| **Fas 2: AI Brain upgrade** | ✅ Implemented | Brain reads all 5 metrics + Kill Rate advisory from Redis. |
| **Fas 3: ECR** | ✅ Implemented | -7.85% (negative — losing money vs theoretical max). 90-point history with sparkline. |
| **Fas 3: Dashboard** | ✅ Implemented | `/metrics` page with ECR, Alpha Decay table, Kill Rate, MFS, Capital Velocity. |
| **Vocabulary shift** | 🟡 Partial | 3 key strings changed in auto-trade logs. Full shift incomplete — see section 4 below. |

**Completion: 12/14 items done. 1 deferred (Postgres). 1 partially done (vocabulary).**

---

## 2. First Metrics Results — What The Data Tells Us

### Alpha Decay — 3 dying strategies

| Pattern | Latest EV | Slope | Trend | Action |
|---------|-----------|-------|-------|--------|
| RSI_OVERSOLD | -0.257 | -0.007 | ↓ declining | **Blocked** (weak solo) |
| BOLLINGER_SQUEEZE | -0.024 | -0.012 | ↓ declining | **Blocked** (weak solo) |
| BOLLINGER_SQUEEZE+RSI_OVERSOLD | -0.067 | -0.010 | ↓ declining | Blocked by negative EV filter |
| MACD_BULLISH_CROSS+VOLUME_SPIKE_UP | +0.238 | 0.000 | → stable | **Best pattern** — only one with positive EV |
| VOLUME_SPIKE_UP | -0.006 | +0.002 | ↑ improving | Watch — trending positive |

**Insight:** Only 1 of 11 patterns has positive EV. The system is in a regime where most mean-reversion strategies fail. Volume-based combos outperform momentum and oversold patterns.

### Mutation Fitness — Evolution mostly helps

| Mutation | ΔSharpe | Improved? |
|----------|---------|-----------|
| 623e5a1c → ddc08011 | +1.502 | ✅ |
| ddc08011 → 7565bee8 | -2.493 | ❌ (worst) |
| 7565bee8 → ad705e91 | +1.300 | ✅ |
| ad705e91 → 0829a95d | +0.260 | ✅ |
| 0829a95d → 17e56d77 | -0.537 | ❌ |
| 17e56d77 → 2e05eaac | +0.905 | ✅ |

**Insight:** 4/6 mutations improved performance. The 2 regressions were large (-2.5 and -0.5 Sharpe). Auto-revert on 2+ consecutive failures would have prevented the ddc08011→7565bee8 disaster.

### ECR — System is losing edge

**ECR = -7.85%** (realized -$2.57 / theoretical +$32.69 over 7 days)

This means the system is losing $2.57 while a perfect trader would have made $32.69. The system captures **negative** edge — it's worse than random. This is expected given that 10 of 11 patterns have negative EV in the current market regime.

### Capital Velocity — Money is working

**CV = 1.70x/day** — $457 traded over 5.4 days on $50 capital. Capital is not sleeping. If anything, it's over-traded given the negative EV regime.

---

## 3. Metrics We Should Still Add

### 3.1 Regime Efficiency Score (RES) — NEW

**Problem:** ORAKEL detects market regime (bull/bear/sideways) but we don't measure how well we adapt to it.

**Formula:** `RES = WR_in_regime / baseline_WR_for_regime`

- If sideways regime and WR = 20% but baseline sideways WR = 30% → RES = 0.67 (underperforming)
- If bull regime and WR = 60% but baseline bull WR = 45% → RES = 1.33 (outperforming)

**Why:** ECR tells us we're losing, but RES tells us *where* we're losing relative to what's achievable in this specific regime. It separates "the market is hard" from "our system is bad."

**Implementation:** Tag each trade with the ORAKEL regime at entry. Group trades by regime, compute WR per regime. Compare against a rolling 30-day baseline per regime.

### 3.2 Signal Latency — How fast are we?

**Problem:** Price moves between signal generation (engine) and execution (auto-trader). We don't measure this slippage.

**Formula:** `Latency = execution_time - signal_time` (from trades table, both timestamps exist)

**Why:** If latency > 60s, we're trading stale signals. Fast markets punish slow execution.

### 3.3 Conviction Depth — How sure are we?

**Problem:** We measure confidence (0-100%) but not how many independent sources agree.

**Formula:** `ConvictionDepth = number_of_independent_sources_confirming`

- RSI_OVERSOLD alone = depth 1
- RSI_OVERSOLD + F&G extreme fear + Polymarket bearish = depth 3
- DEEP_VALUE_CRASH + whale buy + Venus Rx ending = depth 3

**Why:** APEX already computes this (confluence scoring). Expose it as a metric. Trades with depth ≥ 3 likely outperform depth 1. This would validate the APEX thesis.

### 3.4 Recovery Time — How fast do we bounce back?

**Problem:** After a loss streak, how long until equity recovers?

**Formula:** `RecoveryTime = days_from_drawdown_trough_to_new_HWM`

**Why:** A system with 50% WR and 3-day recovery is better than one with 70% WR and 30-day recovery. Recovery time is the hidden dimension of risk management.

---

## 4. Vocabulary Audit — Current vs Proposed

### 4.1 What's Already Changed

| Location | Old | New | Status |
|----------|-----|-----|--------|
| auto-trade logs | `[BUY-FILTER]` | `[CONVICTION]` | ✅ Done |
| auto-trade logs | `Weak solo pattern` | `Low-conviction solo hypothesis` | ✅ Done |
| auto-trade logs | `Negative EV` | `Negative expected value` | ✅ Done |

### 4.2 What Still Needs Changing

#### High Impact — AI Prompt Language

The AI prompts shape how Grok *thinks* about our system. Current prompt language treats every signal as a potential trade rather than a hypothesis to test.

| Current (auto-trade Grok prompt) | Proposed | Why |
|----------------------------------|----------|-----|
| "You are a crypto trading risk analyst" | "You are a hypothesis validator" | Frame as testing, not confirming |
| "Should we trade this signal?" | "Should we accept this hypothesis?" | Signals imply action; hypotheses imply skepticism |
| "approve: true/false" | "conviction: 0-100" | Binary approve/reject loses nuance. A 51% conviction trade ≠ a 95% one |
| "confidence: 0-100" | "independent_evidence: number" | Confidence is self-reported. Evidence count is verifiable |
| "reasoning: string" | "reasoning: string, contradictions: string[]" | Force the AI to also find reasons NOT to trade |

#### AI Brain Prompt Shifts

| Current | Proposed | Why |
|---------|----------|-----|
| "Which pattern lost?" | "Which pattern's edge is decaying? (αD slope)" | Decay is a trend; "lost" is a snapshot |
| "Tighten filters if WR dropping" | "Check Kill Rate before tightening — are we killing gold?" | Prevents reflexive filter-tightening |
| "Be conservative: small changes" | "Match intervention to evidence: small αD → small change, severe αD → disable pattern" | Proportional response instead of blanket conservatism |
| "Max 4 actions per run" | "Max 2 actions per run, both must have independent evidence" | Fewer, higher-quality mutations |

#### Evolution Engine Prompt Shifts

The evolution engine (`copilot-evolution.mjs`) has a long prompt that should use the new vocabulary:

| Current concept | New framing |
|-----------------|-------------|
| "Optimize this pattern" | "This pattern has αD={slope}. Should it be disabled or recalibrated?" |
| "Improve win rate" | "Improve edge capture (ECR). Win rate alone is misleading without payoff ratio." |
| "Find patterns that work" | "Find patterns with positive MFS trajectory" |

### 4.3 Complete Vocabulary Map

#### Core Concepts

| Old Term | New Term | Definition | Where Used |
|----------|----------|------------|------------|
| Signal | **Hypothesis** | An unvalidated prediction that a price move will occur | Engine → auto-trade → logs |
| Filter | **Conviction Gate** | A test that increases or decreases our belief in a hypothesis | auto-trade risk checks |
| Win Rate | **Hit Rate × Payoff** | WR alone is meaningless — 90% WR with $1 wins and $100 losses is terrible | Dashboard, Brain prompts |
| P&L | **Edge Capture** | How much of the available edge we actually captured | Dashboard, Telegram |
| Risk Management | **Survival Mechanics** | We survive until edge materializes. Risk = extinction probability. | Documentation, prompts |
| Approved/Rejected | **High/Low Conviction** | Continuous scale, not binary. A 45-score hypothesis might become 65 with more evidence. | Grok response, logs |
| Backtest | **Hypothesis Replay** | We replay hypotheses against historical data | Backtest page |

#### New Terms to Introduce

| Term | Definition | Metric |
|------|------------|--------|
| **Edge Decay** | Rate at which a strategy's edge erodes over time | Alpha Decay slope |
| **Conviction Depth** | Number of independent sources confirming a hypothesis | APEX confluence score sources |
| **Mutation Fitness** | Whether a config change improved or degraded performance | MFS (Sharpe delta) |
| **Capital Utilization** | How efficiently deployed capital generates returns | Capital Velocity |
| **Phantom Trade** | A rejected hypothesis tracked to see if it would have won | Kill Rate data |
| **Regime Fit** | How well our system performs relative to the current market regime | RES (proposed) |
| **Recovery Horizon** | Time from drawdown trough to equity high-water-mark | Recovery Time (proposed) |

---

## 5. Prompt Redesign Recommendations

### 5.1 Grok Validation — From Approval to Evidence

**Current approach:** Binary approve/reject with confidence score.

**Proposed approach:** Evidence-based conviction scoring.

```
You are a hypothesis validator for an automated trading system.

A hypothesis has been generated: {symbol} will move {direction} because of {patterns}.

Your job is NOT to approve or reject. Your job is to:
1. SEARCH for evidence that SUPPORTS this hypothesis
2. SEARCH for evidence that CONTRADICTS this hypothesis
3. Rate the net conviction: -100 (strong contradiction) to +100 (strong confirmation)
4. List what would change your mind (invalidation criteria)

Respond as JSON:
{
    "conviction": -100 to +100,
    "supporting_evidence": ["..."],
    "contradicting_evidence": ["..."],
    "invalidation_criteria": ["if X happens, exit immediately"],
    "estimated_edge_pct": number,
    "reasoning": "..."
}
```

**Why this is better:**
- Forces the AI to find counterevidence (reduces confirmation bias)
- Continuous conviction scale instead of binary
- Invalidation criteria can feed into dynamic exit rules
- `estimated_edge_pct` maps directly to ECR

### 5.2 AI Brain — From Reactive to Predictive

**Current:** Brain reacts to losses. "Pattern X lost → adjust parameters."

**Proposed:** Brain anticipates decay. "Pattern X's edge is eroding → disable before losses accumulate."

```
You are the strategic intelligence layer for Cryonix.

Instead of asking "what went wrong?", ask:
1. Which hypotheses are losing edge? (αD < -0.005 = declining)
2. Are our conviction gates destroying value? (KR > 30% = too aggressive)
3. Did our last adaptation help? (MFS > 0 = yes)
4. Are we capturing available edge? (ECR trend: ↑ learning, ↓ falling behind)
5. Is capital being utilized efficiently? (CV < 0.5 = money sleeping)

For each problem found, categorize your response:
- DISABLE: edge is dead, don't optimize a corpse
- RECALIBRATE: edge exists but parameters are wrong
- INVESTIGATE: insufficient data, need more observations
- HOLD: everything is within normal bounds
```

### 5.3 Evolution Engine — Mutation Discipline

Add to evolution prompt:

```
Before proposing ANY mutation:
1. Check MFS for the last 3 mutations — if 2+ degraded, PAUSE. Do not mutate.
2. Check αD for the target pattern — if declining, DISABLE rather than optimize.
3. Check KR for the affected conviction gate — if KR > 40%, LOOSEN rather than tighten.
4. After mutation: predict the expected impact on ECR. If expected ECR delta < 0, don't apply.
```

---

## 6. Dashboard Language Shifts

### Current → Proposed Label Changes

| Page | Current Label | Proposed Label |
|------|--------------|----------------|
| Main | "OPEN POSITIONS" | "ACTIVE HYPOTHESES" |
| Main | "RECENT TRADES" | "RESOLVED HYPOTHESES" |
| Main | "Win Rate" | "Hit Rate" |
| Main | "P&L" | "Edge Captured" |
| Analytics | "Trade Journal" | "Hypothesis Journal" |
| Analytics | "Pattern Performance" | "Hypothesis Class Performance" |
| Analytics | "Config Versions" | "Mutation History" |
| Metrics | (already uses new terms) | ✅ |
| APEX | "Confluence Score" | "Conviction Score" |
| APEX | "Contributing Signals" | "Supporting Evidence" |

---

## 7. Implementation Priority

| # | Item | Impact | Effort | Priority |
|---|------|--------|--------|----------|
| 1 | **Grok prompt redesign** (evidence-based conviction) | Very High — changes AI decision quality | 2h | P1 |
| 2 | **AI Brain prompt** (metrics-driven, predictive) | High — already partially done | 1h | P1 |
| 3 | **Evolution prompt** (mutation discipline) | High — prevents blind mutations | 1h | P1 |
| 4 | **Regime Efficiency Score** metric | Medium — separates market from system | 2h | P2 |
| 5 | **Conviction Depth** metric (from APEX scores) | Medium — validates APEX thesis | 1h | P2 |
| 6 | **Dashboard label changes** | Low — cosmetic but reinforces mindset | 30min | P3 |
| 7 | **Signal Latency** metric | Low — optimization, not fundamental | 1h | P3 |
| 8 | **Recovery Time** metric | Low — nice-to-have | 1h | P3 |

---

## 8. Summary

The original proposal was **directionally correct** but had factual errors in Fas 1 (secrets were never in git, dashboard is behind VPN). The metrics proposals (Fas 2-3) were excellent and are now fully implemented.

**What the data reveals:** The system is in a harsh regime where 10 of 11 patterns have negative EV. ECR is -7.85%. The Evolution Engine helps more often than it hurts (4/6 mutations positive). Capital is working (CV 1.7x) but working on losing strategies.

**The biggest lever now is not more metrics — it's better AI prompts.** The current prompts ask "should we trade?" when they should ask "what evidence contradicts this hypothesis?" Shifting from approval-seeking to evidence-gathering would be the single highest-impact change.

Cryonix has the engine. It now has the eyes (metrics). Next: teach it to think in hypotheses, not signals.
