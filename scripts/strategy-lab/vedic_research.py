#!/usr/bin/env python3
"""
Vedic Astrology Research Framework — Systematic Signal Validation

Phase 1: Raw signal correlation analysis
  - For each vedic signal, compute correlation with next-day, 3-day, 7-day returns
  - No trading simulation — pure statistical analysis
  - Cross-symbol validation (signal must work on 5+ of 7 test symbols)

Phase 2: Signal combination testing
  - Test all promising signal combinations
  - Find optimal entry/exit rules

Phase 3: Walk-forward validation
  - Train on 70%, test on 30%
  - Out-of-sample validation

Usage:
  python scripts/strategy-lab/vedic_research.py --phase 1 --days 365
  python scripts/strategy-lab/vedic_research.py --phase 2 --days 365
  python scripts/strategy-lab/vedic_research.py --phase 3 --days 730
"""
import argparse
import json
import math
import os
import sys
import time

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import ccxt
import numpy as np

# Import vedic engine
_engine_path = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine')
if os.path.isdir(_engine_path) and _engine_path not in sys.path:
    sys.path.insert(0, _engine_path)

from src.vedic.ephemeris import get_sky_state, SkyState
from src.vedic.scoring import compute_vedic_score, compute_symbol_transits
from src.vedic.aspects import detect_aspects, mercury_retrograde, detect_retrogrades
from src.vedic.nakshatras import nakshatra_at_longitude, moon_nakshatra_score, NAKSHATRAS
from src.vedic.muhurta import calculate_muhurta, calculate_tithi, get_vara, get_hora_lord
from src.vedic.natal import CRYPTO_GENESIS, analyze_transits
from src.vedic.dasha import compute_dasha_for_symbol
from src.vedic.lagna import compute_bhava_score

# ── Test symbols (liquid, diverse) ─────────────────────────────────
TEST_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "AVAX"]
ALL_SYMBOLS = list(CRYPTO_GENESIS.keys())

# ── OHLCV Cache ────────────────────────────────────────────────────
_price_cache: Dict[str, List] = {}

def fetch_daily_ohlcv(symbol: str, days: int) -> List:
    """Fetch daily OHLCV from Binance. Cached."""
    cache_key = f"{symbol}_{days}"
    if cache_key in _price_cache:
        return _price_cache[cache_key]

    exchange = ccxt.binance({"enableRateLimit": True})
    pair = f"{symbol}/USDT"  # USDT has more history than USDC

    since = int((datetime.now(timezone.utc) - timedelta(days=days + 5)).timestamp() * 1000)
    all_candles = []
    limit = 1000

    while True:
        try:
            candles = exchange.fetch_ohlcv(pair, "1d", since=since, limit=limit)
        except Exception:
            # Try USDC if USDT fails
            try:
                candles = exchange.fetch_ohlcv(f"{symbol}/USDC", "1d", since=since, limit=limit)
            except Exception:
                break
        if not candles:
            break
        all_candles.extend(candles)
        since = candles[-1][0] + 1
        if len(candles) < limit:
            break

    _price_cache[cache_key] = all_candles
    return all_candles


def fetch_4h_ohlcv(symbol: str, days: int) -> List:
    """Fetch 4h OHLCV from Binance."""
    cache_key = f"{symbol}_4h_{days}"
    if cache_key in _price_cache:
        return _price_cache[cache_key]

    exchange = ccxt.binance({"enableRateLimit": True})
    pair = f"{symbol}/USDT"

    since = int((datetime.now(timezone.utc) - timedelta(days=days + 2)).timestamp() * 1000)
    all_candles = []
    limit = 1000

    while True:
        try:
            candles = exchange.fetch_ohlcv(pair, "4h", since=since, limit=limit)
        except Exception:
            try:
                candles = exchange.fetch_ohlcv(f"{symbol}/USDC", "4h", since=since, limit=limit)
            except Exception:
                break
        if not candles:
            break
        all_candles.extend(candles)
        since = candles[-1][0] + 1
        if len(candles) < limit:
            break

    _price_cache[cache_key] = all_candles
    return all_candles


# ═══════════════════════════════════════════════════════════════════
# PHASE 1: Raw Signal Correlation Analysis
# ═══════════════════════════════════════════════════════════════════

def compute_forward_returns(candles: List) -> Dict[int, Dict[datetime, float]]:
    """Compute forward returns at multiple lags for daily candles."""
    returns = {}
    for lag in [1, 3, 7, 14]:
        returns[lag] = {}
        for i in range(len(candles) - lag):
            dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
            close_now = candles[i][4]
            close_future = candles[i + lag][4]
            returns[lag][dt] = (close_future - close_now) / close_now * 100
    return returns


def extract_all_signals(dt: datetime, symbol: str) -> Dict[str, Any]:
    """Extract every vedic signal for a given moment and symbol."""
    sky = get_sky_state(dt)
    vedic = compute_vedic_score(sky)
    muhurta = calculate_muhurta(sky)
    tithi = calculate_tithi(sky)

    # Moon data
    moon_lon = sky.planets["Moon"].longitude
    nak = nakshatra_at_longitude(moon_lon)

    # Aspects
    aspects = detect_aspects(sky)
    retros = detect_retrogrades(sky)
    merc_rx = mercury_retrograde(sky)

    # Transit for this symbol
    transit = analyze_transits(symbol, sky)
    transit_score = transit.transit_score if transit else 0.0

    # Dasha
    dasha = compute_dasha_for_symbol(symbol, dt)

    # Bhava
    bhava = compute_bhava_score(symbol, sky)
    bhava_score = bhava.bhava_score if bhava else 0.0

    # Hora
    hora = get_hora_lord(dt)
    vara = get_vara(dt)

    # Planet-specific
    sun_sign = sky.planets["Sun"].sign
    jupiter_sign = sky.planets["Jupiter"].sign
    saturn_sign = sky.planets["Saturn"].sign
    jupiter_retro = sky.planets["Jupiter"].is_retrograde
    saturn_retro = sky.planets["Saturn"].is_retrograde
    venus_retro = sky.planets["Venus"].is_retrograde
    mars_retro = sky.planets["Mars"].is_retrograde

    # Moon phase gradient (continuous)
    moon_phase = tithi.moon_phase_pct

    # Planet speeds (rate of change)
    moon_speed = sky.planets["Moon"].speed
    mercury_speed = sky.planets["Mercury"].speed

    return {
        # V2 signals (currently used)
        "paksha": tithi.paksha,  # Shukla/Krishna
        "is_shukla": 1 if tithi.paksha == "Shukla" else 0,
        "mercury_rx": 1 if merc_rx else 0,
        "moon_phase_pct": moon_phase,
        "v2_composite": vedic.overall_score,

        # Tithi details
        "tithi_number": tithi.number,
        "is_full_moon": 1 if tithi.is_full_moon else 0,
        "is_new_moon": 1 if tithi.is_new_moon else 0,
        "is_rikta": 1 if tithi.is_rikta else 0,
        "is_buying_day": 1 if tithi.is_buying_day else 0,

        # Nakshatra
        "nakshatra_name": nak.nakshatra.name,
        "nakshatra_index": nak.nakshatra.index,
        "nakshatra_bias": nak.nakshatra.trading_bias,
        "nakshatra_score": moon_nakshatra_score(moon_lon),
        "nakshatra_pada": nak.pada,

        # Muhurta
        "muhurta_score": muhurta.score,
        "muhurta_label": muhurta.label,

        # Vara (weekday)
        "vara_day": vara.day_name,
        "vara_bias": vara.trading_bias,

        # Hora
        "hora_lord": hora,

        # Aspects
        "aspect_score": aspects.aspect_score,
        "aspect_nature": aspects.dominant_nature,
        "n_aspects": len(aspects.aspects),
        "n_benefic": sum(1 for a in aspects.aspects if a.nature == "benefic"),
        "n_malefic": sum(1 for a in aspects.aspects if a.nature == "malefic"),

        # Retrogrades
        "n_retrogrades": len([r for r in retros if r not in ("Rahu", "Ketu")]),
        "jupiter_retro": 1 if jupiter_retro else 0,
        "saturn_retro": 1 if saturn_retro else 0,
        "venus_retro": 1 if venus_retro else 0,
        "mars_retro": 1 if mars_retro else 0,

        # Natal transits (symbol-specific)
        "transit_score": transit_score,

        # Dasha (symbol-specific)
        "dasha_maha_lord": dasha.maha_dasha_lord if dasha else "",
        "dasha_antar_lord": dasha.antar_dasha_lord if dasha else "",
        "dasha_combined_bias": dasha.combined_bias if dasha else 0.0,

        # Bhava (symbol-specific)
        "bhava_score": bhava_score,

        # Planet signs (slow movers = macro context)
        "jupiter_sign": jupiter_sign,
        "saturn_sign": saturn_sign,
        "sun_sign": sun_sign,

        # Moon speed (fast/slow)
        "moon_speed": moon_speed,
        "mercury_speed": mercury_speed,

        # Combined / derived
        "paksha_x_phase": (1 if tithi.paksha == "Shukla" else -1) * (moon_phase / 100),
        "mid_shukla": 1 if (tithi.paksha == "Shukla" and 4 <= tithi.number <= 11) else 0,
        "late_shukla": 1 if (tithi.paksha == "Shukla" and tithi.number >= 12) else 0,
        "early_krishna": 1 if (tithi.paksha == "Krishna" and tithi.number <= 22) else 0,
        "late_krishna": 1 if (tithi.paksha == "Krishna" and tithi.number >= 23) else 0,
    }


def phase1_correlations(symbols: List[str], days: int):
    """Phase 1: Test every signal against forward returns."""
    print(f"\n{'='*70}")
    print(f"  PHASE 1: RAW SIGNAL CORRELATION ANALYSIS")
    print(f"  {len(symbols)} symbols × {days} days")
    print(f"{'='*70}\n")

    # Collect all data
    all_results: Dict[str, Dict[int, List[Tuple[float, float]]]] = defaultdict(
        lambda: defaultdict(list)
    )

    for sym in symbols:
        print(f"  Processing {sym}...", end=" ", flush=True)
        candles = fetch_daily_ohlcv(sym, days)
        if len(candles) < 30:
            print(f"SKIP (only {len(candles)} candles)")
            continue

        fwd_returns = compute_forward_returns(candles)

        # Compute vedic signals for each day
        computed = 0
        for candle in candles[:-14]:  # Leave room for forward returns
            dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)

            try:
                signals = extract_all_signals(dt, sym)
            except Exception as e:
                continue

            computed += 1

            # For each numeric signal, record (signal_value, forward_return)
            for sig_name, sig_val in signals.items():
                if isinstance(sig_val, (int, float)) and not isinstance(sig_val, bool):
                    for lag in [1, 3, 7, 14]:
                        if dt in fwd_returns.get(lag, {}):
                            all_results[sig_name][lag].append(
                                (float(sig_val), fwd_returns[lag][dt])
                            )

            # Categorical signals → bucket analysis
            for cat_name in ["paksha", "nakshatra_name", "nakshatra_bias",
                             "muhurta_label", "vara_day", "hora_lord",
                             "aspect_nature", "dasha_maha_lord",
                             "jupiter_sign", "saturn_sign"]:
                cat_val = signals.get(cat_name, "")
                for lag in [1, 3, 7, 14]:
                    if dt in fwd_returns.get(lag, {}):
                        bucket_key = f"CAT_{cat_name}={cat_val}"
                        all_results[bucket_key][lag].append(
                            (1.0, fwd_returns[lag][dt])
                        )

        print(f"{computed} days computed")

    # ── Analyze correlations ──
    print(f"\n{'='*70}")
    print(f"  CORRELATION RESULTS")
    print(f"{'='*70}")

    # Numeric signals: Pearson correlation
    print(f"\n  ── Numeric Signal Correlations ──")
    print(f"  {'Signal':<30s} {'1d r':>8s} {'3d r':>8s} {'7d r':>8s} {'14d r':>8s} {'N':>6s}")
    print(f"  {'-'*30} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*6}")

    numeric_results = []
    for sig_name in sorted(all_results.keys()):
        if sig_name.startswith("CAT_"):
            continue

        row = {"signal": sig_name}
        n = 0
        for lag in [1, 3, 7, 14]:
            pairs = all_results[sig_name][lag]
            if len(pairs) < 30:
                row[f"r_{lag}d"] = None
                continue
            n = len(pairs)
            xs = np.array([p[0] for p in pairs])
            ys = np.array([p[1] for p in pairs])

            # Skip if no variance
            if np.std(xs) < 1e-10 or np.std(ys) < 1e-10:
                row[f"r_{lag}d"] = 0.0
                continue

            r = np.corrcoef(xs, ys)[0, 1]
            row[f"r_{lag}d"] = round(r, 4)

        row["n"] = n
        numeric_results.append(row)

    # Sort by abs(7d correlation)
    numeric_results.sort(key=lambda x: abs(x.get("r_7d", 0) or 0), reverse=True)

    for row in numeric_results:
        vals = []
        for lag in [1, 3, 7, 14]:
            r = row.get(f"r_{lag}d")
            if r is None:
                vals.append("   N/A ")
            else:
                marker = "**" if abs(r) > 0.05 else "  "
                vals.append(f"{r:>+7.4f}{marker[0]}")
        print(f"  {row['signal']:<30s} {''.join(vals)} {row.get('n', 0):>6d}")

    # Categorical signals: mean return per bucket
    print(f"\n\n  ── Categorical Signal Analysis ──")

    cat_groups = defaultdict(dict)
    for sig_name in sorted(all_results.keys()):
        if not sig_name.startswith("CAT_"):
            continue
        # Parse CAT_field=value
        field_val = sig_name[4:]
        field_name, val = field_val.split("=", 1)
        if field_name not in cat_groups:
            cat_groups[field_name] = {}
        cat_groups[field_name][val] = all_results[sig_name]

    for field_name in sorted(cat_groups.keys()):
        print(f"\n  ── {field_name} ──")
        print(f"  {'Value':<25s} {'N':>5s} {'1d avg%':>9s} {'7d avg%':>9s} {'14d avg%':>9s}")
        print(f"  {'-'*25} {'-'*5} {'-'*9} {'-'*9} {'-'*9}")

        val_data = cat_groups[field_name]
        rows = []
        for val, lag_data in val_data.items():
            n = len(lag_data.get(1, []))
            if n < 10:
                continue
            row = {"val": val, "n": n}
            for lag in [1, 7, 14]:
                pairs = lag_data.get(lag, [])
                if pairs:
                    avg = np.mean([p[1] for p in pairs])
                    row[f"avg_{lag}d"] = round(avg, 4)
                else:
                    row[f"avg_{lag}d"] = None
            rows.append(row)

        rows.sort(key=lambda x: x.get("avg_7d", 0) or 0, reverse=True)
        for row in rows:
            vals = []
            for lag in [1, 7, 14]:
                avg = row.get(f"avg_{lag}d")
                if avg is None:
                    vals.append("     N/A ")
                else:
                    vals.append(f"{avg:>+8.4f}%")
            print(f"  {row['val']:<25s} {row['n']:>5d} {''.join(vals)}")

    # ── Summary: Top signals ──
    print(f"\n\n{'='*70}")
    print(f"  TOP SIGNALS BY ABSOLUTE 7-DAY CORRELATION")
    print(f"{'='*70}")
    top = [r for r in numeric_results if r.get("r_7d") is not None and r.get("n", 0) > 100]
    top.sort(key=lambda x: abs(x.get("r_7d", 0)), reverse=True)
    for r in top[:20]:
        direction = "BULLISH" if (r.get("r_7d", 0) or 0) > 0 else "BEARISH"
        print(f"  {r['signal']:<30s}  r={r['r_7d']:>+.4f}  ({direction})  N={r.get('n', 0)}")

    return all_results


# ═══════════════════════════════════════════════════════════════════
# PHASE 2: Signal Combination Testing
# ═══════════════════════════════════════════════════════════════════

def phase2_combinations(symbols: List[str], days: int):
    """Phase 2: Test trading strategies with different signal combinations."""
    print(f"\n{'='*70}")
    print(f"  PHASE 2: SIGNAL COMBINATION BACKTESTING")
    print(f"  {len(symbols)} symbols × {days} days")
    print(f"{'='*70}\n")

    strategies = [
        {
            "name": "V2_CURRENT (paksha+merc+phase)",
            "buy": lambda s: s["v2_composite"] >= 10 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["v2_composite"] <= -20,
        },
        {
            "name": "PAKSHA_ONLY",
            "buy": lambda s: s["is_shukla"] == 1 and not s["is_full_moon"],
            "sell_bearish": lambda s: s["is_shukla"] == 0,
        },
        {
            "name": "MID_SHUKLA (tithi 4-11)",
            "buy": lambda s: s["mid_shukla"] == 1 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["is_shukla"] == 0 or s["is_full_moon"],
        },
        {
            "name": "MERC_RX_INVERSE (buy when Rx ends)",
            "buy": lambda s: s["mercury_rx"] == 0 and s["is_shukla"] == 1 and s["mercury_speed"] > 0.5,
            "sell_bearish": lambda s: s["mercury_rx"] == 1 or s["v2_composite"] <= -30,
        },
        {
            "name": "TRANSIT_DRIVEN (symbol-specific)",
            "buy": lambda s: s["transit_score"] > 0.2 and s["is_shukla"] == 1 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["transit_score"] < -0.3,
        },
        {
            "name": "DASHA_FILTERED (bullish dasha only)",
            "buy": lambda s: s["dasha_combined_bias"] > 0.1 and s["is_shukla"] == 1 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["is_shukla"] == 0,
        },
        {
            "name": "MOON_SPEED (fast moon = momentum)",
            "buy": lambda s: s["moon_speed"] > 13 and s["is_shukla"] == 1 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["moon_speed"] < 11 or s["is_shukla"] == 0,
        },
        {
            "name": "ASPECT_FILTERED (benefic only)",
            "buy": lambda s: s["n_benefic"] >= 2 and s["is_shukla"] == 1 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["n_malefic"] >= 3,
        },
        {
            "name": "RETRO_COUNT (few retros = clear sky)",
            "buy": lambda s: s["n_retrogrades"] <= 1 and s["is_shukla"] == 1 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["n_retrogrades"] >= 3,
        },
        {
            "name": "BHAVA_DRIVEN (house-based)",
            "buy": lambda s: s["bhava_score"] > 0.1 and s["is_shukla"] == 1 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["bhava_score"] < -0.2,
        },
        {
            "name": "JUPITER_RX_FILTER",
            "buy": lambda s: s["jupiter_retro"] == 0 and s["is_shukla"] == 1 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["is_shukla"] == 0,
        },
        {
            "name": "FULL_VEDIC (all signals aligned)",
            "buy": lambda s: (
                s["is_shukla"] == 1 and
                not s["mercury_rx"] and
                s["mid_shukla"] == 1 and
                s["transit_score"] > 0 and
                s["dasha_combined_bias"] > 0 and
                s["n_benefic"] >= s["n_malefic"] and
                s["bhava_score"] > 0
            ),
            "sell_bearish": lambda s: s["is_shukla"] == 0 or s["mercury_rx"],
        },
        {
            "name": "V3_CANDIDATE (mid-shukla + merc-phase + transit)",
            "buy": lambda s: (
                s["mid_shukla"] == 1 and
                not s["mercury_rx"] and
                s["transit_score"] > -0.1 and
                s["moon_phase_pct"] > 20
            ),
            "sell_bearish": lambda s: (
                s["early_krishna"] == 1 or
                s["mercury_rx"] == 1 or
                s["is_full_moon"]
            ),
        },
        {
            "name": "BUY_AND_HOLD (baseline)",
            "buy": lambda s: True,  # Always buy at start
            "sell_bearish": lambda s: False,  # Never sell
        },
    ]

    # Run each strategy on each symbol
    summary = []

    for strat in strategies:
        strat_results = []
        for sym in symbols:
            candles = fetch_4h_ohlcv(sym, days)
            if len(candles) < 50:
                continue

            result = _run_strategy_backtest(
                sym, candles, strat["buy"], strat["sell_bearish"],
                capital=1000.0,
            )
            strat_results.append(result)

        if not strat_results:
            continue

        # Aggregate
        total_return = np.mean([r["return_pct"] for r in strat_results])
        total_wr = np.mean([r["win_rate"] for r in strat_results]) if any(r["trades"] > 0 for r in strat_results) else 0
        total_trades = sum(r["trades"] for r in strat_results)
        max_dd = np.mean([r["max_dd"] for r in strat_results])
        sharpe = np.mean([r["sharpe"] for r in strat_results])
        symbols_positive = sum(1 for r in strat_results if r["return_pct"] > 0)

        summary.append({
            "strategy": strat["name"],
            "avg_return": round(total_return, 2),
            "avg_wr": round(total_wr, 1),
            "total_trades": total_trades,
            "avg_max_dd": round(max_dd, 2),
            "avg_sharpe": round(sharpe, 2),
            "symbols_positive": f"{symbols_positive}/{len(strat_results)}",
            "per_symbol": strat_results,
        })

    # Print results
    print(f"\n{'='*90}")
    print(f"  STRATEGY COMPARISON")
    print(f"{'='*90}")
    print(f"  {'Strategy':<40s} {'Ret%':>7s} {'WR%':>6s} {'Trades':>7s} {'MaxDD':>7s} {'Sharpe':>7s} {'Win/N':>6s}")
    print(f"  {'-'*40} {'-'*7} {'-'*6} {'-'*7} {'-'*7} {'-'*7} {'-'*6}")

    summary.sort(key=lambda x: x["avg_return"], reverse=True)
    for s in summary:
        print(f"  {s['strategy']:<40s} {s['avg_return']:>+6.1f}% {s['avg_wr']:>5.1f}% "
              f"{s['total_trades']:>7d} {s['avg_max_dd']:>6.1f}% {s['avg_sharpe']:>7.2f} "
              f"{s['symbols_positive']:>6s}")

    # Per-symbol breakdown for top 3
    print(f"\n\n  ── Per-Symbol Breakdown (Top 3 Strategies) ──")
    for s in summary[:3]:
        print(f"\n  {s['strategy']}:")
        print(f"    {'Symbol':<8s} {'Return%':>8s} {'WR%':>6s} {'Trades':>7s} {'MaxDD%':>7s}")
        for r in sorted(s["per_symbol"], key=lambda x: x["return_pct"], reverse=True):
            print(f"    {r['symbol']:<8s} {r['return_pct']:>+7.1f}% {r['win_rate']:>5.1f}% "
                  f"{r['trades']:>7d} {r['max_dd']:>6.1f}%")

    return summary


def _run_strategy_backtest(
    symbol: str,
    candles: List,
    buy_fn,
    sell_bearish_fn,
    capital: float = 1000.0,
    sl_pct: float = 0.04,
    tp_pct: float = 0.10,
    trailing_act: float = 0.03,
    trailing_stop: float = 0.015,
    position_size: float = 0.10,
) -> Dict:
    """Run a strategy backtest on 4h candles."""
    balance = capital
    position = None
    trades_closed = 0
    wins = 0
    peak_balance = capital
    max_dd = 0.0
    returns = []
    buy_once = False  # For buy-and-hold baseline

    for i, candle in enumerate(candles):
        ts_ms, open_p, high_p, low_p, close_p, volume = candle
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        price = close_p

        try:
            signals = extract_all_signals(dt, symbol)
        except Exception:
            continue

        if position is None:
            # Check buy
            try:
                should_buy = buy_fn(signals)
            except Exception:
                should_buy = False

            if should_buy and not buy_once:
                size = balance * position_size
                if size >= 1:
                    qty = size / price
                    balance -= size
                    position = {
                        "entry": price, "qty": qty, "peak": price,
                        "entry_time": dt, "trailing": False,
                    }
                    # For buy-and-hold: only buy once
                    if buy_fn.__code__.co_code == (lambda s: True).__code__.co_code:
                        buy_once = True
        else:
            # Check sell
            pnl_pct = (price - position["entry"]) / position["entry"]
            if price > position["peak"]:
                position["peak"] = price

            sell = False

            # Trailing stop
            peak = position["peak"]
            if (peak - position["entry"]) / position["entry"] >= trailing_act:
                position["trailing"] = True
                if price <= peak * (1 - trailing_stop):
                    sell = True

            if not sell and pnl_pct <= -sl_pct:
                sell = True
            if not sell and pnl_pct >= tp_pct:
                sell = True

            try:
                if not sell and sell_bearish_fn(signals):
                    if pnl_pct > 0.005:  # Only sell on bearish if slightly profitable
                        sell = True
            except Exception:
                pass

            if sell:
                sell_val = position["qty"] * price
                trade_pnl = sell_val - (position["qty"] * position["entry"])
                balance += sell_val
                trades_closed += 1
                if trade_pnl > 0:
                    wins += 1
                returns.append(pnl_pct * 100)
                position = None

        # Track drawdown
        val = balance + (position["qty"] * price if position else 0)
        if val > peak_balance:
            peak_balance = val
        dd = (peak_balance - val) / peak_balance * 100
        if dd > max_dd:
            max_dd = dd

    # Close open position
    if position and candles:
        last_price = candles[-1][4]
        sell_val = position["qty"] * last_price
        trade_pnl = sell_val - (position["qty"] * position["entry"])
        balance += sell_val
        trades_closed += 1
        if trade_pnl > 0:
            wins += 1
        pnl_pct = (last_price - position["entry"]) / position["entry"] * 100
        returns.append(pnl_pct)

    total_return = (balance / capital - 1) * 100
    wr = wins / max(trades_closed, 1) * 100

    # Sharpe
    if len(returns) > 1:
        std = np.std(returns)
        sharpe = np.mean(returns) / std * math.sqrt(252) if std > 0 else 0
    else:
        sharpe = 0

    return {
        "symbol": symbol,
        "return_pct": round(total_return, 2),
        "win_rate": round(wr, 1),
        "trades": trades_closed,
        "max_dd": round(max_dd, 2),
        "sharpe": round(sharpe, 2),
    }


# ═══════════════════════════════════════════════════════════════════
# PHASE 3: Walk-Forward Validation
# ═══════════════════════════════════════════════════════════════════

def phase3_walkforward(symbols: List[str], days: int):
    """Phase 3: Walk-forward out-of-sample validation."""
    print(f"\n{'='*70}")
    print(f"  PHASE 3: WALK-FORWARD OUT-OF-SAMPLE VALIDATION")
    print(f"  {len(symbols)} symbols × {days} days")
    print(f"  Training: first 70% | Testing: last 30%")
    print(f"{'='*70}\n")

    # Best strategies from Phase 2 to validate
    strategies = [
        {
            "name": "V2_CURRENT",
            "buy": lambda s: s["v2_composite"] >= 10 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["v2_composite"] <= -20,
        },
        {
            "name": "MID_SHUKLA",
            "buy": lambda s: s["mid_shukla"] == 1 and not s["mercury_rx"],
            "sell_bearish": lambda s: s["is_shukla"] == 0 or s["is_full_moon"],
        },
        {
            "name": "V3_CANDIDATE",
            "buy": lambda s: (
                s["mid_shukla"] == 1 and
                not s["mercury_rx"] and
                s["transit_score"] > -0.1 and
                s["moon_phase_pct"] > 20
            ),
            "sell_bearish": lambda s: (
                s["early_krishna"] == 1 or
                s["mercury_rx"] == 1 or
                s["is_full_moon"]
            ),
        },
    ]

    for strat in strategies:
        print(f"\n  Strategy: {strat['name']}")
        print(f"  {'Symbol':<8s} {'Train%':>8s} {'Test%':>8s} {'Diff':>8s} {'Train WR':>9s} {'Test WR':>9s}")
        print(f"  {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*9} {'-'*9}")

        train_returns = []
        test_returns = []

        for sym in symbols:
            candles = fetch_4h_ohlcv(sym, days)
            if len(candles) < 100:
                continue

            split_idx = int(len(candles) * 0.7)
            train_candles = candles[:split_idx]
            test_candles = candles[split_idx:]

            train_result = _run_strategy_backtest(sym, train_candles, strat["buy"], strat["sell_bearish"])
            test_result = _run_strategy_backtest(sym, test_candles, strat["buy"], strat["sell_bearish"])

            diff = test_result["return_pct"] - train_result["return_pct"]
            train_returns.append(train_result["return_pct"])
            test_returns.append(test_result["return_pct"])

            print(f"  {sym:<8s} {train_result['return_pct']:>+7.1f}% {test_result['return_pct']:>+7.1f}% "
                  f"{diff:>+7.1f}% {train_result['win_rate']:>8.1f}% {test_result['win_rate']:>8.1f}%")

        if train_returns:
            avg_train = np.mean(train_returns)
            avg_test = np.mean(test_returns)
            print(f"  {'AVG':<8s} {avg_train:>+7.1f}% {avg_test:>+7.1f}% "
                  f"{avg_test - avg_train:>+7.1f}%")

            # Stability assessment
            if avg_test > 0 and avg_test > avg_train * 0.5:
                print(f"  → STABLE: Test performance holds up")
            elif avg_test > 0:
                print(f"  → DEGRADED: Some edge but weaker OOS")
            else:
                print(f"  → FAILED: No edge out-of-sample")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Vedic Astrology Research Framework")
    parser.add_argument("--phase", type=int, choices=[1, 2, 3, 0], default=0,
                        help="Research phase (0=all, 1=correlations, 2=combinations, 3=walkforward)")
    parser.add_argument("--days", type=int, default=365, help="Lookback days")
    parser.add_argument("--symbols", type=str, default="test",
                        help="'test' (7 major), 'all' (16), or comma-separated")
    args = parser.parse_args()

    if args.symbols == "test":
        symbols = TEST_SYMBOLS
    elif args.symbols == "all":
        symbols = ALL_SYMBOLS
    else:
        symbols = [s.strip().upper() for s in args.symbols.split(",")]

    start = time.time()

    if args.phase in (0, 1):
        phase1_correlations(symbols, args.days)

    if args.phase in (0, 2):
        phase2_combinations(symbols, args.days)

    if args.phase in (0, 3):
        phase3_walkforward(symbols, args.days)

    elapsed = time.time() - start
    print(f"\n  Total runtime: {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()
