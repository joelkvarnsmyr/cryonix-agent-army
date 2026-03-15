"""
Planetary aspects (Drishti) and conjunctions.

Vedic aspects differ from Western:
  - All planets aspect the 7th house (180°)
  - Mars also aspects 4th and 8th (90° and 210°)
  - Jupiter also aspects 5th and 9th (120° and 240°)
  - Saturn also aspects 3rd and 10th (60° and 270°)
  - Rahu/Ketu aspect 5th, 7th, 9th from their position
"""
from dataclasses import dataclass
from typing import Dict, List, Tuple

from .ephemeris import (
    BENEFICS, MALEFICS, PlanetPosition, SkyState,
    get_angular_distance, get_signed_distance,
)

# ── Aspect rules ──────────────────────────────────────────────────────
# Houses aspected by each planet (as sign distances, 1-indexed)
SPECIAL_ASPECTS: Dict[str, List[int]] = {
    "Sun":     [7],
    "Moon":    [7],
    "Mars":    [4, 7, 8],
    "Mercury": [7],
    "Jupiter": [5, 7, 9],
    "Venus":   [7],
    "Saturn":  [3, 7, 10],
    "Rahu":    [5, 7, 9],
    "Ketu":    [5, 7, 9],
}

# Orb for aspect (degrees of tolerance)
CONJUNCTION_ORB = 10.0  # degrees
ASPECT_ORB = 12.0       # wider orb for house-based aspects

# ── Major aspect patterns with market significance ────────────────────
# These are specific planet combinations that financial astrologers track

@dataclass
class Aspect:
    """A detected aspect between two planets."""
    planet1: str
    planet2: str
    aspect_type: str      # "conjunction", "opposition", "trine", "square", "sextile", "special"
    exact_angle: float    # Actual angular distance
    orb: float            # How far from exact
    nature: str           # "benefic", "malefic", "mixed"
    market_effect: str    # Brief description


@dataclass
class AspectReport:
    """All active aspects at a moment."""
    aspects: List[Aspect]
    dominant_nature: str   # "benefic", "malefic", "neutral"
    aspect_score: float    # -1.0 to +1.0


def _classify_aspect(angle: float) -> Tuple[str, float]:
    """Classify angular distance into aspect type + orb from exact."""
    aspects = [
        ("conjunction", 0.0, CONJUNCTION_ORB),
        ("sextile", 60.0, 8.0),
        ("square", 90.0, 10.0),
        ("trine", 120.0, 10.0),
        ("opposition", 180.0, CONJUNCTION_ORB),
    ]

    for name, exact, orb in aspects:
        diff = abs(angle - exact)
        if diff <= orb:
            return name, diff

    return "", 999.0


def _aspect_nature(planet1: str, planet2: str, aspect_type: str) -> str:
    """Determine benefic/malefic nature of an aspect."""
    p1_benefic = planet1 in BENEFICS
    p2_benefic = planet2 in BENEFICS

    # Conjunctions and trines with benefics = good
    if aspect_type in ("conjunction", "trine", "sextile"):
        if p1_benefic and p2_benefic:
            return "benefic"
        if not p1_benefic and not p2_benefic:
            return "malefic"
        return "mixed"

    # Squares and oppositions = stress
    if aspect_type in ("square", "opposition"):
        if p1_benefic and p2_benefic:
            return "mixed"  # Even benefics under stress
        return "malefic"

    return "neutral"


def _market_effect(planet1: str, planet2: str, aspect_type: str) -> str:
    """Describe market effect of a specific aspect."""
    key = tuple(sorted([planet1, planet2]))

    # Major market-moving combinations
    effects = {
        ("Jupiter", "Saturn"): {
            "conjunction": "Major cycle shift — new 20-year economic era",
            "opposition": "Peak tension between expansion and contraction",
            "square": "Growth vs restriction conflict — choppy markets",
            "trine": "Balanced growth — steady uptrend",
        },
        ("Mars", "Saturn"): {
            "conjunction": "Frustration, blocked energy — crashes possible",
            "opposition": "Conflict peak — sharp sell-offs",
            "square": "Aggressive tension — violent swings",
        },
        ("Jupiter", "Rahu"): {
            "conjunction": "Guru Chandal — inflated expectations, bubbles",
        },
        ("Mars", "Rahu"): {
            "conjunction": "Angarak — explosive, unpredictable aggression",
        },
        ("Saturn", "Rahu"): {
            "conjunction": "Shrapit — karmic disruption, black swan events",
        },
        ("Moon", "Rahu"): {
            "conjunction": "Grahan — emotional panic, fear selling",
        },
        ("Jupiter", "Venus"): {
            "conjunction": "Abundance — risk-on, bullish",
            "trine": "Wealth flow — steady gains",
        },
        ("Mercury", "Rahu"): {
            "conjunction": "Communication chaos — fake news moves markets",
        },
    }

    if key in effects and aspect_type in effects[key]:
        return effects[key][aspect_type]

    # Generic fallbacks
    nature = _aspect_nature(planet1, planet2, aspect_type)
    if nature == "benefic":
        return f"{planet1}-{planet2} {aspect_type}: supportive energy"
    if nature == "malefic":
        return f"{planet1}-{planet2} {aspect_type}: tension/stress"
    return f"{planet1}-{planet2} {aspect_type}: mixed influence"


def detect_aspects(sky: SkyState) -> AspectReport:
    """Detect all active aspects between planets."""
    planets = list(sky.planets.values())
    aspects: List[Aspect] = []

    for i in range(len(planets)):
        for j in range(i + 1, len(planets)):
            p1 = planets[i]
            p2 = planets[j]

            angle = get_angular_distance(p1.longitude, p2.longitude)
            aspect_type, orb = _classify_aspect(angle)

            if not aspect_type:
                continue

            nature = _aspect_nature(p1.name, p2.name, aspect_type)
            effect = _market_effect(p1.name, p2.name, aspect_type)

            aspects.append(Aspect(
                planet1=p1.name,
                planet2=p2.name,
                aspect_type=aspect_type,
                exact_angle=angle,
                orb=orb,
                nature=nature,
                market_effect=effect,
            ))

    # Score: sum up benefic/malefic aspects
    benefic_count = sum(1 for a in aspects if a.nature == "benefic")
    malefic_count = sum(1 for a in aspects if a.nature == "malefic")
    total = len(aspects) or 1

    score = (benefic_count - malefic_count) / total
    score = max(-1.0, min(1.0, score))

    if score > 0.2:
        dominant = "benefic"
    elif score < -0.2:
        dominant = "malefic"
    else:
        dominant = "neutral"

    return AspectReport(
        aspects=aspects,
        dominant_nature=dominant,
        aspect_score=score,
    )


def detect_retrogrades(sky: SkyState) -> List[str]:
    """List all currently retrograde planets."""
    return [p.name for p in sky.planets.values() if p.is_retrograde]


def mercury_retrograde(sky: SkyState) -> bool:
    """Check if Mercury is retrograde (significant for communication/tech)."""
    return sky.planets["Mercury"].is_retrograde
