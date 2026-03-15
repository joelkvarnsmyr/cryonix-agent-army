#!/usr/bin/env python3
"""
Vedic V3 Optimization — Find best entry/exit rules

Tests:
  1. Pure Venus Rx avoidance (how much edge comes from this alone?)
  2. Different SL/TP levels
  3. Position sizing
  4. Multi-signal combinations
  5. Holding period optimization
  6. Buy-the-dip during Venus Rx end (contrarian)
"""
import math
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Dict, List

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import ccxt
import numpy as np

_engine_path = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine')
if os.path.isdir(_engine_path) and _engine_path not in sys.path:
    sys.path.insert(0, _engine_path)

from src.vedic.ephemeris import get_sky_state
from src.vedic.aspects import detect_retrogrades
from src.vedic.muhurta import calculate_tithi

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


SYMBOLS = ["BTC", "ETH", "BNB", "XRP", "ADA", "LTC"]


def run_strategy(symbols, days, strategy_fn, split=0.0, capital=1000.0,
                 sl_pct=0.05, tp_pct=0.12, trail_act=0.04, trail_stop=0.02,
                 pos_size=0.15):
    """Generic strategy runner."""
    results = []

    for sym in symbols:
        candles = fetch_ohlcv(sym, "4h", days)
        if len(candles) < 100:
            continue
        if split > 0:
            candles = candles[int(len(candles) * split):]

        balance = capital
        position = None
        trades = 0
        wins = 0
        returns_list = []
        peak_balance = capital
        max_dd = 0.0
        prev_venus_rx = False
        merc_rx_day = 0
        prev_merc_rx = False
        venus_rx_end_count = 0

        for i, candle in enumerate(candles):
            ts_ms, o, h, l, c, v = candle
            dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
            price = c

            try:
                sky = get_sky_state(dt)
                venus_rx = sky.planets["Venus"].is_retrograde
                merc_rx = sky.planets["Mercury"].is_retrograde
                moon_speed = sky.planets["Moon"].speed
                tithi = calculate_tithi(sky)
                retros = [p for p in sky.planets.values()
                         if p.is_retrograde and p.name not in ("Rahu", "Ketu")]
                n_retro = len(retros)

                # Track transitions
                if merc_rx:
                    if not prev_merc_rx:
                        merc_rx_day = 1
                    else:
                        merc_rx_day += 1
                else:
                    merc_rx_day = 0

                if prev_venus_rx and not venus_rx:
                    venus_rx_end_count = 1
                elif venus_rx_end_count > 0 and venus_rx_end_count < 15:
                    venus_rx_end_count += 1
                elif venus_rx_end_count >= 15:
                    venus_rx_end_count = 0

                prev_merc_rx = merc_rx
                prev_venus_rx = venus_rx

                ctx = {
                    "venus_rx": venus_rx,
                    "merc_rx": merc_rx,
                    "moon_speed": moon_speed,
                    "n_retro": n_retro,
                    "paksha": tithi.paksha,
                    "tithi_number": tithi.number,
                    "merc_rx_day": merc_rx_day,
                    "venus_rx_end_count": venus_rx_end_count,
                    "is_full_moon": tithi.is_full_moon,
                }
            except Exception:
                continue

            buy_signal, sell_signal = strategy_fn(ctx, position is not None,
                                                   (price - position["entry"]) / position["entry"] if position else 0)

            if position is None:
                if buy_signal:
                    size = balance * pos_size
                    if size >= 5:
                        qty = size / price
                        balance -= size
                        position = {"entry": price, "qty": qty, "peak": price, "entry_time": dt}
            else:
                pnl_pct = (price - position["entry"]) / position["entry"]
                if price > position["peak"]:
                    position["peak"] = price

                sell = False
                if pnl_pct <= -sl_pct:
                    sell = True
                if not sell and pnl_pct >= tp_pct:
                    sell = True
                if not sell:
                    peak_gain = (position["peak"] - position["entry"]) / position["entry"]
                    if peak_gain >= trail_act and price <= position["peak"] * (1 - trail_stop):
                        sell = True
                if not sell and sell_signal:
                    sell = True

                if sell:
                    sell_val = position["qty"] * price
                    trade_pnl = sell_val - (position["qty"] * position["entry"])
                    balance += sell_val
                    trades += 1
                    if trade_pnl > 0:
                        wins += 1
                    returns_list.append(pnl_pct * 100)
                    position = None

            val = balance + (position["qty"] * price if position else 0)
            if val > peak_balance:
                peak_balance = val
            dd = (peak_balance - val) / peak_balance * 100
            if dd > max_dd:
                max_dd = dd

        if position and candles:
            last_p = candles[-1][4]
            sell_val = position["qty"] * last_p
            pnl = sell_val - (position["qty"] * position["entry"])
            balance += sell_val
            trades += 1
            if pnl > 0:
                wins += 1
            returns_list.append((last_p - position["entry"]) / position["entry"] * 100)

        total_return = (balance / capital - 1) * 100
        wr = wins / max(trades, 1) * 100
        if len(returns_list) > 1:
            std = np.std(returns_list)
            sharpe = np.mean(returns_list) / std * math.sqrt(252) if std > 0 else 0
        else:
            sharpe = 0

        results.append({
            "symbol": sym,
            "return_pct": round(total_return, 2),
            "win_rate": round(wr, 1),
            "trades": trades,
            "max_dd": round(max_dd, 2),
            "sharpe": round(sharpe, 2),
        })

    return results


def print_results(name, results, show_per_symbol=True):
    """Print strategy results."""
    if not results:
        print(f"  {name}: No results")
        return

    avg_ret = np.mean([r["return_pct"] for r in results])
    avg_wr = np.mean([r["win_rate"] for r in results])
    total_trades = sum(r["trades"] for r in results)
    avg_dd = np.mean([r["max_dd"] for r in results])
    avg_sharpe = np.mean([r["sharpe"] for r in results])
    positive = sum(1 for r in results if r["return_pct"] > 0)

    print(f"  {name:<45s} {avg_ret:>+7.1f}% {avg_wr:>5.1f}% {total_trades:>5d} {avg_dd:>5.1f}% "
          f"{avg_sharpe:>6.2f} {positive}/{len(results)}")

    if show_per_symbol:
        for r in sorted(results, key=lambda x: x["return_pct"], reverse=True):
            print(f"    {r['symbol']:<6s} {r['return_pct']:>+7.1f}% WR={r['win_rate']:.0f}% "
                  f"T={r['trades']} DD={r['max_dd']:.1f}%")


def main():
    days = 2000
    start = time.time()

    print(f"\n{'='*90}")
    print(f"  VEDIC V3 OPTIMIZATION — {days} days")
    print(f"{'='*90}")
    print(f"\n  {'Strategy':<45s} {'Ret%':>7s} {'WR%':>5s} {'Tr':>5s} {'DD%':>5s} {'Sharpe':>6s} {'Win':>4s}")
    print(f"  {'-'*45} {'-'*7} {'-'*5} {'-'*5} {'-'*5} {'-'*6} {'-'*4}")

    # 1. Buy-and-Hold Baseline
    def bah_strategy(ctx, in_pos, pnl):
        return (not in_pos, False)  # Buy once, never sell on signal
    bah = run_strategy(SYMBOLS, days, bah_strategy, sl_pct=1.0, tp_pct=100.0)
    print_results("BUY_AND_HOLD (baseline)", bah, False)

    # 2. Pure Venus Rx Avoidance
    def venus_avoid(ctx, in_pos, pnl):
        buy = not ctx["venus_rx"]  # Buy when Venus is direct
        sell = ctx["venus_rx"] and pnl > -0.01  # Sell when Venus goes Rx
        return (buy and not in_pos, sell and in_pos)
    va = run_strategy(SYMBOLS, days, venus_avoid)
    print_results("VENUS_RX_AVOID (pure)", va, False)

    # 3. Venus Rx + Low Retro Count
    def venus_retro(ctx, in_pos, pnl):
        buy = not ctx["venus_rx"] and ctx["n_retro"] <= 1
        sell = (ctx["venus_rx"] and pnl > -0.01) or (ctx["n_retro"] >= 3 and pnl > 0.01)
        return (buy and not in_pos, sell and in_pos)
    vr = run_strategy(SYMBOLS, days, venus_retro)
    print_results("VENUS_RX + LOW_RETRO", vr, False)

    # 4. Venus Rx + Mercury Rx Phase
    def venus_merc(ctx, in_pos, pnl):
        buy = not ctx["venus_rx"] and not (ctx["merc_rx"] and ctx["merc_rx_day"] > 15)
        sell = ctx["venus_rx"] and pnl > -0.01
        return (buy and not in_pos, sell and in_pos)
    vm = run_strategy(SYMBOLS, days, venus_merc)
    print_results("VENUS_RX + MERC_RX_LATE", vm, False)

    # 5. V3 Full (current model)
    def v3_full(ctx, in_pos, pnl):
        # Compute simplified V3 score
        if ctx["venus_rx"]:
            score = -80
        else:
            merc = 0.1 if not ctx["merc_rx"] else (0.3 if ctx["merc_rx_day"] <= 5 else -0.6 if ctx["merc_rx_day"] >= 16 else -0.2)
            retro = 0.6 if ctx["n_retro"] == 0 else 0.2 if ctx["n_retro"] == 1 else 0 if ctx["n_retro"] == 2 else -0.5
            paksha = 0.3 if (ctx["paksha"] == "Shukla" and ctx["tithi_number"] <= 10) else -0.3 if (ctx["paksha"] == "Krishna" and ctx["tithi_number"] <= 22) else 0
            score = int((merc * 0.35 + retro * 0.30 + paksha * 0.15) * 100)

        buy = score >= 10
        sell = (ctx["venus_rx"] and pnl > 0) or (score <= -25 and pnl > 0)
        return (buy and not in_pos, sell and in_pos)
    v3 = run_strategy(SYMBOLS, days, v3_full)
    print_results("V3_FULL (current)", v3, False)

    # 6. Venus Rx Buy-The-Dip (contrarian: buy when Venus Rx ends)
    def venus_btd(ctx, in_pos, pnl):
        # Buy within 10 candles (40h) of Venus Rx ending
        buy = 1 <= ctx["venus_rx_end_count"] <= 10 and not ctx["venus_rx"]
        sell = False  # Only SL/TP/trailing
        return (buy and not in_pos, sell)
    btd = run_strategy(SYMBOLS, days, venus_btd, pos_size=0.25)
    print_results("VENUS_RX_BUY_THE_DIP (contrarian)", btd, False)

    # 7. Combined: Avoid Venus Rx + Buy-the-Dip after
    def venus_combined(ctx, in_pos, pnl):
        # Normal: buy when not Venus Rx and low retro
        # Aggressive: buy after Venus Rx ends (double size handled separately)
        venus_ending = 1 <= ctx["venus_rx_end_count"] <= 10
        buy = (not ctx["venus_rx"] and ctx["n_retro"] <= 2) or venus_ending
        sell = ctx["venus_rx"] and pnl > -0.01
        return (buy and not in_pos, sell and in_pos)
    vc = run_strategy(SYMBOLS, days, venus_combined)
    print_results("VENUS_COMBINED (avoid + BTD)", vc, False)

    # 8. Test SL/TP variations with Venus Rx strategy
    print(f"\n  -- SL/TP Optimization (Venus Rx Avoid) --")
    print(f"  {'Config':<45s} {'Ret%':>7s} {'WR%':>5s} {'Tr':>5s} {'DD%':>5s}")
    print(f"  {'-'*45} {'-'*7} {'-'*5} {'-'*5} {'-'*5}")

    for sl, tp, ta, ts in [
        (0.03, 0.08, 0.03, 0.015),
        (0.04, 0.10, 0.03, 0.015),
        (0.05, 0.12, 0.04, 0.02),
        (0.06, 0.15, 0.05, 0.025),
        (0.08, 0.20, 0.06, 0.03),
        (0.10, 0.25, 0.08, 0.04),
    ]:
        r = run_strategy(SYMBOLS, days, venus_avoid, sl_pct=sl, tp_pct=tp,
                        trail_act=ta, trail_stop=ts)
        avg_ret = np.mean([x["return_pct"] for x in r])
        avg_wr = np.mean([x["win_rate"] for x in r])
        total_tr = sum(x["trades"] for x in r)
        avg_dd = np.mean([x["max_dd"] for x in r])
        label = f"SL={sl*100:.0f}% TP={tp*100:.0f}% Trail={ta*100:.0f}/{ts*100:.1f}%"
        print(f"  {label:<45s} {avg_ret:>+7.1f}% {avg_wr:>5.1f}% {total_tr:>5d} {avg_dd:>5.1f}%")

    # 9. Position Size testing
    print(f"\n  -- Position Size Optimization (Venus Rx Avoid, SL=5% TP=12%) --")
    for ps in [0.05, 0.10, 0.15, 0.20, 0.30, 0.50]:
        r = run_strategy(SYMBOLS, days, venus_avoid, pos_size=ps)
        avg_ret = np.mean([x["return_pct"] for x in r])
        avg_dd = np.mean([x["max_dd"] for x in r])
        label = f"Position Size = {ps*100:.0f}%"
        print(f"  {label:<45s} {avg_ret:>+7.1f}%  MaxDD={avg_dd:.1f}%")

    # ── Best strategy per-symbol breakdown ──
    print(f"\n  {'='*70}")
    print(f"  BEST STRATEGY PER-SYMBOL BREAKDOWN")
    print(f"  {'='*70}")

    # Full period
    print(f"\n  -- Full Period ({days} days) --")
    best_full = run_strategy(SYMBOLS, days, venus_avoid)
    print_results("VENUS_RX_AVOID", best_full, True)

    # OOS
    print(f"\n  -- Out-of-Sample (last 30%) --")
    best_oos = run_strategy(SYMBOLS, days, venus_avoid, split=0.7)
    print_results("VENUS_RX_AVOID OOS", best_oos, True)

    elapsed = time.time() - start
    print(f"\n  Total runtime: {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()
