"""
Vimshottari Dasha — 120-year planetary period system.

Calculates which Maha Dasha (major period) and Antar Dasha (sub-period)
each cryptocurrency is currently experiencing based on its natal Moon nakshatra.

Each nakshatra lord starts the dasha sequence. The remaining balance at birth
is proportional to the Moon's position within the nakshatra.

Dasha order: Ketu(7) → Venus(20) → Sun(6) → Moon(10) → Mars(7) →
             Rahu(18) → Jupiter(16) → Saturn(19) → Mercury(17) = 120 years
"""
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional

from .ephemeris import get_sky_state
from .nakshatras import nakshatra_at_longitude, NAKSHATRA_SPAN
from .natal import CRYPTO_GENESIS, get_natal_chart


# ── Dasha periods (years) ───────────────────────────────────────────

DASHA_ORDER = ["Ketu", "Venus", "Sun", "Moon", "Mars", "Rahu", "Jupiter", "Saturn", "Mercury"]

DASHA_YEARS: Dict[str, float] = {
    "Ketu":    7.0,
    "Venus":  20.0,
    "Sun":     6.0,
    "Moon":   10.0,
    "Mars":    7.0,
    "Rahu":   18.0,
    "Jupiter":16.0,
    "Saturn": 19.0,
    "Mercury":17.0,
}

TOTAL_CYCLE_YEARS = 120.0  # Sum of all dasha years

# Market interpretation per dasha lord
DASHA_MARKET_EFFECT: Dict[str, str] = {
    "Ketu":    "spirituality, detachment — sudden events, unexpected moves",
    "Venus":   "luxury, beauty, gains — extended bull runs, adoption growth",
    "Sun":     "authority, governance — regulatory focus, leadership changes",
    "Moon":    "emotion, public — sentiment-driven, retail mania/panic",
    "Mars":    "energy, aggression — volatile breakouts, competition, forks",
    "Rahu":    "amplification, obsession — hype cycles, FOMO, bubbles",
    "Jupiter": "expansion, wisdom — institutional adoption, ecosystem growth",
    "Saturn":  "contraction, discipline — bear markets, regulation, maturation",
    "Mercury": "communication, technology — upgrades, dev activity, partnerships",
}

# Trading bias per lord: positive = bullish tendency, negative = bearish
DASHA_BIAS: Dict[str, float] = {
    "Ketu":    -0.2,   # Unpredictable, slightly bearish
    "Venus":    0.6,   # Strong bullish
    "Sun":      0.1,   # Mildly bullish
    "Moon":     0.0,   # Neutral, sentiment-driven
    "Mars":     0.2,   # Mildly bullish (energy)
    "Rahu":     0.3,   # Bullish (hype) but risky
    "Jupiter":  0.7,   # Strongest bullish
    "Saturn":  -0.5,   # Bearish, contraction
    "Mercury":  0.3,   # Mildly bullish (tech)
}


@dataclass
class DashaState:
    """Current dasha state for a cryptocurrency."""
    symbol: str
    maha_dasha_lord: str
    maha_dasha_start: datetime
    maha_dasha_end: datetime
    maha_years_total: float
    antar_dasha_lord: str
    antar_dasha_start: datetime
    antar_dasha_end: datetime
    antar_months_total: float
    market_interpretation: str
    maha_bias: float           # -1.0 to +1.0
    antar_bias: float          # -1.0 to +1.0
    combined_bias: float       # Weighted combo


def _get_dasha_sequence_from(start_lord: str) -> List[str]:
    """Get the dasha sequence starting from a specific lord."""
    idx = DASHA_ORDER.index(start_lord)
    return DASHA_ORDER[idx:] + DASHA_ORDER[:idx]


def compute_birth_balance(moon_longitude: float) -> tuple:
    """
    Compute the remaining dasha balance at birth.

    Returns (starting_lord, remaining_years).
    The remaining years in the first dasha = proportion of nakshatra remaining.
    """
    nak_pos = nakshatra_at_longitude(moon_longitude)
    lord = nak_pos.nakshatra.lord

    # How far through the nakshatra the Moon has traveled (0.0 to 1.0)
    fraction_traversed = nak_pos.degrees_in_nakshatra / NAKSHATRA_SPAN

    # Remaining years = remaining fraction × total years for this lord
    remaining_years = (1.0 - fraction_traversed) * DASHA_YEARS[lord]

    return lord, remaining_years


def compute_dasha_for_symbol(
    symbol: str,
    at_time: Optional[datetime] = None,
) -> Optional[DashaState]:
    """
    Compute which Maha Dasha and Antar Dasha a crypto is in at a given time.

    Uses the natal Moon position to determine the starting dasha,
    then walks forward through the 120-year cycle to find the current period.
    """
    if symbol not in CRYPTO_GENESIS:
        return None

    if at_time is None:
        at_time = datetime.now(timezone.utc)

    genesis = CRYPTO_GENESIS[symbol]
    natal = get_natal_chart(symbol)
    if natal is None:
        return None

    # Get natal Moon longitude
    natal_moon_lon = natal.planets["Moon"].longitude

    # Compute birth balance
    start_lord, remaining_years = compute_birth_balance(natal_moon_lon)
    sequence = _get_dasha_sequence_from(start_lord)

    # Walk forward through Maha Dashas
    cursor = genesis
    maha_lord = None
    maha_start = None
    maha_end = None
    maha_years = 0.0

    for i, lord in enumerate(sequence * 3):  # 3 cycles = 360 years max
        if i == 0:
            years = remaining_years
        else:
            years = DASHA_YEARS[lord]

        period_start = cursor
        period_end = cursor + timedelta(days=years * 365.25)

        if period_start <= at_time < period_end:
            maha_lord = lord
            maha_start = period_start
            maha_end = period_end
            maha_years = years
            break

        cursor = period_end

    if maha_lord is None:
        return None

    # Now find the Antar Dasha within the Maha Dasha
    # Antar sequence starts with the Maha lord, then follows the cycle
    antar_sequence = _get_dasha_sequence_from(maha_lord)
    antar_cursor = maha_start
    antar_lord = None
    antar_start = None
    antar_end = None
    antar_months = 0.0

    for a_lord in antar_sequence:
        # Antar duration = (maha_years × antar_lord_years) / TOTAL_CYCLE_YEARS
        a_years = (maha_years * DASHA_YEARS[a_lord]) / TOTAL_CYCLE_YEARS
        a_start = antar_cursor
        a_end = antar_cursor + timedelta(days=a_years * 365.25)

        if a_start <= at_time < a_end:
            antar_lord = a_lord
            antar_start = a_start
            antar_end = a_end
            antar_months = a_years * 12.0
            break

        antar_cursor = a_end

    if antar_lord is None:
        # Fallback: last antar dasha
        antar_lord = antar_sequence[-1]
        antar_start = antar_cursor
        antar_end = maha_end
        antar_months = ((maha_end - antar_cursor).days / 365.25) * 12.0

    # Market interpretation
    maha_effect = DASHA_MARKET_EFFECT.get(maha_lord, "")
    antar_effect = DASHA_MARKET_EFFECT.get(antar_lord, "")
    interpretation = (
        f"Maha Dasha: {maha_lord} ({maha_effect}). "
        f"Antar Dasha: {antar_lord} ({antar_effect})."
    )

    # Bias calculation: Maha 70%, Antar 30%
    maha_bias = DASHA_BIAS.get(maha_lord, 0.0)
    antar_bias = DASHA_BIAS.get(antar_lord, 0.0)
    combined = maha_bias * 0.7 + antar_bias * 0.3

    return DashaState(
        symbol=symbol,
        maha_dasha_lord=maha_lord,
        maha_dasha_start=maha_start,
        maha_dasha_end=maha_end,
        maha_years_total=round(maha_years, 2),
        antar_dasha_lord=antar_lord,
        antar_dasha_start=antar_start,
        antar_dasha_end=antar_end,
        antar_months_total=round(antar_months, 1),
        market_interpretation=interpretation,
        maha_bias=round(maha_bias, 2),
        antar_bias=round(antar_bias, 2),
        combined_bias=round(combined, 3),
    )


def compute_all_dashas(
    at_time: Optional[datetime] = None,
) -> Dict[str, DashaState]:
    """Compute dasha states for all 16 cryptos with natal charts."""
    results = {}
    for symbol in CRYPTO_GENESIS:
        ds = compute_dasha_for_symbol(symbol, at_time)
        if ds is not None:
            results[symbol] = ds
    return results
