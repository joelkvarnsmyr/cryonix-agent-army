"""
Vedic scoring engine — combines all vedic signals into actionable scores.

Produces a composite score for the auto-trader to consume:
  vedic:score     — overall market timing score (-100 to +100)
  vedic:moon      — moon phase + nakshatra data
  vedic:planets   — all planet positions + retrogrades
  vedic:aspects   — active aspects + nature
  vedic:muhurta   — current muhurta assessment
  vedic:transit:{SYMBOL} — per-symbol transit scores
"""
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .ephemeris import SkyState, get_sky_state
from .nakshatras import nakshatra_at_longitude, moon_nakshatra_score
from .aspects import detect_aspects, detect_retrogrades, mercury_retrograde, AspectReport
from .muhurta import calculate_muhurta, calculate_tithi, MuhurtaScore
from .natal import analyze_transits, CRYPTO_GENESIS, NatalTransitReport


@dataclass
class VedicScore:
    """Composite vedic intelligence for the auto-trader."""
    timestamp: float
    overall_score: int           # -100 to +100
    label: str                   # "very_bullish", "bullish", "neutral", "bearish", "very_bearish"

    # Components
    muhurta_score: float         # -1.0 to +1.0
    nakshatra_score: float       # -1.0 to +1.0
    aspect_score: float          # -1.0 to +1.0
    retrograde_penalty: float    # 0 to -0.3

    # Details
    moon_nakshatra: str
    moon_nakshatra_bias: str
    tithi_name: str
    tithi_number: int
    moon_phase_pct: float
    is_mercury_retrograde: bool
    retrogrades: List[str]
    active_aspects: List[Dict[str, Any]]
    muhurta_label: str
    hora_lord: str
    vara_day: str


@dataclass
class SymbolTransitScore:
    """Per-symbol transit score for the auto-trader."""
    symbol: str
    score: int                   # -100 to +100
    label: str
    hits: List[Dict[str, Any]]
    summary: str
    timestamp: float


def compute_vedic_score(sky: Optional[SkyState] = None) -> VedicScore:
    """Compute the complete vedic score for the current moment."""
    if sky is None:
        sky = get_sky_state()

    now = sky.timestamp.timestamp() if sky.timestamp else datetime.now(timezone.utc).timestamp()

    # ── Muhurta ──
    muhurta = calculate_muhurta(sky)

    # ── Moon nakshatra score ──
    moon_lon = sky.planets["Moon"].longitude
    nak_score = moon_nakshatra_score(moon_lon)
    moon_nak = nakshatra_at_longitude(moon_lon)

    # ── Aspects ──
    aspect_report = detect_aspects(sky)

    # ── Retrogrades ──
    retros = detect_retrogrades(sky)
    merc_retro = mercury_retrograde(sky)

    # Retrograde penalty: Mercury retro = -0.15, each other = -0.05
    retro_penalty = 0.0
    if merc_retro:
        retro_penalty -= 0.15
    for r in retros:
        if r != "Mercury" and r not in ("Rahu", "Ketu"):  # Nodes are always "retrograde"
            retro_penalty -= 0.05
    retro_penalty = max(-0.3, retro_penalty)

    # ── Composite score ──
    # Weights: muhurta 35%, nakshatra 25%, aspects 25%, retrogrades 15%
    composite = (
        muhurta.score * 0.35 +
        nak_score * 0.25 +
        aspect_report.aspect_score * 0.25 +
        retro_penalty * 0.15 / 0.3  # Normalize penalty to -1..0 range
    )

    # Scale to -100..+100
    overall = int(round(composite * 100))
    overall = max(-100, min(100, overall))

    # Label
    if overall >= 40:
        label = "very_bullish"
    elif overall >= 15:
        label = "bullish"
    elif overall >= -15:
        label = "neutral"
    elif overall >= -40:
        label = "bearish"
    else:
        label = "very_bearish"

    # Format aspects for Redis
    active_aspects = [
        {
            "planets": f"{a.planet1}-{a.planet2}",
            "type": a.aspect_type,
            "orb": round(a.orb, 1),
            "nature": a.nature,
            "effect": a.market_effect,
        }
        for a in aspect_report.aspects
    ]

    return VedicScore(
        timestamp=now,
        overall_score=overall,
        label=label,
        muhurta_score=round(muhurta.score, 3),
        nakshatra_score=round(nak_score, 3),
        aspect_score=round(aspect_report.aspect_score, 3),
        retrograde_penalty=round(retro_penalty, 3),
        moon_nakshatra=moon_nak.nakshatra.name,
        moon_nakshatra_bias=moon_nak.nakshatra.trading_bias,
        tithi_name=muhurta.tithi.name,
        tithi_number=muhurta.tithi.number,
        moon_phase_pct=muhurta.tithi.moon_phase_pct,
        is_mercury_retrograde=merc_retro,
        retrogrades=[r for r in retros if r not in ("Rahu", "Ketu")],
        active_aspects=active_aspects,
        muhurta_label=muhurta.label,
        hora_lord=muhurta.hora_lord,
        vara_day=muhurta.vara.day_name,
    )


def compute_symbol_transits(
    symbols: List[str],
    sky: Optional[SkyState] = None,
) -> Dict[str, SymbolTransitScore]:
    """Compute transit scores for symbols that have natal charts."""
    if sky is None:
        sky = get_sky_state()

    now = sky.timestamp.timestamp() if sky.timestamp else datetime.now(timezone.utc).timestamp()
    results: Dict[str, SymbolTransitScore] = {}

    for symbol in symbols:
        if symbol not in CRYPTO_GENESIS:
            continue

        report = analyze_transits(symbol, sky)
        if report is None:
            continue

        # Scale to -100..+100
        score_int = int(round(report.transit_score * 100))
        score_int = max(-100, min(100, score_int))

        if score_int >= 30:
            label = "bullish"
        elif score_int >= -30:
            label = "neutral"
        else:
            label = "bearish"

        hits = [
            {
                "transit": h.transit_planet,
                "natal": h.natal_planet,
                "aspect": h.aspect_type,
                "orb": h.orb,
                "effect": h.effect,
                "strength": h.strength,
            }
            for h in report.hits
        ]

        results[symbol] = SymbolTransitScore(
            symbol=symbol,
            score=score_int,
            label=label,
            hits=hits,
            summary=report.summary,
            timestamp=now,
        )

    return results
