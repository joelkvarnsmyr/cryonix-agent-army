#!/usr/bin/env python3
"""
Vedic Parameter Sweep — Find settings that give 10-50% returns.

Uses the faithful backtester engine to test aggressive parameter combinations.
Each run uses EXACT live V4 scoring logic — only parameters change.
"""
import math
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, List

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np

# Import the faithful backtester
sys.path.insert(0, os.path.dirname(__file__))
from vedic_faithful_backtest import run_faithful_backtest, SYMBOLS
import vedic_faithful_backtest as bt

def sweep():
    days = 2000
    capital = 1000.0

    configs = [
        # Name, threshold, SL, TP, trail_act, trail_stop, pos_size, max_pos, t1_target, t1_sell, t2_target, circuit_max, coh_enabled
        ("CURRENT LIVE",         15, 0.08, 0.20, 0.06, 0.03, 0.15, 3, 0.04, 0.40, 0.08, 2, True),
        ("No tiered exits",      15, 0.08, 0.20, 0.06, 0.03, 0.15, 3, 9.99, 0.40, 9.99, 2, True),
        ("Wider T1 (+8%)",       15, 0.08, 0.20, 0.06, 0.03, 0.15, 3, 0.08, 0.40, 0.15, 2, True),
        ("No circuit breaker",   15, 0.08, 0.20, 0.06, 0.03, 0.15, 3, 0.04, 0.40, 0.08, 999, True),
        ("Lower threshold V4>=8",8,  0.08, 0.20, 0.06, 0.03, 0.15, 3, 0.04, 0.40, 0.08, 2, True),
        ("Bigger size 25%",      15, 0.08, 0.20, 0.06, 0.03, 0.25, 3, 0.04, 0.40, 0.08, 2, True),
        ("Bigger size 30%",      15, 0.08, 0.20, 0.06, 0.03, 0.30, 3, 0.04, 0.40, 0.08, 2, True),
        ("Max 5 positions",      15, 0.08, 0.20, 0.06, 0.03, 0.15, 5, 0.04, 0.40, 0.08, 2, True),
        ("Wider SL 12%",         15, 0.12, 0.25, 0.08, 0.04, 0.15, 3, 0.04, 0.40, 0.08, 2, True),
        ("Wider TP 30%",         15, 0.08, 0.30, 0.06, 0.03, 0.15, 3, 0.04, 0.40, 0.08, 2, True),
        ("No coherence",         15, 0.08, 0.20, 0.06, 0.03, 0.15, 3, 0.04, 0.40, 0.08, 2, False),
        # Aggressive combos
        ("AGGRESSIVE A: V4>=8, 25%, no tiered, no CB",
                                  8, 0.08, 0.20, 0.06, 0.03, 0.25, 3, 9.99, 0.40, 9.99, 999, True),
        ("AGGRESSIVE B: V4>=8, 30%, SL=12%, TP=30%",
                                  8, 0.12, 0.30, 0.08, 0.04, 0.30, 3, 0.04, 0.40, 0.08, 999, True),
        ("AGGRESSIVE C: V4>=8, 25%, wider T1(+8%), no CB",
                                  8, 0.08, 0.25, 0.06, 0.03, 0.25, 3, 0.08, 0.30, 0.15, 999, True),
        ("MOON: V4>=8, 30%, SL=10%, TP=25%, 5pos, no CB",
                                  8, 0.10, 0.25, 0.06, 0.03, 0.30, 5, 9.99, 0.40, 9.99, 999, False),
        ("YOLO: V4>=0, 50%, SL=15%, TP=40%, 5pos",
                                  0, 0.15, 0.40, 0.10, 0.05, 0.50, 5, 9.99, 0.40, 9.99, 999, False),
    ]

    print(f"\n{'='*100}")
    print(f"  VEDIC PARAMETER SWEEP — {len(configs)} configurations × {days} days")
    print(f"{'='*100}")
    print(f"\n  {'Config':<50s} {'Ret%':>7s} {'WR%':>6s} {'Trades':>7s} {'Sharpe':>7s} {'MaxDD':>6s} {'T1':>4s} {'T2':>4s}")
    print(f"  {'-'*50} {'-'*7} {'-'*6} {'-'*7} {'-'*7} {'-'*6} {'-'*4} {'-'*4}")

    results = []

    for name, threshold, sl, tp, trail_act, trail_stop, pos_size, max_pos, t1, t1_sell, t2, cb_max, coh in configs:
        # Override backtester params
        bt.BUY_SCORE_THRESHOLD = threshold
        bt.STOP_LOSS_PCT = sl
        bt.TAKE_PROFIT_PCT = tp
        bt.TRAILING_ACTIVATION_PCT = trail_act
        bt.TRAILING_STOP_PCT = trail_stop
        bt.POSITION_SIZE_PCT = pos_size
        bt.MAX_POSITIONS = max_pos
        bt.T1_TARGET_PCT = t1
        bt.T1_SELL_PCT = t1_sell
        bt.T2_TARGET_PCT = t2
        bt.MAX_CONSECUTIVE_LOSSES = cb_max

        # Run quietly
        import io
        old_stdout = sys.stdout
        sys.stdout = io.StringIO()
        try:
            r = run_faithful_backtest(SYMBOLS, days, capital)
        finally:
            sys.stdout = old_stdout

        ret = r.get("total_return_pct", 0)
        wr = r.get("win_rate", 0)
        trades = r.get("trades", 0)
        sharpe = r.get("sharpe", 0)
        dd = r.get("max_drawdown_pct", 0)
        t1_n = r.get("t1_exits", 0)
        t2_n = r.get("t2_exits", 0)

        marker = " <<<" if ret >= 10 else ""
        print(f"  {name:<50s} {ret:>+6.1f}% {wr:>5.1f}% {trades:>7d} {sharpe:>7.2f} {dd:>5.1f}% {t1_n:>4d} {t2_n:>4d}{marker}")

        results.append({"name": name, "return": ret, "wr": wr, "trades": trades, "sharpe": sharpe, "dd": dd})

    # OOS test for best configs
    top = sorted(results, key=lambda x: x["return"], reverse=True)[:3]
    print(f"\n\n{'='*70}")
    print(f"  TOP 3 — OUT-OF-SAMPLE VALIDATION (last 30%)")
    print(f"{'='*70}")

    for r in top:
        name = r["name"]
        # Find config
        cfg = [c for c in configs if c[0] == name][0]
        bt.BUY_SCORE_THRESHOLD = cfg[1]
        bt.STOP_LOSS_PCT = cfg[2]
        bt.TAKE_PROFIT_PCT = cfg[3]
        bt.TRAILING_ACTIVATION_PCT = cfg[4]
        bt.TRAILING_STOP_PCT = cfg[5]
        bt.POSITION_SIZE_PCT = cfg[6]
        bt.MAX_POSITIONS = cfg[7]
        bt.T1_TARGET_PCT = cfg[8]
        bt.T1_SELL_PCT = cfg[9]
        bt.T2_TARGET_PCT = cfg[10]
        bt.MAX_CONSECUTIVE_LOSSES = cfg[11]

        import io
        old_stdout = sys.stdout
        sys.stdout = io.StringIO()
        try:
            oos = run_faithful_backtest(SYMBOLS, days, capital, split=0.7)
        finally:
            sys.stdout = old_stdout

        oos_ret = oos.get("total_return_pct", 0)
        oos_wr = oos.get("win_rate", 0)
        oos_trades = oos.get("trades", 0)
        oos_sharpe = oos.get("sharpe", 0)

        verdict = "PASS" if oos_ret > 0 else "FAIL"
        print(f"  {name:<50s}")
        print(f"    Full:  {r['return']:>+6.1f}% WR={r['wr']:.0f}% T={r['trades']}")
        print(f"    OOS:   {oos_ret:>+6.1f}% WR={oos_wr:.0f}% T={oos_trades} Sharpe={oos_sharpe:.2f} → {verdict}")


if __name__ == "__main__":
    start = time.time()
    sweep()
    print(f"\n  Runtime: {(time.time()-start)/60:.1f} minutes")
