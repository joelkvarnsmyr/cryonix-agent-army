#!/usr/bin/env python3
"""
Strategy Lab: Python Backtester

Runs historical OHLCV data through the REAL QuantGuild engine and simulates
position management to compute performance metrics.

Usage:
  python3 scripts/strategy-lab/backtest.py --symbol BTC/USDC --days 30 --capital 42
  python3 scripts/strategy-lab/backtest.py --symbol ETH/USDC --days 14 --no-save
  python3 scripts/strategy-lab/backtest.py --symbol SOL/USDC --days 7 --json
"""
import argparse
import json
import math
import os
import sys
import time
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import ccxt
import numpy as np
import pandas as pd
from tabulate import tabulate

# Import shared db helper
sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg

# Import QuantGuild engine
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine', 'src'))
from guilds.quant import QuantGuild


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class BacktestConfig:
    symbol: str = 'BTC/USDC'
    days: int = 30
    timeframe: str = '15m'
    capital: float = 10000.0
    fee_pct: float = 0.001          # 0.1% per side
    max_positions: int = 3
    position_size_pct: float = 0.25  # 25% of equity per position
    min_confidence: float = 0.65
    trailing_stop_pct: float = 0.03  # 3%
    trailing_profit_threshold: float = 0.015  # 1.5%


# ---------------------------------------------------------------------------
# DataFetcher — paginated CCXT OHLCV
# ---------------------------------------------------------------------------

class DataFetcher:
    """Fetches multi-timeframe OHLCV data via CCXT (public, no API key)."""

    TF_CONFIG = {
        '15m': {'ms': 15 * 60 * 1000,  'extra': 100},
        '1h':  {'ms': 60 * 60 * 1000,  'extra': 48},
        '4h':  {'ms': 4 * 60 * 60 * 1000, 'extra': 24},
        '1d':  {'ms': 24 * 60 * 60 * 1000, 'extra': 14},
    }

    def __init__(self, symbol: str, days: int, primary_tf: str = '15m'):
        self.symbol = symbol
        self.days = days
        self.primary_tf = primary_tf
        self.exchange = ccxt.binance({'enableRateLimit': True})

    def fetch_all(self) -> Dict[str, List[list]]:
        """Fetch primary + higher timeframes. Returns {tf: [[ts,o,h,l,c,v], ...]}."""
        data = {}
        for tf, cfg in self.TF_CONFIG.items():
            candles_per_day = (24 * 60 * 60 * 1000) // cfg['ms']
            needed = self.days * candles_per_day + cfg['extra']
            print(f'  Fetching {tf}: ~{needed} candles ... ', end='', flush=True)
            data[tf] = self._paginated_fetch(tf, needed)
            print(f'{len(data[tf])} fetched')
            time.sleep(0.5)  # rate limit courtesy
        return data

    def _paginated_fetch(self, timeframe: str, limit: int) -> List[list]:
        """Fetch OHLCV with pagination (max 1000 per request)."""
        all_candles: List[list] = []
        cfg = self.TF_CONFIG[timeframe]
        since = int(time.time() * 1000) - limit * cfg['ms']
        batch_size = 1000

        while len(all_candles) < limit:
            batch = self.exchange.fetch_ohlcv(
                self.symbol, timeframe, since=since, limit=batch_size
            )
            if not batch:
                break
            all_candles.extend(batch)
            since = batch[-1][0] + cfg['ms']
            if len(batch) < batch_size:
                break
            time.sleep(self.exchange.rateLimit / 1000)

        return all_candles


# ---------------------------------------------------------------------------
# Position / Trade dataclasses
# ---------------------------------------------------------------------------

@dataclass
class Position:
    symbol: str
    entry_price: float
    entry_time: datetime
    entry_idx: int
    size_usd: float
    stop_loss: float
    take_profit: float
    trailing_stop: float
    high_water_mark: float
    patterns: List[str]
    confidence: float
    reason: str


@dataclass
class Trade:
    symbol: str
    entry_price: float
    exit_price: float
    entry_time: datetime
    exit_time: datetime
    entry_idx: int
    exit_idx: int
    size_usd: float
    pnl: float
    pnl_pct: float
    fee_paid: float
    patterns: List[str]
    confidence: float
    exit_reason: str  # 'take_profit', 'stop_loss', 'trailing_stop', 'force_close'


@dataclass
class EquityPoint:
    timestamp: datetime
    equity: float
    idx: int


# ---------------------------------------------------------------------------
# PositionManager — SL / TP / trailing stop simulation
# ---------------------------------------------------------------------------

class PositionManager:
    """Manages open positions and simulates exits matching production logic."""

    def __init__(self, config: BacktestConfig):
        self.config = config
        self.positions: List[Position] = []
        self.trades: List[Trade] = []

    def can_open(self, symbol: str) -> bool:
        if len(self.positions) >= self.config.max_positions:
            return False
        for p in self.positions:
            if p.symbol == symbol:
                return False
        return True

    def open_position(self, signal: Dict[str, Any], current_time: datetime,
                      idx: int, equity: float) -> Optional[Position]:
        size_usd = equity * self.config.position_size_pct
        entry_price = signal['entry_price']
        fee = size_usd * self.config.fee_pct

        pos = Position(
            symbol=self.config.symbol,
            entry_price=entry_price,
            entry_time=current_time,
            entry_idx=idx,
            size_usd=size_usd - fee,  # net of entry fee
            stop_loss=signal['stop_loss'],
            take_profit=signal['target_price'],
            trailing_stop=0.0,
            high_water_mark=entry_price,
            patterns=signal.get('patterns', []),
            confidence=signal.get('confidence', 0),
            reason=signal.get('reason', ''),
        )
        self.positions.append(pos)
        return pos

    def check_exits(self, candle_high: float, candle_low: float,
                    candle_close: float, candle_time: datetime,
                    idx: int) -> List[Trade]:
        """Check all open positions for exit conditions. Returns closed trades."""
        closed = []
        remaining = []

        for pos in self.positions:
            exit_price = None
            exit_reason = None

            # Update high water mark and trailing stop
            if candle_high > pos.high_water_mark:
                pos.high_water_mark = candle_high
                profit_pct = (candle_high - pos.entry_price) / pos.entry_price
                if profit_pct >= self.config.trailing_profit_threshold:
                    new_trail = candle_high * (1 - self.config.trailing_stop_pct)
                    if new_trail > pos.trailing_stop:
                        pos.trailing_stop = new_trail

            # Check exit conditions (order: TP > SL > trailing)
            if candle_high >= pos.take_profit:
                exit_price = pos.take_profit
                exit_reason = 'take_profit'
            elif candle_low <= pos.stop_loss:
                exit_price = pos.stop_loss
                exit_reason = 'stop_loss'
            elif (candle_low <= pos.trailing_stop
                  and pos.trailing_stop > pos.entry_price):
                pnl_check = (candle_close - pos.entry_price) / pos.entry_price
                if pnl_check > 0 or candle_low <= pos.trailing_stop:
                    exit_price = pos.trailing_stop
                    exit_reason = 'trailing_stop'

            if exit_price is not None:
                trade = self._close_position(pos, exit_price, candle_time, idx, exit_reason)
                closed.append(trade)
            else:
                remaining.append(pos)

        self.positions = remaining
        return closed

    def force_close_all(self, close_price: float, close_time: datetime,
                        idx: int) -> List[Trade]:
        closed = []
        for pos in self.positions:
            trade = self._close_position(pos, close_price, close_time, idx, 'force_close')
            closed.append(trade)
        self.positions = []
        return closed

    def unrealized_pnl(self, current_price: float) -> float:
        total = 0.0
        for pos in self.positions:
            qty = pos.size_usd / pos.entry_price
            total += qty * (current_price - pos.entry_price)
        return total

    def _close_position(self, pos: Position, exit_price: float,
                        exit_time: datetime, exit_idx: int,
                        reason: str) -> Trade:
        qty = pos.size_usd / pos.entry_price
        gross_pnl = qty * (exit_price - pos.entry_price)
        exit_value = qty * exit_price
        exit_fee = exit_value * self.config.fee_pct
        net_pnl = gross_pnl - exit_fee
        pnl_pct = (exit_price - pos.entry_price) / pos.entry_price * 100

        trade = Trade(
            symbol=pos.symbol,
            entry_price=pos.entry_price,
            exit_price=exit_price,
            entry_time=pos.entry_time,
            exit_time=exit_time,
            entry_idx=pos.entry_idx,
            exit_idx=exit_idx,
            size_usd=pos.size_usd,
            pnl=net_pnl,
            pnl_pct=pnl_pct,
            fee_paid=exit_fee,
            patterns=pos.patterns,
            confidence=pos.confidence,
            exit_reason=reason,
        )
        self.trades.append(trade)
        return trade


# ---------------------------------------------------------------------------
# Backtester — main simulation loop
# ---------------------------------------------------------------------------

class Backtester:
    """Runs the QuantGuild engine over historical data and simulates trades."""

    WINDOW = 100  # candles passed to quant.analyze()

    def __init__(self, config: BacktestConfig):
        self.config = config
        self.quant = QuantGuild()
        self.pm = PositionManager(config)
        self.equity_curve: List[EquityPoint] = []
        self.signals_generated = 0

    def run(self, data: Dict[str, List[list]]) -> Tuple[List[Trade], List[EquityPoint]]:
        primary = data[self.config.timeframe]
        if len(primary) < self.WINDOW + 1:
            print(f'ERROR: Need at least {self.WINDOW + 1} candles, got {len(primary)}')
            return [], []

        # Pre-compute timestamp arrays for bisect
        htf_timestamps = {}
        for tf in ['1h', '4h', '1d']:
            if tf in data and data[tf]:
                htf_timestamps[tf] = [c[0] for c in data[tf]]

        realized_pnl = 0.0
        equity = self.config.capital

        print(f'\n  Simulating {len(primary) - self.WINDOW} candles...')

        for i in range(self.WINDOW, len(primary)):
            candle = primary[i]
            ts, o, h, l, c, v = candle[0], candle[1], candle[2], candle[3], candle[4], candle[5]
            candle_time = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)

            # 1. Check exits on open positions
            closed = self.pm.check_exits(h, l, c, candle_time, i)
            for trade in closed:
                realized_pnl += trade.pnl

            # 2. Build multi-TF slice at current timestamp
            multi_tf = {}
            for tf in ['1h', '4h', '1d']:
                if tf in htf_timestamps:
                    idx = bisect_right(htf_timestamps[tf], ts)
                    if idx > 0:
                        multi_tf[tf] = data[tf][:idx]

            # 3. Run QuantGuild analysis
            window = primary[i - self.WINDOW:i]
            try:
                result = self.quant.analyze(window, self.config.symbol, multi_tf or None)
            except Exception as e:
                continue

            if result.get('status') == 'insufficient_data':
                continue

            signal = result.get('signal', {})
            if not signal:
                continue

            # 4. Check for BUY signal (spot-only)
            action = signal.get('action', 'HOLD')
            confidence = signal.get('confidence', 0)

            if (action == 'BUY'
                    and confidence >= self.config.min_confidence
                    and self.pm.can_open(self.config.symbol)):
                self.signals_generated += 1
                equity = self.config.capital + realized_pnl + self.pm.unrealized_pnl(c)
                self.pm.open_position(signal, candle_time, i, equity)

            # 5. Sample equity curve every 10 candles
            if i % 10 == 0:
                equity = self.config.capital + realized_pnl + self.pm.unrealized_pnl(c)
                self.equity_curve.append(EquityPoint(
                    timestamp=candle_time, equity=equity, idx=i
                ))

        # Force-close remaining positions at last close
        last = primary[-1]
        last_time = datetime.fromtimestamp(last[0] / 1000, tz=timezone.utc)
        force_closed = self.pm.force_close_all(last[4], last_time, len(primary) - 1)
        for trade in force_closed:
            realized_pnl += trade.pnl

        # Final equity point
        final_equity = self.config.capital + realized_pnl
        self.equity_curve.append(EquityPoint(
            timestamp=last_time, equity=final_equity, idx=len(primary) - 1
        ))

        return self.pm.trades, self.equity_curve


# ---------------------------------------------------------------------------
# MetricsCalculator
# ---------------------------------------------------------------------------

class MetricsCalculator:
    """Computes performance metrics from trades and equity curve."""

    @staticmethod
    def compute(trades: List[Trade], equity_curve: List[EquityPoint],
                initial_capital: float, trading_days: int) -> Dict[str, Any]:
        if not trades:
            return MetricsCalculator._empty_metrics(initial_capital, trading_days)

        total_pnl = sum(t.pnl for t in trades)
        total_fees = sum(t.fee_paid for t in trades)
        wins = [t for t in trades if t.pnl > 0]
        losses = [t for t in trades if t.pnl <= 0]

        win_rate = len(wins) / len(trades) * 100 if trades else 0
        avg_win = np.mean([t.pnl for t in wins]) if wins else 0
        avg_loss = np.mean([abs(t.pnl) for t in losses]) if losses else 0
        gross_profit = sum(t.pnl for t in wins)
        gross_loss = abs(sum(t.pnl for t in losses))
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else (float('inf') if gross_profit > 0 else 0)

        # Expectancy
        expectancy = (win_rate / 100 * avg_win) - ((100 - win_rate) / 100 * avg_loss) if trades else 0

        # Return %
        total_return_pct = (total_pnl / initial_capital) * 100
        annualized = MetricsCalculator._annualized_return(total_return_pct, trading_days)

        # Daily returns from equity curve
        daily_returns = MetricsCalculator._daily_returns(equity_curve)
        sharpe = MetricsCalculator._sharpe(daily_returns)
        sortino = MetricsCalculator._sortino(daily_returns)

        # Drawdown
        dd = MetricsCalculator._drawdown(equity_curve, initial_capital)
        calmar = annualized / abs(dd['max_dd_pct']) if dd['max_dd_pct'] != 0 else 0

        # Consecutive
        consec = MetricsCalculator._consecutive(trades)

        # Exit reasons
        exit_reasons = {}
        for t in trades:
            exit_reasons[t.exit_reason] = exit_reasons.get(t.exit_reason, 0) + 1

        # Pattern breakdown
        pattern_perf = MetricsCalculator._pattern_breakdown(trades, total_pnl)

        # Monthly returns
        monthly = MetricsCalculator._monthly_returns(trades)

        return {
            'total_trades': len(trades),
            'winning_trades': len(wins),
            'losing_trades': len(losses),
            'win_rate': round(win_rate, 1),
            'total_pnl': round(total_pnl, 4),
            'total_fees': round(total_fees, 4),
            'total_return_pct': round(total_return_pct, 2),
            'annualized_return_pct': round(annualized, 2),
            'avg_win': round(float(avg_win), 4),
            'avg_loss': round(float(avg_loss), 4),
            'largest_win': round(max(t.pnl for t in trades), 4),
            'largest_loss': round(min(t.pnl for t in trades), 4),
            'profit_factor': round(profit_factor, 2) if profit_factor != float('inf') else 999.99,
            'expectancy': round(expectancy, 4),
            'sharpe_ratio': round(sharpe, 2),
            'sortino_ratio': round(sortino, 2),
            'calmar_ratio': round(calmar, 2),
            'max_drawdown': round(dd['max_dd'], 4),
            'max_drawdown_pct': round(dd['max_dd_pct'], 2),
            'max_dd_duration_days': round(dd['duration_days'], 1),
            'max_consec_wins': consec[0],
            'max_consec_losses': consec[1],
            'exit_reasons': exit_reasons,
            'pattern_performance': pattern_perf,
            'monthly_returns': monthly,
            'trading_days': trading_days,
            'initial_capital': initial_capital,
            'final_equity': round(initial_capital + total_pnl, 4),
        }

    @staticmethod
    def _empty_metrics(initial_capital: float, trading_days: int) -> Dict[str, Any]:
        return {
            'total_trades': 0, 'winning_trades': 0, 'losing_trades': 0,
            'win_rate': 0, 'total_pnl': 0, 'total_fees': 0,
            'total_return_pct': 0, 'annualized_return_pct': 0,
            'avg_win': 0, 'avg_loss': 0, 'largest_win': 0, 'largest_loss': 0,
            'profit_factor': 0, 'expectancy': 0,
            'sharpe_ratio': 0, 'sortino_ratio': 0, 'calmar_ratio': 0,
            'max_drawdown': 0, 'max_drawdown_pct': 0, 'max_dd_duration_days': 0,
            'max_consec_wins': 0, 'max_consec_losses': 0,
            'exit_reasons': {}, 'pattern_performance': {},
            'monthly_returns': {}, 'trading_days': trading_days,
            'initial_capital': initial_capital, 'final_equity': initial_capital,
        }

    @staticmethod
    def _daily_returns(curve: List[EquityPoint]) -> List[float]:
        if len(curve) < 2:
            return []
        # Group by date, take last equity per day
        by_day: Dict[str, float] = {}
        for pt in curve:
            day = pt.timestamp.strftime('%Y-%m-%d')
            by_day[day] = pt.equity
        days = sorted(by_day.keys())
        if len(days) < 2:
            return []
        returns = []
        for i in range(1, len(days)):
            prev = by_day[days[i - 1]]
            curr = by_day[days[i]]
            if prev > 0:
                returns.append((curr - prev) / prev)
        return returns

    @staticmethod
    def _sharpe(daily_returns: List[float]) -> float:
        if len(daily_returns) < 2:
            return 0.0
        mean = np.mean(daily_returns)
        std = np.std(daily_returns, ddof=1)
        if std == 0:
            return float('inf') if mean > 0 else 0.0
        return float(mean / std * math.sqrt(252))

    @staticmethod
    def _sortino(daily_returns: List[float]) -> float:
        if len(daily_returns) < 2:
            return 0.0
        mean = np.mean(daily_returns)
        neg = [r for r in daily_returns if r < 0]
        if not neg:
            return float('inf') if mean > 0 else 0.0
        downside_var = np.mean([r ** 2 for r in neg])
        downside_std = math.sqrt(downside_var)
        if downside_std == 0:
            return float('inf') if mean > 0 else 0.0
        return float(mean / downside_std * math.sqrt(252))

    @staticmethod
    def _annualized_return(period_return_pct: float, days: int) -> float:
        if days <= 0:
            return 0.0
        periods_per_year = 365 / days
        total = 1 + period_return_pct / 100
        if total <= 0:
            return -100.0
        return (total ** periods_per_year - 1) * 100

    @staticmethod
    def _drawdown(curve: List[EquityPoint], initial: float) -> Dict[str, float]:
        if not curve:
            return {'max_dd': 0, 'max_dd_pct': 0, 'duration_days': 0}
        peak = initial
        max_dd = 0.0
        max_dd_pct = 0.0
        dd_start = None
        max_duration = 0.0

        for pt in curve:
            if pt.equity > peak:
                if dd_start is not None:
                    dur = (pt.timestamp - dd_start).total_seconds() / 86400
                    max_duration = max(max_duration, dur)
                    dd_start = None
                peak = pt.equity
            else:
                if dd_start is None:
                    dd_start = pt.timestamp
                dd = peak - pt.equity
                dd_pct = (dd / peak) * 100
                if dd > max_dd:
                    max_dd = dd
                    max_dd_pct = dd_pct

        # If still in drawdown at end
        if dd_start is not None and curve:
            dur = (curve[-1].timestamp - dd_start).total_seconds() / 86400
            max_duration = max(max_duration, dur)

        return {'max_dd': max_dd, 'max_dd_pct': max_dd_pct, 'duration_days': max_duration}

    @staticmethod
    def _consecutive(trades: List[Trade]) -> Tuple[int, int]:
        max_w, max_l, cur_w, cur_l = 0, 0, 0, 0
        for t in trades:
            if t.pnl > 0:
                cur_w += 1
                cur_l = 0
                max_w = max(max_w, cur_w)
            else:
                cur_l += 1
                cur_w = 0
                max_l = max(max_l, cur_l)
        return max_w, max_l

    @staticmethod
    def _pattern_breakdown(trades: List[Trade], total_pnl: float) -> Dict[str, Any]:
        by_pattern: Dict[str, List[Trade]] = {}
        for t in trades:
            key = ' + '.join(t.patterns) if t.patterns else 'unknown'
            by_pattern.setdefault(key, []).append(t)
            # Also expand individual patterns
            if len(t.patterns) > 1:
                for p in t.patterns:
                    by_pattern.setdefault(p, []).append(t)

        result = {}
        for pattern, ptrades in by_pattern.items():
            wins = [t for t in ptrades if t.pnl > 0]
            pat_pnl = sum(t.pnl for t in ptrades)
            gp = sum(t.pnl for t in wins)
            gl = abs(sum(t.pnl for t in ptrades if t.pnl <= 0))
            result[pattern] = {
                'trades': len(ptrades),
                'win_rate': round(len(wins) / len(ptrades) * 100, 1) if ptrades else 0,
                'avg_return_pct': round(np.mean([t.pnl_pct for t in ptrades]), 2) if ptrades else 0,
                'profit_factor': round(gp / gl, 2) if gl > 0 else (999.99 if gp > 0 else 0),
                'total_pnl': round(pat_pnl, 4),
                'contribution_pct': round((pat_pnl / abs(total_pnl)) * 100, 1) if total_pnl != 0 else 0,
            }
        return result

    @staticmethod
    def _monthly_returns(trades: List[Trade]) -> Dict[str, float]:
        by_month: Dict[str, float] = {}
        for t in trades:
            key = t.exit_time.strftime('%Y-%m')
            by_month[key] = by_month.get(key, 0) + t.pnl
        return {k: round(v, 4) for k, v in sorted(by_month.items())}


# ---------------------------------------------------------------------------
# CLI Report
# ---------------------------------------------------------------------------

def print_report(config: BacktestConfig, metrics: Dict[str, Any]):
    """Print formatted backtest report."""
    print('\n' + '=' * 72)
    print('  BACKTEST REPORT')
    print(f'  {config.symbol} | {config.days}d | {config.timeframe} | '
          f'Capital: ${config.capital:,.2f}')
    print(f'  Generated: {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}')
    print('=' * 72)

    if metrics['total_trades'] == 0:
        print('\n  No trades generated.\n')
        return

    # --- Returns ---
    print('\n  RETURNS')
    print(f'  {"Total P&L:":<25} ${metrics["total_pnl"]:>10,.4f}  '
          f'({metrics["total_return_pct"]:+.2f}%)')
    print(f'  {"Final Equity:":<25} ${metrics["final_equity"]:>10,.4f}')
    print(f'  {"Annualized Return:":<25} {metrics["annualized_return_pct"]:>10.2f}%')
    print(f'  {"Total Fees Paid:":<25} ${metrics["total_fees"]:>10,.4f}')

    # --- Risk-Adjusted ---
    print('\n  RISK-ADJUSTED')
    ret_table = [
        ['Sharpe Ratio', f'{metrics["sharpe_ratio"]:.2f}'],
        ['Sortino Ratio', f'{metrics["sortino_ratio"]:.2f}'],
        ['Calmar Ratio', f'{metrics["calmar_ratio"]:.2f}'],
        ['Max Drawdown', f'${metrics["max_drawdown"]:.4f} ({metrics["max_drawdown_pct"]:.2f}%)'],
        ['Max DD Duration', f'{metrics["max_dd_duration_days"]:.1f} days'],
    ]
    print(tabulate(ret_table, tablefmt='simple', colalign=('left', 'right')))

    # --- Trade Stats ---
    print('\n  TRADE STATISTICS')
    trade_table = [
        ['Total Trades', metrics['total_trades']],
        ['Win Rate', f'{metrics["win_rate"]:.1f}%'],
        ['Avg Win', f'${metrics["avg_win"]:.4f}'],
        ['Avg Loss', f'${metrics["avg_loss"]:.4f}'],
        ['Largest Win', f'${metrics["largest_win"]:.4f}'],
        ['Largest Loss', f'${metrics["largest_loss"]:.4f}'],
        ['Profit Factor', f'{metrics["profit_factor"]:.2f}'],
        ['Expectancy', f'${metrics["expectancy"]:.4f}'],
        ['Max Consec Wins', metrics['max_consec_wins']],
        ['Max Consec Losses', metrics['max_consec_losses']],
    ]
    print(tabulate(trade_table, tablefmt='simple', colalign=('left', 'right')))

    # --- Exit Reasons ---
    print('\n  EXIT REASONS')
    exit_table = []
    for reason, count in sorted(metrics['exit_reasons'].items(), key=lambda x: -x[1]):
        pct = count / metrics['total_trades'] * 100
        exit_table.append([reason, count, f'{pct:.1f}%'])
    print(tabulate(exit_table, headers=['Reason', 'Count', '%'], tablefmt='simple'))

    # --- Pattern Breakdown ---
    pp = metrics.get('pattern_performance', {})
    if pp:
        print('\n  PATTERN BREAKDOWN')
        pat_table = []
        for pat, data in sorted(pp.items(), key=lambda x: -x[1].get('total_pnl', 0)):
            pat_table.append([
                pat[:30],
                data['trades'],
                f'{data["win_rate"]:.1f}%',
                f'{data["avg_return_pct"]:.2f}%',
                f'{data["profit_factor"]:.2f}',
                f'${data["total_pnl"]:.4f}',
                f'{data["contribution_pct"]:.1f}%',
            ])
        print(tabulate(pat_table,
                       headers=['Pattern', 'Trades', 'Win%', 'Avg Ret', 'PF', 'P&L', 'Contrib'],
                       tablefmt='simple'))

    # --- Monthly Returns ---
    monthly = metrics.get('monthly_returns', {})
    if monthly:
        print('\n  MONTHLY RETURNS')
        mon_table = [[m, f'${v:+.4f}'] for m, v in monthly.items()]
        print(tabulate(mon_table, headers=['Month', 'P&L'], tablefmt='simple'))

    # --- Production Readiness ---
    print('\n  PRODUCTION READINESS')
    checks = [
        ('Sharpe >= 0.5', metrics['sharpe_ratio'] >= 0.5),
        ('Win Rate >= 40%', metrics['win_rate'] >= 40),
        ('Max DD <= 15%', metrics['max_drawdown_pct'] <= 15),
        ('Profit Factor >= 1.2', metrics['profit_factor'] >= 1.2),
        ('Trades >= 10', metrics['total_trades'] >= 10),
    ]
    passed = sum(1 for _, ok in checks if ok)
    for label, ok in checks:
        mark = 'PASS' if ok else 'FAIL'
        print(f'  [{mark}] {label}')
    print(f'\n  Score: {passed}/{len(checks)} checks passed')

    if passed == len(checks):
        print('  --> PRODUCTION READY')
    elif passed >= 3:
        print('  --> MARGINAL — review failing checks')
    else:
        print('  --> NOT READY — significant issues')

    print('')


# ---------------------------------------------------------------------------
# Postgres persistence
# ---------------------------------------------------------------------------

def save_to_postgres(config: BacktestConfig, metrics: Dict[str, Any],
                     trades: List[Trade], equity_curve: List[EquityPoint]):
    """Save backtest results to backtest_results table."""
    pg = get_pg()
    try:
        cur = pg.cursor()

        config_json = {
            'symbol': config.symbol,
            'days': config.days,
            'timeframe': config.timeframe,
            'capital': config.capital,
            'fee_pct': config.fee_pct,
            'max_positions': config.max_positions,
            'position_size_pct': config.position_size_pct,
            'min_confidence': config.min_confidence,
            'trailing_stop_pct': config.trailing_stop_pct,
            'trailing_profit_threshold': config.trailing_profit_threshold,
        }

        trades_json = [{
            'symbol': t.symbol,
            'entry_price': t.entry_price,
            'exit_price': t.exit_price,
            'entry_time': t.entry_time.isoformat(),
            'exit_time': t.exit_time.isoformat(),
            'size_usd': t.size_usd,
            'pnl': t.pnl,
            'pnl_pct': t.pnl_pct,
            'fee_paid': t.fee_paid,
            'patterns': t.patterns,
            'confidence': t.confidence,
            'exit_reason': t.exit_reason,
        } for t in trades]

        equity_json = [{
            'timestamp': pt.timestamp.isoformat(),
            'equity': pt.equity,
        } for pt in equity_curve]

        # Separate pattern_performance and monthly_returns for dedicated columns
        pattern_perf = metrics.get('pattern_performance', {})
        monthly_ret = metrics.get('monthly_returns', {})

        # Clean metrics for the metrics column (remove nested dicts)
        metrics_clean = {k: v for k, v in metrics.items()
                        if k not in ('pattern_performance', 'monthly_returns')}

        cur.execute("""
            INSERT INTO backtest_results
                (config, metrics, trades, equity, pattern_performance, monthly_returns, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (
            json.dumps(config_json),
            json.dumps(metrics_clean),
            json.dumps(trades_json),
            json.dumps(equity_json),
            json.dumps(pattern_perf),
            json.dumps(monthly_ret),
            'COMPLETED',
        ))

        row_id = cur.fetchone()[0]
        pg.commit()
        print(f'  Saved to Postgres: backtest_results id={row_id}')
        return row_id

    except Exception as e:
        pg.rollback()
        print(f'  WARNING: Failed to save to Postgres: {e}')
        return None
    finally:
        pg.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Strategy Lab: Python Backtester (QuantGuild Engine)')
    parser.add_argument('--symbol', type=str, default='BTC/USDC',
                        help='Trading pair (default: BTC/USDC)')
    parser.add_argument('--days', type=int, default=30,
                        help='Backtest period in days (default: 30)')
    parser.add_argument('--timeframe', type=str, default='15m',
                        help='Primary timeframe (default: 15m)')
    parser.add_argument('--capital', type=float, default=10000.0,
                        help='Starting capital in USD (default: 10000)')
    parser.add_argument('--no-save', action='store_true',
                        help='Skip saving to Postgres')
    parser.add_argument('--json', action='store_true',
                        help='Output JSON instead of formatted report')
    args = parser.parse_args()

    config = BacktestConfig(
        symbol=args.symbol,
        days=args.days,
        timeframe=args.timeframe,
        capital=args.capital,
    )

    print(f'\n  Cryonix Backtester v1.0')
    print(f'  Symbol: {config.symbol} | Days: {config.days} | TF: {config.timeframe}')
    print(f'  Capital: ${config.capital:,.2f} | Fee: {config.fee_pct*100}%')
    print(f'  Confidence threshold: {config.min_confidence}')
    print(f'\n  Fetching data...')

    # 1. Fetch data
    fetcher = DataFetcher(config.symbol, config.days, config.timeframe)
    data = fetcher.fetch_all()

    # 2. Run backtest
    bt = Backtester(config)
    trades, equity_curve = bt.run(data)

    print(f'\n  Signals generated: {bt.signals_generated}')
    print(f'  Trades executed: {len(trades)}')

    # 3. Compute metrics
    metrics = MetricsCalculator.compute(trades, equity_curve, config.capital, config.days)

    # 4. Output
    if args.json:
        print(json.dumps(metrics, indent=2, default=str))
    else:
        print_report(config, metrics)

    # 5. Save to Postgres
    if not args.no_save:
        save_to_postgres(config, metrics, trades, equity_curve)


if __name__ == '__main__':
    main()
