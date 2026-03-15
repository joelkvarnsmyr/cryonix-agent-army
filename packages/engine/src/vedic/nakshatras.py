"""
Nakshatra (lunar mansion) calculations.

27 nakshatras of 13°20' each, dividing the 360° sidereal zodiac.
Each nakshatra has a ruling planet, deity, and trading implications.
"""
from dataclasses import dataclass
from typing import Optional


# ── Nakshatra data ────────────────────────────────────────────────────

@dataclass
class NakshatraInfo:
    """Static data for a nakshatra."""
    index: int           # 0-26
    name: str
    lord: str            # Ruling planet (Vimshottari dasha lord)
    nature: str          # Deva (divine), Manushya (human), Rakshasa (demonic)
    gana: str            # Same as nature, used for compatibility
    trading_bias: str    # "bullish", "bearish", "neutral", "volatile"
    description: str     # Brief trading relevance


# Nakshatra sequence with trading-relevant properties
# Lords follow Vimshottari cycle: Ketu, Venus, Sun, Moon, Mars, Rahu, Jupiter, Saturn, Mercury
NAKSHATRAS = [
    NakshatraInfo(0,  "Ashwini",       "Ketu",    "Deva",     "Deva",     "bullish",  "Swift action, new beginnings — favor quick entries"),
    NakshatraInfo(1,  "Bharani",       "Venus",   "Manushya", "Manushya", "bearish",  "Restraint, contraction — caution on new positions"),
    NakshatraInfo(2,  "Krittika",      "Sun",     "Rakshasa", "Rakshasa", "volatile", "Sharp cuts, purification — expect sudden moves"),
    NakshatraInfo(3,  "Rohini",        "Moon",    "Manushya", "Manushya", "bullish",  "Growth, wealth, fertility — favorable for accumulation"),
    NakshatraInfo(4,  "Mrigashira",    "Mars",    "Deva",     "Deva",     "neutral",  "Searching, exploration — good for research, not action"),
    NakshatraInfo(5,  "Ardra",         "Rahu",    "Manushya", "Manushya", "volatile", "Storms, destruction then renewal — high volatility"),
    NakshatraInfo(6,  "Punarvasu",     "Jupiter", "Deva",     "Deva",     "bullish",  "Return, restoration — recovery rallies"),
    NakshatraInfo(7,  "Pushya",        "Saturn",  "Deva",     "Deva",     "bullish",  "THE most auspicious for buying — nourishment, wealth"),
    NakshatraInfo(8,  "Ashlesha",      "Mercury", "Rakshasa", "Rakshasa", "bearish",  "Deception, poison — beware of traps, fake breakouts"),
    NakshatraInfo(9,  "Magha",         "Ketu",    "Rakshasa", "Rakshasa", "neutral",  "Authority, endings — potential regime changes"),
    NakshatraInfo(10, "Purva Phalguni","Venus",   "Manushya", "Manushya", "bullish",  "Enjoyment, luxury — risk-on sentiment"),
    NakshatraInfo(11, "Uttara Phalguni","Sun",    "Manushya", "Manushya", "neutral",  "Contracts, patronage — steady, no drama"),
    NakshatraInfo(12, "Hasta",         "Moon",    "Deva",     "Deva",     "bullish",  "Skill, craftsmanship — precise entries work well"),
    NakshatraInfo(13, "Chitra",        "Mars",    "Rakshasa", "Rakshasa", "neutral",  "Beauty, illusion — things look better than they are"),
    NakshatraInfo(14, "Swati",         "Rahu",    "Deva",     "Deva",     "volatile", "Independence, wind — scattered, unpredictable moves"),
    NakshatraInfo(15, "Vishakha",      "Jupiter", "Rakshasa", "Rakshasa", "bullish",  "Determination, triumph — breakouts succeed"),
    NakshatraInfo(16, "Anuradha",      "Saturn",  "Deva",     "Deva",     "neutral",  "Devotion, friendship — sideways consolidation"),
    NakshatraInfo(17, "Jyeshtha",      "Mercury", "Rakshasa", "Rakshasa", "bearish",  "Elder, peak — potential tops, exhaustion"),
    NakshatraInfo(18, "Mula",          "Ketu",    "Rakshasa", "Rakshasa", "volatile", "Root destruction — deep crashes possible, but deep value buys"),
    NakshatraInfo(19, "Purva Ashadha", "Venus",   "Manushya", "Manushya", "bullish",  "Invincibility — strong momentum continuation"),
    NakshatraInfo(20, "Uttara Ashadha","Sun",     "Manushya", "Manushya", "bullish",  "Final victory — trend confirmation"),
    NakshatraInfo(21, "Shravana",      "Moon",    "Deva",     "Deva",     "neutral",  "Listening, learning — accumulate quietly"),
    NakshatraInfo(22, "Dhanishtha",    "Mars",    "Rakshasa", "Rakshasa", "bullish",  "Wealth, drums — volume surges, breakouts"),
    NakshatraInfo(23, "Shatabhisha",   "Rahu",    "Rakshasa", "Rakshasa", "volatile", "100 healers, mystery — unusual/unexpected moves"),
    NakshatraInfo(24, "Purva Bhadrapada","Jupiter","Manushya","Manushya", "volatile", "Scorching, intense — large swings both ways"),
    NakshatraInfo(25, "Uttara Bhadrapada","Saturn","Manushya","Manushya", "neutral",  "Depth, wisdom — slow but stable"),
    NakshatraInfo(26, "Revati",        "Mercury", "Deva",     "Deva",     "bullish",  "Completion, prosperity — good for closing cycles"),
]

# Quick lookup by name
_NAKSHATRA_BY_NAME = {n.name: n for n in NAKSHATRAS}

# Span of each nakshatra in degrees
NAKSHATRA_SPAN = 360.0 / 27.0  # 13°20' = 13.3333...°
PADA_SPAN = NAKSHATRA_SPAN / 4.0  # 3°20' = 3.3333...°


@dataclass
class NakshatraPosition:
    """A planet's nakshatra position."""
    nakshatra: NakshatraInfo
    pada: int              # 1-4
    degrees_in_nakshatra: float  # 0 to 13.333°


def nakshatra_at_longitude(longitude: float) -> NakshatraPosition:
    """Determine which nakshatra a sidereal longitude falls in."""
    lon = longitude % 360.0
    index = int(lon / NAKSHATRA_SPAN)
    if index > 26:
        index = 26

    degrees_in = lon - (index * NAKSHATRA_SPAN)
    pada = int(degrees_in / PADA_SPAN) + 1
    if pada > 4:
        pada = 4

    return NakshatraPosition(
        nakshatra=NAKSHATRAS[index],
        pada=pada,
        degrees_in_nakshatra=degrees_in,
    )


def moon_nakshatra_score(longitude: float) -> float:
    """
    Score the Moon's nakshatra for trading favorability.

    Returns: -1.0 (very bearish) to +1.0 (very bullish)
    """
    pos = nakshatra_at_longitude(longitude)
    bias = pos.nakshatra.trading_bias

    scores = {
        "bullish": 0.6,
        "neutral": 0.0,
        "bearish": -0.5,
        "volatile": -0.2,  # Slight negative — volatility = risk
    }

    base = scores.get(bias, 0.0)

    # Pushya (index 7) gets extra boost — traditionally THE best for buying
    if pos.nakshatra.index == 7:
        base = 0.9

    # Mula (index 18) extra penalty — root destruction
    if pos.nakshatra.index == 18:
        base = -0.7

    return base
