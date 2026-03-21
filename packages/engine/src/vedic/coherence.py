"""Kuramoto coherence for V4 astronomical signals.

Measures how synchronized the 10 V4 signals are.
High coherence (signals agree) -> larger position.
Low coherence (signals conflict) -> smaller position.

Ported from Copynix psi-engine (Kuramoto order parameter).
"""
import math
from dataclasses import dataclass
from typing import Dict


@dataclass
class CoherenceResult:
    coherence: float        # 0-1 (Kuramoto order parameter)
    size_multiplier: float  # 0.75x to 1.25x position size
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
    FIXED_MAX = 40.0
    normalized = [max(-1, min(1, v / FIXED_MAX)) for v in values]

    # Map to phases: +1 -> 0, 0 -> pi, -1 -> 2*pi
    phases = [(1 - n) * math.pi for n in normalized]

    # Kuramoto order parameter: C = |sum(exp(i*theta))| / N
    N = len(phases)
    real_sum = sum(math.cos(t) for t in phases)
    imag_sum = sum(math.sin(t) for t in phases)
    C = math.sqrt(real_sum**2 + imag_sum**2) / N

    # Net direction
    net = sum(normalized) / N

    # Position size multiplier: C^2 scaling
    # Conservative range: 0.75x to 1.25x (paper trading, still validating)
    mult = 0.75 + 0.5 * C * C

    return CoherenceResult(
        coherence=round(C, 4),
        size_multiplier=round(mult, 3),
        phase_transition=C >= 0.6,
        net_direction=round(net, 4),
    )
