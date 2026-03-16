"""
Bayesian Vedic Scoring Engine — Self-learning probabilistic model.

Uses Bayes' theorem to combine vedic signals into a calibrated probability
of positive returns. Learns from every completed trade.

P(up | signals) = P(signals | up) * P(up) / P(signals)

For multiple independent signals:
P(up | S1, S2, ...) ∝ P(up) * ∏ P(Si | up) / P(Si)

We use the log-odds form for numerical stability:
log_odds(up | signals) = log_odds(up) + Σ log(P(Si | up) / P(Si | down))

Each signal has a likelihood ratio (LR) learned from trade outcomes:
LR(Si) = P(Si | up) / P(Si | down)

Priors are initialized from research data, then updated with each trade.
Uses Laplace smoothing (add-1) to prevent zero probabilities.

Redis keys:
  vedic:bayes:priors     — Likelihood tables for each signal state
  vedic:bayes:stats      — Overall stats (total trades, base rate)
  vedic:bayes:history    — Recent posterior predictions vs outcomes

References:
  - Bayes (1763): "An Essay towards solving a Problem in the Doctrine of Chances"
  - Murphy (2012): "Machine Learning: A Probabilistic Perspective"
  - arXiv:2306.08157v3: Bayesian inference methods
"""
import json
import math
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


# ── Signal Discretization ─────────────────────────────────────────
# Each continuous signal is binned into discrete states for counting.

def discretize_signals(raw: Dict[str, Any]) -> Dict[str, str]:
    """Convert raw vedic signals into discrete bins for Bayesian counting.

    Each signal becomes a key like 'venus_rx:True' or 'n_retro:0'.
    """
    bins = {}

    # 1. Venus Rx (binary) — strongest signal
    bins["venus_rx"] = str(bool(raw.get("venus_rx", False)))

    # 2. Mercury Rx (binary)
    bins["mercury_rx"] = str(bool(raw.get("mercury_rx", False)))

    # 3. Retrograde count (0, 1, 2, 3+)
    n = raw.get("n_retrogrades", 0)
    bins["n_retro"] = str(min(n, 3))

    # 4. Paksha (Shukla/Krishna)
    bins["paksha"] = raw.get("paksha", "Unknown")

    # 5. Tithi group (which part of lunar cycle)
    tithi = raw.get("tithi_number", 15)
    if tithi <= 7:
        bins["tithi_group"] = "early_shukla"
    elif tithi <= 14:
        bins["tithi_group"] = "mid_shukla"
    elif tithi == 15:
        bins["tithi_group"] = "full_moon"
    elif tithi <= 22:
        bins["tithi_group"] = "early_krishna"
    elif tithi <= 29:
        bins["tithi_group"] = "late_krishna"
    else:
        bins["tithi_group"] = "new_moon"

    # 6. Moon speed bin (slow/normal/fast)
    speed = raw.get("moon_speed", 13.0)
    if speed < 12.5:
        bins["moon_speed"] = "slow"
    elif speed < 14.0:
        bins["moon_speed"] = "normal"
    else:
        bins["moon_speed"] = "fast"

    # 7. V3 score bin (for self-calibration)
    score = raw.get("v3_score", 0)
    if score >= 20:
        bins["v3_bin"] = "strong_buy"
    elif score >= 5:
        bins["v3_bin"] = "buy"
    elif score >= -10:
        bins["v3_bin"] = "neutral"
    else:
        bins["v3_bin"] = "avoid"

    # 8. Jupiter retrograde
    bins["jupiter_rx"] = str(bool(raw.get("jupiter_rx", False)))

    # 9. Saturn retrograde
    bins["saturn_rx"] = str(bool(raw.get("saturn_rx", False)))

    return bins


# ── Bayesian Priors (initialized from research) ──────────────────

# Research-derived initial counts: (wins, losses) per signal state
# These serve as "pseudo-counts" (Laplace smoothing with informative priors)
# Based on 6 symbols × 2000 days of backtested data

RESEARCH_PRIORS: Dict[str, Dict[str, Tuple[int, int]]] = {
    "venus_rx": {
        # Venus Rx: 7d Direct +1.63% vs Rx -3.57% (p<0.0001)
        "True":  (5, 30),    # Heavily bearish — 5 wins out of 35
        "False": (55, 45),   # Slight bullish edge
    },
    "mercury_rx": {
        # Mercury Rx: mild 14d drag (p=0.04)
        "True":  (40, 50),   # Slightly bearish
        "False": (55, 45),   # Slightly bullish
    },
    "n_retro": {
        # 0 retro = best, 3+ = worst
        "0": (60, 40),
        "1": (52, 48),
        "2": (50, 50),
        "3": (40, 60),
    },
    "paksha": {
        # 14d: Shukla +3.09% vs Krishna +2.43% (p=0.078)
        "Shukla":  (53, 47),
        "Krishna": (47, 53),
        "Unknown": (50, 50),
    },
    "tithi_group": {
        # From tithi-by-tithi research
        "early_shukla":  (50, 50),
        "mid_shukla":    (55, 45),
        "full_moon":     (45, 55),
        "early_krishna": (48, 52),
        "late_krishna":  (45, 55),
        "new_moon":      (52, 48),
    },
    "moon_speed": {
        # Conflicting research — start neutral
        "slow":   (50, 50),
        "normal": (50, 50),
        "fast":   (50, 50),
    },
    "v3_bin": {
        # V3 score self-calibration (starts neutral, learns from trades)
        "strong_buy": (55, 45),
        "buy":        (52, 48),
        "neutral":    (50, 50),
        "avoid":      (45, 55),
    },
    "jupiter_rx": {
        # Jupiter Rx: contradictory data, start near neutral
        "True":  (50, 50),
        "False": (50, 50),
    },
    "saturn_rx": {
        # Saturn Rx: weak signal (p=0.058)
        "True":  (48, 52),
        "False": (52, 48),
    },
}


# ── Bayesian Engine ───────────────────────────────────────────────

@dataclass
class BayesianState:
    """Persistent state for the Bayesian engine."""
    # Counts per signal: signal_name -> state -> (wins, losses)
    counts: Dict[str, Dict[str, List[int]]] = field(default_factory=dict)
    # Overall base rate
    total_wins: int = 0
    total_losses: int = 0
    total_trades: int = 0
    # Tracking
    last_updated: str = ""
    version: int = 1


class BayesianVedic:
    """Bayesian scoring engine for vedic trading signals.

    Usage:
        engine = BayesianVedic()
        await engine.load(redis)

        # Score current conditions
        signals = {"venus_rx": False, "mercury_rx": True, ...}
        prob, details = engine.predict(signals)

        # After trade closes, update with outcome
        engine.update(signals_at_entry, won=True)
        await engine.save(redis)
    """

    def __init__(self):
        self.state = BayesianState()
        self._initialized = False

    def initialize_from_research(self):
        """Initialize counts from research priors."""
        self.state.counts = {}
        for signal_name, states in RESEARCH_PRIORS.items():
            self.state.counts[signal_name] = {}
            for state_val, (wins, losses) in states.items():
                self.state.counts[signal_name][state_val] = [wins, losses]

        # Base rate: crypto is slightly bullish over time (~55%)
        self.state.total_wins = 550
        self.state.total_losses = 450
        self.state.total_trades = 1000
        self.state.last_updated = datetime.now(timezone.utc).isoformat()
        self._initialized = True

    async def load(self, redis_client) -> bool:
        """Load state from Redis. Returns True if state existed."""
        try:
            raw = await redis_client.get("vedic:bayes:priors")
            if raw:
                data = json.loads(raw)
                self.state = BayesianState(**data)
                self._initialized = True
                return True
        except Exception as e:
            print(f"[Bayes] Failed to load state: {e}")

        # Initialize from research if no saved state
        self.initialize_from_research()
        return False

    async def save(self, redis_client):
        """Persist state to Redis."""
        try:
            data = asdict(self.state)
            await redis_client.set("vedic:bayes:priors", json.dumps(data))
        except Exception as e:
            print(f"[Bayes] Failed to save state: {e}")

    def _get_counts(self, signal_name: str, state_val: str) -> Tuple[int, int]:
        """Get (wins, losses) for a signal state with Laplace smoothing."""
        if signal_name not in self.state.counts:
            return (1, 1)  # Laplace: add-1 smoothing
        states = self.state.counts[signal_name]
        if state_val not in states:
            return (1, 1)
        w, l = states[state_val]
        return (max(w, 1), max(l, 1))  # Ensure no zeros

    def _base_rate(self) -> float:
        """P(up) — overall probability of a winning trade."""
        total = max(self.state.total_wins + self.state.total_losses, 1)
        return self.state.total_wins / total

    def predict(self, raw_signals: Dict[str, Any]) -> Tuple[float, Dict[str, Any]]:
        """Compute Bayesian posterior probability of positive returns.

        Returns:
            (probability, details_dict)
            probability: 0.0 to 1.0 (probability of positive 7d return)
            details: breakdown of each signal's contribution
        """
        if not self._initialized:
            self.initialize_from_research()

        bins = discretize_signals(raw_signals)
        base_rate = self._base_rate()

        # Log-odds form: more numerically stable
        # log_odds = log(P(up)/P(down)) + Σ log(LR_i)
        prior_odds = base_rate / max(1 - base_rate, 0.001)
        log_odds = math.log(max(prior_odds, 0.001))

        details = {
            "base_rate": round(base_rate, 4),
            "prior_log_odds": round(log_odds, 4),
            "signals": {},
        }

        for signal_name, state_val in bins.items():
            wins, losses = self._get_counts(signal_name, state_val)
            total_w = sum(self._get_counts(signal_name, s)[0]
                         for s in self.state.counts.get(signal_name, {state_val: [1,1]}))
            total_l = sum(self._get_counts(signal_name, s)[1]
                         for s in self.state.counts.get(signal_name, {state_val: [1,1]}))

            # Likelihood ratio: P(state | up) / P(state | down)
            p_state_given_up = wins / max(total_w, 1)
            p_state_given_down = losses / max(total_l, 1)

            lr = p_state_given_up / max(p_state_given_down, 0.001)
            log_lr = math.log(max(lr, 0.001))

            log_odds += log_lr

            details["signals"][signal_name] = {
                "state": state_val,
                "wins": wins,
                "losses": losses,
                "lr": round(lr, 4),
                "log_lr": round(log_lr, 4),
                "direction": "bullish" if lr > 1.05 else "bearish" if lr < 0.95 else "neutral",
            }

        # Convert log-odds back to probability
        odds = math.exp(min(log_odds, 10))  # Cap to prevent overflow
        probability = odds / (1 + odds)

        details["posterior_log_odds"] = round(log_odds, 4)
        details["probability"] = round(probability, 4)

        # Convert to score (-100 to +100)
        # 0.5 = 0, 0.75 = +50, 1.0 = +100, 0.25 = -50, 0.0 = -100
        score = int(round((probability - 0.5) * 200))
        score = max(-100, min(100, score))
        details["score"] = score

        if score >= 25:
            label = "strong_buy"
        elif score >= 10:
            label = "buy"
        elif score >= -10:
            label = "neutral"
        elif score >= -25:
            label = "avoid"
        else:
            label = "strong_avoid"
        details["label"] = label

        return probability, details

    def update(self, raw_signals_at_entry: Dict[str, Any], won: bool):
        """Update Bayesian counts after a trade closes.

        Call this with the signals that were active when the trade was entered,
        and whether the trade was profitable (won=True) or not.
        """
        bins = discretize_signals(raw_signals_at_entry)

        for signal_name, state_val in bins.items():
            if signal_name not in self.state.counts:
                self.state.counts[signal_name] = {}
            if state_val not in self.state.counts[signal_name]:
                self.state.counts[signal_name][state_val] = [1, 1]  # Laplace

            if won:
                self.state.counts[signal_name][state_val][0] += 1
            else:
                self.state.counts[signal_name][state_val][1] += 1

        # Update base rate
        if won:
            self.state.total_wins += 1
        else:
            self.state.total_losses += 1
        self.state.total_trades += 1
        self.state.last_updated = datetime.now(timezone.utc).isoformat()

    def get_signal_rankings(self) -> List[Dict]:
        """Get signals ranked by their current predictive power.

        Useful for dashboard display — shows which signals matter most.
        """
        rankings = []
        for signal_name, states in self.state.counts.items():
            max_lr = 0
            min_lr = float('inf')
            for state_val, (w, l) in states.items():
                total_w = sum(s[0] for s in states.values())
                total_l = sum(s[1] for s in states.values())
                p_up = w / max(total_w, 1)
                p_down = l / max(total_l, 1)
                lr = p_up / max(p_down, 0.001)
                max_lr = max(max_lr, lr)
                min_lr = min(min_lr, lr)

            # Spread = how much this signal differentiates up vs down
            spread = max_lr / max(min_lr, 0.001) if min_lr > 0 else max_lr
            rankings.append({
                "signal": signal_name,
                "spread": round(spread, 3),
                "states": len(states),
                "total_obs": sum(w + l for w, l in states.values()),
            })

        rankings.sort(key=lambda x: x["spread"], reverse=True)
        return rankings
