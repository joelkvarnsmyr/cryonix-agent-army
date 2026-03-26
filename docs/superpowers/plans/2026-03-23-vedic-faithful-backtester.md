# Vedic Faithful Backtester — Test EXACT Live Logic

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a backtester that runs the EXACT same trading logic as our live vedic-trader.py against historical data, so we can validate whether the system actually works before trusting paper trading results.

**Architecture:** Single Python script that imports the real V4 scoring engine (`compute_vedic_score`), simulates a paper wallet with the exact same entry/exit rules (thresholds, tiered exits, circuit breakers, coherence sizing), and runs against 4h OHLCV data from Binance for 6 symbols over up to 8 years.

**Tech Stack:** Python 3.11, pyswisseph, ccxt, numpy, scipy

**Why this matters:** Our previous backtests used simplified proxies (basic SL/TP, different thresholds). Live trading is losing money. We need to know if the EXACT live logic would have been profitable historically, or if our whole approach is flawed.

---

### Task 1: Core Backtester Engine

Create a faithful backtester that mirrors vedic-trader.py logic exactly.

**Files:**
- Create: `scripts/strategy-lab/vedic_faithful_backtest.py`

- [ ] **Step 1: Create the backtester with EXACT live parameters**

```python
#!/usr/bin/env python3
"""
Vedic Faithful Backtester — Runs EXACT live trading logic against historical data.

Unlike previous backtests (vedic_research.py, astro_regime_test.py) which used
simplified proxies, this backtester imports and runs the real V4 scoring engine
and applies the exact same entry/exit conditions as vedic-trader.py.

What it mirrors from live:
  - compute_vedic_score() for V4 scoring (10 astronomical signals)
  - BUY_SCORE_THRESHOLD = 15
  - STOP_LOSS_PCT = 0.08 (-8%)
  - TAKE_PROFIT_PCT = 0.20 (+20%)
  - TRAILING_ACTIVATION_PCT = 0.06, TRAILING_STOP_PCT = 0.03
  - Tiered exits: T1 at +4% (sell 40%), T2 at +8% (sell 30%), T3 ratchet
  - Breakeven SL after T1
  - Circuit breaker: pause after 2 consecutive losses
  - Venus Rx absolute buy block
  - Venus Rx BTD window (days 7-60 post-direct, 25% size, SL=12%, TP=40%)
  - Coherence-based position sizing (0.75x-1.25x)
  - Max 3 concurrent positions, 15% position size

What it does NOT simulate:
  - Polymarket overlay (external data, not available historically)
  - Bayesian self-learning (depends on trade history)
  - Exact scan timing (uses 4h candle closes instead of 5-min scans)

Usage:
  python scripts/strategy-lab/vedic_faithful_backtest.py --days 2000 --symbols BTC,ETH,BNB,XRP,ADA,LTC
  python scripts/strategy-lab/vedic_faithful_backtest.py --days 2000 --all --json
  python scripts/strategy-lab/vedic_faithful_backtest.py --days 2000 --walkforward
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

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import ccxt
import numpy as np
from scipy import stats as scipy_stats

# Import REAL vedic engine (same code as live)
_engine_path = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine')
if os.path.isdir(_engine_path) and _engine_path not in sys.path:
    sys.path.insert(0, _engine_path)

from src.vedic.scoring import compute_vedic_score
from src.vedic.ephemeris import get_sky_state, get_angular_distance
from src.vedic.coherence import compute_coherence

# ══════════════════════════════════════════════════════════════════
# EXACT LIVE PARAMETERS (mirrored from vedic-trader.py)
# ══════════════════════════════════════════════════════════════════

BUY_SCORE_THRESHOLD = 15       # V4 score >= 15 to enter
SELL_SCORE_THRESHOLD = -25     # Exit if score drops below -25 (with profit)
STOP_LOSS_PCT = 0.08           # -8% hard stop
TAKE_PROFIT_PCT = 0.20         # +20% hard take profit
TRAILING_ACTIVATION_PCT = 0.06 # Activate trailing at +6%
TRAILING_STOP_PCT = 0.03       # Trail at -3% from peak
POSITION_SIZE_PCT = 0.15       # 15% of balance per trade
MAX_POSITIONS = 3              # Max 3 concurrent positions
VENUS_RX_BLOCKS_BUY = True     # Absolute buy block during Venus Rx

# Tiered exits (from cryonix.toml [vedic.exits])
T1_TARGET_PCT = 0.04           # Sell 40% at +4%
T1_SELL_PCT = 0.40
T2_TARGET_PCT = 0.08           # Sell 30% at +8%, activate ratchet
T2_SELL_PCT = 0.30
RATCHET_5_MULT = 1.0
RATCHET_10_MULT = 2.0
RATCHET_20_MULT = 3.0

# Circuit breaker
MAX_CONSECUTIVE_LOSSES = 2     # Pause after 2 losses in a row

# Venus Rx BTD parameters
BTD_ENTRY_DELAY_DAYS = 7       # Enter 7 days after Venus goes direct
BTD_WINDOW_DAYS = 60           # BTD window lasts 60 days
BTD_POSITION_SIZE = 0.25       # 25% position size during BTD
BTD_SL = 0.12                  # -12% SL during BTD
BTD_TP = 0.40                  # +40% TP during BTD

SYMBOLS = ["BTC", "ETH", "BNB", "XRP", "ADA", "LTC"]


# ══════════════════════════════════════════════════════════════════
# OHLCV FETCHING
# ══════════════════════════════════════════════════════════════════

_cache: Dict[str, List] = {}

def fetch_ohlcv(symbol: str, days: int, timeframe: str = "4h") -> List:
    key = f"{symbol}_{timeframe}_{days}"
    if key in _cache:
        return _cache[key]
    exchange = ccxt.binance({"enableRateLimit": True})
    since = int((datetime.now(timezone.utc) - timedelta(days=days + 5)).timestamp() * 1000)
    all_c = []
    for pair in [f"{symbol}/USDT", f"{symbol}/USDC"]:
        try:
            while True:
                c = exchange.fetch_ohlcv(pair, timeframe, since=since, limit=1000)
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


# ══════════════════════════════════════════════════════════════════
# COHERENCE (mirrors vedic_scout.py signal_points computation)
# ══════════════════════════════════════════════════════════════════

def compute_coherence_from_sky(sky) -> float:
    """Compute coherence size multiplier from sky state."""
    p = sky.planets
    signal_points = {
        "venus_rx": -40 if p["Venus"].is_retrograde else 0,
        "jup_sat": 15 if get_angular_distance(p["Jupiter"].longitude, p["Saturn"].longitude) < 10 else 0,
        "mars_rahu": 10 if get_angular_distance(p["Mars"].longitude, p["Rahu"].longitude) < 10 else 0,
        "merc_venus": -10 if get_angular_distance(p["Mercury"].longitude, p["Venus"].longitude) < 10 else 0,
        "merc_speed": 8 if abs(p["Mercury"].speed) > 1.5 else 0,
        "venus_speed": 8 if abs(p["Venus"].speed) > 1.0 else 0,
        "retro": 5 if all(not p[n].is_retrograde for n in ["Mercury","Venus","Mars","Jupiter","Saturn"]) else (
            -5 if sum(1 for n in ["Mercury","Venus","Mars","Jupiter","Saturn"] if p[n].is_retrograde) >= 3 else 0),
        "venus_sun": -10 if get_angular_distance(p["Sun"].longitude, p["Venus"].longitude) < 15 else 0,
        "eclipse": -5 if get_angular_distance(p["Moon"].longitude, p["Rahu"].longitude) < 15 else 0,
        "spread": 0,
    }
    coh = compute_coherence(signal_points)
    return coh.size_multiplier


# ══════════════════════════════════════════════════════════════════
# POSITION & WALLET
# ══════════════════════════════════════════════════════════════════

@dataclass
class Position:
    symbol: str
    entry_price: float
    quantity: float
    original_quantity: float
    entry_time: datetime
    entry_score: int
    peak_price: float
    trailing_active: bool = False
    is_btd: bool = False
    tiers_filled: List[str] = field(default_factory=list)
    breakeven_sl: bool = False
    ratchet_active: bool = False
    ratchet_trail_price: float = 0.0


@dataclass
class TradeRecord:
    symbol: str
    action: str        # BUY, SELL, PARTIAL_T1, PARTIAL_T2
    price: float
    quantity: float
    timestamp: datetime
    reason: str
    pnl: float = 0.0
    pnl_pct: float = 0.0
    hold_hours: float = 0.0
    v4_score: int = 0


# ══════════════════════════════════════════════════════════════════
# BACKTEST ENGINE
# ══════════════════════════════════════════════════════════════════

def run_faithful_backtest(
    symbols: List[str],
    days: int = 2000,
    capital: float = 1000.0,
    timeframe: str = "4h",
    split: float = 0.0,   # 0.0 = full period, 0.7 = last 30% only
) -> Dict:
    """Run the faithful backtester with EXACT live logic."""

    print(f"\n{'='*70}")
    print(f"  VEDIC FAITHFUL BACKTEST")
    print(f"  {len(symbols)} symbols | {days} days | ${capital} | {timeframe}")
    if split > 0:
        print(f"  OUT-OF-SAMPLE: last {(1-split)*100:.0f}%")
    print(f"{'='*70}\n")

    # Fetch all OHLCV data
    all_candles = {}
    for sym in symbols:
        candles = fetch_ohlcv(sym, days, timeframe)
        if split > 0:
            candles = candles[int(len(candles) * split):]
        if len(candles) > 50:
            all_candles[sym] = candles
            print(f"  {sym}: {len(candles)} candles")
        else:
            print(f"  {sym}: SKIP (only {len(candles)} candles)")

    if not all_candles:
        print("  No data!")
        return {}

    # Find common date range
    min_ts = max(c[0][0] for c in all_candles.values())
    max_ts = min(c[-1][0] for c in all_candles.values())

    # Build unified timeline (4h intervals)
    timeline = []
    for sym, candles in all_candles.items():
        for c in candles:
            if min_ts <= c[0] <= max_ts:
                timeline.append(c[0])
    timeline = sorted(set(timeline))
    print(f"  Timeline: {len(timeline)} points")

    # Build symbol -> timestamp -> candle lookup
    candle_lookup: Dict[str, Dict[int, List]] = {}
    for sym, candles in all_candles.items():
        candle_lookup[sym] = {c[0]: c for c in candles}

    # ── Simulation state ──
    balance = capital
    positions: Dict[str, Position] = {}
    trades: List[TradeRecord] = []
    balance_history = [capital]
    peak_balance = capital
    max_dd = 0.0

    # Circuit breaker state
    consecutive_losses = 0
    circuit_paused = False

    # Venus Rx BTD tracking
    prev_venus_rx = None
    venus_direct_at = None

    # ── Main loop ──
    sky_cache = {}
    score_cache = {}

    for ts_ms in timeline:
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)

        # Compute V4 score (cached per 4h candle)
        cache_key = dt.strftime("%Y-%m-%d-%H")
        if cache_key not in score_cache:
            try:
                sky = get_sky_state(dt)
                vs = compute_vedic_score(sky)
                coh_mult = compute_coherence_from_sky(sky)
                score_cache[cache_key] = (vs, sky, coh_mult)
            except Exception:
                continue
        vs, sky, coh_mult = score_cache[cache_key]

        venus_rx_now = vs.label == "venus_rx_block" or sky.planets["Venus"].is_retrograde

        # ── Venus Rx BTD tracking ──
        btd_window = False
        if prev_venus_rx is True and not venus_rx_now:
            venus_direct_at = dt
        if venus_direct_at:
            btd_days = (dt - venus_direct_at).total_seconds() / 86400
            if BTD_ENTRY_DELAY_DAYS <= btd_days <= BTD_WINDOW_DAYS:
                if not vs.is_mercury_retrograde:
                    btd_window = True
            elif btd_days > BTD_WINDOW_DAYS:
                venus_direct_at = None
        prev_venus_rx = venus_rx_now

        # ── Check existing positions for SELL ──
        for sym in list(positions.keys()):
            if sym not in candle_lookup or ts_ms not in candle_lookup[sym]:
                continue
            candle = candle_lookup[sym][ts_ms]
            price = candle[4]  # close
            high = candle[2]
            low = candle[3]
            pos = positions[sym]

            # Update peak
            if high > pos.peak_price:
                pos.peak_price = high

            pnl_pct = (price - pos.entry_price) / pos.entry_price

            # ── Tiered exits ──
            if "T1" not in pos.tiers_filled and pnl_pct >= T1_TARGET_PCT:
                sell_qty = pos.original_quantity * T1_SELL_PCT
                sell_qty = min(sell_qty, pos.quantity)
                sell_value = sell_qty * price
                pos.quantity -= sell_qty
                balance += sell_value
                pos.tiers_filled.append("T1")
                pos.breakeven_sl = True
                trades.append(TradeRecord(sym, "PARTIAL_T1", price, sell_qty, dt,
                    f"T1 +{pnl_pct*100:.1f}%", pnl=sell_value - sell_qty * pos.entry_price,
                    pnl_pct=pnl_pct*100, v4_score=vs.overall_score))

            if "T1" in pos.tiers_filled and "T2" not in pos.tiers_filled and pnl_pct >= T2_TARGET_PCT:
                sell_qty = pos.original_quantity * T2_SELL_PCT
                sell_qty = min(sell_qty, pos.quantity)
                sell_value = sell_qty * price
                pos.quantity -= sell_qty
                balance += sell_value
                pos.tiers_filled.append("T2")
                pos.ratchet_active = True
                pos.ratchet_trail_price = price * (1 - TRAILING_STOP_PCT)
                trades.append(TradeRecord(sym, "PARTIAL_T2", price, sell_qty, dt,
                    f"T2 +{pnl_pct*100:.1f}% ratchet", pnl=sell_value - sell_qty * pos.entry_price,
                    pnl_pct=pnl_pct*100, v4_score=vs.overall_score))

            # Ratcheting trail (T3)
            if pos.ratchet_active and "T2" in pos.tiers_filled:
                profit_pct = pnl_pct * 100
                mult = RATCHET_20_MULT if profit_pct >= 20 else (
                    RATCHET_10_MULT if profit_pct >= 10 else (
                    RATCHET_5_MULT if profit_pct >= 5 else 1.0))
                new_trail = price * (1 - TRAILING_STOP_PCT * mult)
                if new_trail > pos.ratchet_trail_price:
                    pos.ratchet_trail_price = new_trail
                if low <= pos.ratchet_trail_price:
                    _close_position(positions, trades, balance_history, sym, pos,
                        pos.ratchet_trail_price, dt, f"T3 ratchet ({pnl_pct*100:+.1f}%)",
                        vs.overall_score)
                    pnl = pos.quantity * (pos.ratchet_trail_price - pos.entry_price)
                    balance += pos.quantity * pos.ratchet_trail_price
                    if pnl > 0: consecutive_losses = 0
                    else: consecutive_losses += 1
                    del positions[sym]
                    continue

            # Breakeven SL after T1
            if pos.breakeven_sl and "T1" in pos.tiers_filled and low <= pos.entry_price:
                _close_position(positions, trades, balance_history, sym, pos,
                    pos.entry_price, dt, f"Breakeven SL after T1", vs.overall_score)
                balance += pos.quantity * pos.entry_price
                consecutive_losses += 1  # Breakeven counts as loss
                del positions[sym]
                continue

            sell = False
            sell_price = price
            reason = ""

            # Determine SL/TP based on BTD or normal
            sl = BTD_SL if pos.is_btd else STOP_LOSS_PCT
            tp = BTD_TP if pos.is_btd else TAKE_PROFIT_PCT

            # Trailing stop (uses high/low for intracandle)
            peak_gain = (pos.peak_price - pos.entry_price) / pos.entry_price
            if peak_gain >= TRAILING_ACTIVATION_PCT:
                pos.trailing_active = True
                trail_price = pos.peak_price * (1 - TRAILING_STOP_PCT)
                if low <= trail_price:
                    sell = True
                    sell_price = trail_price
                    reason = f"TRAILING ({pnl_pct*100:+.1f}%)"

            # Hard SL (uses low)
            if not sell and (low - pos.entry_price) / pos.entry_price <= -sl:
                sell = True
                sell_price = pos.entry_price * (1 - sl)
                reason = f"STOP LOSS ({-sl*100:.0f}%)"

            # Hard TP (uses high)
            if not sell and (high - pos.entry_price) / pos.entry_price >= tp:
                sell = True
                sell_price = pos.entry_price * (1 + tp)
                reason = f"TAKE PROFIT (+{tp*100:.0f}%)"

            # Venus Rx exit with profit
            if not sell and venus_rx_now and pnl_pct > 0:
                sell = True
                reason = f"Venus Rx + profit ({pnl_pct*100:+.1f}%)"

            # Score drops to strong_avoid with profit
            if not sell and vs.overall_score < SELL_SCORE_THRESHOLD and pnl_pct > 0:
                sell = True
                reason = f"Score {vs.overall_score} + profit"

            if sell:
                pnl = pos.quantity * (sell_price - pos.entry_price)
                hold_h = (dt - pos.entry_time).total_seconds() / 3600
                balance += pos.quantity * sell_price
                trades.append(TradeRecord(sym, "SELL", sell_price, pos.quantity, dt,
                    reason, pnl=pnl, pnl_pct=(sell_price/pos.entry_price-1)*100,
                    hold_hours=hold_h, v4_score=vs.overall_score))
                if pnl > 0:
                    consecutive_losses = 0
                else:
                    consecutive_losses += 1
                del positions[sym]

            # Dust close
            if sym in positions and positions[sym].quantity * price < 2.0 and positions[sym].tiers_filled:
                pos = positions[sym]
                balance += pos.quantity * price
                del positions[sym]

        # ── Circuit breaker ──
        circuit_paused = consecutive_losses >= MAX_CONSECUTIVE_LOSSES

        # ── Check for BUY ──
        if not circuit_paused and len(positions) < MAX_POSITIONS:
            for sym in symbols:
                if len(positions) >= MAX_POSITIONS:
                    break
                if sym in positions:
                    continue
                if sym not in candle_lookup or ts_ms not in candle_lookup[sym]:
                    continue

                candle = candle_lookup[sym][ts_ms]
                price = candle[4]

                # Venus Rx block
                if VENUS_RX_BLOCKS_BUY and venus_rx_now:
                    continue

                # BTD mode
                is_btd = False
                if btd_window:
                    is_btd = True
                elif vs.overall_score < BUY_SCORE_THRESHOLD:
                    continue

                # Position sizing with coherence
                pos_pct = BTD_POSITION_SIZE if is_btd else POSITION_SIZE_PCT
                size_usd = balance * pos_pct * coh_mult
                if size_usd < 5:
                    continue

                qty = size_usd / price
                balance -= size_usd

                positions[sym] = Position(
                    symbol=sym, entry_price=price, quantity=qty,
                    original_quantity=qty, entry_time=dt,
                    entry_score=vs.overall_score, peak_price=price,
                    is_btd=is_btd,
                )
                trades.append(TradeRecord(sym, "BUY", price, qty, dt,
                    f"{'BTD' if is_btd else 'V4'}={vs.overall_score}",
                    v4_score=vs.overall_score))

        # Track balance for drawdown
        equity = balance + sum(
            pos.quantity * candle_lookup.get(sym, {}).get(ts_ms, [0,0,0,0,0])[4]
            for sym, pos in positions.items()
        )
        balance_history.append(equity)
        if equity > peak_balance:
            peak_balance = equity
        dd = (peak_balance - equity) / peak_balance * 100
        if dd > max_dd:
            max_dd = dd

    # ── Close remaining positions at last price ──
    for sym, pos in list(positions.items()):
        last_candle = all_candles[sym][-1] if sym in all_candles else None
        if last_candle:
            price = last_candle[4]
            pnl = pos.quantity * (price - pos.entry_price)
            balance += pos.quantity * price
            trades.append(TradeRecord(sym, "SELL", price, pos.quantity,
                datetime.fromtimestamp(last_candle[0]/1000, tz=timezone.utc),
                "END OF BACKTEST", pnl=pnl,
                pnl_pct=(price/pos.entry_price-1)*100))

    # ── Compute metrics ──
    sells = [t for t in trades if t.action in ("SELL", "PARTIAL_T1", "PARTIAL_T2")]
    full_sells = [t for t in trades if t.action == "SELL"]
    wins = sum(1 for t in full_sells if t.pnl > 0)
    losses = sum(1 for t in full_sells if t.pnl <= 0)
    total_pnl = sum(t.pnl for t in sells)
    n_trades = len(full_sells)
    total_return = (balance / capital - 1) * 100
    wr = wins / max(n_trades, 1) * 100

    returns = [t.pnl_pct for t in full_sells]
    avg_return = np.mean(returns) if returns else 0
    avg_hold = np.mean([t.hold_hours for t in full_sells if t.hold_hours > 0]) if full_sells else 0

    if len(returns) > 1:
        std = np.std(returns)
        sharpe = np.mean(returns) / std * math.sqrt(252) if std > 0 else 0
    else:
        sharpe = 0

    # ── Print results ──
    print(f"\n{'='*70}")
    print(f"  RESULTS")
    print(f"{'='*70}")
    print(f"  Capital:       ${capital:,.2f} → ${balance:,.2f}")
    print(f"  Total Return:  {total_return:+.1f}%")
    print(f"  Total P&L:     ${total_pnl:+,.2f}")
    print(f"  Trades:        {n_trades} ({wins}W / {losses}L)")
    print(f"  Win Rate:      {wr:.1f}%")
    print(f"  Avg Return:    {avg_return:+.2f}%")
    print(f"  Max Drawdown:  {max_dd:.2f}%")
    print(f"  Sharpe Ratio:  {sharpe:.2f}")
    print(f"  Avg Hold:      {avg_hold:.1f}h")

    # Tiered exit stats
    t1_trades = [t for t in trades if t.action == "PARTIAL_T1"]
    t2_trades = [t for t in trades if t.action == "PARTIAL_T2"]
    print(f"\n  Tiered Exits:  T1={len(t1_trades)}, T2={len(t2_trades)}")

    # Circuit breaker activations
    cb_count = sum(1 for i in range(1, len(full_sells))
                   if full_sells[i-1].pnl <= 0 and full_sells[i].pnl <= 0)
    print(f"  Circuit Breaks: ~{cb_count}")

    # BTD trades
    btd_trades = [t for t in trades if "BTD" in t.reason and t.action == "SELL"]
    if btd_trades:
        btd_pnl = sum(t.pnl for t in btd_trades)
        btd_wr = sum(1 for t in btd_trades if t.pnl > 0) / len(btd_trades) * 100
        print(f"  BTD Trades:    {len(btd_trades)} (WR={btd_wr:.0f}%, P&L=${btd_pnl:+.2f})")

    # Last 10 trades
    print(f"\n  -- Last 10 Trades --")
    for t in full_sells[-10:]:
        emoji = "+" if t.pnl > 0 else "-"
        print(f"  {emoji} {t.timestamp.strftime('%Y-%m-%d %H:%M')} {t.symbol:<6s} "
              f"${t.pnl:+.2f} ({t.pnl_pct:+.1f}%) {t.hold_hours:.0f}h | {t.reason}")

    return {
        "capital": capital, "final_balance": round(balance, 2),
        "total_return_pct": round(total_return, 2),
        "total_pnl": round(total_pnl, 2),
        "trades": n_trades, "wins": wins, "losses": losses,
        "win_rate": round(wr, 1),
        "avg_return_pct": round(avg_return, 2),
        "max_drawdown_pct": round(max_dd, 2),
        "sharpe": round(sharpe, 2),
        "avg_hold_hours": round(avg_hold, 1),
        "t1_exits": len(t1_trades), "t2_exits": len(t2_trades),
        "btd_trades": len(btd_trades),
    }


def _close_position(positions, trades, balance_history, sym, pos, price, dt, reason, score):
    """Helper to record a closing trade."""
    pnl = pos.quantity * (price - pos.entry_price)
    hold_h = (dt - pos.entry_time).total_seconds() / 3600
    trades.append(TradeRecord(sym, "SELL", price, pos.quantity, dt,
        reason, pnl=pnl, pnl_pct=(price/pos.entry_price-1)*100,
        hold_hours=hold_h, v4_score=score))


# ══════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Vedic Faithful Backtester")
    parser.add_argument("--days", type=int, default=2000)
    parser.add_argument("--symbols", type=str, default="BTC,ETH,BNB,XRP,ADA,LTC")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--walkforward", action="store_true",
                        help="Run 70/30 walk-forward validation")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--capital", type=float, default=1000.0)
    args = parser.parse_args()

    symbols = args.symbols.split(",") if not args.all else SYMBOLS
    start = time.time()

    if args.walkforward:
        print("\n  === WALK-FORWARD VALIDATION ===")
        print("  Full period:")
        full = run_faithful_backtest(symbols, args.days, args.capital)
        print("\n  Out-of-sample (last 30%):")
        oos = run_faithful_backtest(symbols, args.days, args.capital, split=0.7)

        print(f"\n{'='*70}")
        print(f"  WALK-FORWARD COMPARISON")
        print(f"{'='*70}")
        print(f"  {'Period':<15s} {'Return%':>8s} {'WR%':>6s} {'Trades':>7s} {'Sharpe':>7s}")
        print(f"  {'Full':<15s} {full.get('total_return_pct',0):>+7.1f}% {full.get('win_rate',0):>5.1f}% "
              f"{full.get('trades',0):>7d} {full.get('sharpe',0):>7.2f}")
        print(f"  {'OOS (30%)':<15s} {oos.get('total_return_pct',0):>+7.1f}% {oos.get('win_rate',0):>5.1f}% "
              f"{oos.get('trades',0):>7d} {oos.get('sharpe',0):>7.2f}")

        if oos.get('total_return_pct', 0) > 0:
            print(f"\n  >>> FAITHFUL BACKTEST PASSES OOS VALIDATION")
        else:
            print(f"\n  >>> FAITHFUL BACKTEST FAILS OOS — live logic does not backtest profitably")
    else:
        result = run_faithful_backtest(symbols, args.days, args.capital)
        if args.json:
            print(json.dumps(result, indent=2))

    elapsed = time.time() - start
    print(f"\n  Runtime: {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the backtester on 2000 days**

```bash
python scripts/strategy-lab/vedic_faithful_backtest.py --days 2000 --walkforward
```

Expected: Results showing whether EXACT live logic is profitable historically.

- [ ] **Step 3: Compare with previous simplified backtests**

The key question: does the faithful backtest match the +30.9% we saw in `astro_regime_test.py`? Or does the faithful logic (tiered exits, circuit breakers, coherence) change the results?

- [ ] **Step 4: Commit**

```bash
git add scripts/strategy-lab/vedic_faithful_backtest.py
git commit -m "feat(vedic): faithful backtester — tests EXACT live trading logic

Runs compute_vedic_score() historically with exact same entry/exit
conditions as vedic-trader.py: V4>=15, SL=8%, TP=20%, tiered exits
(T1/T2/T3), circuit breakers, coherence sizing, Venus Rx BTD.

Walk-forward validation (70/30 split) determines if live logic
would have been profitable out-of-sample."
```

---

### Task 2: Analyze Results & Document

- [ ] **Step 1: Run backtester with different parameter sets**

Test sensitivity:
```bash
# Default (exact live params)
python scripts/strategy-lab/vedic_faithful_backtest.py --days 2000 --walkforward

# Without tiered exits (old-style all-or-nothing)
# Modify T1_TARGET_PCT = 999 temporarily and re-run

# Without circuit breaker (MAX_CONSECUTIVE_LOSSES = 999)

# Without coherence (coh_mult = 1.0 always)
```

- [ ] **Step 2: Document findings**

Update `docs/vedic.md` or create a new research report with:
- Does the faithful backtest match previous simplified results?
- What's the impact of tiered exits vs all-or-nothing?
- Does the circuit breaker help or hurt?
- Does coherence sizing add value?
- Walk-forward: does it pass OOS?

- [ ] **Step 3: Commit documentation**

```bash
git add docs/
git commit -m "docs(vedic): faithful backtest results — exact live logic vs simplified"
```
