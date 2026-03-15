"""
Swiss Ephemeris wrapper for vedic astrology calculations.

Provides sidereal (nirayana) planetary positions using Lahiri ayanamsa.
All longitudes are 0-360° sidereal unless noted.
"""
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import swisseph as swe

# ── Ayanamsa ──────────────────────────────────────────────────────────
# Lahiri (Chitrapaksha) is the standard for Jyotish
AYANAMSA = swe.SIDM_LAHIRI

# ── Planet codes ──────────────────────────────────────────────────────
PLANETS = {
    "Sun": swe.SUN,
    "Moon": swe.MOON,
    "Mars": swe.MARS,
    "Mercury": swe.MERCURY,
    "Jupiter": swe.JUPITER,
    "Venus": swe.VENUS,
    "Saturn": swe.SATURN,
    "Rahu": swe.MEAN_NODE,    # Mean north lunar node
    "Ketu": -1,                # South node = Rahu + 180°
}

# ── Zodiac signs ──────────────────────────────────────────────────────
SIGNS = [
    "Aries", "Taurus", "Gemini", "Cancer",
    "Leo", "Virgo", "Libra", "Scorpio",
    "Sagittarius", "Capricorn", "Aquarius", "Pisces",
]

# ── Planet natures ────────────────────────────────────────────────────
BENEFICS = {"Jupiter", "Venus", "Moon", "Mercury"}  # Mercury conditional
MALEFICS = {"Sun", "Mars", "Saturn", "Rahu", "Ketu"}


@dataclass
class PlanetPosition:
    """Position of a planet in the sidereal zodiac."""
    name: str
    longitude: float          # 0-360° sidereal
    latitude: float
    speed: float              # deg/day (negative = retrograde)
    sign: str                 # Zodiac sign name
    sign_index: int           # 0-11
    degrees_in_sign: float    # 0-30°
    is_retrograde: bool


@dataclass
class SkyState:
    """Complete snapshot of the sky at a moment."""
    timestamp: datetime
    planets: Dict[str, PlanetPosition]
    ayanamsa: float


def _datetime_to_jd(dt: datetime) -> float:
    """Convert datetime to Julian Day number."""
    # Ensure UTC
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt_utc = dt.astimezone(timezone.utc)

    return swe.julday(
        dt_utc.year,
        dt_utc.month,
        dt_utc.day,
        dt_utc.hour + dt_utc.minute / 60.0 + dt_utc.second / 3600.0,
    )


def get_ayanamsa(dt: datetime) -> float:
    """Get Lahiri ayanamsa value for a given time."""
    jd = _datetime_to_jd(dt)
    swe.set_sid_mode(AYANAMSA)
    return swe.get_ayanamsa(jd)


def get_planet_position(planet_name: str, dt: datetime) -> PlanetPosition:
    """Calculate sidereal position of a single planet."""
    jd = _datetime_to_jd(dt)
    swe.set_sid_mode(AYANAMSA)

    if planet_name == "Ketu":
        # Ketu = Rahu + 180°
        result, _flag = swe.calc_ut(jd, swe.MEAN_NODE, swe.FLG_SIDEREAL | swe.FLG_SPEED)
        lon = (result[0] + 180.0) % 360.0
        lat = -result[1]
        speed = result[3]
    else:
        planet_code = PLANETS[planet_name]
        result, _flag = swe.calc_ut(jd, planet_code, swe.FLG_SIDEREAL | swe.FLG_SPEED)
        lon = result[0] % 360.0
        lat = result[1]
        speed = result[3]

    sign_index = int(lon / 30.0)
    degrees_in_sign = lon % 30.0

    return PlanetPosition(
        name=planet_name,
        longitude=lon,
        latitude=lat,
        speed=speed,
        sign=SIGNS[sign_index],
        sign_index=sign_index,
        degrees_in_sign=degrees_in_sign,
        is_retrograde=speed < 0,
    )


def get_sky_state(dt: Optional[datetime] = None) -> SkyState:
    """Get complete sky snapshot for all planets at a given time."""
    if dt is None:
        dt = datetime.now(timezone.utc)

    planets = {}
    for name in PLANETS:
        planets[name] = get_planet_position(name, dt)

    ayanamsa_val = get_ayanamsa(dt)

    return SkyState(
        timestamp=dt,
        planets=planets,
        ayanamsa=ayanamsa_val,
    )


def get_angular_distance(lon1: float, lon2: float) -> float:
    """Shortest angular distance between two longitudes (0-180°)."""
    diff = abs(lon1 - lon2) % 360.0
    return min(diff, 360.0 - diff)


def get_signed_distance(from_lon: float, to_lon: float) -> float:
    """Signed forward distance from one longitude to another (0-360°)."""
    return (to_lon - from_lon) % 360.0
