# Vedic Next Iteration — Bayes Calibration + Entry Threshold + Coherence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Bayes P(up) over-confidence (99.6% → realistic), raise entry threshold to avoid Mercury Rx entries, and add Kuramoto coherence-based position sizing.

**Architecture:** Three independent improvements to the vedic trading system. Bayes fix reduces prior weight so live trades dominate faster. Entry threshold prevents early entries. Kuramoto measures signal synchronization — when multiple V4 signals agree, position size increases exponentially (from Copynix psi-engine pattern).

**Tech Stack:** Python 3.11, pyswisseph, Redis, Next.js (dashboard)

---

### Task 1: Fix Bayes Over-Confidence

Research priors start at (65, 35) for bullish signals = 1000 pseudo-observations. With only 4 real trades, priors dominate completely → P(up)=99.6% which is unrealistic.

**Fix:** Reduce all research priors by 10x (from ~100 total counts to ~10). This means real trades shift the posterior much faster.

**Files:**
- Modify: `packages/engine/src/vedic/bayesian.py:112-180` (RESEARCH_PRIORS)
- Modify: `packages/engine/src/vedic/bayesian.py:227-230` (base rate counts)

- [ ] **Step 1: Write test for calibrated Bayes**

Create file `packages/engine/src/vedic/__tests__/test_bayesian.py`:

```python
"""Test Bayesian calibration — priors should not dominate with few trades."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))

from src.vedic.bayesian import BayesianVedic

def test_prior_does_not_dominate():
    """With 0 real trades, P(up) should be 50-70%, not 99%."""
    b = BayesianVedic()
    b.initialize_from_research()
    prob, details = b.predict({
        "venus_rx": False, "mercury_rx": False, "n_retrogrades": 0,
        "jup_sat_tight": False, "mars_rahu_tight": True,
        "merc_venus_tight": False, "merc_speed_fast": False,
        "venus_speed_fast": True, "venus_near_sun": False,
        "eclipse_near": False, "v4_score": 18,
    })
    assert 0.50 < prob < 0.80, f"P(up)={prob:.1%} — priors too strong"

def test_trades_shift_posterior():
    """After 5 losses, P(up) should drop significantly."""
    b = BayesianVedic()
    b.initialize_from_research()
    signals = {"venus_rx": False, "mercury_rx": True, "n_retrogrades": 1,
               "jup_sat_tight": False, "mars_rahu_tight": False,
               "merc_venus_tight": False, "merc_speed_fast": False,
               "venus_speed_fast": True, "venus_near_sun": False,
               "eclipse_near": False, "v4_score": 8}
    prob_before, _ = b.predict(signals)
    for _ in range(5):
        b.update(signals, won=False)
    prob_after, _ = b.predict(signals)
    assert prob_after < prob_before - 0.05, f"5 losses didn't shift posterior enough"

def test_venus_rx_stays_bearish():
    """Venus Rx should always produce P(up) < 40%."""
    b = BayesianVedic()
    b.initialize_from_research()
    prob, _ = b.predict({
        "venus_rx": True, "mercury_rx": False, "n_retrogrades": 0,
        "jup_sat_tight": False, "mars_rahu_tight": False,
        "merc_venus_tight": False, "merc_speed_fast": True,
        "venus_speed_fast": False, "venus_near_sun": False,
        "eclipse_near": False, "v4_score": -40,
    })
    assert prob < 0.40, f"Venus Rx P(up)={prob:.1%} — should be bearish"

if __name__ == "__main__":
    test_prior_does_not_dominate()
    test_trades_shift_posterior()
    test_venus_rx_stays_bearish()
    print("All Bayes tests passed!")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && python -m pytest src/vedic/__tests__/test_bayesian.py -v`
Expected: FAIL on `test_prior_does_not_dominate` (current priors give ~99%)

- [ ] **Step 3: Reduce research priors by 10x**

In `bayesian.py`, change all RESEARCH_PRIORS counts from ~(50-70, 30-50) to ~(5-7, 3-5):

```python
RESEARCH_PRIORS: Dict[str, Dict[str, Tuple[int, int]]] = {
    "venus_rx": {
        "True":  (1, 6),     # Was (5, 30)
        "False": (6, 5),     # Was (55, 45)
    },
    "mercury_rx": {
        "True":  (5, 6),     # Was (45, 55)
        "False": (6, 5),     # Was (55, 45)
    },
    "n_retro": {
        "0": (6, 4),  "1": (5, 5),  "2": (5, 5),  "3": (4, 6),
    },
    "jup_sat_tight": {
        "True":  (7, 3),     # Was (70, 30)
        "False": (5, 5),     # Was (48, 52)
    },
    "mars_rahu_tight": {
        "True":  (7, 4),     # Was (65, 35)
        "False": (5, 5),
    },
    "merc_venus_tight": {
        "True":  (3, 7),     # Was (30, 70)
        "False": (6, 5),
    },
    "merc_speed_fast": {
        "True":  (6, 4),  "False": (5, 6),
    },
    "venus_speed_fast": {
        "True":  (6, 4),  "False": (5, 5),
    },
    "venus_near_sun": {
        "True":  (4, 7),  "False": (6, 5),
    },
    "eclipse_near": {
        "True":  (4, 6),  "False": (5, 5),
    },
    "v4_bin": {
        "strong_buy": (7, 4),  "buy": (6, 5),
        "neutral": (5, 5),     "avoid": (4, 6),
    },
    "polymarket_crypto": {
        "very_bearish": (5, 6),  "bearish": (5, 5),
        "neutral": (5, 5),      "bullish": (5, 5),
        "euphoria": (5, 6),
    },
}
```

And reduce base rate to match signal prior scale:
```python
self.state.total_wins = 6
self.state.total_losses = 5
self.state.total_trades = 11
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/engine && python -m pytest src/vedic/__tests__/test_bayesian.py -v`
Expected: All 3 PASS

- [ ] **Step 5: Delete stale Bayes priors from Redis**

Run on VM: `docker exec cryonix-redis-1 redis-cli DEL vedic:bayes:priors`

This forces re-initialization with new reduced priors on next engine scan.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/vedic/bayesian.py packages/engine/src/vedic/__tests__/test_bayesian.py
git commit -m "fix(vedic-bayes): reduce priors 10x — real trades shift posterior faster"
```

---

### Task 2: Raise Entry Threshold to V4 ≥ 15

All entries at V4=8 during Mercury Rx resulted in losses. Backtest showed score ≥15 entries had significantly better returns.

**Files:**
- Modify: `scripts/services/vedic-trader.py` (BUY_SCORE_THRESHOLD)
- Modify: `scripts/services/vedic-futures-paper.py` (LONG_THRESHOLD)

- [ ] **Step 1: Update vedic-trader threshold**

In `scripts/services/vedic-trader.py`, change:
```python
BUY_SCORE_THRESHOLD = 8  # V4: "buy" label starts at 8 (aligned with backtest)
```
To:
```python
BUY_SCORE_THRESHOLD = 15  # V4: raised from 8 — entries at 8 during MercRx all lost
```

- [ ] **Step 2: Update vedic-futures threshold**

In `scripts/services/vedic-futures-paper.py`, change:
```python
LONG_THRESHOLD = 0.55
```
To:
```python
LONG_THRESHOLD = 0.60  # Raised from 0.55 — too many false entries at low confidence
```

- [ ] **Step 3: Commit**

```bash
git add scripts/services/vedic-trader.py scripts/services/vedic-futures-paper.py
git commit -m "fix(vedic): raise entry thresholds — V4>=15, Bayes P(up)>=60%"
```

---

### Task 3: Kuramoto Coherence Position Sizing

When multiple V4 signals align (all bullish or all bearish), position size should increase. When signals are mixed, reduce size. Ported from Copynix psi-engine.

**Files:**
- Create: `packages/engine/src/vedic/coherence.py`
- Modify: `packages/engine/src/tanks/vedic_scout.py` (add coherence to Redis)
- Modify: `scripts/services/vedic-trader.py` (use coherence for sizing)
- Modify: `scripts/services/vedic-futures-paper.py` (same)
- Modify: `apps/web/src/app/api/vedic/status/route.ts` (expose coherence)
- Modify: `apps/web/src/app/vedic/page.tsx` (display coherence)

- [ ] **Step 1: Write coherence test**

Create `packages/engine/src/vedic/__tests__/test_coherence.py`:

```python
"""Test Kuramoto coherence for V4 signals."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))

from src.vedic.coherence import compute_coherence

def test_all_bullish_high_coherence():
    signals = {"venus_rx": 0, "jup_sat": +15, "mars_rahu": +10,
               "merc_venus": 0, "merc_speed": +8, "venus_speed": +8,
               "retro": +5, "venus_sun": 0, "eclipse": 0, "spread": +5}
    c = compute_coherence(signals)
    assert c.coherence > 0.7, f"All bullish should have high coherence: {c.coherence}"
    assert c.size_multiplier > 1.0

def test_mixed_low_coherence():
    signals = {"venus_rx": -40, "jup_sat": +15, "mars_rahu": +10,
               "merc_venus": -10, "merc_speed": +8, "venus_speed": 0,
               "retro": -5, "venus_sun": -10, "eclipse": -5, "spread": +5}
    c = compute_coherence(signals)
    assert c.coherence < 0.5, f"Mixed signals should have low coherence: {c.coherence}"
    assert c.size_multiplier <= 1.0

def test_all_neutral_medium_coherence():
    signals = {"venus_rx": 0, "jup_sat": 0, "mars_rahu": 0,
               "merc_venus": 0, "merc_speed": 0, "venus_speed": 0,
               "retro": 0, "venus_sun": 0, "eclipse": 0, "spread": 0}
    c = compute_coherence(signals)
    assert 0.3 < c.coherence < 0.8

if __name__ == "__main__":
    test_all_bullish_high_coherence()
    test_mixed_low_coherence()
    test_all_neutral_medium_coherence()
    print("All coherence tests passed!")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && python -m pytest src/vedic/__tests__/test_coherence.py -v`
Expected: FAIL (module doesn't exist)

- [ ] **Step 3: Implement coherence module**

Create `packages/engine/src/vedic/coherence.py`:

```python
"""Kuramoto coherence for V4 astronomical signals.

Measures how synchronized the 10 V4 signals are.
High coherence (signals agree) → larger position.
Low coherence (signals conflict) → smaller position.

Ported from Copynix psi-engine (Kuramoto order parameter).
"""
import math
from dataclasses import dataclass
from typing import Dict

@dataclass
class CoherenceResult:
    coherence: float        # 0-1 (Kuramoto order parameter)
    size_multiplier: float  # 0.5x to 1.5x position size
    phase_transition: bool  # True if coherence > 0.6
    net_direction: float    # -1 to +1 (bearish to bullish)

def compute_coherence(signal_points: Dict[str, float]) -> CoherenceResult:
    """Compute Kuramoto coherence from V4 signal point contributions.

    Args:
        signal_points: dict of signal_name -> point contribution
        (e.g. {"venus_rx": -40, "mars_rahu": +10, "merc_speed": +8, ...})
    """
    values = list(signal_points.values())
    if not values:
        return CoherenceResult(0.5, 1.0, False, 0.0)

    # Handle all-zero case (no active signals = neutral, not coherent)
    if all(v == 0 for v in values):
        return CoherenceResult(0.5, 1.0, False, 0.0)

    # Normalize to [-1, +1] using FIXED max (40 = Venus Rx contribution)
    # Fixed scale preserves semantic meaning regardless of which signals fire
    FIXED_MAX = 40.0
    normalized = [max(-1, min(1, v / FIXED_MAX)) for v in values]

    # Map to phases: +1 → 0, 0 → π, -1 → 2π
    phases = [(1 - n) * math.pi for n in normalized]

    # Kuramoto order parameter: C = |Σ exp(iθ)| / N
    N = len(phases)
    real_sum = sum(math.cos(t) for t in phases)
    imag_sum = sum(math.sin(t) for t in phases)
    C = math.sqrt(real_sum**2 + imag_sum**2) / N

    # Net direction
    net = sum(normalized) / N  # -1 to +1

    # Position size multiplier: C² scaling (from psi-engine)
    # Conservative range: 0.75x to 1.25x (paper trading, still validating)
    mult = 0.75 + 0.5 * C * C  # Range: 0.75 to 1.25

    return CoherenceResult(
        coherence=round(C, 4),
        size_multiplier=round(mult, 3),
        phase_transition=C >= 0.6,
        net_direction=round(net, 4),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/engine && python -m pytest src/vedic/__tests__/test_coherence.py -v`
Expected: All 3 PASS

- [ ] **Step 5: Integrate into VedicScout**

In `vedic_scout.py`, after V4 score computation, add:

```python
from src.vedic.coherence import compute_coherence

# Compute signal coherence
signal_points = {
    "venus_rx": -40 if p["Venus"].is_retrograde else 0,
    "jup_sat": 15 if get_angular_distance(p["Jupiter"].longitude, p["Saturn"].longitude) < 10 else 0,
    "mars_rahu": 10 if get_angular_distance(p["Mars"].longitude, p["Rahu"].longitude) < 10 else 0,
    "merc_venus": -10 if get_angular_distance(p["Mercury"].longitude, p["Venus"].longitude) < 10 else 0,
    "merc_speed": 8 if abs(p["Mercury"].speed) > 1.5 else 0,
    "venus_speed": 8 if abs(p["Venus"].speed) > 1.0 else 0,
    "retro": 5 if len(vedic_score.retrogrades) == 0 else (-5 if len(vedic_score.retrogrades) >= 3 else 0),
    "venus_sun": -10 if get_angular_distance(p["Sun"].longitude, p["Venus"].longitude) < 15 else 0,
    "eclipse": -5 if get_angular_distance(p["Moon"].longitude, p["Rahu"].longitude) < 15 else 0,
    "spread": 5 if spread > 1.8 else (-5 if spread < 1.2 else 0),
}
coherence = compute_coherence(signal_points)
```

Write to Redis:
```python
pipe.set("vedic:coherence", json.dumps({
    "coherence": coherence.coherence,
    "size_multiplier": coherence.size_multiplier,
    "phase_transition": coherence.phase_transition,
    "net_direction": coherence.net_direction,
    "timestamp": vedic_score.timestamp,
}), ex=REDIS_TTL)
```

- [ ] **Step 6: Use coherence in traders**

In both `vedic-trader.py` and `vedic-futures-paper.py`, read coherence from Redis and multiply position size:

```python
# In scan_cycle, before BUY:
coherence_raw = await self.redis.get("vedic:coherence")
coherence_mult = 1.0
if coherence_raw:
    coh = json.loads(coherence_raw)
    coherence_mult = coh.get("size_multiplier", 1.0)
    if coh.get("coherence", 0) > 0.7:
        print(f"[{self.name}] High coherence {coh['coherence']:.2f} → size x{coherence_mult:.2f}")

effective_pos_size *= coherence_mult
```

- [ ] **Step 7: Add coherence to dashboard API**

In `apps/web/src/app/api/vedic/status/route.ts`, read `vedic:coherence` from Redis and add to response.

- [ ] **Step 8: Display coherence on dashboard**

In `apps/web/src/app/vedic/page.tsx`, add a small coherence indicator near the V4 score showing "C=0.72 (1.3x size)".

- [ ] **Step 9: Commit**

```bash
git add packages/engine/src/vedic/coherence.py packages/engine/src/vedic/__tests__/ \
  packages/engine/src/tanks/vedic_scout.py scripts/services/vedic-trader.py \
  scripts/services/vedic-futures-paper.py apps/web/src/app/api/vedic/status/route.ts \
  apps/web/src/app/vedic/page.tsx
git commit -m "feat(vedic): Kuramoto coherence position sizing — signals aligned = bigger positions"
```

---

### Task 4: Update Memory + Deploy

- [ ] **Step 1: Update project memory**

Update `memory/project_vedic_v3.md` to reflect V4 status, Bayes calibration, coherence, and live trading results.

- [ ] **Step 2: Deploy all changes**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
# Build engine (has Bayes + coherence)
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml build engine && docker compose -f docker-compose.prod.yml up -d engine"
# Delete stale Bayes priors
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli DEL vedic:bayes:priors"
# Rebuild traders sequentially
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml stop vedic-trader && docker rmi cryonix-vedic-trader 2>/dev/null; docker compose -f docker-compose.prod.yml up -d --build vedic-trader"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml stop vedic-futures && docker rmi cryonix-vedic-futures 2>/dev/null; docker compose -f docker-compose.prod.yml up -d --build vedic-futures"
# Rebuild web
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build web"
```

- [ ] **Step 3: Verify**

Check engine logs for: `Bayes: initialized from research priors` (fresh init with reduced priors)
Check that P(up) is now 50-70% range, not 99%.
Check coherence data in Redis: `docker exec cryonix-redis-1 redis-cli GET vedic:coherence`

- [ ] **Step 4: Commit memory update**

```bash
git add memory/
git commit -m "docs: update vedic memory to V4 with Bayes calibration + coherence"
```
