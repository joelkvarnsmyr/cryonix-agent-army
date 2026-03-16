#!/usr/bin/env python3
"""
Venus Rx BTD + Technical Indicators Research

Tests whether technical filters improve entry timing for the Venus Rx
Buy-The-Dip strategy. Venus Rx causes ~40-day drawdowns; after Venus
goes direct, BTC recovers +24.9% avg over 60 days. Current strategy
enters Day+7 after Rx ends. This script checks if RSI, Bollinger Bands,
volume spikes, and momentum filters can improve that entry.

Historical Venus Rx end dates tested:
  2017-04-15, 2018-11-16, 2020-06-25, 2022-01-29, 2023-09-04, 2025-04-13

Usage:
  python scripts/strategy-lab/vedic_btd_technicals.py
"""
import sys
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Tuple

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import ccxt
import numpy as np

# ── Constants ─────────────────────────────────────────────────────────

VENUS_RX_END_DATES = [
    "2017-04-15",
    "2018-11-16",
    "2020-06-25",
    "2022-01-29",
    "2023-09-04",
    "2025-04-13",
]

SYMBOLS = ["BTC/USDT", "ETH/USDT"]
TIMEFRAME = "4h"       # fetch 4h candles
RSI_PERIOD = 14
BB_PERIOD = 20
BB_STD = 2.0
VOL_AVG_PERIOD = 20
MOMENTUM_PERIOD = 5    # 5-day rate of change
HOLD_DAYS = 60         # measure returns over 60 days post-entry

# Days around Rx end to analyze: -5 to +30
WINDOW_BEFORE = 5
WINDOW_AFTER = 30

# ── Price fetching ────────────────────────────────────────────────────

_cache: Dict[str, list] = {}


def fetch_ohlcv(symbol: str, since_dt: datetime, until_dt: datetime) -> List[list]:
    """Fetch 4h OHLCV from Binance between two dates."""
    key = f"{symbol}_{since_dt.date()}_{until_dt.date()}"
    if key in _cache:
        return _cache[key]

    exchange = ccxt.binance({"enableRateLimit": True})
    since_ms = int(since_dt.timestamp() * 1000)
    until_ms = int(until_dt.timestamp() * 1000)

    all_candles = []
    cursor = since_ms

    while cursor < until_ms:
        try:
            candles = exchange.fetch_ohlcv(symbol, TIMEFRAME, since=cursor, limit=1000)
        except Exception as e:
            print(f"  [WARN] fetch error {symbol}: {e}, retrying...")
            time.sleep(2)
            continue

        if not candles:
            break

        all_candles.extend(candles)
        last_ts = candles[-1][0]
        if last_ts <= cursor:
            break
        cursor = last_ts + 1
        time.sleep(0.2)  # rate limit

    # Filter to requested range
    all_candles = [c for c in all_candles if since_ms <= c[0] <= until_ms]
    _cache[key] = all_candles
    return all_candles


def candles_to_daily(candles_4h: List[list]) -> List[dict]:
    """Aggregate 4h candles into daily OHLCV."""
    from collections import defaultdict
    daily_map = defaultdict(list)

    for c in candles_4h:
        ts, o, h, l, close, vol = c
        day = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        daily_map[day].append(c)

    daily = []
    for day in sorted(daily_map.keys()):
        bars = daily_map[day]
        daily.append({
            "date": day,
            "open": bars[0][1],
            "high": max(b[2] for b in bars),
            "low": min(b[3] for b in bars),
            "close": bars[-1][4],
            "volume": sum(b[5] for b in bars),
        })
    return daily


# ── Technical Indicators ──────────────────────────────────────────────

def calc_rsi(closes: np.ndarray, period: int = 14) -> np.ndarray:
    """RSI calculation."""
    rsi = np.full_like(closes, np.nan)
    if len(closes) < period + 1:
        return rsi

    deltas = np.diff(closes)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])

    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        if avg_loss == 0:
            rsi[i + 1] = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi[i + 1] = 100.0 - (100.0 / (1.0 + rs))

    return rsi


def calc_bollinger(closes: np.ndarray, period: int = 20, std_mult: float = 2.0):
    """Returns (upper, middle, lower, pct_b) arrays."""
    n = len(closes)
    upper = np.full(n, np.nan)
    middle = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    pct_b = np.full(n, np.nan)

    for i in range(period - 1, n):
        window = closes[i - period + 1: i + 1]
        sma = np.mean(window)
        std = np.std(window, ddof=0)
        middle[i] = sma
        upper[i] = sma + std_mult * std
        lower[i] = sma - std_mult * std
        if std > 0:
            pct_b[i] = (closes[i] - lower[i]) / (upper[i] - lower[i])
        else:
            pct_b[i] = 0.5

    return upper, middle, lower, pct_b


def calc_volume_spike(volumes: np.ndarray, period: int = 20) -> np.ndarray:
    """Volume relative to 20-period average."""
    spike = np.full_like(volumes, np.nan, dtype=float)
    for i in range(period, len(volumes)):
        avg = np.mean(volumes[i - period: i])
        if avg > 0:
            spike[i] = volumes[i] / avg
        else:
            spike[i] = 1.0
    return spike


def calc_momentum(closes: np.ndarray, period: int = 5) -> np.ndarray:
    """Price rate of change over N days (%)."""
    mom = np.full_like(closes, np.nan, dtype=float)
    for i in range(period, len(closes)):
        if closes[i - period] > 0:
            mom[i] = (closes[i] / closes[i - period] - 1.0) * 100.0
    return mom


# ── Analysis ──────────────────────────────────────────────────────────

def analyze_rx_end(rx_end_str: str, symbol: str) -> Optional[dict]:
    """
    For a given Venus Rx end date, fetch data and compute technicals.
    Returns dict with entry conditions and forward returns.
    """
    rx_end = datetime.strptime(rx_end_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)

    # Need enough history for indicators (BB20 needs 20 days before window)
    fetch_start = rx_end - timedelta(days=WINDOW_BEFORE + 40)
    # Need forward returns data
    fetch_end = rx_end + timedelta(days=WINDOW_AFTER + HOLD_DAYS + 5)

    # Don't try to fetch future data
    now = datetime.now(timezone.utc)
    if fetch_end > now:
        fetch_end = now
        if fetch_start > now:
            return None

    print(f"  Fetching {symbol} for Rx end {rx_end_str}...")
    candles_4h = fetch_ohlcv(symbol, fetch_start, fetch_end)

    if len(candles_4h) < 100:
        print(f"  [SKIP] Not enough data for {rx_end_str} {symbol} ({len(candles_4h)} candles)")
        return None

    daily = candles_to_daily(candles_4h)
    if len(daily) < 30:
        print(f"  [SKIP] Not enough daily bars for {rx_end_str} {symbol}")
        return None

    dates = [d["date"] for d in daily]
    closes = np.array([d["close"] for d in daily])
    volumes = np.array([d["volume"] for d in daily])

    # Calculate indicators
    rsi = calc_rsi(closes, RSI_PERIOD)
    bb_upper, bb_mid, bb_lower, pct_b = calc_bollinger(closes, BB_PERIOD, BB_STD)
    vol_spike = calc_volume_spike(volumes, VOL_AVG_PERIOD)
    momentum = calc_momentum(closes, MOMENTUM_PERIOD)

    # Find the index for Rx end date
    rx_end_idx = None
    for i, d in enumerate(dates):
        if d >= rx_end_str:
            rx_end_idx = i
            break

    if rx_end_idx is None:
        print(f"  [SKIP] Rx end date not in data range for {rx_end_str}")
        return None

    result = {
        "rx_end": rx_end_str,
        "symbol": symbol,
        "daily_data": [],
    }

    # Collect data for each day in the window
    for day_offset in range(-WINDOW_BEFORE, WINDOW_AFTER + 1):
        idx = rx_end_idx + day_offset
        if idx < 0 or idx >= len(dates):
            continue

        # Forward return: how much price gains in HOLD_DAYS from this entry
        fwd_return = None
        # Also check 30-day and 14-day returns
        fwd_14 = None
        fwd_30 = None

        for fwd_days, holder in [(14, "fwd_14"), (30, "fwd_30"), (HOLD_DAYS, "fwd_60")]:
            fwd_idx = idx + fwd_days
            if fwd_idx < len(closes) and closes[idx] > 0:
                ret = (closes[fwd_idx] / closes[idx] - 1.0) * 100.0
                if holder == "fwd_14":
                    fwd_14 = ret
                elif holder == "fwd_30":
                    fwd_30 = ret
                else:
                    fwd_return = ret

        entry = {
            "day_offset": day_offset,
            "date": dates[idx],
            "close": closes[idx],
            "rsi": float(rsi[idx]) if not np.isnan(rsi[idx]) else None,
            "pct_b": float(pct_b[idx]) if not np.isnan(pct_b[idx]) else None,
            "bb_lower": float(bb_lower[idx]) if not np.isnan(bb_lower[idx]) else None,
            "vol_spike": float(vol_spike[idx]) if not np.isnan(vol_spike[idx]) else None,
            "momentum": float(momentum[idx]) if not np.isnan(momentum[idx]) else None,
            "fwd_14_return": fwd_14,
            "fwd_30_return": fwd_30,
            "fwd_60_return": fwd_return,
        }
        result["daily_data"].append(entry)

    return result


def run_strategy_comparison(all_results: List[dict]):
    """Compare different entry strategies across all Rx periods."""

    strategies = {
        "Day+7 Blind": lambda d: d["day_offset"] == 7,
        "Day+7 + RSI<40": lambda d: d["day_offset"] == 7 and d["rsi"] is not None and d["rsi"] < 40,
        "Day+7 + RSI<50": lambda d: d["day_offset"] == 7 and d["rsi"] is not None and d["rsi"] < 50,
        "Day+7 + Below Lower BB": lambda d: (
            d["day_offset"] == 7
            and d["pct_b"] is not None
            and d["pct_b"] < 0.0
        ),
        "Day+7 + BB%<0.2": lambda d: (
            d["day_offset"] == 7
            and d["pct_b"] is not None
            and d["pct_b"] < 0.2
        ),
        "Day+7 + Volume Spike>1.5x": lambda d: (
            d["day_offset"] == 7
            and d["vol_spike"] is not None
            and d["vol_spike"] > 1.5
        ),
        "Day+7 + Momentum<0": lambda d: (
            d["day_offset"] == 7
            and d["momentum"] is not None
            and d["momentum"] < 0
        ),
        "Day+7 + RSI<50 + Mom<0": lambda d: (
            d["day_offset"] == 7
            and d["rsi"] is not None and d["rsi"] < 50
            and d["momentum"] is not None and d["momentum"] < 0
        ),
        # Also test flexible entry: first day in D+5..D+15 where RSI<40
        "D+5..D+15 first RSI<40": None,  # handled specially
        "D+5..D+15 first BB%<0.2": None,  # handled specially
        "D+5..D+15 first RSI<50 + Mom<0": None,  # handled specially
    }

    print("\n" + "=" * 80)
    print("STRATEGY COMPARISON: Venus Rx BTD + Technical Filters")
    print("=" * 80)

    for strat_name in strategies:
        entries_14 = []
        entries_30 = []
        entries_60 = []
        entry_details = []

        for res in all_results:
            data = res["daily_data"]

            if strat_name == "D+5..D+15 first RSI<40":
                # Find first day in range with RSI < 40
                candidates = [d for d in data if 5 <= d["day_offset"] <= 15 and d["rsi"] is not None and d["rsi"] < 40]
                if candidates:
                    d = candidates[0]
                    if d["fwd_14_return"] is not None:
                        entries_14.append(d["fwd_14_return"])
                    if d["fwd_30_return"] is not None:
                        entries_30.append(d["fwd_30_return"])
                    if d["fwd_60_return"] is not None:
                        entries_60.append(d["fwd_60_return"])
                    entry_details.append(f"    {res['symbol']} Rx={res['rx_end']} -> entered D+{d['day_offset']} RSI={d['rsi']:.1f} close=${d['close']:.2f}")
                continue

            if strat_name == "D+5..D+15 first BB%<0.2":
                candidates = [d for d in data if 5 <= d["day_offset"] <= 15 and d["pct_b"] is not None and d["pct_b"] < 0.2]
                if candidates:
                    d = candidates[0]
                    if d["fwd_14_return"] is not None:
                        entries_14.append(d["fwd_14_return"])
                    if d["fwd_30_return"] is not None:
                        entries_30.append(d["fwd_30_return"])
                    if d["fwd_60_return"] is not None:
                        entries_60.append(d["fwd_60_return"])
                    entry_details.append(f"    {res['symbol']} Rx={res['rx_end']} -> entered D+{d['day_offset']} BB%={d['pct_b']:.2f} close=${d['close']:.2f}")
                continue

            if strat_name == "D+5..D+15 first RSI<50 + Mom<0":
                candidates = [d for d in data if 5 <= d["day_offset"] <= 15
                              and d["rsi"] is not None and d["rsi"] < 50
                              and d["momentum"] is not None and d["momentum"] < 0]
                if candidates:
                    d = candidates[0]
                    if d["fwd_14_return"] is not None:
                        entries_14.append(d["fwd_14_return"])
                    if d["fwd_30_return"] is not None:
                        entries_30.append(d["fwd_30_return"])
                    if d["fwd_60_return"] is not None:
                        entries_60.append(d["fwd_60_return"])
                    entry_details.append(f"    {res['symbol']} Rx={res['rx_end']} -> entered D+{d['day_offset']} RSI={d['rsi']:.1f} Mom={d['momentum']:.1f}% close=${d['close']:.2f}")
                continue

            # Standard fixed-day strategies
            filter_fn = strategies[strat_name]
            for d in data:
                if filter_fn(d):
                    if d["fwd_14_return"] is not None:
                        entries_14.append(d["fwd_14_return"])
                    if d["fwd_30_return"] is not None:
                        entries_30.append(d["fwd_30_return"])
                    if d["fwd_60_return"] is not None:
                        entries_60.append(d["fwd_60_return"])
                    rsi_str = f"RSI={d['rsi']:.1f}" if d['rsi'] else "RSI=N/A"
                    bb_str = f"BB%={d['pct_b']:.2f}" if d['pct_b'] is not None else "BB%=N/A"
                    vol_str = f"Vol={d['vol_spike']:.1f}x" if d['vol_spike'] is not None else "Vol=N/A"
                    mom_str = f"Mom={d['momentum']:.1f}%" if d['momentum'] is not None else "Mom=N/A"
                    entry_details.append(f"    {res['symbol']} Rx={res['rx_end']} {rsi_str} {bb_str} {vol_str} {mom_str} close=${d['close']:.2f}")

        print(f"\n--- {strat_name} ---")
        print(f"  Entries triggered: {max(len(entries_14), len(entries_30), len(entries_60))}")

        if entries_14:
            print(f"  14-day return: avg={np.mean(entries_14):+.1f}% | med={np.median(entries_14):+.1f}% | win={sum(1 for r in entries_14 if r > 0)}/{len(entries_14)}")
        if entries_30:
            print(f"  30-day return: avg={np.mean(entries_30):+.1f}% | med={np.median(entries_30):+.1f}% | win={sum(1 for r in entries_30 if r > 0)}/{len(entries_30)}")
        if entries_60:
            print(f"  60-day return: avg={np.mean(entries_60):+.1f}% | med={np.median(entries_60):+.1f}% | win={sum(1 for r in entries_60 if r > 0)}/{len(entries_60)}")

        if not entries_14 and not entries_30 and not entries_60:
            print("  [NO ENTRIES] Filter too restrictive - never triggered")

        for detail in entry_details:
            print(detail)


def print_technical_heatmap(all_results: List[dict]):
    """Print a heatmap of technicals around Rx end dates."""

    print("\n" + "=" * 80)
    print("TECHNICAL CONDITIONS AROUND VENUS RX END DATES")
    print("=" * 80)

    for res in all_results:
        print(f"\n{res['symbol']} | Venus Rx end: {res['rx_end']}")
        print(f"  {'Day':>5} {'Date':>12} {'Close':>10} {'RSI':>6} {'BB%':>6} {'Vol':>6} {'Mom%':>7} {'Fwd14':>7} {'Fwd30':>7} {'Fwd60':>7}")
        print("  " + "-" * 85)

        for d in res["daily_data"]:
            if d["day_offset"] < -2 or d["day_offset"] > 20:
                continue  # only show interesting range

            rsi_str = f"{d['rsi']:.0f}" if d['rsi'] is not None else "  -"
            bb_str = f"{d['pct_b']:.2f}" if d['pct_b'] is not None else "  -"
            vol_str = f"{d['vol_spike']:.1f}x" if d['vol_spike'] is not None else "  -"
            mom_str = f"{d['momentum']:+.1f}" if d['momentum'] is not None else "   -"
            f14 = f"{d['fwd_14_return']:+.1f}" if d['fwd_14_return'] is not None else "   -"
            f30 = f"{d['fwd_30_return']:+.1f}" if d['fwd_30_return'] is not None else "   -"
            f60 = f"{d['fwd_60_return']:+.1f}" if d['fwd_60_return'] is not None else "   -"

            marker = " <-- Rx end" if d["day_offset"] == 0 else ""
            marker = " <-- D+7 entry" if d["day_offset"] == 7 else marker

            print(f"  D{d['day_offset']:+3d}  {d['date']:>12} {d['close']:>10.2f} {rsi_str:>6} {bb_str:>6} {vol_str:>6} {mom_str:>7} {f14:>7} {f30:>7} {f60:>7}{marker}")


def find_optimal_conditions(all_results: List[dict]):
    """Find which technical conditions at entry correlate with best returns."""

    print("\n" + "=" * 80)
    print("OPTIMAL ENTRY CONDITIONS ANALYSIS (Days +3 to +20)")
    print("=" * 80)

    # Collect all potential entry points in the D+3..D+20 window
    all_entries = []
    for res in all_results:
        for d in res["daily_data"]:
            if 3 <= d["day_offset"] <= 20 and d["fwd_30_return"] is not None:
                all_entries.append(d)

    if not all_entries:
        print("  No valid entries found.")
        return

    # RSI buckets
    print("\n  RSI at entry vs 30-day forward return:")
    for lo, hi, label in [(0, 30, "RSI<30"), (30, 40, "RSI 30-40"), (40, 50, "RSI 40-50"),
                           (50, 60, "RSI 50-60"), (60, 100, "RSI>60")]:
        bucket = [e for e in all_entries if e["rsi"] is not None and lo <= e["rsi"] < hi]
        if bucket:
            rets = [e["fwd_30_return"] for e in bucket]
            print(f"    {label:>10}: n={len(bucket):>3} | avg={np.mean(rets):+.1f}% | med={np.median(rets):+.1f}% | win={sum(1 for r in rets if r > 0)}/{len(bucket)}")

    # BB% buckets
    print("\n  Bollinger Band position at entry vs 30-day forward return:")
    for lo, hi, label in [(-1, 0, "Below LBB"), (0, 0.2, "BB% 0-0.2"), (0.2, 0.5, "BB% 0.2-0.5"),
                           (0.5, 0.8, "BB% 0.5-0.8"), (0.8, 2, "BB%>0.8")]:
        bucket = [e for e in all_entries if e["pct_b"] is not None and lo <= e["pct_b"] < hi]
        if bucket:
            rets = [e["fwd_30_return"] for e in bucket]
            print(f"    {label:>12}: n={len(bucket):>3} | avg={np.mean(rets):+.1f}% | med={np.median(rets):+.1f}% | win={sum(1 for r in rets if r > 0)}/{len(bucket)}")

    # Volume spike buckets
    print("\n  Volume spike at entry vs 30-day forward return:")
    for lo, hi, label in [(0, 0.8, "Low vol <0.8x"), (0.8, 1.2, "Normal 0.8-1.2x"),
                           (1.2, 1.5, "Elevated 1.2-1.5x"), (1.5, 100, "Spike >1.5x")]:
        bucket = [e for e in all_entries if e["vol_spike"] is not None and lo <= e["vol_spike"] < hi]
        if bucket:
            rets = [e["fwd_30_return"] for e in bucket]
            print(f"    {label:>18}: n={len(bucket):>3} | avg={np.mean(rets):+.1f}% | med={np.median(rets):+.1f}% | win={sum(1 for r in rets if r > 0)}/{len(bucket)}")

    # Momentum buckets
    print("\n  5-day momentum at entry vs 30-day forward return:")
    for lo, hi, label in [(-100, -5, "Mom<-5%"), (-5, 0, "Mom -5..0%"), (0, 5, "Mom 0..+5%"), (5, 100, "Mom>+5%")]:
        bucket = [e for e in all_entries if e["momentum"] is not None and lo <= e["momentum"] < hi]
        if bucket:
            rets = [e["fwd_30_return"] for e in bucket]
            print(f"    {label:>12}: n={len(bucket):>3} | avg={np.mean(rets):+.1f}% | med={np.median(rets):+.1f}% | win={sum(1 for r in rets if r > 0)}/{len(bucket)}")


# ── Main ──────────────────────────────────────────────────────────────

def main():
    print("=" * 80)
    print("VENUS RX BTD + TECHNICAL INDICATORS RESEARCH")
    print("=" * 80)
    print(f"Symbols: {', '.join(SYMBOLS)}")
    print(f"Timeframe: {TIMEFRAME} (aggregated to daily)")
    print(f"Rx end dates: {len(VENUS_RX_END_DATES)}")
    print(f"Window: D-{WINDOW_BEFORE} to D+{WINDOW_AFTER}")
    print(f"Forward return measured: {HOLD_DAYS} days")
    print()

    all_results = []

    for rx_date in VENUS_RX_END_DATES:
        for symbol in SYMBOLS:
            result = analyze_rx_end(rx_date, symbol)
            if result:
                all_results.append(result)

    if not all_results:
        print("\n[ERROR] No results collected. Exiting.")
        return

    print(f"\nCollected data for {len(all_results)} symbol/date combinations.\n")

    # 1. Print technical heatmap
    print_technical_heatmap(all_results)

    # 2. Find optimal conditions
    find_optimal_conditions(all_results)

    # 3. Strategy comparison
    run_strategy_comparison(all_results)

    # 4. Summary
    print("\n" + "=" * 80)
    print("SUMMARY & RECOMMENDATIONS")
    print("=" * 80)
    print("""
    This research compares "blind Day+7 entry" against technically-filtered entries
    after Venus Rx ends. Key questions answered:

    1. Does RSI < 40 at Day+7 improve returns? (filters out entries when momentum already recovered)
    2. Does price below lower Bollinger Band improve returns? (catches oversold bounces)
    3. Does a volume spike improve returns? (confirms capitulation/reversal)
    4. Does waiting for RSI < 40 within D+5..D+15 beat fixed Day+7?

    Look at the strategy comparison above for the answer with real data.
    """)


if __name__ == "__main__":
    main()
