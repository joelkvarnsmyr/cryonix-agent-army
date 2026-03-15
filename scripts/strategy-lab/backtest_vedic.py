#!/usr/bin/env python3
"""
Strategy Lab: Vedic Astrology Backtester

Runs pyswisseph backwards in time against historical price data (CCXT)
to measure how vedic astrology signals correlate with actual price moves.

Usage:
  python3 scripts/strategy-lab/backtest_vedic.py --symbol BTC --days 90
  python3 scripts/strategy-lab/backtest_vedic.py --all --days 60
  python3 scripts/strategy-lab/backtest_vedic.py --symbol ETH --days 30 --json
  python3 scripts/strategy-lab/backtest_vedic.py --all --days 90 --capital 1000

Docker:
  docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/backtest_vedic.py --symbol BTC --days 60
"""
import argparse
import json
import math
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import ccxt
import numpy as np

# Import vedic engine
_engine_paths = [
    os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine'),
    '/app',
]
for _p in _engine_paths:
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)

from src.vedic.ephemeris import get_sky_state
from src.vedic.scoring import compute_vedic_score, compute_symbol_transits
from src.vedic.aspects import mercury_retrograde
from src.vedic.nakshatras import nakshatra_at_longitude
from src.vedic.natal import CRYPTO_GENESIS
from src.vedic.dasha import compute_dasha_for_symbol


# ── Configuration (mirrors vedic-trader.py) ──────────────────────────

BUY_SCORE_THRESHOLD = 10
SELL_SCORE_THRESHOLD = -20
STOP_LOSS_PCT = 0.04
TAKE_PROFIT_PCT = 0.10
TRAILING_ACTIVATION_PCT = 0.03
TRAILING_STOP_PCT = 0.015
POSITION_SIZE_PCT = 0.10
MIN_TRANSIT_SCORE = -20
MIN_DASHA_BIAS = -0.3
ALLOWED_NAKSHATRA_BIAS = {"bullish", "neutral"}
REQUIRE_SHUKLA_PAKSHA = True
MIN_MUHURTA = "neutral"
MUHURTA_LEVELS = {
    "very_inauspicious": -2, "inauspicious": -1, "neutral": 0,
    "auspicious": 1, "very_auspicious": 2,
}


# ── Data classes ─────────────────────────────────────────────────────

@dataclass
class BacktestTrade:
    symbol: str
    action: str            # BUY or SELL
    price: float
    quantity: float
    timestamp: datetime
    reason: str
    vedic_score: int
    muhurta: str
    moon_nakshatra: str
    mercury_rx: bool
    transit_score: Optional[int] = None
    dasha_lord: str = ""
    pnl: float = 0.0
    pnl_pct: float = 0.0
    hold_hours: float = 0.0
    trailing_active: bool = False


@dataclass
class BacktestResult:
    symbol: str
    days: int
    capital: float
    final_balance: float
    total_trades: int
    wins: int
    losses: int
    total_pnl: float
    win_rate: float
    avg_return_pct: float
    max_drawdown_pct: float
    sharpe_ratio: float
    sortino_ratio: float
    avg_hold_hours: float
    trades: List[BacktestTrade] = field(default_factory=list)
    # Vedic-specific metrics
    wins_auspicious_muhurta: int = 0
    total_auspicious_muhurta: int = 0
    wins_merc_rx: int = 0
    total_merc_rx: int = 0
    nakshatra_performance: Dict[str, Dict] = field(default_factory=dict)
    dasha_performance: Dict[str, Dict] = field(default_factory=dict)


# ── OHLCV Fetching ──────────────────────────────────────────────────

def fetch_ohlcv(symbol: str, days: int, timeframe: str = "4h") -> List:
    """Fetch historical OHLCV data from Binance."""
    exchange = ccxt.binance({"enableRateLimit": True})
    pair = f"{symbol}/USDC"

    since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp() * 1000)
    all_candles = []
    limit = 1000

    print(f"  Fetching {pair} {timeframe} candles ({days} days)...")

    while True:
        candles = exchange.fetch_ohlcv(pair, timeframe, since=since, limit=limit)
        if not candles:
            break
        all_candles.extend(candles)
        since = candles[-1][0] + 1
        if len(candles) < limit:
            break

    print(f"  Fetched {len(all_candles)} candles")
    return all_candles


# ── Backtest Engine ──────────────────────────────────────────────────

def run_backtest(
    symbol: str,
    days: int = 90,
    capital: float = 1000.0,
    timeframe: str = "4h",
) -> BacktestResult:
    """Run vedic backtest for a single symbol."""

    print(f"\n{'='*60}")
    print(f"  VEDIC BACKTEST: {symbol}/USDC | {days} days | ${capital}")
    print(f"{'='*60}")

    # Fetch price data
    candles = fetch_ohlcv(symbol, days, timeframe)
    if len(candles) < 10:
        print(f"  Not enough data for {symbol}")
        return BacktestResult(
            symbol=symbol, days=days, capital=capital, final_balance=capital,
            total_trades=0, wins=0, losses=0, total_pnl=0, win_rate=0,
            avg_return_pct=0, max_drawdown_pct=0, sharpe_ratio=0,
            sortino_ratio=0, avg_hold_hours=0,
        )

    # Simulation state
    balance = capital
    position = None  # {entry_price, quantity, entry_time, peak_price, trailing_active, ...}
    trades: List[BacktestTrade] = []
    balance_history = [capital]
    peak_balance = capital

    # Vedic-specific tracking
    nakshatra_stats: Dict[str, Dict] = {}
    dasha_stats: Dict[str, Dict] = {}

    print(f"  Simulating {len(candles)} candles...")

    for i, candle in enumerate(candles):
        ts_ms, open_p, high_p, low_p, close_p, volume = candle
        candle_dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        price = close_p

        # Compute vedic state at this historical moment
        try:
            sky = get_sky_state(candle_dt)
            vedic_score = compute_vedic_score(sky)
            transit_data = compute_symbol_transits([symbol], sky)
            ts_obj = transit_data.get(symbol)
            transit_score = ts_obj.score if ts_obj else None
            dasha = compute_dasha_for_symbol(symbol, candle_dt)
        except Exception:
            continue

        # Track nakshatra for stats
        nak_name = vedic_score.moon_nakshatra
        if nak_name not in nakshatra_stats:
            nakshatra_stats[nak_name] = {"buys": 0, "wins": 0, "pnl": 0.0}

        # Track dasha for stats
        dasha_lord = dasha.maha_dasha_lord if dasha else "Unknown"
        if dasha_lord not in dasha_stats:
            dasha_stats[dasha_lord] = {"buys": 0, "wins": 0, "pnl": 0.0}

        if position is None:
            # ── Evaluate BUY ──
            buy = True
            reason_parts = []

            if vedic_score.overall_score < BUY_SCORE_THRESHOLD:
                buy = False
            else:
                reason_parts.append(f"score={vedic_score.overall_score}")

            if buy and vedic_score.is_mercury_retrograde:
                buy = False

            if buy:
                muhurta_level = MUHURTA_LEVELS.get(vedic_score.muhurta_label, -99)
                if muhurta_level < MUHURTA_LEVELS.get(MIN_MUHURTA, 0):
                    buy = False
                else:
                    reason_parts.append(f"muhurta={vedic_score.muhurta_label}")

            if buy and vedic_score.moon_nakshatra_bias not in ALLOWED_NAKSHATRA_BIAS:
                buy = False

            if buy and transit_score is not None and transit_score < MIN_TRANSIT_SCORE:
                buy = False

            if buy and vedic_score.aspect_score < -0.4:
                buy = False

            if buy and dasha is not None and dasha.combined_bias < MIN_DASHA_BIAS:
                buy = False

            # ── Research-based lunar gates (Yuan et al) ──
            is_full_moon = vedic_score.tithi_number == 15

            if buy and is_full_moon:
                buy = False  # Purnima: strongest bearish day

            if buy and REQUIRE_SHUKLA_PAKSHA and vedic_score.lunar_paksha != "Shukla":
                buy = False  # Only buy during waxing moon

            if buy:
                size_usd = balance * POSITION_SIZE_PCT
                if size_usd >= 5:
                    quantity = size_usd / price
                    balance -= size_usd

                    position = {
                        "entry_price": price,
                        "quantity": quantity,
                        "entry_time": candle_dt,
                        "peak_price": price,
                        "trailing_active": False,
                        "vedic_score": vedic_score.overall_score,
                        "muhurta": vedic_score.muhurta_label,
                        "moon_nak": nak_name,
                        "mercury_rx": vedic_score.is_mercury_retrograde,
                        "transit_score": transit_score,
                        "dasha_lord": dasha_lord,
                    }

                    trades.append(BacktestTrade(
                        symbol=symbol, action="BUY", price=price, quantity=quantity,
                        timestamp=candle_dt, reason=" | ".join(reason_parts),
                        vedic_score=vedic_score.overall_score,
                        muhurta=vedic_score.muhurta_label,
                        moon_nakshatra=nak_name,
                        mercury_rx=vedic_score.is_mercury_retrograde,
                        transit_score=transit_score, dasha_lord=dasha_lord,
                    ))

                    nakshatra_stats[nak_name]["buys"] += 1
                    dasha_stats[dasha_lord]["buys"] += 1

        else:
            # ── Evaluate SELL ──
            entry_price = position["entry_price"]
            pnl_pct = (price - entry_price) / entry_price

            # Update peak for trailing
            if price > position["peak_price"]:
                position["peak_price"] = price

            sell = False
            reason = ""

            # Trailing stop
            peak = position["peak_price"]
            pnl_to_peak = (peak - entry_price) / entry_price
            if pnl_to_peak >= TRAILING_ACTIVATION_PCT:
                position["trailing_active"] = True
                trail_price = peak * (1 - TRAILING_STOP_PCT)
                if price <= trail_price:
                    sell = True
                    reason = f"TRAILING STOP (peak={peak:.2f})"

            # Hard stops
            if not sell and pnl_pct <= -STOP_LOSS_PCT:
                sell = True
                reason = f"STOP LOSS ({pnl_pct*100:.1f}%)"

            if not sell and pnl_pct >= TAKE_PROFIT_PCT:
                sell = True
                reason = f"TAKE PROFIT ({pnl_pct*100:.1f}%)"

            # Vedic conditions
            if not sell and vedic_score.overall_score < SELL_SCORE_THRESHOLD:
                sell = True
                reason = f"Vedic bearish ({vedic_score.overall_score})"

            # ── Research-based lunar exits (Yuan et al) ──
            is_full_moon_sell = vedic_score.tithi_number == 15
            is_krishna = vedic_score.lunar_paksha == "Krishna"

            if not sell and is_full_moon_sell and pnl_pct > 0:
                sell = True
                reason = f"FULL MOON EXIT (Purnima, +{pnl_pct*100:.1f}%)"

            if not sell and is_krishna and pnl_pct > 0.02:
                sell = True
                reason = f"KRISHNA PAKSHA EXIT (waning moon, +{pnl_pct*100:.1f}%)"

            if not sell and vedic_score.is_mercury_retrograde and pnl_pct > 0:
                sell = True
                reason = "Mercury Rx + profit"

            if not sell and vedic_score.moon_nakshatra_bias == "bearish" and pnl_pct > 0.01:
                sell = True
                reason = f"Bearish nakshatra ({vedic_score.moon_nakshatra})"

            if sell:
                quantity = position["quantity"]
                sell_value = quantity * price
                pnl = sell_value - (quantity * entry_price)
                hold_hours = (candle_dt - position["entry_time"]).total_seconds() / 3600

                balance += sell_value

                entry_nak = position["moon_nak"]
                entry_dasha = position["dasha_lord"]

                trades.append(BacktestTrade(
                    symbol=symbol, action="SELL", price=price, quantity=quantity,
                    timestamp=candle_dt, reason=reason,
                    vedic_score=vedic_score.overall_score,
                    muhurta=position["muhurta"],
                    moon_nakshatra=entry_nak,
                    mercury_rx=position["mercury_rx"],
                    transit_score=position["transit_score"],
                    dasha_lord=entry_dasha,
                    pnl=pnl, pnl_pct=pnl_pct * 100, hold_hours=hold_hours,
                    trailing_active=position["trailing_active"],
                ))

                # Update nakshatra/dasha stats
                if pnl > 0:
                    nakshatra_stats.get(entry_nak, {}).setdefault("wins", 0)
                    nakshatra_stats[entry_nak]["wins"] += 1
                    dasha_stats.get(entry_dasha, {}).setdefault("wins", 0)
                    dasha_stats[entry_dasha]["wins"] += 1
                nakshatra_stats.get(entry_nak, {}).setdefault("pnl", 0.0)
                nakshatra_stats[entry_nak]["pnl"] += pnl
                dasha_stats.get(entry_dasha, {}).setdefault("pnl", 0.0)
                dasha_stats[entry_dasha]["pnl"] += pnl

                position = None

        # Track balance for drawdown
        current_value = balance
        if position:
            current_value += position["quantity"] * price
        balance_history.append(current_value)
        if current_value > peak_balance:
            peak_balance = current_value

    # Close any open position at last price
    if position and candles:
        last_price = candles[-1][4]
        quantity = position["quantity"]
        sell_value = quantity * last_price
        pnl = sell_value - (quantity * position["entry_price"])
        pnl_pct = (last_price - position["entry_price"]) / position["entry_price"]
        balance += sell_value

        trades.append(BacktestTrade(
            symbol=symbol, action="SELL", price=last_price, quantity=quantity,
            timestamp=datetime.fromtimestamp(candles[-1][0]/1000, tz=timezone.utc),
            reason="END OF BACKTEST",
            vedic_score=0, muhurta="", moon_nakshatra="",
            mercury_rx=False, pnl=pnl, pnl_pct=pnl_pct*100,
        ))

    # ── Compute metrics ──
    sell_trades = [t for t in trades if t.action == "SELL"]
    wins = sum(1 for t in sell_trades if t.pnl > 0)
    losses = sum(1 for t in sell_trades if t.pnl <= 0)
    total_pnl = sum(t.pnl for t in sell_trades)
    n_trades = len(sell_trades)

    returns = [t.pnl_pct for t in sell_trades]
    avg_return = np.mean(returns) if returns else 0.0
    avg_hold = np.mean([t.hold_hours for t in sell_trades]) if sell_trades else 0.0

    # Max drawdown
    bal_arr = np.array(balance_history)
    running_max = np.maximum.accumulate(bal_arr)
    drawdowns = (bal_arr - running_max) / running_max * 100
    max_dd = abs(float(np.min(drawdowns))) if len(drawdowns) > 0 else 0.0

    # Sharpe & Sortino (annualized, assuming 4h candles = 6 per day)
    if len(returns) > 1:
        ret_arr = np.array(returns)
        std = np.std(ret_arr)
        sharpe = (np.mean(ret_arr) / std * math.sqrt(365 * 6)) if std > 0 else 0.0
        downside = ret_arr[ret_arr < 0]
        down_std = np.std(downside) if len(downside) > 0 else 1.0
        sortino = (np.mean(ret_arr) / down_std * math.sqrt(365 * 6)) if down_std > 0 else 0.0
    else:
        sharpe = 0.0
        sortino = 0.0

    # Vedic-specific metrics
    auspicious_trades = [t for t in sell_trades if t.muhurta in ("auspicious", "very_auspicious")]
    wins_auspicious = sum(1 for t in auspicious_trades if t.pnl > 0)
    merc_rx_trades = [t for t in sell_trades if t.mercury_rx]
    wins_merc_rx = sum(1 for t in merc_rx_trades if t.pnl > 0)

    result = BacktestResult(
        symbol=symbol, days=days, capital=capital, final_balance=round(balance, 2),
        total_trades=n_trades, wins=wins, losses=losses,
        total_pnl=round(total_pnl, 2),
        win_rate=round(wins / max(n_trades, 1) * 100, 1),
        avg_return_pct=round(avg_return, 2),
        max_drawdown_pct=round(max_dd, 2),
        sharpe_ratio=round(sharpe, 2),
        sortino_ratio=round(sortino, 2),
        avg_hold_hours=round(avg_hold, 1),
        trades=trades,
        wins_auspicious_muhurta=wins_auspicious,
        total_auspicious_muhurta=len(auspicious_trades),
        wins_merc_rx=wins_merc_rx,
        total_merc_rx=len(merc_rx_trades),
        nakshatra_performance=nakshatra_stats,
        dasha_performance=dasha_stats,
    )

    return result


# ── Output ───────────────────────────────────────────────────────────

def print_result(r: BacktestResult):
    """Print backtest result in formatted table."""
    print(f"\n{'='*60}")
    print(f"  RESULTS: {r.symbol}/USDC | {r.days} days")
    print(f"{'='*60}")

    print(f"\n  Capital:        ${r.capital:,.2f} -> ${r.final_balance:,.2f}")
    print(f"  Total P&L:      ${r.total_pnl:+,.2f} ({(r.final_balance/r.capital-1)*100:+.1f}%)")
    print(f"  Trades:         {r.total_trades} ({r.wins}W / {r.losses}L)")
    print(f"  Win Rate:       {r.win_rate}%")
    print(f"  Avg Return:     {r.avg_return_pct:+.2f}%")
    print(f"  Max Drawdown:   {r.max_drawdown_pct:.2f}%")
    print(f"  Sharpe Ratio:   {r.sharpe_ratio}")
    print(f"  Sortino Ratio:  {r.sortino_ratio}")
    print(f"  Avg Hold:       {r.avg_hold_hours:.1f}h")

    # Vedic-specific
    print(f"\n  -- Vedic Metrics --")
    if r.total_auspicious_muhurta > 0:
        auspicious_wr = r.wins_auspicious_muhurta / r.total_auspicious_muhurta * 100
        print(f"  Auspicious Muhurta WR:  {auspicious_wr:.0f}% ({r.wins_auspicious_muhurta}/{r.total_auspicious_muhurta})")
    if r.total_merc_rx > 0:
        rx_wr = r.wins_merc_rx / r.total_merc_rx * 100
        print(f"  Mercury Rx WR:          {rx_wr:.0f}% ({r.wins_merc_rx}/{r.total_merc_rx})")

    # Nakshatra breakdown
    if r.nakshatra_performance:
        print(f"\n  -- Nakshatra Performance --")
        sorted_naks = sorted(
            r.nakshatra_performance.items(),
            key=lambda x: x[1].get("pnl", 0), reverse=True
        )
        for nak, stats in sorted_naks:
            buys = stats.get("buys", 0)
            if buys == 0:
                continue
            wins = stats.get("wins", 0)
            pnl = stats.get("pnl", 0)
            wr = wins / buys * 100 if buys > 0 else 0
            print(f"    {nak:<20s}  {buys:>3d} trades  {wr:>5.0f}% WR  ${pnl:>+8.2f}")

    # Dasha breakdown
    if r.dasha_performance:
        print(f"\n  -- Dasha Period Performance --")
        for lord, stats in sorted(r.dasha_performance.items(), key=lambda x: x[1].get("pnl", 0), reverse=True):
            buys = stats.get("buys", 0)
            if buys == 0:
                continue
            wins = stats.get("wins", 0)
            pnl = stats.get("pnl", 0)
            wr = wins / buys * 100 if buys > 0 else 0
            print(f"    {lord:<12s}  {buys:>3d} trades  {wr:>5.0f}% WR  ${pnl:>+8.2f}")

    # Last 5 trades
    sell_trades = [t for t in r.trades if t.action == "SELL"]
    if sell_trades:
        print(f"\n  -- Last 5 Trades --")
        for t in sell_trades[-5:]:
            emoji = "+" if t.pnl > 0 else "-"
            trail = " [T]" if t.trailing_active else ""
            print(f"    {emoji} {t.timestamp.strftime('%Y-%m-%d %H:%M')} "
                  f"${t.pnl:+.2f} ({t.pnl_pct:+.1f}%){trail} "
                  f"| {t.reason}")


def result_to_json(r: BacktestResult) -> dict:
    """Convert result to JSON-serializable dict."""
    return {
        "symbol": r.symbol,
        "days": r.days,
        "capital": r.capital,
        "final_balance": r.final_balance,
        "total_pnl": r.total_pnl,
        "total_return_pct": round((r.final_balance / r.capital - 1) * 100, 2),
        "total_trades": r.total_trades,
        "wins": r.wins,
        "losses": r.losses,
        "win_rate": r.win_rate,
        "avg_return_pct": r.avg_return_pct,
        "max_drawdown_pct": r.max_drawdown_pct,
        "sharpe_ratio": r.sharpe_ratio,
        "sortino_ratio": r.sortino_ratio,
        "avg_hold_hours": r.avg_hold_hours,
        "vedic_metrics": {
            "auspicious_muhurta_wr": round(
                r.wins_auspicious_muhurta / max(r.total_auspicious_muhurta, 1) * 100, 1
            ),
            "auspicious_muhurta_trades": r.total_auspicious_muhurta,
            "mercury_rx_wr": round(
                r.wins_merc_rx / max(r.total_merc_rx, 1) * 100, 1
            ),
            "mercury_rx_trades": r.total_merc_rx,
        },
        "nakshatra_performance": r.nakshatra_performance,
        "dasha_performance": r.dasha_performance,
    }


# ── CLI ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Vedic Astrology Backtester")
    parser.add_argument("--symbol", type=str, help="Single symbol (e.g. BTC)")
    parser.add_argument("--all", action="store_true", help="Backtest all 16 symbols")
    parser.add_argument("--days", type=int, default=90, help="Lookback days (default: 90)")
    parser.add_argument("--capital", type=float, default=1000.0, help="Paper capital (default: 1000)")
    parser.add_argument("--timeframe", type=str, default="4h", help="Candle timeframe (default: 4h)")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    if not args.symbol and not args.all:
        parser.error("Must specify --symbol or --all")

    symbols = list(CRYPTO_GENESIS.keys()) if args.all else [args.symbol.upper()]

    # Validate symbols
    for sym in symbols:
        if sym not in CRYPTO_GENESIS:
            print(f"Warning: {sym} has no natal chart, skipping")
            symbols.remove(sym)

    results = []
    for sym in symbols:
        try:
            r = run_backtest(sym, args.days, args.capital, args.timeframe)
            results.append(r)
            if not args.json:
                print_result(r)
        except Exception as e:
            print(f"  ERROR backtesting {sym}: {e}")
            import traceback
            traceback.print_exc()

    if args.json:
        output = [result_to_json(r) for r in results]
        print(json.dumps(output if len(output) > 1 else output[0], indent=2))
    elif len(results) > 1:
        # Summary table for --all
        print(f"\n{'='*70}")
        print(f"  SUMMARY: {len(results)} symbols | {args.days} days")
        print(f"{'='*70}")
        print(f"  {'Symbol':<8s} {'Trades':>6s} {'WR':>6s} {'P&L':>10s} {'Return':>8s} {'Sharpe':>7s} {'MaxDD':>7s}")
        print(f"  {'-'*8} {'-'*6} {'-'*6} {'-'*10} {'-'*8} {'-'*7} {'-'*7}")

        total_pnl = 0
        total_trades = 0
        total_wins = 0
        for r in sorted(results, key=lambda x: x.total_pnl, reverse=True):
            ret_pct = (r.final_balance / r.capital - 1) * 100
            print(f"  {r.symbol:<8s} {r.total_trades:>6d} {r.win_rate:>5.0f}% "
                  f"${r.total_pnl:>+9.2f} {ret_pct:>+7.1f}% {r.sharpe_ratio:>7.1f} "
                  f"{r.max_drawdown_pct:>6.1f}%")
            total_pnl += r.total_pnl
            total_trades += r.total_trades
            total_wins += r.wins

        overall_wr = total_wins / max(total_trades, 1) * 100
        print(f"  {'-'*8} {'-'*6} {'-'*6} {'-'*10} {'-'*8}")
        print(f"  {'TOTAL':<8s} {total_trades:>6d} {overall_wr:>5.0f}% ${total_pnl:>+9.2f}")


if __name__ == "__main__":
    main()
