"""
Natal charts for cryptocurrency projects.

Each crypto has a "birth moment" (genesis block or mainnet launch).
Transiting planets aspecting the natal chart generate signals.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

from .ephemeris import (
    SkyState, get_sky_state, get_angular_distance, get_signed_distance,
)
from .nakshatras import nakshatra_at_longitude


# ── Genesis data (UTC + geographic coordinates) ──────────────────────
# Each crypto has a "birth moment" and a "birth location" (founding team HQ).
# Location is needed for Lagna (Ascendant) calculation.

@dataclass
class GenesisData:
    """Birth data for a cryptocurrency."""
    time: datetime
    lat: float       # Geographic latitude
    lon: float       # Geographic longitude
    city: str        # Birth city (for reference)


CRYPTO_GENESIS: Dict[str, GenesisData] = {
    # ── BTC: London, UK — Satoshi's Times headline + activity analysis ──
    "BTC": GenesisData(datetime(2009, 1, 3, 18, 15, 0, tzinfo=timezone.utc),
                       51.5074, -0.1278, "London"),
    # ── ETH: Zug, Switzerland — Ethereum Foundation HQ ──
    "ETH": GenesisData(datetime(2015, 7, 30, 15, 26, 0, tzinfo=timezone.utc),
                       47.1660, 8.5155, "Zug"),
    # ── BNB: Shanghai, China — Binance pre-ban HQ ──
    "BNB": GenesisData(datetime(2017, 7, 25, 0, 0, 0, tzinfo=timezone.utc),
                       31.2304, 121.4737, "Shanghai"),
    # ── SOL: San Francisco, CA — Solana Labs HQ ──
    "SOL": GenesisData(datetime(2020, 3, 16, 0, 0, 0, tzinfo=timezone.utc),
                       37.7749, -122.4194, "San Francisco"),
    # ── ADA: Hong Kong — IOHK HQ at launch ──
    "ADA": GenesisData(datetime(2017, 9, 29, 0, 0, 0, tzinfo=timezone.utc),
                       22.3193, 114.1694, "Hong Kong"),
    # ── XRP: San Francisco, CA — Ripple/OpenCoin HQ ──
    "XRP": GenesisData(datetime(2012, 6, 2, 0, 0, 0, tzinfo=timezone.utc),
                       37.7749, -122.4194, "San Francisco"),
    # ── AVAX: New York City — Ava Labs HQ ──
    "AVAX": GenesisData(datetime(2020, 9, 21, 0, 0, 0, tzinfo=timezone.utc),
                        40.7128, -74.0060, "New York City"),
    # ── DOT: Zug, Switzerland — Web3 Foundation ──
    "DOT": GenesisData(datetime(2020, 5, 26, 0, 0, 0, tzinfo=timezone.utc),
                       47.1660, 8.5155, "Zug"),
    # ── LINK: San Francisco, CA — SmartContract.com / Chainlink Labs ──
    "LINK": GenesisData(datetime(2017, 9, 19, 0, 0, 0, tzinfo=timezone.utc),
                        37.7749, -122.4194, "San Francisco"),
    # ── ATOM: San Francisco, CA — Tendermint Inc ──
    "ATOM": GenesisData(datetime(2019, 3, 14, 0, 0, 0, tzinfo=timezone.utc),
                        37.7749, -122.4194, "San Francisco"),
    # ── DOGE: Portland, OR — Billy Markus (genesis miner) ──
    "DOGE": GenesisData(datetime(2013, 12, 6, 0, 0, 0, tzinfo=timezone.utc),
                        45.5152, -122.6784, "Portland"),
    # ── NEAR: San Francisco, CA — NEAR Protocol HQ ──
    "NEAR": GenesisData(datetime(2020, 10, 13, 0, 0, 0, tzinfo=timezone.utc),
                        37.7749, -122.4194, "San Francisco"),
    # ── SUI: Palo Alto, CA — Mysten Labs HQ ──
    "SUI": GenesisData(datetime(2023, 5, 3, 0, 0, 0, tzinfo=timezone.utc),
                       37.4419, -122.1430, "Palo Alto"),
    # ── UNI: New York City — Hayden Adams / Uniswap Labs ──
    "UNI": GenesisData(datetime(2018, 11, 2, 0, 0, 0, tzinfo=timezone.utc),
                       40.7128, -74.0060, "New York City"),
    # ── AAVE: Helsinki, Finland — Stani Kulechov / ETHLend ──
    "AAVE": GenesisData(datetime(2017, 11, 27, 0, 0, 0, tzinfo=timezone.utc),
                        60.1699, 24.9384, "Helsinki"),
    # ── LTC: Mountain View, CA — Charlie Lee at Google ──
    "LTC": GenesisData(datetime(2011, 10, 7, 0, 0, 0, tzinfo=timezone.utc),
                       37.3861, -122.0839, "Mountain View"),
}

# Natal charts are cached after first computation
_natal_cache: Dict[str, SkyState] = {}


@dataclass
class TransitHit:
    """A significant transit aspect to a natal planet."""
    transit_planet: str       # Current planet
    natal_planet: str         # Planet in genesis chart
    aspect_type: str          # conjunction, opposition, trine, square, sextile
    orb: float                # Degrees from exact
    effect: str               # Market interpretation
    strength: float           # -1.0 to +1.0


@dataclass
class NatalTransitReport:
    """Transit analysis for a specific crypto."""
    symbol: str
    genesis_date: datetime
    hits: List[TransitHit]
    transit_score: float       # -1.0 to +1.0
    summary: str


def get_natal_chart(symbol: str) -> Optional[SkyState]:
    """Get or compute the natal (genesis) chart for a crypto."""
    if symbol not in CRYPTO_GENESIS:
        return None

    if symbol not in _natal_cache:
        _natal_cache[symbol] = get_sky_state(CRYPTO_GENESIS[symbol].time)

    return _natal_cache[symbol]


def _transit_effect(transit_planet: str, natal_planet: str, aspect_type: str) -> tuple:
    """Determine effect and strength of a transit aspect."""

    # Jupiter transits = expansion, growth
    if transit_planet == "Jupiter":
        if aspect_type in ("conjunction", "trine"):
            return "Jupiter blesses — expansion, price growth", 0.7
        if aspect_type == "opposition":
            return "Jupiter opposition — overextension risk", -0.2
        if aspect_type == "square":
            return "Jupiter square — stalled growth", -0.1

    # Saturn transits = contraction, testing
    if transit_planet == "Saturn":
        if aspect_type in ("conjunction", "opposition", "square"):
            return "Saturn pressure — price suppression, consolidation", -0.6
        if aspect_type == "trine":
            return "Saturn trine — structured growth, solid base", 0.3

    # Mars transits = energy, volatility
    if transit_planet == "Mars":
        if aspect_type in ("conjunction", "square"):
            return "Mars fire — volatile, breakout attempts", 0.2
        if aspect_type == "opposition":
            return "Mars opposition — aggressive selling pressure", -0.4

    # Rahu transits = amplification, chaos
    if transit_planet == "Rahu":
        if aspect_type == "conjunction":
            return "Rahu amplifies — unpredictable moves, possible pump", 0.1
        if aspect_type in ("opposition", "square"):
            return "Rahu stress — deception, fake moves", -0.4

    # Ketu transits = detachment, sudden events
    if transit_planet == "Ketu":
        if aspect_type == "conjunction":
            return "Ketu detachment — sudden drops or spiritual shifts", -0.3

    # Venus transits = short-term positive
    if transit_planet == "Venus":
        if aspect_type in ("conjunction", "trine"):
            return "Venus grace — attractive entry, gains", 0.3

    # Mercury transits = communication, tech
    if transit_planet == "Mercury":
        if aspect_type in ("conjunction", "trine"):
            return "Mercury activation — news, updates, movement", 0.2

    return f"{transit_planet} {aspect_type} natal {natal_planet}", 0.0


def _classify_transit_aspect(angle: float) -> Optional[tuple]:
    """Check if an angular distance forms a major aspect."""
    checks = [
        ("conjunction", 0.0, 8.0),
        ("sextile", 60.0, 6.0),
        ("square", 90.0, 8.0),
        ("trine", 120.0, 8.0),
        ("opposition", 180.0, 8.0),
    ]
    for name, exact, orb in checks:
        if abs(angle - exact) <= orb:
            return name, abs(angle - exact)
    return None


def analyze_transits(symbol: str, current_sky: SkyState) -> Optional[NatalTransitReport]:
    """Analyze current planetary transits to a crypto's natal chart."""
    natal = get_natal_chart(symbol)
    if natal is None:
        return None

    hits: List[TransitHit] = []

    # Key natal planets to check transits against
    # Focus on Sun, Moon, Jupiter, Saturn (major significators)
    natal_planets_to_check = ["Sun", "Moon", "Mars", "Jupiter", "Saturn"]

    # Transit planets (slow movers are more significant)
    transit_planets = ["Jupiter", "Saturn", "Rahu", "Ketu", "Mars", "Venus", "Mercury"]

    for t_name in transit_planets:
        t_pos = current_sky.planets[t_name]

        for n_name in natal_planets_to_check:
            n_pos = natal.planets[n_name]

            angle = get_angular_distance(t_pos.longitude, n_pos.longitude)
            result = _classify_transit_aspect(angle)

            if result is None:
                continue

            aspect_type, orb = result
            effect_text, strength = _transit_effect(t_name, n_name, aspect_type)

            # Slow movers (Jupiter, Saturn, Rahu, Ketu) are more impactful
            if t_name in ("Jupiter", "Saturn", "Rahu", "Ketu"):
                strength *= 1.5

            # Tighter orb = stronger effect
            strength *= (1.0 - orb / 10.0)

            hits.append(TransitHit(
                transit_planet=t_name,
                natal_planet=n_name,
                aspect_type=aspect_type,
                orb=round(orb, 2),
                effect=effect_text,
                strength=round(max(-1.0, min(1.0, strength)), 3),
            ))

    # Overall score: weighted average of hits
    if hits:
        total_strength = sum(h.strength for h in hits)
        transit_score = max(-1.0, min(1.0, total_strength / max(len(hits), 1)))
    else:
        transit_score = 0.0

    # Summary
    bullish = [h for h in hits if h.strength > 0.2]
    bearish = [h for h in hits if h.strength < -0.2]

    if transit_score > 0.3:
        summary = f"{symbol}: favorable transits ({len(bullish)} bullish aspects)"
    elif transit_score < -0.3:
        summary = f"{symbol}: challenging transits ({len(bearish)} bearish aspects)"
    else:
        summary = f"{symbol}: mixed/neutral transits"

    return NatalTransitReport(
        symbol=symbol,
        genesis_date=CRYPTO_GENESIS[symbol].time,
        hits=hits,
        transit_score=round(transit_score, 3),
        summary=summary,
    )
