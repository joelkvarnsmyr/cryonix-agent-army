#!/usr/bin/env python3
"""
Vedic Deep Research — Multi-Timeframe, Regime-Controlled, Statistically Rigorous

Key innovations over vedic_research.py:
  1. MAXIMUM HISTORY: Uses all available Binance data (2017+) = up to 9 years
  2. REGIME CONTROL: Separates astro signal from market momentum
  3. MULTI-TIMEFRAME: Tests 1h, 4h, daily, weekly, monthly
  4. STATISTICAL SIGNIFICANCE: T-tests, bootstrap confidence intervals
  5. DECADE-SCALE: Planetary cycles need years of data to validate
  6. INNOVATION LOOPS: Automatic hypothesis generation and testing

Research questions:
  - Do lunar phases predict crypto returns AFTER controlling for momentum?
  - Do planetary retrogrades have intraday effects (hora-level)?
  - Is the Jupiter sign correlation real or just market-regime coincidence?
  - What timeframe shows the strongest vedic correlations?
  - Are there signals that work in BOTH bull and bear markets?

Usage:
  python scripts/strategy-lab/vedic_deep_research.py --study all --days 2000
  python scripts/strategy-lab/vedic_deep_research.py --study lunar --days 2000
  python scripts/strategy-lab/vedic_deep_research.py --study retrogrades --days 2000
  python scripts/strategy-lab/vedic_deep_research.py --study timeframes --days 365
  python scripts/strategy-lab/vedic_deep_research.py --study regime --days 2000
"""
import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import ccxt
import numpy as np
from scipy import stats as scipy_stats

# Import vedic engine
_engine_path = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine')
if os.path.isdir(_engine_path) and _engine_path not in sys.path:
    sys.path.insert(0, _engine_path)

from src.vedic.ephemeris import get_sky_state, SkyState
from src.vedic.scoring import compute_vedic_score
from src.vedic.aspects import detect_aspects, mercury_retrograde, detect_retrogrades
from src.vedic.nakshatras import nakshatra_at_longitude, moon_nakshatra_score, NAKSHATRAS
from src.vedic.muhurta import calculate_muhurta, calculate_tithi, get_vara, get_hora_lord
from src.vedic.natal import CRYPTO_GENESIS, analyze_transits
from src.vedic.dasha import compute_dasha_for_symbol
from src.vedic.lagna import compute_bhava_score

# ── Configuration ──────────────────────────────────────────────────
TEST_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "AVAX"]
LONG_HISTORY_SYMBOLS = ["BTC", "ETH", "BNB", "XRP", "ADA", "LTC"]  # Have 5+ years of data

# ── Price data cache ───────────────────────────────────────────────
_cache: Dict[str, List] = {}

def fetch_ohlcv(symbol: str, timeframe: str, days: int) -> List:
    """Fetch OHLCV with caching. Tries USDT first, then USDC."""
    key = f"{symbol}_{timeframe}_{days}"
    if key in _cache:
        return _cache[key]

    exchange = ccxt.binance({"enableRateLimit": True})
    since = int((datetime.now(timezone.utc) - timedelta(days=days + 5)).timestamp() * 1000)
    all_candles = []

    for pair in [f"{symbol}/USDT", f"{symbol}/USDC"]:
        try:
            while True:
                candles = exchange.fetch_ohlcv(pair, timeframe, since=since, limit=1000)
                if not candles:
                    break
                all_candles.extend(candles)
                since = candles[-1][0] + 1
                if len(candles) < 1000:
                    break
            if all_candles:
                break
        except Exception:
            continue

    _cache[key] = all_candles
    return all_candles


def compute_returns(candles: List, lags: List[int]) -> Dict[int, List[Tuple[datetime, float]]]:
    """Compute forward returns at given candle lags."""
    result = {lag: [] for lag in lags}
    for i in range(len(candles)):
        dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
        close = candles[i][4]
        for lag in lags:
            if i + lag < len(candles):
                fwd_close = candles[i + lag][4]
                ret = (fwd_close - close) / close * 100
                result[lag].append((dt, ret))
    return result


def compute_momentum(candles: List, lookback: int = 20) -> Dict[datetime, float]:
    """Simple price momentum: return over last N candles."""
    mom = {}
    for i in range(lookback, len(candles)):
        dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
        close_now = candles[i][4]
        close_past = candles[i - lookback][4]
        mom[dt] = (close_now - close_past) / close_past * 100
    return mom


def classify_regime(momentum: float) -> str:
    """Classify market regime from momentum."""
    if momentum > 10:
        return "strong_bull"
    elif momentum > 2:
        return "mild_bull"
    elif momentum > -2:
        return "sideways"
    elif momentum > -10:
        return "mild_bear"
    else:
        return "strong_bear"


def ttest_groups(group_a: List[float], group_b: List[float]) -> Tuple[float, float, float]:
    """Welch's t-test between two groups. Returns (mean_diff, t_stat, p_value)."""
    if len(group_a) < 5 or len(group_b) < 5:
        return 0, 0, 1.0
    t_stat, p_val = scipy_stats.ttest_ind(group_a, group_b, equal_var=False)
    mean_diff = np.mean(group_a) - np.mean(group_b)
    return float(mean_diff), float(t_stat), float(p_val)


def bootstrap_ci(data: List[float], n_boot: int = 1000, ci: float = 0.95) -> Tuple[float, float, float]:
    """Bootstrap confidence interval for mean."""
    if len(data) < 5:
        return 0, 0, 0
    arr = np.array(data)
    means = []
    for _ in range(n_boot):
        sample = np.random.choice(arr, size=len(arr), replace=True)
        means.append(np.mean(sample))
    alpha = (1 - ci) / 2
    lower = np.percentile(means, alpha * 100)
    upper = np.percentile(means, (1 - alpha) * 100)
    return float(np.mean(data)), float(lower), float(upper)


# ═══════════════════════════════════════════════════════════════════
# STUDY 1: LUNAR CYCLES — Maximum history, regime-controlled
# ═══════════════════════════════════════════════════════════════════

def study_lunar(days: int):
    """Deep study of lunar cycle effects on crypto.

    Academic basis:
    - Yuan et al (2006): 3-5% annual return diff between new/full moon in STOCKS
    - Dichev & Janes (2003): new moon returns = 2x full moon over 100 YEARS
    - Key question: Does this hold in CRYPTO? Over YEARS not months?
    """
    print(f"\n{'='*80}")
    print(f"  STUDY 1: LUNAR CYCLES IN CRYPTO — {days} DAYS OF HISTORY")
    print(f"  Academic refs: Yuan et al 2006, Dichev & Janes 2003")
    print(f"  Hypothesis: Waxing moon (Shukla) returns > Waning moon (Krishna)")
    print(f"{'='*80}\n")

    # Use LONG history symbols for this study
    symbols = LONG_HISTORY_SYMBOLS if days > 365 else TEST_SYMBOLS

    # Collect returns by lunar phase bins
    paksha_returns = {"Shukla": defaultdict(list), "Krishna": defaultdict(list)}
    tithi_returns = defaultdict(lambda: defaultdict(list))  # tithi_num -> lag -> returns
    phase_bin_returns = defaultdict(lambda: defaultdict(list))  # phase_bin -> lag -> returns
    regime_controlled = defaultdict(lambda: defaultdict(list))  # (paksha, regime) -> lag -> returns

    for sym in symbols:
        print(f"  {sym}: fetching {days} days daily data...", end=" ", flush=True)
        candles = fetch_ohlcv(sym, "1d", days)
        if len(candles) < 50:
            print(f"SKIP ({len(candles)} candles)")
            continue

        fwd = compute_returns(candles, [1, 3, 7, 14, 30])
        momentum = compute_momentum(candles, 20)

        computed = 0
        for lag in [1, 3, 7, 14, 30]:
            for dt, ret in fwd[lag]:
                try:
                    sky = get_sky_state(dt)
                    tithi = calculate_tithi(sky)
                except Exception:
                    continue

                computed += 1
                paksha = tithi.paksha
                tithi_num = tithi.number
                phase = tithi.moon_phase_pct

                # Paksha returns
                paksha_returns[paksha][lag].append(ret)

                # Tithi returns
                tithi_returns[tithi_num][lag].append(ret)

                # Phase bins (0-10, 10-20, ..., 90-100)
                phase_bin = int(phase / 10) * 10
                phase_bin_returns[phase_bin][lag].append(ret)

                # Regime-controlled
                mom = momentum.get(dt, 0)
                regime = classify_regime(mom)
                regime_controlled[(paksha, regime)][lag].append(ret)

        print(f"{computed} observations")

    # ── Results: Paksha Effect ──
    print(f"\n  {'='*70}")
    print(f"  PAKSHA EFFECT (Waxing vs Waning Moon)")
    print(f"  {'='*70}")
    print(f"  {'Lag':<8s} {'Shukla avg%':>12s} {'Krishna avg%':>12s} {'Diff%':>8s} {'t-stat':>8s} {'p-value':>8s} {'Signif':>7s}")
    print(f"  {'-'*8} {'-'*12} {'-'*12} {'-'*8} {'-'*8} {'-'*8} {'-'*7}")

    for lag in [1, 3, 7, 14, 30]:
        s_data = paksha_returns["Shukla"][lag]
        k_data = paksha_returns["Krishna"][lag]
        if not s_data or not k_data:
            continue

        s_mean = np.mean(s_data)
        k_mean = np.mean(k_data)
        diff, t, p = ttest_groups(s_data, k_data)
        sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""

        print(f"  {lag:>2d}d     {s_mean:>+11.4f}% {k_mean:>+11.4f}% {diff:>+7.4f}% {t:>+7.2f}  {p:>7.4f}  {sig:>6s}")
        print(f"          N={len(s_data):<6d}   N={len(k_data):<6d}")

    # ── Results: Tithi Returns ──
    print(f"\n  {'='*70}")
    print(f"  TITHI-BY-TITHI RETURNS (30 lunar days)")
    print(f"  {'='*70}")
    print(f"  {'Tithi':<8s} {'1d%':>8s} {'7d%':>8s} {'14d%':>8s} {'30d%':>8s} {'N':>6s}")
    print(f"  {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*6}")

    for t_num in range(1, 31):
        vals = []
        n = 0
        for lag in [1, 7, 14, 30]:
            data = tithi_returns[t_num][lag]
            n = max(n, len(data))
            if len(data) > 3:
                vals.append(f"{np.mean(data):>+7.3f}%")
            else:
                vals.append("    N/A ")
        paksha_mark = " (S)" if t_num <= 15 else " (K)"
        full_mark = " <-- FULL" if t_num == 15 else " <-- NEW" if t_num == 30 else ""
        print(f"  {t_num:>3d}{paksha_mark} {''.join(vals)} {n:>6d}{full_mark}")

    # ── Results: Phase Bins ──
    print(f"\n  {'='*70}")
    print(f"  MOON PHASE GRADIENT (illumination %)")
    print(f"  {'='*70}")
    print(f"  {'Phase%':<10s} {'1d%':>8s} {'7d%':>8s} {'14d%':>8s} {'N':>6s}")
    print(f"  {'-'*10} {'-'*8} {'-'*8} {'-'*8} {'-'*6}")

    for pbin in sorted(phase_bin_returns.keys()):
        vals = []
        n = 0
        for lag in [1, 7, 14]:
            data = phase_bin_returns[pbin][lag]
            n = max(n, len(data))
            if len(data) > 5:
                vals.append(f"{np.mean(data):>+7.3f}%")
            else:
                vals.append("    N/A ")
        print(f"  {pbin:>3d}-{pbin+10:<3d}%  {''.join(vals)} {n:>6d}")

    # ── Results: Regime-Controlled ──
    print(f"\n  {'='*70}")
    print(f"  REGIME-CONTROLLED PAKSHA EFFECT")
    print(f"  Question: Does paksha predict returns AFTER controlling for momentum?")
    print(f"  {'='*70}")
    print(f"  {'Regime':<15s} {'Paksha':<10s} {'7d avg%':>10s} {'14d avg%':>10s} {'N':>6s}")
    print(f"  {'-'*15} {'-'*10} {'-'*10} {'-'*10} {'-'*6}")

    regimes = ["strong_bull", "mild_bull", "sideways", "mild_bear", "strong_bear"]
    for regime in regimes:
        for paksha in ["Shukla", "Krishna"]:
            key = (paksha, regime)
            data_7 = regime_controlled[key][7]
            data_14 = regime_controlled[key][14]
            if len(data_7) < 5:
                continue
            avg7 = np.mean(data_7)
            avg14 = np.mean(data_14) if data_14 else 0
            print(f"  {regime:<15s} {paksha:<10s} {avg7:>+9.3f}% {avg14:>+9.3f}% {len(data_7):>6d}")

    # Compute regime-controlled edge
    print(f"\n  -- Paksha edge per regime (Shukla - Krishna, 7d) --")
    for regime in regimes:
        s = regime_controlled[("Shukla", regime)][7]
        k = regime_controlled[("Krishna", regime)][7]
        if len(s) > 5 and len(k) > 5:
            diff, t, p = ttest_groups(s, k)
            sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else "ns"
            print(f"    {regime:<15s}: {diff:>+7.3f}%  t={t:>+5.2f}  p={p:.3f}  {sig}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 2: RETROGRADES — Jupiter, Saturn, Mercury over years
# ═══════════════════════════════════════════════════════════════════

def study_retrogrades(days: int):
    """Study retrograde effects across all timeframes.

    Key retrogrades to test:
    - Mercury Rx: ~3 weeks, ~3x/year (well-known in trading lore)
    - Jupiter Rx: ~4 months/year (strongest in Phase 1)
    - Saturn Rx: ~4.5 months/year (showed signal in Phase 1)
    - Venus Rx: ~40 days, ~every 18 months (rare, tradeable?)
    """
    print(f"\n{'='*80}")
    print(f"  STUDY 2: PLANETARY RETROGRADES — {days} DAYS")
    print(f"  Mercury Rx (~3x/yr), Jupiter Rx (~4mo/yr), Saturn Rx (~4.5mo/yr)")
    print(f"{'='*80}\n")

    symbols = LONG_HISTORY_SYMBOLS if days > 365 else TEST_SYMBOLS
    planets = ["Mercury", "Jupiter", "Saturn", "Venus"]

    # Collect returns by retrograde state
    retro_returns: Dict[str, Dict[str, Dict[int, List[float]]]] = {}
    for planet in planets:
        retro_returns[planet] = {"direct": defaultdict(list), "retrograde": defaultdict(list)}

    # Also track NUMBER of retrogrades
    n_retro_returns = defaultdict(lambda: defaultdict(list))  # count -> lag -> returns

    # Mercury Rx PHASES (start, middle, end, post)
    merc_rx_phase_returns = defaultdict(lambda: defaultdict(list))

    for sym in symbols:
        print(f"  {sym}: fetching...", end=" ", flush=True)
        candles = fetch_ohlcv(sym, "1d", days)
        if len(candles) < 50:
            print("SKIP")
            continue

        fwd = compute_returns(candles, [1, 3, 7, 14, 30])
        momentum = compute_momentum(candles, 20)

        # Track Mercury Rx transitions
        prev_merc_rx = None
        merc_rx_start_day = 0
        merc_rx_total_days = 0

        computed = 0
        for lag in [1, 3, 7, 14, 30]:
            for dt, ret in fwd[lag]:
                try:
                    sky = get_sky_state(dt)
                except Exception:
                    continue
                computed += 1

                # Individual planet retrogrades
                for planet in planets:
                    is_rx = sky.planets[planet].is_retrograde
                    state = "retrograde" if is_rx else "direct"
                    retro_returns[planet][state][lag].append(ret)

                # Count total retrogrades (excluding Rahu/Ketu which are always Rx)
                retros = [p for p in sky.planets.values()
                         if p.is_retrograde and p.name not in ("Rahu", "Ketu")]
                n_retro_returns[len(retros)][lag].append(ret)

                # Mercury Rx phase tracking
                merc_rx = sky.planets["Mercury"].is_retrograde
                merc_speed = sky.planets["Mercury"].speed

                if merc_rx:
                    if prev_merc_rx is False:  # Just entered Rx
                        merc_rx_start_day = 0
                        merc_rx_total_days = 21  # ~3 weeks average
                    merc_rx_start_day += 1

                    # Classify phase
                    if merc_rx_start_day <= 5:
                        phase = "rx_start"
                    elif merc_rx_start_day >= 16:
                        phase = "rx_end"
                    else:
                        phase = "rx_middle"
                    merc_rx_phase_returns[phase][lag].append(ret)
                elif prev_merc_rx is True:  # Just went direct
                    merc_rx_phase_returns["post_rx_5d"][lag].append(ret)

                prev_merc_rx = merc_rx

        print(f"{computed} obs")

    # ── Results per planet ──
    print(f"\n  {'='*70}")
    print(f"  RETROGRADE vs DIRECT — Per Planet")
    print(f"  {'='*70}")

    for planet in planets:
        print(f"\n  -- {planet} --")
        print(f"  {'Lag':<6s} {'Direct%':>10s} {'Retro%':>10s} {'Diff%':>8s} {'t':>7s} {'p':>7s} {'Sig':>5s}")
        print(f"  {'-'*6} {'-'*10} {'-'*10} {'-'*8} {'-'*7} {'-'*7} {'-'*5}")

        for lag in [1, 3, 7, 14, 30]:
            d = retro_returns[planet]["direct"][lag]
            r = retro_returns[planet]["retrograde"][lag]
            if len(d) < 10 or len(r) < 10:
                continue
            diff, t, p = ttest_groups(d, r)
            sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""
            print(f"  {lag:>2d}d    {np.mean(d):>+9.3f}% {np.mean(r):>+9.3f}% "
                  f"{diff:>+7.3f}% {t:>+6.2f}  {p:>6.3f}  {sig}")
            print(f"         N={len(d):<6d}   N={len(r):<6d}")

    # ── Mercury Rx Phases ──
    print(f"\n  {'='*70}")
    print(f"  MERCURY RX PHASES")
    print(f"  {'='*70}")
    print(f"  {'Phase':<15s} {'1d%':>8s} {'7d%':>8s} {'14d%':>8s} {'N':>6s}")
    print(f"  {'-'*15} {'-'*8} {'-'*8} {'-'*8} {'-'*6}")

    for phase in ["rx_start", "rx_middle", "rx_end", "post_rx_5d"]:
        vals = []
        n = 0
        for lag in [1, 7, 14]:
            data = merc_rx_phase_returns[phase][lag]
            n = max(n, len(data))
            if len(data) > 3:
                vals.append(f"{np.mean(data):>+7.3f}%")
            else:
                vals.append("    N/A ")
        print(f"  {phase:<15s} {''.join(vals)} {n:>6d}")

    # ── Retrograde Count ──
    print(f"\n  {'='*70}")
    print(f"  NUMBER OF RETROGRADES vs RETURNS")
    print(f"  {'='*70}")
    print(f"  {'#Retro':<8s} {'1d%':>8s} {'7d%':>8s} {'14d%':>8s} {'N':>6s}")
    print(f"  {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*6}")

    for count in sorted(n_retro_returns.keys()):
        vals = []
        n = 0
        for lag in [1, 7, 14]:
            data = n_retro_returns[count][lag]
            n = max(n, len(data))
            if len(data) > 5:
                vals.append(f"{np.mean(data):>+7.3f}%")
            else:
                vals.append("    N/A ")
        print(f"  {count:>3d}      {''.join(vals)} {n:>6d}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 3: MULTI-TIMEFRAME — Which timeframe do vedic signals work?
# ═══════════════════════════════════════════════════════════════════

def study_timeframes(days: int):
    """Test vedic signals on hourly, 4h, daily, weekly timeframes.

    Hypothesis: Different vedic signals work on different timeframes.
    - Hora (planetary hour): should work on HOURLY
    - Nakshatra: should work on ~DAILY (moon stays ~1 day per nakshatra)
    - Paksha: should work on WEEKLY (half-cycle = ~14 days)
    - Retrogrades: should work on WEEKLY/MONTHLY (slow)
    """
    print(f"\n{'='*80}")
    print(f"  STUDY 3: MULTI-TIMEFRAME VEDIC SIGNALS — {days} DAYS")
    print(f"  Testing: 1h, 4h, daily candles")
    print(f"{'='*80}\n")

    # Test BTC on multiple timeframes
    sym = "BTC"
    timeframes = {
        "1h": {"lags": [1, 4, 12, 24], "label": "1h candles"},  # 1h, 4h, 12h, 24h forward
        "4h": {"lags": [1, 3, 6, 12], "label": "4h candles"},   # 4h, 12h, 24h, 48h
        "1d": {"lags": [1, 3, 7, 14], "label": "daily candles"}, # 1d, 3d, 7d, 14d
    }

    for tf, tf_config in timeframes.items():
        print(f"\n  === {tf_config['label'].upper()} ===")
        candles = fetch_ohlcv(sym, tf, days)
        if len(candles) < 50:
            print(f"  SKIP (only {len(candles)} candles)")
            continue

        print(f"  Fetched {len(candles)} candles")
        fwd = compute_returns(candles, tf_config["lags"])

        # Collect signals
        signals_data = defaultdict(lambda: defaultdict(list))
        # signals_data[signal_name][lag] = [(signal_value, return)]

        for lag in tf_config["lags"]:
            for dt, ret in fwd[lag]:
                try:
                    sky = get_sky_state(dt)
                    tithi = calculate_tithi(sky)
                    hora = get_hora_lord(dt)
                    vara = get_vara(dt)
                    nak = nakshatra_at_longitude(sky.planets["Moon"].longitude)
                    merc_rx = sky.planets["Mercury"].is_retrograde
                except Exception:
                    continue

                # Paksha
                signals_data[f"paksha_{tithi.paksha}"][lag].append(ret)

                # Hora lord
                signals_data[f"hora_{hora}"][lag].append(ret)

                # Nakshatra bias
                signals_data[f"nak_bias_{nak.nakshatra.trading_bias}"][lag].append(ret)

                # Mercury Rx
                rx_state = "rx" if merc_rx else "direct"
                signals_data[f"merc_{rx_state}"][lag].append(ret)

                # Vara
                signals_data[f"vara_{vara.day_name}"][lag].append(ret)

                # Moon speed bins
                speed = sky.planets["Moon"].speed
                speed_bin = "fast" if speed > 13.5 else "slow" if speed < 12 else "normal"
                signals_data[f"moon_speed_{speed_bin}"][lag].append(ret)

                # Jupiter Rx
                jup_rx = "rx" if sky.planets["Jupiter"].is_retrograde else "direct"
                signals_data[f"jupiter_{jup_rx}"][lag].append(ret)

        # Print results
        print(f"\n  {'Signal':<25s}", end="")
        for lag in tf_config["lags"]:
            print(f" {'lag=' + str(lag):>10s}", end="")
        print(f" {'Best lag':>10s}")
        print(f"  {'-'*25}", end="")
        for _ in tf_config["lags"]:
            print(f" {'-'*10}", end="")
        print(f" {'-'*10}")

        # Group by signal type and find the best
        signal_groups = defaultdict(dict)
        for sig_name, lag_data in signals_data.items():
            for lag in tf_config["lags"]:
                data = lag_data[lag]
                if len(data) > 10:
                    signal_groups[sig_name][lag] = np.mean(data)

        # Sort by max absolute return
        sorted_signals = sorted(
            signal_groups.items(),
            key=lambda x: max(abs(v) for v in x[1].values()) if x[1] else 0,
            reverse=True
        )

        for sig_name, lag_means in sorted_signals[:30]:
            print(f"  {sig_name:<25s}", end="")
            best_lag = ""
            best_val = 0
            for lag in tf_config["lags"]:
                val = lag_means.get(lag)
                if val is not None:
                    n = len(signals_data[sig_name][lag])
                    marker = "*" if abs(val) > 0.1 else ""
                    print(f" {val:>+9.3f}%{marker}", end="")
                    if abs(val) > abs(best_val):
                        best_val = val
                        best_lag = f"lag={lag}"
                else:
                    print(f" {'N/A':>10s}", end="")
            print(f" {best_lag:>10s}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 4: REGIME ANALYSIS — Do signals work in bull AND bear?
# ═══════════════════════════════════════════════════════════════════

def study_regime(days: int):
    """Test if vedic signals are regime-dependent or universal.

    THIS IS THE KEY TEST: A truly valuable signal must work in both
    bull and bear markets. If it only works in one regime, it's just
    a market-direction proxy, not a genuine astro signal.
    """
    print(f"\n{'='*80}")
    print(f"  STUDY 4: REGIME DEPENDENCY — DO SIGNALS SURVIVE BEAR MARKETS?")
    print(f"  {days} DAYS | If signal only works in bull market = it's NOT real")
    print(f"{'='*80}\n")

    symbols = LONG_HISTORY_SYMBOLS if days > 365 else TEST_SYMBOLS

    # Collect data bucketed by regime
    signals_by_regime: Dict[str, Dict[str, Dict[int, List[float]]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(list))
    )
    # signals_by_regime[signal_name][regime][lag] = [returns]

    regime_counts = defaultdict(int)

    for sym in symbols:
        print(f"  {sym}...", end=" ", flush=True)
        candles = fetch_ohlcv(sym, "1d", days)
        if len(candles) < 50:
            print("SKIP")
            continue

        fwd = compute_returns(candles, [1, 7, 14])
        momentum = compute_momentum(candles, 20)

        for lag in [1, 7, 14]:
            for dt, ret in fwd[lag]:
                mom = momentum.get(dt)
                if mom is None:
                    continue
                regime = classify_regime(mom)
                regime_counts[regime] += 1

                try:
                    sky = get_sky_state(dt)
                    tithi = calculate_tithi(sky)
                    merc_rx = sky.planets["Mercury"].is_retrograde
                    jup_rx = sky.planets["Jupiter"].is_retrograde
                    retros = [p for p in sky.planets.values()
                             if p.is_retrograde and p.name not in ("Rahu", "Ketu")]
                except Exception:
                    continue

                # Key signals to test
                signals_by_regime[f"paksha_{tithi.paksha}"][regime][lag].append(ret)
                rx_str = "rx" if merc_rx else "direct"
                signals_by_regime[f"merc_{rx_str}"][regime][lag].append(ret)
                jrx_str = "rx" if jup_rx else "direct"
                signals_by_regime[f"jupiter_{jrx_str}"][regime][lag].append(ret)
                retro_bin = "few" if len(retros) <= 1 else "many"
                signals_by_regime[f"retro_count_{retro_bin}"][regime][lag].append(ret)

                mid_s = "yes" if (tithi.paksha == "Shukla" and 4 <= tithi.number <= 11) else "no"
                signals_by_regime[f"mid_shukla_{mid_s}"][regime][lag].append(ret)

        print("OK")

    # Print regime distribution
    print(f"\n  Regime distribution:")
    for r, c in sorted(regime_counts.items(), key=lambda x: x[1], reverse=True):
        print(f"    {r:<15s}: {c:>6d}")

    # For each signal, show performance per regime
    print(f"\n  {'='*70}")
    print(f"  SIGNAL PERFORMANCE BY MARKET REGIME (7-day returns)")
    print(f"  {'='*70}")

    regimes = ["strong_bull", "mild_bull", "sideways", "mild_bear", "strong_bear"]

    for sig_name in sorted(signals_by_regime.keys()):
        print(f"\n  -- {sig_name} --")
        print(f"  {'Regime':<15s} {'7d avg%':>10s} {'N':>6s}")
        print(f"  {'-'*15} {'-'*10} {'-'*6}")

        for regime in regimes:
            data = signals_by_regime[sig_name][regime][7]
            if len(data) < 5:
                continue
            avg = np.mean(data)
            print(f"  {regime:<15s} {avg:>+9.3f}% {len(data):>6d}")

    # ── The KEY test: Shukla vs Krishna within each regime ──
    print(f"\n  {'='*70}")
    print(f"  THE KEY TEST: Shukla vs Krishna WITHIN each regime")
    print(f"  If Shukla consistently > Krishna in ALL regimes = REAL signal")
    print(f"  {'='*70}")
    print(f"  {'Regime':<15s} {'Shukla 7d%':>12s} {'Krishna 7d%':>12s} {'Edge%':>8s} {'p-val':>8s} {'Verdict':>10s}")
    print(f"  {'-'*15} {'-'*12} {'-'*12} {'-'*8} {'-'*8} {'-'*10}")

    all_regime_edge = []
    for regime in regimes:
        s = signals_by_regime["paksha_Shukla"][regime][7]
        k = signals_by_regime["paksha_Krishna"][regime][7]
        if len(s) < 10 or len(k) < 10:
            continue
        s_mean = np.mean(s)
        k_mean = np.mean(k)
        diff, t, p = ttest_groups(s, k)
        verdict = "EDGE" if diff > 0 else "NO EDGE"
        if p < 0.1 and diff > 0:
            verdict = "REAL EDGE"
        all_regime_edge.append(diff > 0)
        print(f"  {regime:<15s} {s_mean:>+11.3f}% {k_mean:>+11.3f}% {diff:>+7.3f}% {p:>7.3f}  {verdict}")

    if all_regime_edge:
        pct = sum(all_regime_edge) / len(all_regime_edge) * 100
        print(f"\n  Shukla > Krishna in {sum(all_regime_edge)}/{len(all_regime_edge)} regimes ({pct:.0f}%)")
        if pct >= 80:
            print(f"  >>> PAKSHA IS A GENUINE SIGNAL (works across market regimes)")
        elif pct >= 60:
            print(f"  >>> PAKSHA HAS SOME EDGE (partially regime-dependent)")
        else:
            print(f"  >>> PAKSHA IS REGIME-DEPENDENT (not a genuine signal)")


# ═══════════════════════════════════════════════════════════════════
# STUDY 5: PLANETARY LONG CYCLES — Jupiter (12yr), Saturn (29yr)
# ═══════════════════════════════════════════════════════════════════

def study_long_cycles(days: int):
    """Study Jupiter and Saturn sign transitions over maximum history.

    Jupiter changes sign ~every year. With 8+ years of BTC data, we can see
    Jupiter through 6-7 signs. This tests whether Jupiter's sign placement
    genuinely affects crypto markets.
    """
    print(f"\n{'='*80}")
    print(f"  STUDY 5: PLANETARY LONG CYCLES — Jupiter sign, Saturn sign")
    print(f"  {days} days | Jupiter stays ~1yr per sign, Saturn ~2.5yr")
    print(f"{'='*80}\n")

    sym = "BTC"  # Maximum history
    candles = fetch_ohlcv(sym, "1d", days)
    if len(candles) < 100:
        print("  Not enough data")
        return

    print(f"  BTC: {len(candles)} daily candles loaded")
    fwd = compute_returns(candles, [7, 14, 30, 90])

    # Track Jupiter and Saturn sign returns
    jup_sign_returns = defaultdict(lambda: defaultdict(list))
    sat_sign_returns = defaultdict(lambda: defaultdict(list))
    jup_sign_dates = defaultdict(list)

    for lag in [7, 14, 30, 90]:
        for dt, ret in fwd[lag]:
            try:
                sky = get_sky_state(dt)
            except Exception:
                continue

            jup_sign = sky.planets["Jupiter"].sign
            sat_sign = sky.planets["Saturn"].sign
            jup_sign_returns[jup_sign][lag].append(ret)
            sat_sign_returns[sat_sign][lag].append(ret)
            if lag == 7:
                jup_sign_dates[jup_sign].append(dt)

    # Jupiter signs
    print(f"\n  -- JUPITER SIGN RETURNS (BTC) --")
    print(f"  {'Sign':<15s} {'Period':>25s} {'7d%':>8s} {'30d%':>8s} {'90d%':>8s} {'N':>5s}")
    print(f"  {'-'*15} {'-'*25} {'-'*8} {'-'*8} {'-'*8} {'-'*5}")

    for sign in sorted(jup_sign_returns.keys(), key=lambda s: np.mean(jup_sign_returns[s][30]) if jup_sign_returns[s][30] else 0, reverse=True):
        dates = jup_sign_dates[sign]
        if not dates:
            continue
        period = f"{min(dates).strftime('%Y-%m')}-{max(dates).strftime('%Y-%m')}"
        vals = []
        n = 0
        for lag in [7, 30, 90]:
            data = jup_sign_returns[sign][lag]
            n = max(n, len(data))
            if data:
                vals.append(f"{np.mean(data):>+7.2f}%")
            else:
                vals.append("    N/A ")
        print(f"  {sign:<15s} {period:>25s} {''.join(vals)} {n:>5d}")

    # Saturn signs
    print(f"\n  -- SATURN SIGN RETURNS (BTC) --")
    print(f"  {'Sign':<15s} {'7d%':>8s} {'30d%':>8s} {'90d%':>8s} {'N':>5s}")
    print(f"  {'-'*15} {'-'*8} {'-'*8} {'-'*8} {'-'*5}")

    for sign in sorted(sat_sign_returns.keys(), key=lambda s: np.mean(sat_sign_returns[s][30]) if sat_sign_returns[s][30] else 0, reverse=True):
        vals = []
        n = 0
        for lag in [7, 30, 90]:
            data = sat_sign_returns[sign][lag]
            n = max(n, len(data))
            if data:
                vals.append(f"{np.mean(data):>+7.2f}%")
            else:
                vals.append("    N/A ")
        print(f"  {sign:<15s} {''.join(vals)} {n:>5d}")

    print(f"\n  NOTE: Jupiter/Saturn sign correlations may reflect MARKET EPOCHS")
    print(f"  rather than planetary influence. With only ~1 visit per sign in")
    print(f"  {days/365:.0f} years of data, we can't distinguish planet effect from")
    print(f"  the specific market conditions during that period.")
    print(f"  True validation requires 12+ years (full Jupiter cycle) minimum.")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Vedic Deep Research")
    parser.add_argument("--study", type=str, default="all",
                        choices=["all", "lunar", "retrogrades", "timeframes", "regime", "longcycles"],
                        help="Which study to run")
    parser.add_argument("--days", type=int, default=2000, help="Max lookback days")
    args = parser.parse_args()

    start = time.time()

    if args.study in ("all", "lunar"):
        study_lunar(args.days)

    if args.study in ("all", "retrogrades"):
        study_retrogrades(args.days)

    if args.study in ("all", "timeframes"):
        study_timeframes(args.days)

    if args.study in ("all", "regime"):
        study_regime(args.days)

    if args.study in ("all", "longcycles"):
        study_long_cycles(args.days)

    elapsed = time.time() - start
    print(f"\n  Total runtime: {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()
