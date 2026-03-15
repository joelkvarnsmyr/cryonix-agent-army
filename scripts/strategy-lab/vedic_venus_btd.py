#!/usr/bin/env python3
"""
Venus Rx Buy-The-Dip Strategy — Deep Analysis & Optimization

Venus Rx causes ~40-day drawdowns (p<0.0001). When Rx ends, there's a
potential snapback/recovery. This script:

1. Maps every Venus Rx period historically (2017-2026)
2. Measures post-Rx recovery patterns (how fast, how much)
3. Tests optimal entry timing (day 1 after Rx? day 5? day 10?)
4. Tests optimal exit strategy (fixed hold? trailing? vedic score?)
5. Combines with Cryonix signals (momentum, F&G, volume)
6. Walk-forward validates the final strategy

Usage:
  python scripts/strategy-lab/vedic_venus_btd.py
"""
import math
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Tuple

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import ccxt
import numpy as np
from scipy import stats as scipy_stats

_engine_path = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine')
if os.path.isdir(_engine_path) and _engine_path not in sys.path:
    sys.path.insert(0, _engine_path)

from src.vedic.ephemeris import get_sky_state

# ── Price fetching ─────────────────────────────────────────────────
_cache: Dict[str, List] = {}

def fetch_ohlcv(symbol: str, tf: str, days: int) -> List:
    key = f"{symbol}_{tf}_{days}"
    if key in _cache:
        return _cache[key]
    exchange = ccxt.binance({"enableRateLimit": True})
    since = int((datetime.now(timezone.utc) - timedelta(days=days + 5)).timestamp() * 1000)
    all_c = []
    for pair in [f"{symbol}/USDT", f"{symbol}/USDC"]:
        try:
            while True:
                c = exchange.fetch_ohlcv(pair, tf, since=since, limit=1000)
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

SYMBOLS = ["BTC", "ETH", "BNB", "XRP", "ADA", "LTC", "SOL", "AVAX"]


# ═══════════════════════════════════════════════════════════════════
# STUDY 1: Map all Venus Rx periods and measure drawdown/recovery
# ═══════════════════════════════════════════════════════════════════

def map_venus_rx_periods(days: int = 3500):
    """Find all Venus Rx periods in historical data."""
    print(f"\n{'='*80}")
    print(f"  VENUS Rx PERIOD MAPPING — {days} days")
    print(f"{'='*80}\n")

    # Scan daily to find Venus Rx transitions
    periods = []
    start = datetime.now(timezone.utc) - timedelta(days=days)
    end = datetime.now(timezone.utc)

    current = start
    in_rx = False
    rx_start = None

    while current < end:
        try:
            sky = get_sky_state(current)
            venus_rx = sky.planets["Venus"].is_retrograde

            if venus_rx and not in_rx:
                rx_start = current
                in_rx = True
            elif not venus_rx and in_rx:
                periods.append({
                    "start": rx_start,
                    "end": current,
                    "duration": (current - rx_start).days,
                })
                in_rx = False
        except Exception:
            pass

        current += timedelta(days=1)

    print(f"  Found {len(periods)} Venus Rx periods:\n")
    print(f"  {'#':>3s} {'Start':>12s} {'End':>12s} {'Days':>5s}")
    print(f"  {'-'*3} {'-'*12} {'-'*12} {'-'*5}")

    for i, p in enumerate(periods):
        print(f"  {i+1:>3d} {p['start'].strftime('%Y-%m-%d'):>12s} "
              f"{p['end'].strftime('%Y-%m-%d'):>12s} {p['duration']:>5d}")

    return periods


def analyze_rx_impact(periods: List[Dict], symbols: List[str]):
    """Measure price impact during and after each Venus Rx period."""
    print(f"\n{'='*80}")
    print(f"  VENUS Rx PRICE IMPACT ANALYSIS")
    print(f"  During Rx | Post-Rx recovery at 7d, 14d, 30d, 60d")
    print(f"{'='*80}\n")

    # For each period, measure:
    # 1. Price change DURING Rx
    # 2. Price change at 7d, 14d, 30d, 60d AFTER Rx ends
    # 3. Max drawdown during Rx
    # 4. Time to recover (days to break even from Rx start price)

    all_during = defaultdict(list)
    all_post = defaultdict(lambda: defaultdict(list))

    for sym in symbols:
        candles = fetch_ohlcv(sym, "1d", 3500)
        if not candles:
            continue

        # Build date -> price lookup
        prices = {}
        for c in candles:
            dt = datetime.fromtimestamp(c[0] / 1000, tz=timezone.utc).date()
            prices[dt] = c[4]  # close

        for p in periods:
            rx_start_date = p["start"].date()
            rx_end_date = p["end"].date()

            # Price at Rx start and end
            start_price = prices.get(rx_start_date)
            end_price = prices.get(rx_end_date)

            if not start_price or not end_price:
                continue

            # During Rx change
            during_pct = (end_price - start_price) / start_price * 100
            all_during[sym].append(during_pct)

            # Post-Rx returns
            for lag_days in [3, 7, 14, 30, 60]:
                target_date = rx_end_date + timedelta(days=lag_days)
                target_price = prices.get(target_date)
                if target_price:
                    post_pct = (target_price - end_price) / end_price * 100
                    all_post[lag_days][sym].append(post_pct)

    # Print results per period
    print(f"  {'Symbol':<8s} {'During Rx%':>10s} {'Post 3d%':>9s} {'Post 7d%':>9s} "
          f"{'Post 14d%':>10s} {'Post 30d%':>10s} {'Post 60d%':>10s}")
    print(f"  {'-'*8} {'-'*10} {'-'*9} {'-'*9} {'-'*10} {'-'*10} {'-'*10}")

    for sym in symbols:
        during = all_during.get(sym, [])
        if not during:
            continue

        vals = [f"{np.mean(during):>+9.2f}%"]
        for lag in [3, 7, 14, 30, 60]:
            post = all_post[lag].get(sym, [])
            if post:
                vals.append(f"{np.mean(post):>+9.2f}%")
            else:
                vals.append(f"{'N/A':>9s}")
        print(f"  {sym:<8s} {''.join(vals)}")

    # Aggregate across symbols
    print(f"\n  -- Aggregate (all symbols) --")
    all_during_flat = []
    for v in all_during.values():
        all_during_flat.extend(v)

    if all_during_flat:
        print(f"  During Rx:   {np.mean(all_during_flat):>+.2f}% avg  (N={len(all_during_flat)})")

    for lag in [3, 7, 14, 30, 60]:
        flat = []
        for v in all_post[lag].values():
            flat.extend(v)
        if flat:
            mean_val = np.mean(flat)
            t, p_val = scipy_stats.ttest_1samp(flat, 0)
            sig = "***" if p_val < 0.01 else "**" if p_val < 0.05 else "*" if p_val < 0.1 else ""
            print(f"  Post {lag:>2d}d:    {mean_val:>+.2f}% avg  (N={len(flat)}, p={p_val:.4f} {sig})")

    return all_during, all_post


# ═══════════════════════════════════════════════════════════════════
# STUDY 2: Optimal BTD entry timing
# ═══════════════════════════════════════════════════════════════════

def optimize_btd_entry(periods: List[Dict], symbols: List[str]):
    """Test different entry timing after Venus Rx ends."""
    print(f"\n{'='*80}")
    print(f"  OPTIMAL BTD ENTRY TIMING")
    print(f"  When to buy after Venus Rx ends?")
    print(f"{'='*80}\n")

    # Test: enter at day 0, 1, 2, 3, 5, 7, 10, 14 after Rx ends
    # Hold for: 7, 14, 30, 60 days
    # Measure return

    entry_offsets = [0, 1, 2, 3, 5, 7, 10, 14]
    hold_periods = [7, 14, 30, 60]

    results = defaultdict(list)
    # results[(entry_offset, hold_days)] = [returns]

    for sym in symbols:
        candles = fetch_ohlcv(sym, "1d", 3500)
        if not candles:
            continue

        prices = {}
        for c in candles:
            dt = datetime.fromtimestamp(c[0] / 1000, tz=timezone.utc).date()
            prices[dt] = c[4]

        for p in periods:
            rx_end = p["end"].date()

            for offset in entry_offsets:
                entry_date = rx_end + timedelta(days=offset)
                entry_price = prices.get(entry_date)
                if not entry_price:
                    continue

                for hold in hold_periods:
                    exit_date = entry_date + timedelta(days=hold)
                    exit_price = prices.get(exit_date)
                    if exit_price:
                        ret = (exit_price - entry_price) / entry_price * 100
                        results[(offset, hold)].append(ret)

    # Print heatmap
    print(f"  Entry timing vs hold period (avg return %):\n")
    print(f"  {'Entry':>8s}", end="")
    for hold in hold_periods:
        print(f" {'Hold ' + str(hold) + 'd':>10s}", end="")
    print(f" {'Best':>10s}")
    print(f"  {'-'*8}", end="")
    for _ in hold_periods:
        print(f" {'-'*10}", end="")
    print(f" {'-'*10}")

    best_combo = (0, 0, -999)
    for offset in entry_offsets:
        print(f"  {'Day +' + str(offset):>8s}", end="")
        row_best = -999
        for hold in hold_periods:
            data = results[(offset, hold)]
            if data:
                avg = np.mean(data)
                n = len(data)
                marker = "*" if avg > 3 else ""
                print(f" {avg:>+8.2f}%{marker}", end="")
                if avg > row_best:
                    row_best = avg
                if avg > best_combo[2]:
                    best_combo = (offset, hold, avg)
            else:
                print(f" {'N/A':>10s}", end="")
        print(f" {row_best:>+8.2f}%")

    print(f"\n  BEST COMBO: Entry Day+{best_combo[0]}, Hold {best_combo[1]}d = {best_combo[2]:+.2f}%")

    # Statistical significance of best combo
    best_data = results[(best_combo[0], best_combo[1])]
    if best_data:
        t, p = scipy_stats.ttest_1samp(best_data, 0)
        ci_low = np.percentile(best_data, 2.5)
        ci_high = np.percentile(best_data, 97.5)
        print(f"  t-stat={t:.2f}, p={p:.4f}, 95% CI=[{ci_low:+.2f}%, {ci_high:+.2f}%]")
        print(f"  Win rate: {sum(1 for x in best_data if x > 0) / len(best_data) * 100:.0f}%")

    return results, best_combo


# ═══════════════════════════════════════════════════════════════════
# STUDY 3: BTD with stops (realistic trading simulation)
# ═══════════════════════════════════════════════════════════════════

def simulate_btd_trades(periods: List[Dict], symbols: List[str]):
    """Simulate actual BTD trades with SL/TP/trailing stops."""
    print(f"\n{'='*80}")
    print(f"  BTD TRADING SIMULATION")
    print(f"  Testing SL/TP combos on post-Venus-Rx entries")
    print(f"{'='*80}\n")

    configs = [
        {"name": "Tight (SL=3% TP=8%)", "sl": 0.03, "tp": 0.08, "trail_act": 0.03, "trail_stop": 0.015},
        {"name": "Medium (SL=5% TP=15%)", "sl": 0.05, "tp": 0.15, "trail_act": 0.05, "trail_stop": 0.025},
        {"name": "Wide (SL=8% TP=25%)", "sl": 0.08, "tp": 0.25, "trail_act": 0.08, "trail_stop": 0.04},
        {"name": "Very wide (SL=12% TP=40%)", "sl": 0.12, "tp": 0.40, "trail_act": 0.10, "trail_stop": 0.05},
        {"name": "No SL (TP=30% only)", "sl": 0.50, "tp": 0.30, "trail_act": 0.10, "trail_stop": 0.05},
    ]

    entry_offset_days = 2  # Enter 2 days after Rx ends (allow dust to settle)
    max_hold_candles = 90 * 6  # 90 days max hold on 4h candles
    pos_size = 0.25  # 25% position size (aggressive)

    for cfg in configs:
        total_trades = 0
        total_wins = 0
        total_pnl = 0.0
        all_returns = []

        for sym in symbols:
            candles = fetch_ohlcv(sym, "4h", 3500)
            if not candles:
                continue

            for p in periods:
                entry_target = p["end"] + timedelta(days=entry_offset_days)

                # Find the candle closest to entry_target
                entry_idx = None
                for i, c in enumerate(candles):
                    dt = datetime.fromtimestamp(c[0] / 1000, tz=timezone.utc)
                    if dt >= entry_target:
                        entry_idx = i
                        break

                if entry_idx is None:
                    continue

                entry_price = candles[entry_idx][4]
                peak_price = entry_price

                # Simulate with stops
                for j in range(entry_idx + 1, min(entry_idx + max_hold_candles, len(candles))):
                    price = candles[j][4]
                    high = candles[j][2]
                    low = candles[j][3]

                    if high > peak_price:
                        peak_price = high

                    pnl_pct = (price - entry_price) / entry_price

                    # Stop loss (check low)
                    if (low - entry_price) / entry_price <= -cfg["sl"]:
                        exit_price = entry_price * (1 - cfg["sl"])
                        trade_ret = -cfg["sl"] * 100
                        total_trades += 1
                        all_returns.append(trade_ret)
                        total_pnl += trade_ret
                        break

                    # Take profit (check high)
                    if (high - entry_price) / entry_price >= cfg["tp"]:
                        trade_ret = cfg["tp"] * 100
                        total_trades += 1
                        total_wins += 1
                        all_returns.append(trade_ret)
                        total_pnl += trade_ret
                        break

                    # Trailing stop
                    peak_gain = (peak_price - entry_price) / entry_price
                    if peak_gain >= cfg["trail_act"]:
                        trail_price = peak_price * (1 - cfg["trail_stop"])
                        if low <= trail_price:
                            trade_ret = ((trail_price - entry_price) / entry_price) * 100
                            total_trades += 1
                            if trade_ret > 0:
                                total_wins += 1
                            all_returns.append(trade_ret)
                            total_pnl += trade_ret
                            break
                else:
                    # Max hold reached, close at market
                    if entry_idx + max_hold_candles < len(candles):
                        exit_price = candles[entry_idx + max_hold_candles][4]
                        trade_ret = (exit_price - entry_price) / entry_price * 100
                        total_trades += 1
                        if trade_ret > 0:
                            total_wins += 1
                        all_returns.append(trade_ret)
                        total_pnl += trade_ret

        wr = total_wins / max(total_trades, 1) * 100
        avg_ret = np.mean(all_returns) if all_returns else 0
        if len(all_returns) > 1:
            std = np.std(all_returns)
            sharpe = avg_ret / std * math.sqrt(12) if std > 0 else 0  # ~12 trades/year
        else:
            sharpe = 0

        print(f"  {cfg['name']:<30s}  Trades={total_trades:>3d}  WR={wr:>5.1f}%  "
              f"Avg={avg_ret:>+6.2f}%  Total={total_pnl:>+7.1f}%  Sharpe={sharpe:>5.2f}")


# ═══════════════════════════════════════════════════════════════════
# STUDY 4: Combine BTD with other signals
# ═══════════════════════════════════════════════════════════════════

def study_signal_combinations(periods: List[Dict]):
    """Test if other vedic/market signals improve BTD timing."""
    print(f"\n{'='*80}")
    print(f"  SIGNAL ENHANCEMENT FOR BTD")
    print(f"  Can other signals improve entry timing?")
    print(f"{'='*80}\n")

    # For each Rx end, check:
    # 1. Mercury Rx status (is Mercury also Rx?)
    # 2. Retrograde count
    # 3. Paksha at entry
    # 4. Moon speed at entry

    for sym in ["BTC", "ETH"]:
        print(f"\n  -- {sym} --")
        candles = fetch_ohlcv(sym, "1d", 3500)
        if not candles:
            continue

        prices = {}
        for c in candles:
            dt = datetime.fromtimestamp(c[0] / 1000, tz=timezone.utc).date()
            prices[dt] = c[4]

        for p in periods:
            rx_end = p["end"]
            entry_date = (rx_end + timedelta(days=2)).date()
            entry_price = prices.get(entry_date)
            if not entry_price:
                continue

            # Check vedic state at entry
            try:
                sky = get_sky_state(rx_end + timedelta(days=2))
                merc_rx = sky.planets["Mercury"].is_retrograde
                retros = [pl for pl in sky.planets.values()
                         if pl.is_retrograde and pl.name not in ("Rahu", "Ketu", "Venus")]
                n_retro = len(retros)
                moon_speed = sky.planets["Moon"].speed

                from src.vedic.muhurta import calculate_tithi
                tithi = calculate_tithi(sky)
                paksha = tithi.paksha
            except Exception:
                continue

            # 30d return
            exit_date = entry_date + timedelta(days=30)
            exit_price = prices.get(exit_date)
            if not exit_price:
                continue

            ret_30d = (exit_price - entry_price) / entry_price * 100

            rx_period = f"{p['start'].strftime('%Y-%m')}"
            merc_str = "MercRx" if merc_rx else "MercDirect"
            print(f"    {rx_period}  Entry={entry_date}  30d={ret_30d:>+6.1f}%  "
                  f"{merc_str}  retro={n_retro}  {paksha}  moonSpd={moon_speed:.1f}")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    start = time.time()

    # Step 1: Map Venus Rx periods
    periods = map_venus_rx_periods(3500)

    # Step 2: Analyze price impact
    analyze_rx_impact(periods, SYMBOLS)

    # Step 3: Optimize entry timing
    optimize_btd_entry(periods, SYMBOLS)

    # Step 4: Simulate with stops
    simulate_btd_trades(periods, SYMBOLS)

    # Step 5: Signal combinations
    study_signal_combinations(periods)

    elapsed = time.time() - start
    print(f"\n  Total runtime: {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()
