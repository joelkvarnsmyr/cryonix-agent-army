#!/usr/bin/env python3
"""
Venus Rx SHORT Signal Research
===============================
Venus Rx causes -18.73% avg drawdown across 6 historical periods (2017-2026).
Currently we just AVOID buying. Question: can we PROFIT by shorting?

Tests entry strategies (day 1, day 3, day 7) x exit strategies
(close at direct, fixed TP, trailing stop) across BTC, ETH, BNB, XRP, SOL, ADA.

IMPORTANT CAVEAT: Cryonix is SPOT ONLY. Shorting requires margin/futures.
This research determines if returns justify setting up a futures account.

Usage:
  python scripts/strategy-lab/vedic_venus_short.py
"""
import sys
import os
import time
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import ccxt
import numpy as np

# ── Venus Rx periods (approximate start -> end dates) ──────────────
# Each tuple: (rx_start, rx_end_direct)
# Venus Rx lasts ~40 days on average
VENUS_RX_PERIODS = [
    ("2017-03-04", "2017-04-15"),
    ("2018-10-05", "2018-11-16"),
    ("2020-05-13", "2020-06-25"),
    ("2021-12-19", "2022-01-29"),
    ("2023-07-23", "2023-09-04"),
    ("2025-03-02", "2025-04-13"),
]

SYMBOLS = ["BTC", "ETH", "BNB", "XRP", "SOL", "ADA"]
FETCH_DAYS = 3500

# ── Price fetching ─────────────────────────────────────────────────
_cache: Dict[str, List] = {}


def fetch_ohlcv(symbol: str, days: int = FETCH_DAYS) -> List:
    """Fetch daily OHLCV from Binance. Returns list of [ts_ms, O, H, L, C, V]."""
    key = f"{symbol}_1d_{days}"
    if key in _cache:
        return _cache[key]

    exchange = ccxt.binance({"enableRateLimit": True})
    since = int((datetime.now(timezone.utc) - timedelta(days=days + 5)).timestamp() * 1000)
    all_c = []

    for pair in [f"{symbol}/USDT", f"{symbol}/USDC"]:
        try:
            fetch_since = since
            while True:
                c = exchange.fetch_ohlcv(pair, "1d", since=fetch_since, limit=1000)
                if not c:
                    break
                all_c.extend(c)
                fetch_since = c[-1][0] + 1
                if len(c) < 1000:
                    break
                time.sleep(0.2)
            if all_c:
                break
        except Exception:
            continue

    if not all_c:
        print(f"  [WARN] No data for {symbol}")
        return []

    # Deduplicate by timestamp
    seen = set()
    deduped = []
    for c in all_c:
        if c[0] not in seen:
            seen.add(c[0])
            deduped.append(c)
    deduped.sort(key=lambda x: x[0])
    _cache[key] = deduped
    return deduped


def get_price_at_date(candles: List, target_date: str, offset_days: int = 0) -> Optional[float]:
    """Get closing price at target_date + offset_days."""
    target = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    target += timedelta(days=offset_days)
    target_ms = int(target.timestamp() * 1000)

    # Find closest candle within 2 days
    best = None
    best_dist = float("inf")
    for c in candles:
        dist = abs(c[0] - target_ms)
        if dist < best_dist:
            best_dist = dist
            best = c
    if best and best_dist < 3 * 86400 * 1000:
        return best[4]  # close price
    return None


def get_prices_in_range(candles: List, start_date: str, end_date: str, start_offset: int = 0) -> List[Tuple[int, float]]:
    """Get all daily close prices in [start+offset, end] range."""
    start = datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=start_offset)
    end = datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)
    return [(c[0], c[4]) for c in candles if start_ms <= c[0] <= end_ms]


def get_max_adverse_in_range(candles: List, start_date: str, end_date: str, start_offset: int = 0) -> float:
    """Get max price increase (adverse for short) in range as pct of entry."""
    prices = get_prices_in_range(candles, start_date, end_date, start_offset)
    if len(prices) < 2:
        return 0.0
    entry = prices[0][1]
    max_price = max(p[1] for p in prices)
    return (max_price - entry) / entry * 100


# ── Trade simulation ───────────────────────────────────────────────

def simulate_short_close_at_direct(candles: List, rx_start: str, rx_end: str, entry_delay: int) -> Optional[Dict]:
    """Enter short at rx_start + entry_delay days, close when Venus goes direct."""
    entry_price = get_price_at_date(candles, rx_start, entry_delay)
    exit_price = get_price_at_date(candles, rx_end, 0)
    if not entry_price or not exit_price:
        return None
    pnl_pct = (entry_price - exit_price) / entry_price * 100
    max_adverse = get_max_adverse_in_range(candles, rx_start, rx_end, entry_delay)
    return {
        "entry_price": entry_price,
        "exit_price": exit_price,
        "pnl_pct": pnl_pct,
        "max_adverse_pct": max_adverse,
        "hold_days": (datetime.strptime(rx_end, "%Y-%m-%d") -
                      datetime.strptime(rx_start, "%Y-%m-%d")).days - entry_delay,
    }


def simulate_short_fixed_tp(candles: List, rx_start: str, rx_end: str, entry_delay: int, tp_pct: float) -> Optional[Dict]:
    """Enter short, close at fixed TP% or at Rx end (whichever first)."""
    entry_price = get_price_at_date(candles, rx_start, entry_delay)
    if not entry_price:
        return None
    prices = get_prices_in_range(candles, rx_start, rx_end, entry_delay)
    if len(prices) < 2:
        return None

    target_price = entry_price * (1 - tp_pct / 100)
    max_adverse = 0.0

    for ts, price in prices[1:]:
        adverse = (price - entry_price) / entry_price * 100
        max_adverse = max(max_adverse, adverse)
        if price <= target_price:
            pnl_pct = tp_pct
            days_held = (ts - prices[0][0]) / (86400 * 1000)
            return {
                "entry_price": entry_price,
                "exit_price": price,
                "pnl_pct": pnl_pct,
                "max_adverse_pct": max_adverse,
                "hold_days": int(days_held),
                "hit_tp": True,
            }

    # TP not hit, close at Rx end
    exit_price = prices[-1][1]
    pnl_pct = (entry_price - exit_price) / entry_price * 100
    return {
        "entry_price": entry_price,
        "exit_price": exit_price,
        "pnl_pct": pnl_pct,
        "max_adverse_pct": max_adverse,
        "hold_days": (datetime.strptime(rx_end, "%Y-%m-%d") -
                      datetime.strptime(rx_start, "%Y-%m-%d")).days - entry_delay,
        "hit_tp": False,
    }


def simulate_short_trailing(candles: List, rx_start: str, rx_end: str, entry_delay: int,
                            activate_pct: float = 5.0, trail_pct: float = 3.0) -> Optional[Dict]:
    """Enter short, trailing stop: activate at +activate_pct, trail at -trail_pct from best."""
    entry_price = get_price_at_date(candles, rx_start, entry_delay)
    if not entry_price:
        return None
    prices = get_prices_in_range(candles, rx_start, rx_end, entry_delay)
    if len(prices) < 2:
        return None

    best_gain = 0.0  # Best unrealized short gain (%)
    trailing_active = False
    max_adverse = 0.0

    for ts, price in prices[1:]:
        short_gain = (entry_price - price) / entry_price * 100
        adverse = (price - entry_price) / entry_price * 100
        max_adverse = max(max_adverse, adverse)

        if short_gain > best_gain:
            best_gain = short_gain

        if best_gain >= activate_pct:
            trailing_active = True

        if trailing_active:
            drawback = best_gain - short_gain
            if drawback >= trail_pct:
                pnl_pct = short_gain
                days_held = (ts - prices[0][0]) / (86400 * 1000)
                return {
                    "entry_price": entry_price,
                    "exit_price": price,
                    "pnl_pct": pnl_pct,
                    "max_adverse_pct": max_adverse,
                    "hold_days": int(days_held),
                    "trailing_triggered": True,
                    "best_unrealized": best_gain,
                }

    # Trailing not triggered, close at Rx end
    exit_price = prices[-1][1]
    pnl_pct = (entry_price - exit_price) / entry_price * 100
    return {
        "entry_price": entry_price,
        "exit_price": exit_price,
        "pnl_pct": pnl_pct,
        "max_adverse_pct": max_adverse,
        "hold_days": (datetime.strptime(rx_end, "%Y-%m-%d") -
                      datetime.strptime(rx_start, "%Y-%m-%d")).days - entry_delay,
        "trailing_triggered": False,
        "best_unrealized": best_gain,
    }


# ── Metrics ────────────────────────────────────────────────────────

def compute_metrics(trades: List[Dict]) -> Dict:
    """Compute summary metrics from a list of trades."""
    if not trades:
        return {"n": 0, "total_return": 0, "win_rate": 0, "avg_return": 0, "sharpe": 0, "max_adverse": 0}
    returns = [t["pnl_pct"] for t in trades]
    wins = [r for r in returns if r > 0]
    arr = np.array(returns)
    sharpe = (arr.mean() / arr.std()) * np.sqrt(len(returns)) if arr.std() > 0 else 0
    return {
        "n": len(trades),
        "total_return": sum(returns),
        "win_rate": len(wins) / len(returns) * 100,
        "avg_return": np.mean(returns),
        "median_return": np.median(returns),
        "sharpe": sharpe,
        "max_adverse": max(t.get("max_adverse_pct", 0) for t in trades),
        "best": max(returns),
        "worst": min(returns),
    }


# ── Main ───────────────────────────────────────────────────────────

def main():
    print("=" * 80)
    print("  VENUS Rx SHORT SIGNAL RESEARCH")
    print("  Can we profit from the -18.73% avg drawdown by shorting?")
    print("=" * 80)
    print()

    # Fetch all data first
    print("[1/3] Fetching daily OHLCV data from Binance...")
    symbol_candles: Dict[str, List] = {}
    for sym in SYMBOLS:
        candles = fetch_ohlcv(sym)
        symbol_candles[sym] = candles
        print(f"  {sym}: {len(candles)} daily candles")
    print()

    # ── Run all strategy combinations ──────────────────────────────
    entry_delays = {"Day 1": 0, "Day 3": 2, "Day 7": 6}

    exit_strategies = {
        "Close at Direct": lambda c, s, e, d: simulate_short_close_at_direct(c, s, e, d),
        "TP 10%": lambda c, s, e, d: simulate_short_fixed_tp(c, s, e, d, 10),
        "TP 15%": lambda c, s, e, d: simulate_short_fixed_tp(c, s, e, d, 15),
        "TP 20%": lambda c, s, e, d: simulate_short_fixed_tp(c, s, e, d, 20),
        "Trail 5/3": lambda c, s, e, d: simulate_short_trailing(c, s, e, d, 5, 3),
    }

    print("[2/3] Simulating short trades across all combos...")
    print(f"  {len(entry_delays)} entries x {len(exit_strategies)} exits x {len(SYMBOLS)} symbols x {len(VENUS_RX_PERIODS)} periods")
    print()

    # Store results: results[entry_name][exit_name] = list of trades
    results: Dict[str, Dict[str, List[Dict]]] = defaultdict(lambda: defaultdict(list))
    # Per-symbol results
    symbol_results: Dict[str, Dict[str, Dict[str, List[Dict]]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(list))
    )

    for sym in SYMBOLS:
        candles = symbol_candles[sym]
        if not candles:
            continue
        for rx_start, rx_end in VENUS_RX_PERIODS:
            for entry_name, delay in entry_delays.items():
                for exit_name, sim_fn in exit_strategies.items():
                    trade = sim_fn(candles, rx_start, rx_end, delay)
                    if trade:
                        trade["symbol"] = sym
                        trade["period"] = f"{rx_start}"
                        results[entry_name][exit_name].append(trade)
                        symbol_results[sym][entry_name][exit_name].append(trade)

    # ── Display results ────────────────────────────────────────────
    print("[3/3] Results")
    print()

    # Overview table
    print("=" * 80)
    print("  STRATEGY MATRIX: All Symbols Combined")
    print("=" * 80)
    print()
    print(f"{'Entry':<10} {'Exit':<18} {'N':>4} {'TotRet%':>8} {'WinR%':>7} {'AvgRet%':>8} {'MedRet%':>8} {'Sharpe':>7} {'MaxAdv%':>8} {'Best%':>7} {'Worst%':>7}")
    print("-" * 105)

    best_combo = None
    best_sharpe = -999

    for entry_name in entry_delays:
        for exit_name in exit_strategies:
            trades = results[entry_name][exit_name]
            m = compute_metrics(trades)
            if m["n"] == 0:
                continue
            print(f"{entry_name:<10} {exit_name:<18} {m['n']:>4} {m['total_return']:>8.1f} {m['win_rate']:>7.1f} {m['avg_return']:>8.2f} {m['median_return']:>8.2f} {m['sharpe']:>7.2f} {m['max_adverse']:>8.1f} {m['best']:>7.1f} {m['worst']:>7.1f}")
            if m["sharpe"] > best_sharpe and m["n"] >= 5:
                best_sharpe = m["sharpe"]
                best_combo = (entry_name, exit_name, m)

    print()

    # Per-symbol breakdown for best combo
    if best_combo:
        be, bx, bm = best_combo
        print("=" * 80)
        print(f"  BEST COMBO: {be} + {bx}")
        print(f"  Sharpe={bm['sharpe']:.2f}, WinRate={bm['win_rate']:.1f}%, AvgReturn={bm['avg_return']:.2f}%")
        print("=" * 80)
        print()

        # Per-symbol for best combo
        print(f"{'Symbol':<8} {'N':>4} {'TotRet%':>8} {'WinR%':>7} {'AvgRet%':>8} {'Sharpe':>7}")
        print("-" * 45)
        for sym in SYMBOLS:
            trades = symbol_results[sym][be][bx]
            m = compute_metrics(trades)
            if m["n"] == 0:
                continue
            print(f"{sym:<8} {m['n']:>4} {m['total_return']:>8.1f} {m['win_rate']:>7.1f} {m['avg_return']:>8.2f} {m['sharpe']:>7.2f}")
        print()

    # Per-period breakdown (all symbols, best combo)
    if best_combo:
        be, bx, _ = best_combo
        print(f"  Per-Period Breakdown ({be} + {bx}):")
        print(f"  {'Period':<14} {'N':>4} {'AvgRet%':>8} {'WinR%':>7}")
        print("  " + "-" * 38)
        for rx_start, rx_end in VENUS_RX_PERIODS:
            period_trades = [t for t in results[be][bx] if t["period"] == rx_start]
            if not period_trades:
                print(f"  {rx_start:<14} {'--':>4} {'--':>8} {'--':>7}")
                continue
            rets = [t["pnl_pct"] for t in period_trades]
            wins = [r for r in rets if r > 0]
            print(f"  {rx_start:<14} {len(rets):>4} {np.mean(rets):>8.2f} {len(wins)/len(rets)*100:>7.1f}")
        print()

    # Detailed trade log for best combo
    if best_combo:
        be, bx, _ = best_combo
        print("  Detailed Trade Log:")
        print(f"  {'Period':<12} {'Symbol':<6} {'Entry$':>10} {'Exit$':>10} {'PnL%':>8} {'MaxAdv%':>8} {'Days':>5}")
        print("  " + "-" * 65)
        for t in sorted(results[be][bx], key=lambda x: x["period"]):
            print(f"  {t['period']:<12} {t['symbol']:<6} {t['entry_price']:>10.2f} {t['exit_price']:>10.2f} {t['pnl_pct']:>8.2f} {t['max_adverse_pct']:>8.2f} {t['hold_days']:>5}")
        print()

    # ── Feasibility analysis ───────────────────────────────────────
    print("=" * 80)
    print("  FEASIBILITY ANALYSIS: SPOT-ONLY vs FUTURES")
    print("=" * 80)
    print()

    if best_combo:
        be, bx, bm = best_combo
        n_periods = len(VENUS_RX_PERIODS)
        avg_per_period = bm["total_return"] / n_periods if n_periods > 0 else 0
        trades_per_year = n_periods / 9 * len(SYMBOLS)  # ~6 periods over 9 years

        print(f"  Best strategy: {be} + {bx}")
        print(f"  Total return across all trades: {bm['total_return']:.1f}%")
        print(f"  Average return per trade: {bm['avg_return']:.2f}%")
        print(f"  Win rate: {bm['win_rate']:.1f}%")
        print(f"  Sharpe ratio: {bm['sharpe']:.2f}")
        print(f"  Max adverse excursion: {bm['max_adverse']:.1f}%")
        print(f"  Trades per Rx period: ~{len(SYMBOLS)} (one per symbol)")
        print(f"  Rx periods per year: ~{n_periods/9:.1f}")
        print()

        # Cost analysis
        funding_rate_daily = 0.03  # ~0.03%/day typical
        avg_hold_days = np.mean([t["hold_days"] for t in results[be][bx]])
        funding_cost = funding_rate_daily * avg_hold_days
        trading_fee = 0.08  # maker+taker round trip on futures

        print(f"  Cost estimates (futures):")
        print(f"    Avg hold: {avg_hold_days:.0f} days")
        print(f"    Funding rate cost: ~{funding_cost:.2f}% ({funding_rate_daily}%/day x {avg_hold_days:.0f}d)")
        print(f"    Trading fees (round trip): ~{trading_fee}%")
        print(f"    Total cost per trade: ~{funding_cost + trading_fee:.2f}%")
        print(f"    Net avg return after costs: {bm['avg_return'] - funding_cost - trading_fee:.2f}%")
        print()

        net_return = bm["avg_return"] - funding_cost - trading_fee
        if net_return > 3.0 and bm["win_rate"] > 60:
            verdict = "STRONG YES - Returns justify futures account setup"
        elif net_return > 1.0 and bm["win_rate"] > 50:
            verdict = "MARGINAL - Modest edge, consider if combined with other strategies"
        elif net_return > 0:
            verdict = "WEAK - Positive but thin edge, not worth complexity alone"
        else:
            verdict = "NO - Returns do not justify futures after costs"

        print(f"  VERDICT: {verdict}")
        print()

        # Alternative: inverse ETFs / put options note
        print("  Alternatives to futures:")
        print("    - Binance Margin (spot short): 3x max, higher fees")
        print("    - Binance Futures: up to 125x leverage (1x recommended for this)")
        print("    - Simply AVOID buying during Rx (current strategy) - zero cost/risk")
        print("    - Reduce position size during Rx (partial avoidance)")
        print()

    # ── Raw comparison: avoid vs short ─────────────────────────────
    print("=" * 80)
    print("  COMPARISON: AVOID (current) vs SHORT (proposed)")
    print("=" * 80)
    print()
    print("  AVOID strategy (no cost, no risk):")
    print("    - Saves -18.73% avg drawdown exposure per Rx period")
    print("    - Zero fees, zero margin risk, zero liquidation risk")
    print("    - Already implemented in production")
    print()
    if best_combo:
        be, bx, bm = best_combo
        print(f"  SHORT strategy ({be} + {bx}):")
        print(f"    - Avg return: {bm['avg_return']:.2f}% per trade")
        print(f"    - Requires: Binance Futures account + margin")
        print(f"    - Risk: max adverse excursion {bm['max_adverse']:.1f}%")
        print(f"    - Complexity: new execution path, liquidation management")
        print(f"    - Frequency: ~{len(SYMBOLS)} trades every ~18 months")
    print()
    print("=" * 80)
    print("  RESEARCH COMPLETE")
    print("=" * 80)


if __name__ == "__main__":
    main()
