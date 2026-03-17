#!/usr/bin/env python3
"""
Astronomical Signal Regime Testing + New Combined Model

Phase 1: Regime-test all 6 new signals from astro_research.py
  - Jupiter-Saturn conjunction (p<0.0001)
  - Mars-Rahu conjunction (p=0.006)
  - Mercury-Venus conjunction (p=0.0001, bearish)
  - Mercury speed (p<0.0001)
  - Venus speed (p=0.0006)
  - Planetary spread/clustering (p=0.004)
  + Venus Rx (already validated)

Phase 2: Build combined astronomical model (V4)
Phase 3: Walk-forward validate V4
Phase 4: Backtest V4 as trading strategy

Usage:
  python scripts/strategy-lab/astro_regime_test.py
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

from src.vedic.ephemeris import get_sky_state, get_angular_distance

_cache: Dict[str, List] = {}
SYMBOLS = ["BTC", "ETH", "BNB", "XRP", "ADA", "LTC"]

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
                if not c: break
                all_c.extend(c)
                since = c[-1][0] + 1
                if len(c) < 1000: break
            if all_c: break
        except Exception: continue
    _cache[key] = all_c
    return all_c

def classify_regime(mom: float) -> str:
    if mom > 10: return "strong_bull"
    elif mom > 2: return "mild_bull"
    elif mom > -2: return "sideways"
    elif mom > -10: return "mild_bear"
    else: return "strong_bear"


def extract_astro_signals(dt: datetime) -> Dict:
    """Extract all astronomical signals for a moment."""
    sky = get_sky_state(dt)
    p = sky.planets

    # 1. Venus Rx
    venus_rx = p["Venus"].is_retrograde

    # 2. Jupiter-Saturn distance
    jup_sat = get_angular_distance(p["Jupiter"].longitude, p["Saturn"].longitude)

    # 3. Mars-Rahu distance
    mars_rahu = get_angular_distance(p["Mars"].longitude, p["Rahu"].longitude)

    # 4. Mercury-Venus distance
    merc_venus = get_angular_distance(p["Mercury"].longitude, p["Venus"].longitude)

    # 5. Mercury speed (absolute)
    merc_speed = abs(p["Mercury"].speed)

    # 6. Venus speed (absolute)
    venus_speed = abs(p["Venus"].speed)

    # 7. Planetary spread (circular std of 7 classical planets)
    lons = [p[name].longitude for name in ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]]
    sins = [math.sin(math.radians(l)) for l in lons]
    coss = [math.cos(math.radians(l)) for l in lons]
    R = math.sqrt(np.mean(sins)**2 + np.mean(coss)**2)
    spread = math.sqrt(max(-2 * math.log(max(R, 0.001)), 0))

    # 8. Venus elongation (distance from Sun)
    venus_elong = get_angular_distance(p["Sun"].longitude, p["Venus"].longitude)

    # 9. Retrogrades count
    n_retro = sum(1 for name in ["Mercury", "Venus", "Mars", "Jupiter", "Saturn"]
                  if p[name].is_retrograde)

    # 10. Eclipse proximity (Moon-Rahu distance)
    moon_rahu = get_angular_distance(p["Moon"].longitude, p["Rahu"].longitude)

    return {
        "venus_rx": venus_rx,
        "jup_sat_dist": jup_sat,
        "jup_sat_tight": jup_sat < 10,
        "mars_rahu_dist": mars_rahu,
        "mars_rahu_tight": mars_rahu < 10,
        "merc_venus_dist": merc_venus,
        "merc_venus_tight": merc_venus < 10,
        "merc_speed": merc_speed,
        "merc_speed_fast": merc_speed > 1.5,
        "venus_speed": venus_speed,
        "venus_speed_fast": venus_speed > 1.0,
        "spread": spread,
        "spread_high": spread > np.percentile([spread], 75) if spread > 1.5 else False,
        "venus_elong": venus_elong,
        "venus_near_sun": venus_elong < 15,
        "n_retro": n_retro,
        "eclipse_near": moon_rahu < 15,
    }


# ═══════════════════════════════════════════════════════════════════
# PHASE 1: Regime Test All New Signals
# ═══════════════════════════════════════════════════════════════════

def phase1_regime_tests(days: int):
    """Test each signal in bull, sideways, and bear markets."""
    print(f"\n{'='*80}")
    print(f"  PHASE 1: REGIME TESTING — Do signals survive all market conditions?")
    print(f"  {len(SYMBOLS)} symbols x {days} days")
    print(f"{'='*80}\n")

    # Signals to test: (name, condition_fn, description)
    signals = [
        ("venus_rx", lambda s: s["venus_rx"], "Venus Retrograde"),
        ("jup_sat_tight", lambda s: s["jup_sat_tight"], "Jupiter-Saturn <10 deg"),
        ("mars_rahu_tight", lambda s: s["mars_rahu_tight"], "Mars-Rahu <10 deg"),
        ("merc_venus_tight", lambda s: s["merc_venus_tight"], "Mercury-Venus <10 deg"),
        ("merc_speed_fast", lambda s: s["merc_speed_fast"], "Mercury speed >1.5 deg/d"),
        ("venus_speed_fast", lambda s: s["venus_speed_fast"], "Venus speed >1.0 deg/d"),
        ("venus_near_sun", lambda s: s["venus_near_sun"], "Venus <15 deg from Sun"),
        ("low_retro", lambda s: s["n_retro"] == 0, "0 retrogrades"),
        ("eclipse_near", lambda s: s["eclipse_near"], "Moon near Rahu (<15 deg)"),
    ]

    results = {}

    for sym in SYMBOLS:
        print(f"  Processing {sym}...", end=" ", flush=True)
        candles = fetch_daily(sym, days)
        if len(candles) < 100:
            print("SKIP")
            continue

        # Build momentum map
        momentum = {}
        for i in range(20, len(candles)):
            dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
            momentum[dt] = (candles[i][4] - candles[i - 20][4]) / candles[i - 20][4] * 100

        computed = 0
        for i in range(len(candles) - 14):
            dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
            close = candles[i][4]
            fwd_7 = (candles[min(i+7, len(candles)-1)][4] - close) / close * 100
            mom = momentum.get(dt, 0)
            regime = classify_regime(mom)

            try:
                astro = extract_astro_signals(dt)
            except Exception:
                continue
            computed += 1

            for sig_name, condition_fn, _ in signals:
                is_active = condition_fn(astro)
                key = (sig_name, regime, is_active)
                results.setdefault(key, []).append(fwd_7)

        print(f"{computed} obs")

    # Print results
    regimes = ["strong_bull", "mild_bull", "sideways", "mild_bear", "strong_bear"]

    print(f"\n{'='*80}")
    print(f"  REGIME TEST RESULTS")
    print(f"{'='*80}")

    for sig_name, _, desc in signals:
        print(f"\n  --- {desc} ({sig_name}) ---")
        print(f"  {'Regime':<15s} {'Active 7d%':>12s} {'Inactive 7d%':>13s} {'Edge':>8s} {'p':>8s} {'Verdict':>10s}")
        print(f"  {'-'*15} {'-'*12} {'-'*13} {'-'*8} {'-'*8} {'-'*10}")

        edge_positive = 0
        edge_negative = 0
        total_regimes = 0

        for regime in regimes:
            active = results.get((sig_name, regime, True), [])
            inactive = results.get((sig_name, regime, False), [])

            if len(active) < 10 or len(inactive) < 10:
                continue

            total_regimes += 1
            a_mean = np.mean(active)
            i_mean = np.mean(inactive)
            edge = a_mean - i_mean
            _, p = scipy_stats.ttest_ind(active, inactive, equal_var=False)

            if edge > 0:
                edge_positive += 1
            else:
                edge_negative += 1

            sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""
            verdict = "CONSISTENT" if (sig_name == "venus_rx" and edge < 0) or (sig_name != "venus_rx" and edge > 0) else "MIXED"

            print(f"  {regime:<15s} {a_mean:>+11.3f}% {i_mean:>+12.3f}% {edge:>+7.3f}% {p:>7.4f} {sig:>2s} {verdict}")

        # Overall verdict
        if total_regimes > 0:
            consistency = max(edge_positive, edge_negative) / total_regimes
            direction = "bullish" if edge_positive > edge_negative else "bearish"
            if consistency >= 0.8:
                print(f"  >>> REGIME-STABLE ({direction}, {consistency:.0%} consistent)")
            elif consistency >= 0.6:
                print(f"  >>> PARTIALLY STABLE ({direction}, {consistency:.0%})")
            else:
                print(f"  >>> REGIME-DEPENDENT (not reliable)")


# ═══════════════════════════════════════════════════════════════════
# PHASE 2: Build V4 Combined Model
# ═══════════════════════════════════════════════════════════════════

def compute_v4_score(astro: Dict) -> Tuple[int, str]:
    """V4 astronomical score combining all validated signals.

    Returns (score, label). Score range roughly -100 to +100.
    """
    score = 0.0

    # 1. Venus Rx: -40 points (strongest, most validated)
    if astro["venus_rx"]:
        score -= 40

    # 2. Venus near Sun (<15 deg): -10 (bearish elongation)
    if astro["venus_near_sun"]:
        score -= 10

    # 3. Mercury-Venus tight (<10 deg): -10 (bearish conjunction)
    if astro["merc_venus_tight"]:
        score -= 10

    # 4. Jupiter-Saturn tight (<10 deg): +15 (bullish, p<0.0001)
    if astro["jup_sat_tight"]:
        score += 15

    # 5. Mars-Rahu tight (<10 deg): +10 (bullish, p=0.006)
    if astro["mars_rahu_tight"]:
        score += 10

    # 6. Mercury speed fast: +8 (p<0.0001 on ETH)
    if astro["merc_speed_fast"]:
        score += 8

    # 7. Venus speed fast: +8 (p<0.001)
    if astro["venus_speed_fast"]:
        score += 8

    # 8. Planetary spread (high = bullish, p=0.004)
    if astro["spread"] > 1.8:
        score += 5
    elif astro["spread"] < 1.2:
        score -= 5

    # 9. Low retrogrades: +5
    if astro["n_retro"] == 0:
        score += 5
    elif astro["n_retro"] >= 3:
        score -= 5

    # 10. Eclipse proximity: -5
    if astro["eclipse_near"]:
        score -= 5

    score = max(-100, min(100, int(round(score))))

    if score >= 20:
        label = "strong_buy"
    elif score >= 8:
        label = "buy"
    elif score >= -8:
        label = "neutral"
    elif score >= -20:
        label = "avoid"
    else:
        label = "strong_avoid"

    return score, label


def phase2_v4_model(days: int):
    """Backtest the V4 combined model."""
    print(f"\n{'='*80}")
    print(f"  PHASE 2: V4 MODEL BACKTEST")
    print(f"  Combined astronomical score (10 signals)")
    print(f"{'='*80}\n")

    for sym in SYMBOLS:
        candles = fetch_daily(sym, days)
        if len(candles) < 100:
            continue

        # Score distribution
        score_returns = defaultdict(list)
        all_pairs = []

        for i in range(len(candles) - 14):
            dt = datetime.fromtimestamp(candles[i][0] / 1000, tz=timezone.utc)
            close = candles[i][4]
            fwd_7 = (candles[min(i+7, len(candles)-1)][4] - close) / close * 100

            try:
                astro = extract_astro_signals(dt)
                score, label = compute_v4_score(astro)
            except Exception:
                continue

            score_returns[label].append(fwd_7)
            all_pairs.append((score, fwd_7))

        print(f"\n  -- {sym} --")
        print(f"  {'Label':<15s} {'7d avg%':>10s} {'N':>6s}")
        print(f"  {'-'*15} {'-'*10} {'-'*6}")
        for label in ["strong_buy", "buy", "neutral", "avoid", "strong_avoid"]:
            data = score_returns.get(label, [])
            if data:
                print(f"  {label:<15s} {np.mean(data):>+9.3f}% {len(data):>6d}")

        if all_pairs:
            sarr = np.array([s for s, _ in all_pairs])
            rarr = np.array([r for _, r in all_pairs])
            corr = np.corrcoef(sarr, rarr)[0, 1]

            n = len(all_pairs)
            q1 = sorted(all_pairs, key=lambda x: x[0])[:n//5]
            q5 = sorted(all_pairs, key=lambda x: x[0])[4*n//5:]
            q1_ret = np.mean([r for _, r in q1])
            q5_ret = np.mean([r for _, r in q5])
            edge = q5_ret - q1_ret
            _, p = scipy_stats.ttest_ind([r for _, r in q5], [r for _, r in q1], equal_var=False)
            sig = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else ""

            print(f"  Correlation: r={corr:+.4f}")
            print(f"  Q5 vs Q1: {q5_ret:+.2f}% vs {q1_ret:+.2f}% = {edge:+.2f}% edge, p={p:.4f} {sig}")


# ═══════════════════════════════════════════════════════════════════
# PHASE 3: Walk-Forward Validation
# ═══════════════════════════════════════════════════════════════════

def phase3_walkforward(days: int):
    """Walk-forward: train on 70%, test on 30%."""
    print(f"\n{'='*80}")
    print(f"  PHASE 3: V4 WALK-FORWARD VALIDATION (70/30 split)")
    print(f"{'='*80}\n")

    print(f"  {'Symbol':<8s} {'Train Q5-Q1':>12s} {'Test Q5-Q1':>12s} {'Train r':>8s} {'Test r':>8s} {'Verdict':>10s}")
    print(f"  {'-'*8} {'-'*12} {'-'*12} {'-'*8} {'-'*8} {'-'*10}")

    all_train_edges = []
    all_test_edges = []

    for sym in SYMBOLS:
        candles = fetch_daily(sym, days)
        if len(candles) < 200:
            continue

        split = int(len(candles) * 0.7)
        train_candles = candles[:split]
        test_candles = candles[split:]

        for label, cset in [("train", train_candles), ("test", test_candles)]:
            pairs = []
            for i in range(len(cset) - 14):
                dt = datetime.fromtimestamp(cset[i][0] / 1000, tz=timezone.utc)
                close = cset[i][4]
                fwd = (cset[min(i+7, len(cset)-1)][4] - close) / close * 100
                try:
                    astro = extract_astro_signals(dt)
                    score, _ = compute_v4_score(astro)
                    pairs.append((score, fwd))
                except Exception:
                    continue

            if label == "train":
                train_pairs = pairs
            else:
                test_pairs = pairs

        if len(train_pairs) < 50 or len(test_pairs) < 20:
            continue

        # Compute metrics
        for label, pairs in [("train", train_pairs), ("test", test_pairs)]:
            sarr = np.array([s for s, _ in pairs])
            rarr = np.array([r for _, r in pairs])
            corr = np.corrcoef(sarr, rarr)[0, 1] if len(pairs) > 10 else 0

            n = len(pairs)
            q1 = sorted(pairs, key=lambda x: x[0])[:n//5]
            q5 = sorted(pairs, key=lambda x: x[0])[4*n//5:]
            edge = np.mean([r for _, r in q5]) - np.mean([r for _, r in q1])

            if label == "train":
                train_edge = edge
                train_corr = corr
            else:
                test_edge = edge
                test_corr = corr

        verdict = "PASS" if test_edge > 0 else "FAIL"
        all_train_edges.append(train_edge)
        all_test_edges.append(test_edge)

        print(f"  {sym:<8s} {train_edge:>+11.2f}% {test_edge:>+11.2f}% "
              f"{train_corr:>+7.4f} {test_corr:>+7.4f} {verdict:>10s}")

    if all_test_edges:
        avg_train = np.mean(all_train_edges)
        avg_test = np.mean(all_test_edges)
        positive = sum(1 for e in all_test_edges if e > 0)
        print(f"\n  {'AVG':<8s} {avg_train:>+11.2f}% {avg_test:>+11.2f}%")
        print(f"  Positive OOS: {positive}/{len(all_test_edges)}")
        if avg_test > 0 and positive > len(all_test_edges) / 2:
            print(f"  >>> V4 PASSES WALK-FORWARD VALIDATION")
        else:
            print(f"  >>> V4 NEEDS MORE WORK")


# ═══════════════════════════════════════════════════════════════════
# PHASE 4: Trading Simulation
# ═══════════════════════════════════════════════════════════════════

def phase4_trading_sim(days: int):
    """Simulate V4 as a trading strategy with SL/TP."""
    print(f"\n{'='*80}")
    print(f"  PHASE 4: V4 TRADING SIMULATION")
    print(f"  Buy when V4 >= 8, sell on SL/TP/signal change")
    print(f"{'='*80}\n")

    configs = [
        {"name": "V4 (SL=5% TP=12%)", "sl": 0.05, "tp": 0.12, "buy_thr": 8, "sell_thr": -8},
        {"name": "V4 (SL=8% TP=20%)", "sl": 0.08, "tp": 0.20, "buy_thr": 8, "sell_thr": -8},
        {"name": "V4 aggressive (SL=10% TP=25%)", "sl": 0.10, "tp": 0.25, "buy_thr": 5, "sell_thr": -15},
        {"name": "V4 strong only (SL=8% TP=20%)", "sl": 0.08, "tp": 0.20, "buy_thr": 15, "sell_thr": -8},
        {"name": "Buy & Hold baseline", "sl": 1.0, "tp": 100.0, "buy_thr": -999, "sell_thr": -999},
    ]

    for cfg in configs:
        all_results = []
        for sym in SYMBOLS:
            candles = fetch_daily(sym, days)
            if len(candles) < 100:
                continue

            # OOS only (last 30%)
            candles = candles[int(len(candles) * 0.7):]

            balance = 1000.0
            position = None
            trades = 0
            wins = 0
            returns = []
            peak_bal = 1000.0
            max_dd = 0

            for i, candle in enumerate(candles):
                dt = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
                price = candle[4]

                try:
                    astro = extract_astro_signals(dt)
                    score, label = compute_v4_score(astro)
                except Exception:
                    continue

                if position is None:
                    if score >= cfg["buy_thr"] and not astro["venus_rx"]:
                        size = balance * 0.15
                        if size >= 5:
                            qty = size / price
                            balance -= size
                            position = {"entry": price, "qty": qty, "peak": price}
                else:
                    pnl_pct = (price - position["entry"]) / position["entry"]
                    if price > position["peak"]:
                        position["peak"] = price

                    sell = False
                    if pnl_pct <= -cfg["sl"]: sell = True
                    if pnl_pct >= cfg["tp"]: sell = True
                    peak_g = (position["peak"] - position["entry"]) / position["entry"]
                    if peak_g >= 0.04 and price <= position["peak"] * 0.98: sell = True
                    if score <= cfg["sell_thr"] and pnl_pct > 0: sell = True
                    if astro["venus_rx"] and pnl_pct > 0: sell = True

                    if sell:
                        pnl = position["qty"] * (price - position["entry"])
                        balance += position["qty"] * price
                        trades += 1
                        if pnl > 0: wins += 1
                        returns.append(pnl_pct * 100)
                        position = None

                val = balance + (position["qty"] * price if position else 0)
                if val > peak_bal: peak_bal = val
                dd = (peak_bal - val) / peak_bal * 100
                if dd > max_dd: max_dd = dd

            if position and candles:
                pnl_pct = (candles[-1][4] - position["entry"]) / position["entry"]
                balance += position["qty"] * candles[-1][4]
                trades += 1
                if pnl_pct > 0: wins += 1
                returns.append(pnl_pct * 100)

            ret = (balance / 1000 - 1) * 100
            wr = wins / max(trades, 1) * 100
            all_results.append({"sym": sym, "ret": ret, "wr": wr, "trades": trades, "dd": max_dd})

        if not all_results:
            continue

        avg_ret = np.mean([r["ret"] for r in all_results])
        avg_wr = np.mean([r["wr"] for r in all_results])
        total_tr = sum(r["trades"] for r in all_results)
        avg_dd = np.mean([r["dd"] for r in all_results])
        positive = sum(1 for r in all_results if r["ret"] > 0)

        print(f"  {cfg['name']:<35s} Ret={avg_ret:>+6.1f}% WR={avg_wr:>5.1f}% "
              f"Tr={total_tr:>4d} DD={avg_dd:>5.1f}% Win={positive}/{len(all_results)}")

        if "aggressive" in cfg["name"] or "strong" in cfg["name"]:
            for r in sorted(all_results, key=lambda x: x["ret"], reverse=True):
                print(f"    {r['sym']:<6s} {r['ret']:>+6.1f}% WR={r['wr']:.0f}% T={r['trades']}")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    start = time.time()
    days = 3000

    phase1_regime_tests(days)
    phase2_v4_model(days)
    phase3_walkforward(days)
    phase4_trading_sim(days)

    elapsed = time.time() - start
    print(f"\n  Total runtime: {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()
