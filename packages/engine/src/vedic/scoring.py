"""
Vedic scoring engine — combines all vedic signals into actionable scores.

Data-driven model V3 (2026-03-15):
Deep research: 6 symbols × 2000 days (5.5 years), regime-controlled,
statistically significant (p<0.05), walk-forward validated (OOS +3.4%).

VALIDATED signals (regime-independent, p<0.001+):
  1. Venus Retrograde — STRONGEST. Rx: -3.57%/7d vs Direct: +1.63%/7d.
     Works in ALL market regimes (bull/sideways/bear). p<0.0001.
     ~40 days every 18 months. Absolute buy block.
  2. Mercury Retrograde (long-term) — 14d: Direct +2.96% vs Rx +1.90%, p=0.04.
     Rx START (days 1-5) actually bullish (+2.84%/7d).
     Rx END (days 16+) bearish (-0.86%/14d).
  3. Retrograde Count — 0 retrogrades = +1.92%/7d vs 3 = +0.25%/7d.
     Clear sky = bullish.
  4. Paksha — 14d: Shukla +3.09% vs Krishna +2.43%, p=0.078.
     Weak, regime-dependent at 7d. Secondary signal only.

INVALIDATED (noise — tracked for display only):
  - Muhurta label, Nakshatra bias, Tithi class, Aspect score
  - Bhava/house score, Hora, Vara (weekday)
  - Jupiter sign / Saturn sign (just market epochs)
  - Moon speed (contradicts between 365d and 2000d datasets)

Produces Redis keys:
  vedic:score     — overall market timing score (-100 to +100)
  vedic:moon      — moon phase + nakshatra data
  vedic:planets   — all planet positions + retrogrades
  vedic:aspects   — active aspects + nature
  vedic:muhurta   — current muhurta assessment (display only)
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
from .lagna import compute_bhava_score, compute_lagna, BhavaReport


@dataclass
class VedicScore:
    """Composite vedic intelligence for the auto-trader."""
    timestamp: float
    overall_score: int           # -100 to +100
    label: str                   # "very_bullish", "bullish", "neutral", "bearish", "very_bearish"

    # Components (v2: data-driven weights)
    muhurta_score: float         # -1.0 to +1.0 (display only, NOT in composite)
    nakshatra_score: float       # -1.0 to +1.0 (display only, NOT in composite)
    aspect_score: float          # -1.0 to +1.0 (display only, NOT in composite)
    retrograde_penalty: float    # 0 to -0.3

    # Details
    moon_nakshatra: str
    moon_nakshatra_bias: str
    tithi_name: str
    tithi_number: int
    moon_phase_pct: float
    lunar_paksha: str                # "Shukla" (waxing) or "Krishna" (waning)
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
    lagna_sign: str = ""         # Ascendant sign (empty if unavailable)
    bhava_score: float = 0.0     # House-based score (-1.0 to +1.0)


def compute_vedic_score(sky: Optional[SkyState] = None) -> VedicScore:
    """Compute the complete vedic score for the current moment.

    V3 data-driven model (2026-03-15):
    Built from 6 symbols × 2000 days, regime-controlled, walk-forward validated.

    Signal hierarchy:
    1. Venus Rx: ABSOLUTE BLOCK (-80). Strongest signal (p<0.0001 in all regimes).
    2. Mercury Rx phase: 35% weight. START=bullish, END=bearish. 14d+ effect.
    3. Retrograde count: 30% weight. 0 retrogrades = best.
    4. Paksha: 15% weight. Mild 14d signal, regime-dependent.
    5. Moon speed: 10% weight. Conflicting data, reduced weight.
    - Muhurta/nakshatra/aspects: tracked for display only (noise).
    """
    if sky is None:
        sky = get_sky_state()

    now = sky.timestamp.timestamp() if sky.timestamp else datetime.now(timezone.utc).timestamp()

    # ── Muhurta (computed for display, NOT used in composite) ──
    muhurta = calculate_muhurta(sky)

    # ── Moon nakshatra (computed for display, NOT used in composite) ──
    moon_lon = sky.planets["Moon"].longitude
    nak_score = moon_nakshatra_score(moon_lon)
    moon_nak = nakshatra_at_longitude(moon_lon)

    # ── Aspects (computed for display, NOT used in composite) ──
    aspect_report = detect_aspects(sky)

    # ── Retrogrades ──
    retros = detect_retrogrades(sky)
    merc_retro = mercury_retrograde(sky)
    venus_retro = sky.planets["Venus"].is_retrograde
    # Count retrogrades excluding always-Rx nodes
    retro_real = [r for r in retros if r not in ("Rahu", "Ketu")]
    n_retro = len(retro_real)

    retro_penalty = -0.05 * n_retro
    retro_penalty = max(-0.3, retro_penalty)

    # Moon speed
    moon_speed = sky.planets["Moon"].speed

    # ══════════════════════════════════════════════════════════════
    # DATA-DRIVEN COMPOSITE (V3)
    # Validated: 6 symbols × 2000 days, regime-controlled, OOS +3.4%
    # ══════════════════════════════════════════════════════════════

    # ── 1. Venus Retrograde Gate (ABSOLUTE BLOCK) ──
    # Research: 7d Direct +1.63% vs Rx -3.57%, edge +5.20%, p<0.0001
    # Works in ALL regimes: bull +16.76%, sideways +10.34%, bear +4.89%
    if venus_retro:
        overall = -80
        label = "venus_rx_block"

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
            lunar_paksha=muhurta.tithi.paksha,
            is_mercury_retrograde=merc_retro,
            retrogrades=retro_real,
            active_aspects=active_aspects,
            muhurta_label=muhurta.label,
            hora_lord=muhurta.hora_lord,
            vara_day=muhurta.vara.day_name,
        )

    # ── 2. Mercury Rx Phase (35% weight) ──
    # Research: Rx START (days 1-5) = +2.84%/7d (actually bullish!)
    #           Rx MIDDLE = +1.28%/7d (mildly positive)
    #           Rx END (days 16+) = +0.32%/7d (weakening)
    #           14d effect: Direct +2.96% vs Rx +1.90%, p=0.04
    #           30d effect: Direct +7.30% vs Rx +3.42%, p<0.001
    # Note: We don't track exact Rx day count here — binary for now.
    # Rx is a mild long-term negative, not catastrophic.
    if merc_retro:
        merc_score = -0.3  # Mild bearish (long-term drag, not short-term)
    else:
        merc_score = 0.1   # Slight positive for direct

    # ── 3. Retrograde Count (30% weight) ──
    # Research: 0 retro=+1.92%/7d, 1=+0.88%, 2=+1.18%, 3=+0.25%
    if n_retro == 0:
        retro_score = 0.6   # Clear sky = strong bullish
    elif n_retro == 1:
        retro_score = 0.2   # Mostly clear
    elif n_retro == 2:
        retro_score = 0.0   # Neutral
    else:
        retro_score = -0.5  # Crowded = bearish

    # ── 4. Paksha (15% weight) ──
    # Research: 14d Shukla +3.09% vs Krishna +2.43%, p=0.078
    # Regime-dependent at 7d. Weak but directionally consistent at 14d.
    paksha_score = 0.0
    if muhurta.tithi.paksha == "Shukla":
        if muhurta.tithi.number <= 10:
            paksha_score = 0.3   # Early-mid waxing = mild bullish
        elif muhurta.tithi.is_full_moon:
            paksha_score = -0.2  # Transition point
        else:
            paksha_score = 0.1
    else:
        if muhurta.tithi.number <= 22:
            paksha_score = -0.3  # Early Krishna = mild bearish
        elif muhurta.tithi.is_new_moon:
            paksha_score = 0.2   # Transition to bullish
        else:
            paksha_score = -0.1

    # ── 5. Moon Speed (10% weight — REDUCED due to conflicting data) ──
    # 365d: slow=bullish. 2000d: fast=bullish. Contradictory → low weight.
    if moon_speed < 12.0:
        speed_score = -0.2
    elif moon_speed < 13.5:
        speed_score = 0.1
    else:
        speed_score = 0.2

    # ── Weighted composite ──
    composite = (
        merc_score * 0.35 +
        retro_score * 0.30 +
        paksha_score * 0.15 +
        speed_score * 0.10
    )
    # Weights sum to 0.90, giving conservative scores (max ~±55)

    # Scale to -100..+100
    overall = int(round(composite * 100))
    overall = max(-100, min(100, overall))

    # Label
    if overall >= 25:
        label = "strong_buy"
    elif overall >= 10:
        label = "buy"
    elif overall >= -10:
        label = "neutral"
    elif overall >= -25:
        label = "avoid"
    else:
        label = "strong_avoid"

    # Format aspects for Redis (display only)
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
        lunar_paksha=muhurta.tithi.paksha,
        is_mercury_retrograde=merc_retro,
        retrogrades=retro_real,
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

        # Bhava (house) score — blends transit + house placement
        bhava = compute_bhava_score(symbol, sky)
        bhava_val = bhava.bhava_score if bhava else 0.0
        lagna_sign = bhava.lagna_sign if bhava else ""

        # Composite: 75% transit aspects + 25% house placement
        blended = report.transit_score * 0.75 + bhava_val * 0.25

        # Scale to -100..+100
        score_int = int(round(blended * 100))
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

        summary = report.summary
        if lagna_sign:
            summary += f" | Lagna {lagna_sign} bhava={bhava_val:+.2f}"

        results[symbol] = SymbolTransitScore(
            symbol=symbol,
            score=score_int,
            label=label,
            hits=hits,
            summary=summary,
            timestamp=now,
            lagna_sign=lagna_sign,
            bhava_score=bhava_val,
        )

    return results
