"""
Muhurta (auspicious timing) and lunar calculations.

Determines whether the current moment is favorable for trading
based on tithi (lunar day), vara (weekday), nakshatra, and yoga.
"""
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from .ephemeris import PlanetPosition, SkyState, get_signed_distance
from .nakshatras import NakshatraPosition, nakshatra_at_longitude


# ── Tithi (Lunar Day) ────────────────────────────────────────────────

TITHI_NAMES = [
    "Pratipada", "Dvitiya", "Tritiya", "Chaturthi", "Panchami",
    "Shashthi", "Saptami", "Ashtami", "Navami", "Dashami",
    "Ekadashi", "Dvadashi", "Trayodashi", "Chaturdashi", "Purnima",  # Shukla (waxing)
    "Pratipada", "Dvitiya", "Tritiya", "Chaturthi", "Panchami",
    "Shashthi", "Saptami", "Ashtami", "Navami", "Dashami",
    "Ekadashi", "Dvadashi", "Trayodashi", "Chaturdashi", "Amavasya",  # Krishna (waning)
]

# Tithis unfavorable for new ventures (Rikta tithis = 4, 9, 14 of each paksha)
RIKTA_TITHIS = {4, 9, 14, 19, 24, 29}

# Tithis favorable for buying/accumulation
BUYING_TITHIS = {2, 3, 5, 7, 10, 11, 13, 17, 18, 20, 22, 25, 26}


@dataclass
class TithiInfo:
    """Lunar day information."""
    number: int            # 1-30
    name: str
    paksha: str            # "Shukla" (waxing) or "Krishna" (waning)
    is_full_moon: bool
    is_new_moon: bool
    is_rikta: bool         # Unfavorable
    is_buying_day: bool    # Good for accumulation
    moon_phase_pct: float  # 0% (new) to 100% (full)


def calculate_tithi(sky: SkyState) -> TithiInfo:
    """Calculate the current tithi (lunar day) from Sun-Moon distance."""
    sun_lon = sky.planets["Sun"].longitude
    moon_lon = sky.planets["Moon"].longitude

    # Forward distance from Sun to Moon
    diff = get_signed_distance(sun_lon, moon_lon)

    # Each tithi = 12° of separation
    tithi_num = math.ceil(diff / 12.0)
    if tithi_num == 0:
        tithi_num = 30
    if tithi_num > 30:
        tithi_num = 30

    # Paksha
    paksha = "Shukla" if tithi_num <= 15 else "Krishna"
    is_full = tithi_num == 15
    is_new = tithi_num == 30

    # Moon phase percentage (0=new, 100=full)
    if tithi_num <= 15:
        phase_pct = (tithi_num / 15.0) * 100.0
    else:
        phase_pct = ((30 - tithi_num) / 15.0) * 100.0

    return TithiInfo(
        number=tithi_num,
        name=TITHI_NAMES[tithi_num - 1],
        paksha=paksha,
        is_full_moon=is_full,
        is_new_moon=is_new,
        is_rikta=tithi_num in RIKTA_TITHIS,
        is_buying_day=tithi_num in BUYING_TITHIS,
        moon_phase_pct=round(phase_pct, 1),
    )


# ── Vara (Weekday) ───────────────────────────────────────────────────

VARA_LORDS = {
    0: ("Monday", "Moon", "neutral"),     # Chandra — emotional, indecisive
    1: ("Tuesday", "Mars", "volatile"),    # Mangala — aggressive, risky entries
    2: ("Wednesday", "Mercury", "bullish"), # Budha — good for trading, communication
    3: ("Thursday", "Jupiter", "bullish"),  # Guru — most auspicious for wealth
    4: ("Friday", "Venus", "bullish"),     # Shukra — luxury, gains
    5: ("Saturday", "Saturn", "bearish"),   # Shani — delays, losses
    6: ("Sunday", "Sun", "neutral"),       # Surya — authority, steady
}


@dataclass
class VaraInfo:
    """Weekday ruler information."""
    day_name: str
    lord: str
    trading_bias: str


def get_vara(dt: Optional[datetime] = None) -> VaraInfo:
    """Get the vara (weekday ruler) for a datetime."""
    if dt is None:
        dt = datetime.now(timezone.utc)
    weekday = dt.weekday()  # 0=Monday
    day_name, lord, bias = VARA_LORDS[weekday]
    return VaraInfo(day_name=day_name, lord=lord, trading_bias=bias)


# ── Hora (Planetary Hour) ────────────────────────────────────────────

# Hora sequence from sunrise, cycling through 7 planets
# Order: Sun, Venus, Mercury, Moon, Saturn, Jupiter, Mars (Chaldean order)
HORA_SEQUENCE = ["Sun", "Venus", "Mercury", "Moon", "Saturn", "Jupiter", "Mars"]

# Day starts with the day lord, then follows sequence
HORA_START = {
    6: 0,  # Sunday → Sun
    0: 3,  # Monday → Moon
    1: 6,  # Tuesday → Mars
    2: 2,  # Wednesday → Mercury
    3: 5,  # Thursday → Jupiter
    4: 1,  # Friday → Venus
    5: 4,  # Saturday → Saturn
}


def get_hora_lord(dt: Optional[datetime] = None) -> str:
    """Get the planetary ruler of the current hour.

    Simplified: uses fixed 1-hour slots from midnight.
    (Full implementation would use sunrise-based division.)
    """
    if dt is None:
        dt = datetime.now(timezone.utc)

    weekday = dt.weekday()
    hour = dt.hour
    start_idx = HORA_START[weekday]
    hora_idx = (start_idx + hour) % 7

    return HORA_SEQUENCE[hora_idx]


# ── Muhurta Score ─────────────────────────────────────────────────────

@dataclass
class MuhurtaScore:
    """Overall muhurta (auspicious timing) assessment."""
    score: float           # -1.0 to +1.0
    label: str             # "very_auspicious", "auspicious", "neutral", "inauspicious", "very_inauspicious"
    tithi: TithiInfo
    vara: VaraInfo
    moon_nakshatra: NakshatraPosition
    hora_lord: str
    factors: dict          # Breakdown of scoring factors


def calculate_muhurta(sky: SkyState) -> MuhurtaScore:
    """Calculate overall muhurta score for the current moment.

    Combines tithi, vara, nakshatra, and hora into a single score.
    """
    tithi = calculate_tithi(sky)
    vara = get_vara(sky.timestamp)
    moon_nak = nakshatra_at_longitude(sky.planets["Moon"].longitude)
    hora = get_hora_lord(sky.timestamp)

    factors = {}
    score = 0.0

    # ── Tithi factor (weight: 30%) ──
    if tithi.is_buying_day:
        factors["tithi"] = 0.3
    elif tithi.is_rikta:
        factors["tithi"] = -0.3
    elif tithi.is_full_moon:
        factors["tithi"] = -0.1  # Volatility risk
    elif tithi.is_new_moon:
        factors["tithi"] = -0.15  # Low energy
    else:
        factors["tithi"] = 0.0

    # ── Vara factor (weight: 20%) ──
    vara_scores = {"bullish": 0.2, "neutral": 0.0, "bearish": -0.2, "volatile": -0.1}
    factors["vara"] = vara_scores.get(vara.trading_bias, 0.0)

    # ── Nakshatra factor (weight: 35%) ──
    nak_bias = moon_nak.nakshatra.trading_bias
    nak_scores = {"bullish": 0.35, "neutral": 0.0, "bearish": -0.3, "volatile": -0.15}
    factors["nakshatra"] = nak_scores.get(nak_bias, 0.0)

    # Pushya special bonus
    if moon_nak.nakshatra.index == 7:
        factors["nakshatra"] = 0.5

    # ── Hora factor (weight: 15%) ──
    hora_scores = {
        "Jupiter": 0.15, "Venus": 0.1, "Mercury": 0.05,
        "Sun": 0.0, "Moon": 0.0,
        "Saturn": -0.1, "Mars": -0.05,
    }
    factors["hora"] = hora_scores.get(hora, 0.0)

    # ── Sum all factors ──
    score = sum(factors.values())
    score = max(-1.0, min(1.0, score))

    # Label
    if score >= 0.5:
        label = "very_auspicious"
    elif score >= 0.2:
        label = "auspicious"
    elif score >= -0.2:
        label = "neutral"
    elif score >= -0.5:
        label = "inauspicious"
    else:
        label = "very_inauspicious"

    return MuhurtaScore(
        score=score,
        label=label,
        tithi=tithi,
        vara=vara,
        moon_nakshatra=moon_nak,
        hora_lord=hora,
        factors=factors,
    )
