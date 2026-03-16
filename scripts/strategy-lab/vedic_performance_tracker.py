#!/usr/bin/env python3
"""
Vedic Performance Tracker — Compare live results against backtest expectations.

Tracks three metrics to know if the system is on track:
1. SIGNAL ACCURACY: Does the V3 score predict direction correctly?
2. TRADE PERFORMANCE: Are live trades matching backtest win rate & avg return?
3. BAYESIAN DRIFT: Are likelihood ratios drifting from research values?

When to worry:
  - Win rate drops below 40% after 20+ trades → model may be broken
  - Avg return < -1% after 20+ trades → stops may need adjustment
  - Bayes LR for Venus Rx < 0.5 or > 3.0 → something fundamental changed
  - Score accuracy < 50% over 30+ days → V3 model is not predictive

Run periodically (e.g. weekly) or on-demand:
  python scripts/strategy-lab/vedic_performance_tracker.py

Docker:
  docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/vedic_performance_tracker.py
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import redis

# ── Redis connection ──────────────────────────────────────────────
KV_URL = os.getenv("KV_URL", "redis://localhost:6379")
r = redis.from_url(KV_URL, decode_responses=True)


def main():
    print(f"\n{'='*70}")
    print(f"  VEDIC PERFORMANCE TRACKER")
    print(f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"{'='*70}")

    # ── 1. Backtest expectations ──
    print(f"\n  --- BACKTEST EXPECTATIONS (targets to beat) ---")
    expectations = {
        "V3 Trader": {
            "win_rate_target": 53.0,
            "avg_return_target": 0.5,  # % per trade
            "max_dd_target": 20.0,
        },
        "BTD Trader": {
            "win_rate_target": 67.0,
            "avg_return_target": 4.0,  # % per trade (very high)
            "max_dd_target": 15.0,
        },
    }
    for name, exp in expectations.items():
        print(f"  {name}: WR >= {exp['win_rate_target']}%, "
              f"Avg >= {exp['avg_return_target']}%, "
              f"MaxDD <= {exp['max_dd_target']}%")

    # ── 2. V3 Trader live stats ──
    print(f"\n  --- V3 TRADER (vedic_trader) ---")
    trader_raw = r.get("vedic_trader:stats")
    if trader_raw:
        ts = json.loads(trader_raw)
        wr = ts.get("win_rate", 0)
        trades = ts.get("total_trades", 0)
        pnl = ts.get("total_pnl", 0)
        balance = ts.get("balance", 1000)
        ret_pct = ts.get("total_return_pct", 0)

        print(f"  Balance: ${balance:.2f} | P&L: ${pnl:+.2f} ({ret_pct:+.1f}%)")
        print(f"  Trades: {trades} | WR: {wr:.1f}% | Positions: {ts.get('open_positions', 0)}")

        if trades >= 10:
            exp = expectations["V3 Trader"]
            wr_ok = wr >= exp["win_rate_target"]
            print(f"\n  Win Rate: {wr:.1f}% vs target {exp['win_rate_target']}% "
                  f"{'OK' if wr_ok else 'BELOW TARGET'}")
            if not wr_ok:
                print(f"  >>> WARNING: Win rate below backtest expectation!")
                print(f"  >>> Action: Review if market regime has shifted")
        elif trades > 0:
            print(f"\n  Too few trades ({trades}) for meaningful comparison (need 10+)")
        else:
            print(f"\n  No trades yet — system starts trading ~March 21")
    else:
        print(f"  No data available")

    # ── 3. BTD Trader live stats ──
    print(f"\n  --- BTD TRADER (vedic_btd) ---")
    btd_raw = r.get("vedic_btd:stats")
    if btd_raw:
        bs = json.loads(btd_raw)
        print(f"  Phase: {bs.get('btd_phase', '?')}")
        print(f"  Balance: ${bs.get('balance', 500):.2f} | P&L: ${bs.get('total_pnl', 0):+.2f}")
        print(f"  Trades: {bs.get('total_trades', 0)} | WR: {bs.get('win_rate', 0):.1f}%")
        print(f"  Next BTD window: ~October 2026 (Venus Rx)")
    else:
        print(f"  No data available (BTD only trades post-Venus-Rx)")

    # ── 4. Bayesian model state ──
    print(f"\n  --- BAYESIAN MODEL ---")
    bayes_raw = r.get("vedic:bayes:priors")
    if bayes_raw:
        bp = json.loads(bayes_raw)
        total = bp.get("total_trades", 0)
        wins = bp.get("total_wins", 0)
        losses = bp.get("total_losses", 0)
        base_rate = wins / max(total, 1)
        print(f"  Total observations: {total} | Base rate: {base_rate:.1%}")
        print(f"  Last updated: {bp.get('last_updated', 'never')}")

        # Check for drift in key signals
        counts = bp.get("counts", {})
        print(f"\n  Key signal likelihood ratios:")
        print(f"  {'Signal':<15s} {'State':<12s} {'Wins':>5s} {'Losses':>6s} {'LR':>7s} {'Status':>10s}")
        print(f"  {'-'*15} {'-'*12} {'-'*5} {'-'*6} {'-'*7} {'-'*10}")

        research_lr = {
            ("venus_rx", "True"): (0.17, "Should be very low"),
            ("venus_rx", "False"): (1.22, "Should be > 1"),
            ("mercury_rx", "True"): (0.80, "Should be < 1"),
            ("mercury_rx", "False"): (1.22, "Should be > 1"),
        }

        for signal_name in ["venus_rx", "mercury_rx", "n_retro", "paksha"]:
            if signal_name not in counts:
                continue
            states = counts[signal_name]
            total_w = sum(s[0] for s in states.values())
            total_l = sum(s[1] for s in states.values())
            for state_val, (w, l) in states.items():
                p_up = w / max(total_w, 1)
                p_down = l / max(total_l, 1)
                lr = p_up / max(p_down, 0.001)

                status = "OK"
                key = (signal_name, state_val)
                if key in research_lr:
                    expected, note = research_lr[key]
                    if lr > expected * 3 or lr < expected / 3:
                        status = "DRIFT!"
                    elif lr > expected * 2 or lr < expected / 2:
                        status = "drifting"

                print(f"  {signal_name:<15s} {state_val:<12s} {w:>5d} {l:>6d} {lr:>7.3f} {status:>10s}")
    else:
        print(f"  Bayesian priors not yet saved (will save after first trade)")

    # ── 5. Current vedic score ──
    print(f"\n  --- CURRENT V3 STATE ---")
    score_raw = r.get("vedic:score")
    if score_raw:
        vs = json.loads(score_raw)
        print(f"  Score: {vs.get('score', '?')} ({vs.get('label', '?')})")
        print(f"  Venus Rx: {vs.get('venus_rx', False)}")
        print(f"  Mercury Rx: {vs.get('mercury_rx', False)}")
        print(f"  Retrogrades: {vs.get('n_retrogrades', '?')}")
    else:
        print(f"  No score data (engine may be restarting)")

    # ── 6. Trade history ──
    print(f"\n  --- RECENT TRADES ---")
    trades_raw = r.lrange("vedic_trader:trades", 0, 9)
    if trades_raw:
        for raw in trades_raw:
            t = json.loads(raw)
            if t.get("action") == "SELL":
                pnl = t.get("pnl", 0)
                emoji = "+" if pnl > 0 else "-"
                print(f"  {emoji} {t.get('base_asset', '?'):<6s} "
                      f"${pnl:+.2f} ({t.get('pnl_pct', 0):+.1f}%) "
                      f"{t.get('reason', '')[:40]} "
                      f"{t.get('datetime', '')[:10]}")
    else:
        print(f"  No trades yet")

    # ── 7. Decision thresholds ──
    print(f"\n  --- WHEN TO TAKE ACTION ---")
    print(f"  After 20+ trades:")
    print(f"    WR < 40%        -> Review model, check market regime")
    print(f"    Avg ret < -1%   -> Widen stops or reduce position size")
    print(f"    MaxDD > 25%     -> Reduce position size to 10%")
    print(f"  After 50+ trades:")
    print(f"    WR < 45%        -> Consider reverting to V2 or pausing")
    print(f"    Bayes LR drift  -> Signals may have changed, retrain")
    print(f"  Venus Rx period:")
    print(f"    If BTC drops < 5% during Rx -> Venus signal weakening")
    print(f"    If BTD fails 2 consecutive cycles -> Reduce BTD size")

    print(f"\n{'='*70}\n")


if __name__ == "__main__":
    main()
