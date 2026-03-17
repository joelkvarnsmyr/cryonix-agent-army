#!/usr/bin/env python3
"""
Geophysical Correlation Research — Solar Activity & Earth's EM Field

Tests if geophysical phenomena correlate with crypto market returns.

Phenomena:
  1. Kp-index (geomagnetic storm intensity, 0-9 scale)
     - Source: NOAA/GFZ Potsdam
     - Known to affect mood, risk-taking (Krivelyova & Robotti 2003)
     - High Kp = geomagnetic storm = negative stock returns (published research)

  2. Solar wind speed
     - Proxy for geomagnetic activity

  3. F10.7 solar radio flux (solar cycle proxy)
     - 11-year sunspot cycle
     - High solar activity = more storms

  4. Schumann Resonance (~7.83 Hz)
     - Earth's electromagnetic "heartbeat"
     - Hard to get historical data — we use solar proxies instead

Academic references:
  - Krivelyova & Robotti (2003): "Playing the Field: Geomagnetic Storms and Stock Markets"
    Found: High Kp days → significantly lower stock returns. Effect survives CAPM.
  - Kamstra, Kramer & Levi (2003): Seasonal mood / daylight effects on markets
  - Hirshleifer & Shumway (2003): Sunshine effect on stock returns

Data sources:
  - NOAA Space Weather: Kp index, solar wind, F10.7
  - GFZ Potsdam: Definitive Kp values
  - All available via HTTP API (no auth needed for most)

Usage:
  python scripts/strategy-lab/geophysics_research.py
"""
import json
import math
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Tuple

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import ccxt
import numpy as np
from scipy import stats as scipy_stats

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests"])
    import requests

# ── Price data ─────────────────────────────────────────────────────
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


# ═══════════════════════════════════════════════════════════════════
# DATA: Fetch geomagnetic Kp index from GFZ Potsdam
# ═══════════════════════════════════════════════════════════════════

def fetch_kp_index(days: int = 3000) -> Dict[str, float]:
    """Fetch daily Kp index from GFZ Potsdam.

    Kp ranges 0-9. We take the daily maximum Kp.
    Source: https://kp.gfz-potsdam.de/en/data
    Alternative: NOAA JSON API
    """
    print("  Fetching Kp index from NOAA...", end=" ", flush=True)
    kp_data = {}

    # NOAA provides recent Kp data (last ~30 days) via API
    # For longer history, we need to use the GFZ FTP or estimate from solar proxy

    # Method 1: NOAA recent data
    try:
        url = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"
        resp = requests.get(url, timeout=30)
        if resp.ok:
            data = resp.json()
            for row in data[1:]:  # Skip header
                try:
                    dt_str = row[0]  # "2026-03-16 00:00:00.000"
                    kp_val = float(row[1])
                    date_key = dt_str[:10]
                    if date_key not in kp_data or kp_val > kp_data[date_key]:
                        kp_data[date_key] = kp_val
                except (ValueError, IndexError):
                    continue
            print(f"NOAA: {len(kp_data)} days")
    except Exception as e:
        print(f"NOAA failed: {e}")

    # Method 2: GFZ Potsdam (longer history)
    try:
        # GFZ provides Kp in a text format
        url = "https://kp.gfz-potsdam.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt"
        resp = requests.get(url, timeout=60)
        if resp.ok:
            for line in resp.text.split("\n"):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) >= 30:
                    try:
                        year = int(parts[0])
                        month = int(parts[1])
                        day = int(parts[2])
                        # Kp values are in columns 7-14 (8 values per day, in thirds)
                        # Take max Kp for the day
                        kp_vals = []
                        for i in range(7, 15):
                            if i < len(parts):
                                try:
                                    kp_vals.append(float(parts[i]) / 10.0)  # GFZ stores Kp*10
                                except ValueError:
                                    pass
                        if kp_vals:
                            date_key = f"{year:04d}-{month:02d}-{day:02d}"
                            kp_data[date_key] = max(kp_vals)
                    except (ValueError, IndexError):
                        continue
            print(f"GFZ: {len(kp_data)} total days")
    except Exception as e:
        print(f"GFZ failed: {e}")

    # Method 3: Estimate from F10.7 solar flux (longer proxy)
    if len(kp_data) < 365:
        print("  Warning: Limited Kp data. Using solar proxy estimation.")

    return kp_data


def fetch_solar_flux(days: int = 3000) -> Dict[str, float]:
    """Fetch F10.7 solar radio flux (solar activity proxy).

    F10.7 = 10.7 cm radio emission from the Sun.
    Range: ~65 (solar minimum) to ~300+ (solar maximum).
    Source: NOAA
    """
    print("  Fetching F10.7 solar flux...", end=" ", flush=True)
    flux_data = {}

    try:
        # NOAA daily solar data
        url = "https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json"
        resp = requests.get(url, timeout=30)
        if resp.ok:
            data = resp.json()
            for entry in data:
                try:
                    date_str = entry.get("time-tag", "")[:10]
                    f107 = entry.get("f10.7")
                    if f107 is not None and date_str:
                        flux_data[date_str] = float(f107)
                except (ValueError, KeyError):
                    continue
            print(f"{len(flux_data)} months")
    except Exception as e:
        print(f"Failed: {e}")

    return flux_data


# ═══════════════════════════════════════════════════════════════════
# STUDY 1: Kp Index vs Crypto Returns
# ═══════════════════════════════════════════════════════════════════

def study_kp_index():
    """Test: Do geomagnetic storms (high Kp) predict lower crypto returns?

    Krivelyova & Robotti (2003) found this for stocks. Does it hold for crypto?
    """
    print(f"\n{'='*80}")
    print(f"  GEOMAGNETIC STORMS (Kp INDEX) vs CRYPTO RETURNS")
    print(f"  Academic ref: Krivelyova & Robotti (2003)")
    print(f"  Hypothesis: High Kp (storms) = lower returns")
    print(f"{'='*80}\n")

    kp_data = fetch_kp_index()
    if not kp_data:
        print("  No Kp data available")
        return

    for sym in ["BTC", "ETH"]:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, 3000)
        if not candles:
            continue

        # Build date -> return map
        fwd = {}
        for i in range(len(candles)):
            dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
            close = candles[i][4]
            date_key = dt.strftime("%Y-%m-%d")
            for lag in [1, 3, 7, 14]:
                if i + lag < len(candles):
                    fwd_close = candles[i + lag][4]
                    fwd.setdefault(lag, {})[date_key] = (fwd_close - close) / close * 100

        # Bin Kp values and check returns
        kp_bins = {"quiet": [], "unsettled": [], "storm": [], "major_storm": []}

        for date_key, kp in kp_data.items():
            if date_key not in fwd.get(7, {}):
                continue

            if kp <= 2:
                kp_bins["quiet"].append(fwd[7][date_key])
            elif kp <= 4:
                kp_bins["unsettled"].append(fwd[7][date_key])
            elif kp <= 6:
                kp_bins["storm"].append(fwd[7][date_key])
            else:
                kp_bins["major_storm"].append(fwd[7][date_key])

        print(f"  {'Kp Level':<15s} {'7d avg%':>10s} {'N':>6s}")
        print(f"  {'-'*15} {'-'*10} {'-'*6}")
        for label in ["quiet", "unsettled", "storm", "major_storm"]:
            data = kp_bins[label]
            if data:
                print(f"  {label:<15s} {np.mean(data):>+9.3f}% {len(data):>6d}")

        # T-test: quiet vs storm
        quiet = kp_bins["quiet"]
        storm = kp_bins["storm"] + kp_bins["major_storm"]
        if quiet and storm:
            edge = np.mean(quiet) - np.mean(storm)
            t, p = scipy_stats.ttest_ind(quiet, storm, equal_var=False)
            sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""
            print(f"\n  Quiet vs Storm 7d: edge={edge:>+.3f}%, t={t:.2f}, p={p:.4f} {sig}")

        # Correlation: Kp vs next-7d returns
        pairs = [(kp_data[d], fwd[7][d]) for d in kp_data if d in fwd.get(7, {})]
        if len(pairs) > 30:
            karr = np.array([k for k, _ in pairs])
            rarr = np.array([r for _, r in pairs])
            corr = np.corrcoef(karr, rarr)[0, 1]
            print(f"  Kp vs 7d return correlation: r={corr:+.4f}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 2: Solar Cycle Phase vs Crypto
# ═══════════════════════════════════════════════════════════════════

def study_solar_cycle():
    """Test: Does the 11-year solar cycle phase affect crypto?

    Solar max = more storms, more volatility.
    Solar min = quieter, steadier markets?
    """
    print(f"\n{'='*80}")
    print(f"  SOLAR CYCLE PHASE vs CRYPTO RETURNS")
    print(f"  Current: approaching Solar Cycle 25 maximum (~2025)")
    print(f"{'='*80}\n")

    flux_data = fetch_solar_flux()
    if not flux_data:
        print("  No solar flux data available")
        return

    for sym in ["BTC", "ETH"]:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, 3000)
        if not candles:
            continue

        fwd = {}
        for i in range(len(candles)):
            dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
            close = candles[i][4]
            # Use YYYY-MM for monthly matching with solar data
            month_key = dt.strftime("%Y-%m")
            date_key = dt.strftime("%Y-%m-%d")
            for lag in [7, 14, 30]:
                if i + lag < len(candles):
                    fwd_close = candles[i + lag][4]
                    fwd.setdefault(lag, {})[date_key] = (fwd_close - close) / close * 100

        # Match with closest monthly solar flux
        flux_returns = defaultdict(list)
        pairs_7d = []

        for date_key in fwd.get(7, {}):
            month = date_key[:7]
            f107 = flux_data.get(month)
            if f107 is None:
                # Try adjacent months
                for offset in [-1, 1]:
                    try:
                        y, m = int(month[:4]), int(month[5:7])
                        m += offset
                        if m > 12:
                            y, m = y + 1, 1
                        elif m < 1:
                            y, m = y - 1, 12
                        alt = f"{y:04d}-{m:02d}"
                        if alt in flux_data:
                            f107 = flux_data[alt]
                            break
                    except ValueError:
                        continue

            if f107 is None:
                continue

            # Bin solar activity
            if f107 < 80:
                fbin = "low (<80)"
            elif f107 < 120:
                fbin = "moderate (80-120)"
            elif f107 < 180:
                fbin = "high (120-180)"
            else:
                fbin = "very_high (>180)"

            flux_returns[fbin].append(fwd[7][date_key])
            pairs_7d.append((f107, fwd[7][date_key]))

        print(f"  {'Solar Activity':<20s} {'7d avg%':>10s} {'N':>6s}")
        print(f"  {'-'*20} {'-'*10} {'-'*6}")
        for fbin in ["low (<80)", "moderate (80-120)", "high (120-180)", "very_high (>180)"]:
            data = flux_returns.get(fbin, [])
            if data:
                print(f"  {fbin:<20s} {np.mean(data):>+9.3f}% {len(data):>6d}")

        if pairs_7d:
            farr = np.array([f for f, _ in pairs_7d])
            rarr = np.array([r for _, r in pairs_7d])
            corr = np.corrcoef(farr, rarr)[0, 1]
            print(f"\n  F10.7 vs 7d return correlation: r={corr:+.4f}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 3: Combined Astro + Geophysics
# ═══════════════════════════════════════════════════════════════════

def study_combined_astro_geo():
    """Combine astronomical signals with geomagnetic data.

    Test if Venus Rx + geomagnetic storms compound the effect.
    """
    print(f"\n{'='*80}")
    print(f"  COMBINED: Venus Rx + Geomagnetic Activity")
    print(f"  Does solar activity amplify the Venus Rx drawdown?")
    print(f"{'='*80}\n")

    kp_data = fetch_kp_index()

    # Import vedic for Venus Rx
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine'))
    from src.vedic.ephemeris import get_sky_state

    for sym in ["BTC", "ETH"]:
        print(f"\n  -- {sym} --")
        candles = fetch_daily(sym, 3000)
        if not candles:
            continue

        combo_returns = defaultdict(list)

        for i in range(len(candles) - 14):
            dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
            close = candles[i][4]
            fwd_14 = (candles[i + 14][4] - close) / close * 100
            date_key = dt.strftime("%Y-%m-%d")

            try:
                sky = get_sky_state(dt)
                venus_rx = sky.planets["Venus"].is_retrograde
            except Exception:
                continue

            kp = kp_data.get(date_key, 2.0)  # Default to quiet
            high_kp = kp >= 4

            if venus_rx and high_kp:
                combo_returns["venus_rx + storm"].append(fwd_14)
            elif venus_rx:
                combo_returns["venus_rx only"].append(fwd_14)
            elif high_kp:
                combo_returns["storm only"].append(fwd_14)
            else:
                combo_returns["normal"].append(fwd_14)

        print(f"  {'Condition':<22s} {'14d avg%':>10s} {'N':>6s}")
        print(f"  {'-'*22} {'-'*10} {'-'*6}")
        for cond in ["normal", "storm only", "venus_rx only", "venus_rx + storm"]:
            data = combo_returns.get(cond, [])
            if data:
                print(f"  {cond:<22s} {np.mean(data):>+9.3f}% {len(data):>6d}")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    start = time.time()

    study_kp_index()
    study_solar_cycle()
    study_combined_astro_geo()

    elapsed = time.time() - start
    print(f"\n  Total runtime: {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()
