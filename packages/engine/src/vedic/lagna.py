"""
Lagna (Ascendant) and Bhava (House) calculations for crypto natal charts.

The Lagna is the rising sign at the moment and location of a crypto's genesis.
It defines the 12 houses (bhavas), which map planetary transits to specific
life areas — in financial astrology: wealth (2nd), gains (11th), losses (12th),
fortune (9th), obstacles (6th), etc.

Requires geographic coordinates (lat/lon) of the genesis location.
Uses pyswisseph swe.houses() with Whole Sign house system (default in Jyotish).
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import swisseph as swe

from .ephemeris import AYANAMSA, SIGNS, SkyState, _datetime_to_jd, get_sky_state
from .natal import CRYPTO_GENESIS, GenesisData


# ── House significations for financial astrology ─────────────────────
# Each house has a financial meaning. Benefics in good houses = bullish.
# Malefics in bad houses = bearish. This maps house number to effect.
HOUSE_FINANCE = {
    1:  ("self/identity", 0.0),        # Lagna — neutral baseline
    2:  ("wealth/assets", 0.6),        # Dhana — accumulated wealth
    3:  ("effort/courage", 0.1),       # Sahaja — initiative
    4:  ("foundations", 0.2),          # Sukha — stability, property
    5:  ("speculation", 0.5),          # Putra — speculation, creativity
    6:  ("obstacles/debt", -0.4),      # Ripu — enemies, losses from competition
    7:  ("partnerships", 0.2),         # Kalatra — deals, contracts
    8:  ("sudden events", -0.5),       # Randhra — crisis, sudden losses, BUT also windfalls
    9:  ("fortune/luck", 0.7),         # Bhagya — the great fortune house
    10: ("status/career", 0.4),        # Karma — public standing, achievement
    11: ("gains/income", 0.8),         # Labha — the best house for gains
    12: ("losses/expenses", -0.6),     # Vyaya — expenditure, dissolution
}

# Benefic/malefic nature affects house interpretation
BENEFICS = {"Jupiter", "Venus", "Moon", "Mercury"}
MALEFICS = {"Sun", "Mars", "Saturn", "Rahu", "Ketu"}


@dataclass
class LagnaChart:
    """Lagna (Ascendant) and house cusps for a crypto."""
    symbol: str
    ascendant_lon: float          # Sidereal longitude of Ascendant (0-360°)
    ascendant_sign: str           # Rising sign name
    ascendant_sign_index: int     # 0-11
    house_cusps: List[float]      # 12 house cusp longitudes (Whole Sign)
    mc_lon: float                 # Midheaven longitude (10th house cusp approx)


@dataclass
class HousePosition:
    """A planet's house placement in a crypto's natal chart."""
    planet: str
    house: int                    # 1-12
    sign: str
    longitude: float
    is_benefic: bool


@dataclass
class BhavaReport:
    """House-based analysis for a crypto at a given moment."""
    symbol: str
    lagna_sign: str
    natal_houses: List[HousePosition]    # Natal planet placements
    transit_houses: List[HousePosition]  # Current transit placements
    bhava_score: float                   # -1.0 to +1.0
    summary: str


# ── Cache ────────────────────────────────────────────────────────────
_lagna_cache: Dict[str, LagnaChart] = {}


def compute_lagna(symbol: str) -> Optional[LagnaChart]:
    """Compute the Lagna (Ascendant) for a crypto's genesis moment and location.

    Uses Whole Sign houses (standard Jyotish):
    House 1 starts at 0° of the Ascendant's sign,
    House 2 at 0° of the next sign, etc.
    """
    if symbol in _lagna_cache:
        return _lagna_cache[symbol]

    if symbol not in CRYPTO_GENESIS:
        return None

    genesis = CRYPTO_GENESIS[symbol]
    jd = _datetime_to_jd(genesis.time)

    # Set sidereal mode (Lahiri)
    swe.set_sid_mode(AYANAMSA)

    # Calculate houses using Whole Sign system ('W')
    # swe.houses() returns (cusps_tuple, ascmc_tuple)
    # ascmc[0] = Ascendant, ascmc[1] = MC
    try:
        cusps, ascmc = swe.houses(jd, genesis.lat, genesis.lon, b'W')
    except Exception:
        return None

    # Get sidereal Ascendant
    ayanamsa = swe.get_ayanamsa(jd)
    asc_sid = (ascmc[0] - ayanamsa) % 360.0
    mc_sid = (ascmc[1] - ayanamsa) % 360.0

    asc_sign_idx = int(asc_sid / 30.0)

    # Whole Sign houses: each house = 30° starting from Asc sign
    house_cusps = [(asc_sign_idx * 30.0 + i * 30.0) % 360.0 for i in range(12)]

    chart = LagnaChart(
        symbol=symbol,
        ascendant_lon=asc_sid,
        ascendant_sign=SIGNS[asc_sign_idx],
        ascendant_sign_index=asc_sign_idx,
        house_cusps=house_cusps,
        mc_lon=mc_sid,
    )

    _lagna_cache[symbol] = chart
    return chart


def _planet_house(planet_lon: float, asc_sign_idx: int) -> int:
    """Determine which house (1-12) a planet falls in using Whole Sign."""
    planet_sign = int(planet_lon / 30.0)
    house = ((planet_sign - asc_sign_idx) % 12) + 1
    return house


def _get_house_positions(
    sky: SkyState,
    asc_sign_idx: int,
) -> List[HousePosition]:
    """Map all planets to houses based on Ascendant sign."""
    positions = []
    for name, pos in sky.planets.items():
        house = _planet_house(pos.longitude, asc_sign_idx)
        positions.append(HousePosition(
            planet=name,
            house=house,
            sign=pos.sign,
            longitude=pos.longitude,
            is_benefic=name in BENEFICS,
        ))
    return positions


def compute_bhava_score(
    symbol: str,
    current_sky: Optional[SkyState] = None,
) -> Optional[BhavaReport]:
    """Compute house-based score for a crypto using transiting planets.

    Scoring logic:
    - Benefics in wealth houses (2, 5, 9, 11) → bullish
    - Malefics in loss houses (6, 8, 12) → bearish
    - Benefics in loss houses or malefics in wealth houses → mixed
    - Transit planets through natal houses carry the house signification
    """
    lagna = compute_lagna(symbol)
    if lagna is None:
        return None

    if current_sky is None:
        current_sky = get_sky_state()

    # Get natal planet placements
    natal_sky = get_sky_state(CRYPTO_GENESIS[symbol].time)
    natal_houses = _get_house_positions(natal_sky, lagna.ascendant_sign_index)

    # Get current transit placements in this crypto's house system
    transit_houses = _get_house_positions(current_sky, lagna.ascendant_sign_index)

    # Score transiting planets by house placement
    score = 0.0
    details = []

    for hp in transit_houses:
        house_name, house_weight = HOUSE_FINANCE[hp.house]

        if hp.is_benefic:
            # Benefics amplify positive houses, reduce negative ones
            contribution = house_weight * 0.15
        else:
            # Malefics amplify negative houses, reduce positive ones
            contribution = -house_weight * 0.12

        # Slow movers (Jupiter, Saturn, Rahu, Ketu) have more weight
        if hp.planet in ("Jupiter", "Saturn", "Rahu", "Ketu"):
            contribution *= 2.0

        score += contribution

    # Clamp to -1..+1
    score = max(-1.0, min(1.0, score))

    # Summary
    bullish_houses = [hp for hp in transit_houses
                      if hp.house in (2, 5, 9, 11) and hp.is_benefic]
    bearish_houses = [hp for hp in transit_houses
                      if hp.house in (6, 8, 12) and not hp.is_benefic]

    if score > 0.2:
        summary = (f"{symbol} Lagna {lagna.ascendant_sign}: "
                   f"favorable houses ({len(bullish_houses)} benefics in wealth houses)")
    elif score < -0.2:
        summary = (f"{symbol} Lagna {lagna.ascendant_sign}: "
                   f"challenging houses ({len(bearish_houses)} malefics in loss houses)")
    else:
        summary = f"{symbol} Lagna {lagna.ascendant_sign}: mixed house placements"

    return BhavaReport(
        symbol=symbol,
        lagna_sign=lagna.ascendant_sign,
        natal_houses=natal_houses,
        transit_houses=transit_houses,
        bhava_score=round(score, 3),
        summary=summary,
    )
