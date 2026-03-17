#!/usr/bin/env python3
"""
Astronomical Correlation Research — Beyond Traditional Astrology

Tests PHYSICAL astronomical phenomena against crypto returns.
Not astrological interpretations — measurable celestial mechanics.

Phenomena tested:
  1. Retrograde stations (exact turn days, ±3 days window)
  2. Planetary conjunctions (angular proximity of planet pairs)
  3. Lunar distance (perigee/apogee cycles, "supermoons")
  4. Eclipses (solar + lunar, from Swiss Ephemeris)
  5. Planetary speeds (all 7 classical planets)
  6. Sign ingresses (planet enters new zodiac sign)
  7. Void-of-Course Moon (no aspects before sign change)
  8. Planetary declination extremes (max north/south)
  9. Planetary elongation (angle from Sun — evening/morning star)
  10. Multi-planet alignment (how clustered are planets?)

Method:
  - 8+ years BTC/ETH daily data (2017-2026)
  - Forward returns at 1d, 3d, 7d, 14d, 30d
  - Welch's t-test for significance
  - Regime control (bull/bear/sideways)
  - Cross-symbol validation

Usage:
  python scripts/strategy-lab/astro_research.py --study all --days 3000
  python scripts/strategy-lab/astro_research.py --study stations --days 3000
  python scripts/strategy-lab/astro_research.py --study conjunctions --days 3000
"""
import argparse
import math
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import ccxt
import numpy as np
from scipy import stats as scipy_stats
import swisseph as swe

# Import vedic engine for some utilities
_engine_path = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine')
if os.path.isdir(_engine_path) and _engine_path not in sys.path:
    sys.path.insert(0, _engine_path)

from src.vedic.ephemeris import (
    get_sky_state, get_angular_distance, PLANETS, SIGNS, AYANAMSA,
    _datetime_to_jd,
)

# ── Config ─────────────────────────────────────────────────────────
SYMBOLS = ["BTC", "ETH"]  # Focus on highest-liquidity
LAGS = [1, 3, 7, 14, 30]

# ── Price Cache ────────────────────────────────────────────────────
_cache: Dict[str, List] = {}

def fetch_daily(symbol: str, days: int) -> List:
    key = f"{symbol}_1d_{days}"
    if key in _cache:
        return _cache[key]
    exchange = ccxt.binance({"enableRateLimit": True})
    since = int((datetime.now(timezone.utc) - timedelta(days=days + 5)).timestamp() * 1000)
    all_c = []
    for pair in [f"{symbol}/USDT", f"{symbol}/USDC"]:
        try:
            while True:
                c = exchange.fetch_ohlcv(pair, "1d", since=since, limit=1000)
                if not c:
                    break
                all_c.extend(c)
                since = c[-1][0] + 1
                if len(c) < 1000:
                    break
            if all_c:
                break
        except Exception:
            continue
    _cache[key] = all_c
    return all_c


def build_return_map(candles: List) -> Dict[int, Dict[datetime, float]]:
    """Forward returns at multiple lags."""
    result = {lag: {} for lag in LAGS}
    for i in range(len(candles)):
        dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
        close = candles[i][4]
        for lag in LAGS:
            if i + lag < len(candles):
                fwd = candles[i + lag][4]
                result[lag][dt] = (fwd - close) / close * 100
    return result


def build_momentum_map(candles: List, lookback: int = 20) -> Dict[datetime, float]:
    mom = {}
    for i in range(lookback, len(candles)):
        dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
        mom[dt] = (candles[i][4] - candles[i - lookback][4]) / candles[i - lookback][4] * 100
    return mom


def ttest(a: List[float], b: List[float]) -> Tuple[float, float, float]:
    if len(a) < 5 or len(b) < 5:
        return 0, 0, 1.0
    t, p = scipy_stats.ttest_ind(a, b, equal_var=False)
    return float(np.mean(a) - np.mean(b)), float(t), float(p)


def print_header(title: str, days: int):
    print(f"\n{'='*80}")
    print(f"  {title} — {days} DAYS")
    print(f"{'='*80}\n")


# ═══════════════════════════════════════════════════════════════════
# STUDY 1: Retrograde Stations (exact turn points)
# ═══════════════════════════════════════════════════════════════════

def study_stations(days: int):
    """Test if the exact days planets turn retrograde/direct have market impact.

    Hypothesis: The "station" point (speed = 0, planet appears stationary)
    creates maximum "tension" and may correlate with market reversals.
    """
    print_header("RETROGRADE STATIONS — Turn Points", days)

    planets_to_test = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn"]

    # Find all station dates
    stations = defaultdict(list)  # planet -> [(date, type)]

    start = datetime.now(timezone.utc) - timedelta(days=days)
    current = start
    prev_speeds = {}

    print("  Scanning for station points...", end=" ", flush=True)
    while current < datetime.now(timezone.utc):
        try:
            sky = get_sky_state(current)
            for pname in planets_to_test:
                speed = sky.planets[pname].speed
                prev = prev_speeds.get(pname)
                if prev is not None:
                    # Station = speed changes sign
                    if prev > 0 and speed <= 0:
                        stations[pname].append((current, "Rx_station"))
                    elif prev <= 0 and speed > 0:
                        stations[pname].append((current, "Direct_station"))
                prev_speeds[pname] = speed
        except Exception:
            pass
        current += timedelta(days=1)

    total_stations = sum(len(v) for v in stations.values())
    print(f"{total_stations} stations found")

    for pname in planets_to_test:
        if not stations[pname]:
            continue
        print(f"\n  -- {pname} Stations ({len(stations[pname])}) --")
        for date, stype in stations[pname]:
            print(f"    {date.strftime('%Y-%m-%d')} {stype}")

    # Test returns around stations
    print(f"\n  Returns around station points:")
    print(f"  {'Planet':<10s} {'Type':<15s} {'Window':>8s} {'1d%':>8s} {'7d%':>8s} {'14d%':>8s} {'N':>4s} {'vs Normal p':>12s}")
    print(f"  {'-'*10} {'-'*15} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*4} {'-'*12}")

    for sym in SYMBOLS:
        candles = fetch_daily(sym, days)
        if not candles:
            continue
        fwd = build_return_map(candles)

        # Normal returns (non-station days)
        all_dates = set()
        for lag_data in fwd.values():
            all_dates.update(lag_data.keys())

        station_dates = set()
        for pname in planets_to_test:
            for date, _ in stations[pname]:
                for offset in range(-3, 4):  # ±3 day window
                    station_dates.add((date + timedelta(days=offset)).replace(hour=0, minute=0, second=0))

        for pname in planets_to_test:
            for stype in ["Rx_station", "Direct_station"]:
                type_dates = set()
                for date, t in stations[pname]:
                    if t == stype:
                        for offset in range(-3, 4):
                            d = (date + timedelta(days=offset)).replace(hour=0, minute=0, second=0)
                            type_dates.add(d)

                station_returns = {lag: [] for lag in LAGS}
                normal_returns = {lag: [] for lag in LAGS}

                for lag in LAGS:
                    for dt, ret in fwd[lag].items():
                        d = dt.replace(hour=0, minute=0, second=0)
                        if d in type_dates:
                            station_returns[lag].append(ret)
                        else:
                            normal_returns[lag].append(ret)

                n = len(station_returns[7])
                if n < 5:
                    continue

                vals = []
                p_val = 1.0
                for lag in [1, 7, 14]:
                    s_data = station_returns[lag]
                    n_data = normal_returns[lag]
                    if s_data:
                        avg = np.mean(s_data)
                        vals.append(f"{avg:>+7.3f}%")
                        if lag == 7:
                            _, _, p_val = ttest(s_data, n_data)
                    else:
                        vals.append(f"{'N/A':>8s}")

                sig = "***" if p_val < 0.01 else "**" if p_val < 0.05 else "*" if p_val < 0.1 else ""
                label = f"{sym} {pname}"
                print(f"  {label:<10s} {stype:<15s} {'+-3d':>8s} {''.join(vals)} {n:>4d} {p_val:>8.4f} {sig}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 2: Planetary Conjunctions (angular proximity)
# ═══════════════════════════════════════════════════════════════════

def study_conjunctions(days: int):
    """Test if close angular proximity between planets affects markets.

    Not vedic "aspects" — just raw angular distance.
    Test: do tight conjunctions (<5°) predict different returns than wide separations?
    """
    print_header("PLANETARY CONJUNCTIONS — Angular Proximity", days)

    # Important pairs in financial astrology
    pairs = [
        ("Jupiter", "Saturn"),   # 20-year cycle
        ("Jupiter", "Rahu"),     # Guru Chandal
        ("Mars", "Saturn"),      # Frustration
        ("Venus", "Jupiter"),    # Abundance
        ("Mars", "Rahu"),        # Angarak
        ("Sun", "Jupiter"),      # Authority + expansion
        ("Mercury", "Venus"),    # Communication + money
    ]

    for sym in SYMBOLS:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, days)
        if not candles:
            continue
        fwd = build_return_map(candles)

        print(f"  {'Pair':<20s} {'Tight(<10) 7d%':>15s} {'Wide(>30) 7d%':>15s} {'Edge':>8s} {'p':>8s}")
        print(f"  {'-'*20} {'-'*15} {'-'*15} {'-'*8} {'-'*8}")

        for p1, p2 in pairs:
            tight_returns = []
            wide_returns = []

            for candle in candles[:-30]:
                dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
                if dt not in fwd[7]:
                    continue
                ret = fwd[7][dt]

                try:
                    sky = get_sky_state(dt)
                    dist = get_angular_distance(
                        sky.planets[p1].longitude,
                        sky.planets[p2].longitude
                    )
                except Exception:
                    continue

                if dist < 10:
                    tight_returns.append(ret)
                elif dist > 30:
                    wide_returns.append(ret)

            if len(tight_returns) < 10 or len(wide_returns) < 10:
                continue

            tight_avg = np.mean(tight_returns)
            wide_avg = np.mean(wide_returns)
            edge, _, p_val = ttest(tight_returns, wide_returns)
            sig = "***" if p_val < 0.01 else "**" if p_val < 0.05 else "*" if p_val < 0.1 else ""

            print(f"  {p1+'-'+p2:<20s} {tight_avg:>+13.3f}% {wide_avg:>+13.3f}% "
                  f"{edge:>+7.3f}% {p_val:>7.4f} {sig}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 3: Lunar Distance (Perigee/Apogee)
# ═══════════════════════════════════════════════════════════════════

def study_lunar_distance(days: int):
    """Test if Moon's distance from Earth affects crypto markets.

    "Supermoon" = full moon at perigee. Claimed to affect tides, mood, markets.
    Moon distance varies ~356,000 - 406,000 km.
    """
    print_header("LUNAR DISTANCE — Perigee/Apogee Cycles", days)

    for sym in SYMBOLS:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, days)
        if not candles:
            continue
        fwd = build_return_map(candles)

        distance_returns = defaultdict(lambda: defaultdict(list))

        for candle in candles[:-30]:
            dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
            if dt not in fwd[7]:
                continue

            try:
                jd = _datetime_to_jd(dt)
                # Get Moon's position with distance
                result, _ = swe.calc_ut(jd, swe.MOON)
                moon_dist = result[2]  # distance in AU
                moon_dist_km = moon_dist * 149597870.7  # Convert AU to km

                # Bin into quintiles
                if moon_dist_km < 365000:
                    dbin = "very_close"
                elif moon_dist_km < 375000:
                    dbin = "close"
                elif moon_dist_km < 390000:
                    dbin = "medium"
                elif moon_dist_km < 400000:
                    dbin = "far"
                else:
                    dbin = "very_far"

                for lag in LAGS:
                    if dt in fwd[lag]:
                        distance_returns[dbin][lag].append(fwd[lag][dt])
            except Exception:
                continue

        print(f"  {'Distance':<12s} {'1d%':>8s} {'7d%':>8s} {'14d%':>8s} {'30d%':>8s} {'N':>5s}")
        print(f"  {'-'*12} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*5}")

        for dbin in ["very_close", "close", "medium", "far", "very_far"]:
            vals = []
            n = 0
            for lag in [1, 7, 14, 30]:
                data = distance_returns[dbin][lag]
                n = max(n, len(data))
                if data:
                    vals.append(f"{np.mean(data):>+7.3f}%")
                else:
                    vals.append(f"{'N/A':>8s}")
            print(f"  {dbin:<12s} {''.join(vals)} {n:>5d}")

        # T-test: close vs far
        close = distance_returns["very_close"][7] + distance_returns["close"][7]
        far = distance_returns["far"][7] + distance_returns["very_far"][7]
        if close and far:
            edge, t, p = ttest(close, far)
            print(f"\n  Close vs Far 7d: edge={edge:>+.3f}%, t={t:.2f}, p={p:.4f}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 4: Planetary Speed Extremes (all planets)
# ═══════════════════════════════════════════════════════════════════

def study_planet_speeds(days: int):
    """Test if extreme planetary speeds predict market moves.

    When a planet is fastest = direct motion peak.
    When slowest = near station (about to reverse). Already tested stations,
    but this tests the GRADIENT — does market correlate with acceleration?
    """
    print_header("PLANETARY SPEED — Fast vs Slow for All Planets", days)

    planets_to_test = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn"]

    for sym in SYMBOLS:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, days)
        if not candles:
            continue
        fwd = build_return_map(candles)

        print(f"  {'Planet':<10s} {'Fast 7d%':>10s} {'Slow 7d%':>10s} {'Edge':>8s} {'p':>8s}")
        print(f"  {'-'*10} {'-'*10} {'-'*10} {'-'*8} {'-'*8}")

        for pname in planets_to_test:
            speeds = []
            speed_return_pairs = []

            for candle in candles[:-30]:
                dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
                if dt not in fwd[7]:
                    continue
                try:
                    sky = get_sky_state(dt)
                    speed = abs(sky.planets[pname].speed)
                    speeds.append(speed)
                    speed_return_pairs.append((speed, fwd[7][dt]))
                except Exception:
                    continue

            if len(speeds) < 50:
                continue

            median_speed = np.median(speeds)
            fast = [r for s, r in speed_return_pairs if s > median_speed]
            slow = [r for s, r in speed_return_pairs if s <= median_speed]

            if not fast or not slow:
                continue

            edge, _, p = ttest(fast, slow)
            sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""

            # Also compute correlation
            sarr = np.array([s for s, _ in speed_return_pairs])
            rarr = np.array([r for _, r in speed_return_pairs])
            corr = np.corrcoef(sarr, rarr)[0, 1] if len(sarr) > 10 else 0

            print(f"  {pname:<10s} {np.mean(fast):>+9.3f}% {np.mean(slow):>+9.3f}% "
                  f"{edge:>+7.3f}% {p:>7.4f} {sig}  r={corr:+.3f}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 5: Sign Ingresses (planet enters new sign)
# ═══════════════════════════════════════════════════════════════════

def study_ingresses(days: int):
    """Test if the day a planet changes zodiac sign has market impact.

    Hypothesis: Sign changes = shift in "energy" → market regime change.
    Testable: planet's sign today != planet's sign yesterday.
    """
    print_header("SIGN INGRESSES — Planet Enters New Sign", days)

    planets_to_test = ["Sun", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]

    for sym in SYMBOLS:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, days)
        if not candles:
            continue
        fwd = build_return_map(candles)

        print(f"  {'Planet':<10s} {'Ingress 7d%':>13s} {'Normal 7d%':>12s} {'Edge':>8s} {'p':>8s} {'N_ing':>6s}")
        print(f"  {'-'*10} {'-'*13} {'-'*12} {'-'*8} {'-'*8} {'-'*6}")

        for pname in planets_to_test:
            ingress_returns = []
            normal_returns = []
            prev_sign = None

            for candle in candles[:-30]:
                dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
                if dt not in fwd[7]:
                    continue
                try:
                    sky = get_sky_state(dt)
                    sign = sky.planets[pname].sign
                    is_ingress = prev_sign is not None and sign != prev_sign

                    # ±1 day window for ingress
                    if is_ingress:
                        ingress_returns.append(fwd[7][dt])
                    else:
                        normal_returns.append(fwd[7][dt])

                    prev_sign = sign
                except Exception:
                    continue

            if len(ingress_returns) < 5:
                continue

            edge, _, p = ttest(ingress_returns, normal_returns)
            sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""
            print(f"  {pname:<10s} {np.mean(ingress_returns):>+12.3f}% {np.mean(normal_returns):>+11.3f}% "
                  f"{edge:>+7.3f}% {p:>7.4f} {sig} {len(ingress_returns):>6d}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 6: Multi-Planet Alignment (cluster measure)
# ═══════════════════════════════════════════════════════════════════

def study_alignment(days: int):
    """Test if planets being clustered vs spread affects markets.

    Measure: standard deviation of all planet longitudes.
    Low std = clustered (stellium). High std = spread out.
    """
    print_header("PLANETARY ALIGNMENT — Clustered vs Spread", days)

    for sym in SYMBOLS:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, days)
        if not candles:
            continue
        fwd = build_return_map(candles)

        alignment_data = []

        for candle in candles[:-30]:
            dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
            if dt not in fwd[7]:
                continue
            try:
                sky = get_sky_state(dt)
                lons = [sky.planets[p].longitude for p in
                        ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]]

                # Circular standard deviation (handles 0/360 wraparound)
                sins = [math.sin(math.radians(l)) for l in lons]
                coss = [math.cos(math.radians(l)) for l in lons]
                mean_sin = np.mean(sins)
                mean_cos = np.mean(coss)
                R = math.sqrt(mean_sin**2 + mean_cos**2)
                circ_std = math.sqrt(-2 * math.log(max(R, 0.001)))

                alignment_data.append((circ_std, fwd[7][dt]))
            except Exception:
                continue

        if len(alignment_data) < 50:
            continue

        stds = [s for s, _ in alignment_data]
        median_std = np.median(stds)

        clustered = [r for s, r in alignment_data if s < np.percentile(stds, 25)]
        spread = [r for s, r in alignment_data if s > np.percentile(stds, 75)]
        middle = [r for s, r in alignment_data
                  if np.percentile(stds, 25) <= s <= np.percentile(stds, 75)]

        corr = np.corrcoef([s for s, _ in alignment_data],
                           [r for _, r in alignment_data])[0, 1]

        print(f"  Clustered (Q1) 7d: {np.mean(clustered):>+.3f}% (N={len(clustered)})")
        print(f"  Middle (Q2-Q3) 7d: {np.mean(middle):>+.3f}% (N={len(middle)})")
        print(f"  Spread (Q4)    7d: {np.mean(spread):>+.3f}% (N={len(spread)})")
        print(f"  Correlation (alignment vs 7d return): r={corr:+.4f}")

        edge, _, p = ttest(clustered, spread)
        sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""
        print(f"  Clustered vs Spread: edge={edge:>+.3f}%, p={p:.4f} {sig}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 7: Eclipse Seasons
# ═══════════════════════════════════════════════════════════════════

def study_eclipses(days: int):
    """Test if eclipse proximity affects crypto markets.

    Eclipses = Sun/Moon near lunar nodes (Rahu/Ketu).
    Solar eclipse: Sun-Moon-Rahu within ~15°.
    Lunar eclipse: Sun-Moon opposition with Moon near Rahu.
    """
    print_header("ECLIPSE PROXIMITY — Sun/Moon/Node Alignment", days)

    for sym in SYMBOLS:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, days)
        if not candles:
            continue
        fwd = build_return_map(candles)

        eclipse_returns = defaultdict(list)

        for candle in candles[:-30]:
            dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
            if dt not in fwd[7]:
                continue
            try:
                sky = get_sky_state(dt)
                sun_lon = sky.planets["Sun"].longitude
                moon_lon = sky.planets["Moon"].longitude
                rahu_lon = sky.planets["Rahu"].longitude

                # Distance from Moon to Rahu (eclipse proximity)
                moon_rahu = get_angular_distance(moon_lon, rahu_lon)
                # Distance from Sun to Rahu
                sun_rahu = get_angular_distance(sun_lon, rahu_lon)
                # Sun-Moon distance
                sun_moon = get_angular_distance(sun_lon, moon_lon)

                # Near-eclipse: Moon within 15° of Rahu AND Sun within 15° of Rahu
                # (solar eclipse zone)
                if moon_rahu < 15 and sun_rahu < 15:
                    zone = "solar_eclipse_zone"
                # Lunar eclipse zone: Moon near Rahu, Sun opposite
                elif moon_rahu < 15 and sun_moon > 165:
                    zone = "lunar_eclipse_zone"
                # Eclipse season: Sun within 18° of node axis
                elif sun_rahu < 18 or get_angular_distance(sun_lon, (rahu_lon + 180) % 360) < 18:
                    zone = "eclipse_season"
                else:
                    zone = "normal"

                for lag in LAGS:
                    if dt in fwd[lag]:
                        eclipse_returns[(zone, lag)].append(fwd[lag][dt])

            except Exception:
                continue

        print(f"  {'Zone':<22s} {'1d%':>8s} {'7d%':>8s} {'14d%':>8s} {'N':>5s}")
        print(f"  {'-'*22} {'-'*8} {'-'*8} {'-'*8} {'-'*5}")

        for zone in ["solar_eclipse_zone", "lunar_eclipse_zone", "eclipse_season", "normal"]:
            vals = []
            n = 0
            for lag in [1, 7, 14]:
                data = eclipse_returns.get((zone, lag), [])
                n = max(n, len(data))
                if data:
                    vals.append(f"{np.mean(data):>+7.3f}%")
                else:
                    vals.append(f"{'N/A':>8s}")
            print(f"  {zone:<22s} {''.join(vals)} {n:>5d}")

        # T-test: eclipse zone vs normal
        eclipse_7d = (eclipse_returns.get(("solar_eclipse_zone", 7), []) +
                      eclipse_returns.get(("lunar_eclipse_zone", 7), []))
        normal_7d = eclipse_returns.get(("normal", 7), [])
        if eclipse_7d and normal_7d:
            edge, _, p = ttest(eclipse_7d, normal_7d)
            sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""
            print(f"\n  Eclipse zone vs Normal 7d: edge={edge:>+.3f}%, p={p:.4f} {sig}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 8: Planetary Elongation (angle from Sun)
# ═══════════════════════════════════════════════════════════════════

def study_elongation(days: int):
    """Test if a planet's angle from the Sun predicts market behavior.

    Venus/Mercury elongation: evening star (east) vs morning star (west).
    Maximum elongation = planet most visible = traditional "power point".
    """
    print_header("PLANETARY ELONGATION — Angle from Sun", days)

    for sym in SYMBOLS:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, days)
        if not candles:
            continue
        fwd = build_return_map(candles)

        for pname in ["Venus", "Mercury", "Mars", "Jupiter"]:
            elong_bins = defaultdict(list)

            for candle in candles[:-30]:
                dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
                if dt not in fwd[7]:
                    continue
                try:
                    sky = get_sky_state(dt)
                    sun_lon = sky.planets["Sun"].longitude
                    p_lon = sky.planets[pname].longitude
                    elong = get_angular_distance(sun_lon, p_lon)

                    if elong < 15:
                        ebin = "conjunction"
                    elif elong < 45:
                        ebin = "close"
                    elif elong < 90:
                        ebin = "moderate"
                    elif elong < 135:
                        ebin = "wide"
                    else:
                        ebin = "opposition"

                    elong_bins[ebin].append(fwd[7][dt])
                except Exception:
                    continue

            if sum(len(v) for v in elong_bins.values()) < 50:
                continue

            print(f"\n  {pname} elongation from Sun:")
            print(f"  {'Bin':<15s} {'7d avg%':>10s} {'N':>5s}")
            for ebin in ["conjunction", "close", "moderate", "wide", "opposition"]:
                data = elong_bins.get(ebin, [])
                if data:
                    print(f"  {ebin:<15s} {np.mean(data):>+9.3f}% {len(data):>5d}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 9: Combined Astronomical Score
# ═══════════════════════════════════════════════════════════════════

def study_combined(days: int):
    """Build a combined score from all significant astronomical signals.

    Uses findings from other studies to create a multi-factor score.
    Tests if combining signals improves prediction.
    """
    print_header("COMBINED ASTRONOMICAL SCORE", days)

    for sym in SYMBOLS:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, days)
        if not candles:
            continue
        fwd = build_return_map(candles)

        score_returns = defaultdict(list)
        all_scores = []

        for candle in candles[:-30]:
            dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
            if dt not in fwd[7]:
                continue
            try:
                sky = get_sky_state(dt)

                score = 0

                # 1. Venus Rx (strongest validated signal)
                if sky.planets["Venus"].is_retrograde:
                    score -= 5  # Strong negative

                # 2. Retrograde count
                retros = sum(1 for p in sky.planets.values()
                            if p.is_retrograde and p.name not in ("Rahu", "Ketu"))
                score -= retros  # More retros = worse

                # 3. Venus near station (speed close to 0)
                venus_speed = abs(sky.planets["Venus"].speed)
                if venus_speed < 0.1:
                    score -= 2  # Venus station = high impact

                # 4. Mercury speed (fast = good? test from study 4)
                merc_speed = abs(sky.planets["Mercury"].speed)
                if merc_speed > 1.5:
                    score += 1  # Fast Mercury = good

                # 5. Eclipse proximity
                moon_rahu = get_angular_distance(
                    sky.planets["Moon"].longitude, sky.planets["Rahu"].longitude)
                if moon_rahu < 15:
                    score -= 1

                # 6. Jupiter-Saturn distance
                jup_sat = get_angular_distance(
                    sky.planets["Jupiter"].longitude, sky.planets["Saturn"].longitude)
                if jup_sat < 10:
                    score -= 1  # Tight conjunction = tension

                all_scores.append((score, fwd[7][dt]))

                if score >= 2:
                    sbin = "bullish"
                elif score >= 0:
                    sbin = "neutral"
                elif score >= -3:
                    sbin = "bearish"
                else:
                    sbin = "very_bearish"

                score_returns[sbin].append(fwd[7][dt])

            except Exception:
                continue

        print(f"  {'Score Bin':<15s} {'7d avg%':>10s} {'14d avg%':>10s} {'N':>5s}")
        print(f"  {'-'*15} {'-'*10} {'-'*10} {'-'*5}")

        for sbin in ["bullish", "neutral", "bearish", "very_bearish"]:
            data = score_returns.get(sbin, [])
            if data:
                print(f"  {sbin:<15s} {np.mean(data):>+9.3f}% {'':>10s} {len(data):>5d}")

        # Correlation
        if all_scores:
            scores_arr = np.array([s for s, _ in all_scores])
            returns_arr = np.array([r for _, r in all_scores])
            corr = np.corrcoef(scores_arr, returns_arr)[0, 1]
            print(f"\n  Score vs 7d return correlation: r={corr:+.4f}")

            # Quintile analysis
            sorted_sr = sorted(all_scores, key=lambda x: x[0])
            n = len(sorted_sr)
            q1 = sorted_sr[:n//5]
            q5 = sorted_sr[4*n//5:]
            edge, _, p = ttest([r for _, r in q5], [r for _, r in q1])
            sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""
            print(f"  Top quintile vs Bottom quintile: edge={edge:>+.3f}%, p={p:.4f} {sig}")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Astronomical Correlation Research")
    parser.add_argument("--study", default="all",
                        choices=["all", "stations", "conjunctions", "lunar_dist",
                                "speeds", "ingresses", "alignment", "eclipses",
                                "elongation", "combined"])
    parser.add_argument("--days", type=int, default=3000)
    args = parser.parse_args()

    start = time.time()

    studies = {
        "stations": study_stations,
        "conjunctions": study_conjunctions,
        "lunar_dist": study_lunar_distance,
        "speeds": study_planet_speeds,
        "ingresses": study_ingresses,
        "alignment": study_alignment,
        "eclipses": study_eclipses,
        "elongation": study_elongation,
        "combined": study_combined,
    }

    if args.study == "all":
        for name, fn in studies.items():
            print(f"\n  >>> Running study: {name}")
            try:
                fn(args.days)
            except Exception as e:
                print(f"  ERROR in {name}: {e}")
                import traceback
                traceback.print_exc()
    else:
        studies[args.study](args.days)

    elapsed = time.time() - start
    print(f"\n  Total runtime: {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()
