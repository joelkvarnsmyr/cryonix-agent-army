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

import asyncio

import ccxt
import httpx
import numpy as np
import pandas as pd
from tabulate import tabulate

# Import shared db helper
sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg

# Import QuantGuild engine — works in Docker (/app/) and on host (packages/engine/)
# quant.py uses `from src.core.config import ...` so we need the parent of src/ in path
_engine_paths = [
    os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine'),  # host: packages/engine/
    '/app',                                                                      # Docker: /app/
]
for _p in _engine_paths:
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)
from src.guilds.quant import QuantGuild
from src.core.config import get_toml


# ---------------------------------------------------------------------------
# Grok AI Validation (mirrors production auto-trade route)
# ---------------------------------------------------------------------------

XAI_API_KEY = os.getenv('XAI_API_KEY', '')
GROK_API_URL = 'https://api.x.ai/v1/chat/completions'

class GrokValidator:
    """Calls Grok AI to validate signals, matching production prompt logic."""

    def __init__(self, capital: float = 17.0):
        self.capital = capital
        self.enabled = bool(XAI_API_KEY)
        self.client = httpx.Client(timeout=30) if self.enabled else None
        self.stats = {'total': 0, 'approved': 0, 'rejected': 0, 'errors': 0}
        self.log: List[Dict[str, Any]] = []
        # Load config from TOML
        self.value_patterns = get_toml('patterns', 'value_patterns', ['DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE'])
        self.rsi_oversold = get_toml('indicators', 'rsi_oversold', 30)
        self.adx_threshold = get_toml('indicators', 'adx_trending_threshold', 25)
        self.alert_keywords = get_toml('sentiment', 'alert_keywords', ['hack', 'exploit', 'rug', 'delist', 'scam'])
        self.min_conf = int((get_toml('risk', 'min_confidence', 0.70)) * 100)
        self.dip_focus = get_toml('patterns', 'dip_focus_mode', True)
        self.ta_weight = get_toml('ai', 'ta_weight', 0.60)
        self.ai_weight = get_toml('ai', 'ai_weight', 0.40)
        self.model = get_toml('ai', 'model', 'grok-3-mini-fast')

    def validate(self, signal: Dict, result: Dict) -> Dict[str, Any]:
        """Validate a signal with Grok AI. Returns {approved, confidence, reasoning}."""
        if not self.enabled:
            return {'approved': True, 'confidence': signal.get('confidence', 0.7), 'reasoning': 'AI disabled'}

        self.stats['total'] += 1
        patterns = signal.get('patterns', [])
        indicators = result.get('indicators', {})
        htf_trend = result.get('htf_trend', {})

        is_deep_value = 'DEEP_VALUE_CRASH' in patterns
        is_dip = any(p in self.value_patterns and p != 'DEEP_VALUE_CRASH' for p in patterns)
        alert_kw_str = ', '.join(self.alert_keywords)
        strategy_mode = 'Smart Dip Hunter (mean-reversion focus)' if self.dip_focus else 'All patterns'

        if is_deep_value:
            system_prompt = (
                'You are a crash-buying specialist for crypto markets. '
                'Evaluate whether a large drawdown is PANIC SELLING (buy opportunity) or a FALLING KNIFE (avoid). '
                'Use your reasoning to analyze drop velocity, volume patterns, multi-timeframe RSI alignment. '
                'Respond with ONLY a JSON object.'
            )
        elif is_dip:
            non_dv = [p for p in self.value_patterns if p != 'DEEP_VALUE_CRASH']
            system_prompt = (
                f'You are a mean-reversion specialist for crypto dip buying. Strategy: {strategy_mode}.\n\n'
                f'CRITICAL: {", ".join(non_dv)} are mean-reversion strategies. '
                'A bearish short-term trend is EXPECTED — that is what creates the dip. '
                'Do NOT reject simply because the higher-timeframe trend is bearish. Instead focus on:\n'
                f'- Is price near historical support levels?\n'
                f'- Is RSI deeply oversold (< {self.rsi_oversold + 5})?\n'
                f'- Any negative catalysts? Watch for: {alert_kw_str}\n\n'
                f'Key principles:\n'
                f'- On a ${self.capital:.0f} account, missing a good dip costs more than a small stop-loss\n'
                f'- APPROVE if: dip looks structural (no bad news), price near support, RSI oversold\n'
                f'- REJECT only if: X reveals negative catalyst ({alert_kw_str}), drop velocity suggests rug pull\n'
                f'- Give confidence {self.min_conf - 10}-90 based on conviction level\n\n'
                'Respond with ONLY a JSON object.'
            )
        else:
            system_prompt = (
                f'You are a crypto trading risk analyst. Strategy: {strategy_mode}.\n\n'
                f'Key principles:\n'
                f'- On a ${self.capital:.0f} account, missed good trades cost more than small losses\n'
                f'- Approve signals with 2+ confirming indicators\n'
                f'- For trend signals: reject if HTF bearish or ADX < {self.adx_threshold}\n'
                f'- REJECT if: negative EV pattern, or bad news ({alert_kw_str})\n\n'
                'Respond with ONLY a JSON object.'
            )

        # Build user prompt with signal data
        htf_label = htf_trend.get('trend', 'unknown') if htf_trend else 'unknown'
        user_prompt = (
            f'SIGNAL: BUY {signal.get("symbol", "?")}\n\n'
            f'Setup: {" + ".join(patterns)} | TA confidence: {signal.get("confidence", 0) * 100:.0f}%\n'
            f'Reason: {signal.get("reason", "?")}\n'
            f'Entry: ${signal.get("entry_price", 0):.4f} | SL: ${signal.get("stop_loss", 0):.4f} | TP: ${signal.get("target_price", 0):.4f}\n\n'
            f'Indicators:\n'
            f'RSI={indicators.get("rsi", "?")} | MACD hist={indicators.get("macd_hist", "?")} | ADX={indicators.get("adx", "?")}\n'
            f'ATR={indicators.get("atr_pct", "?")}% | EMA9/21={indicators.get("ema9", "?")}/{indicators.get("ema21", "?")}\n'
            f'Volume: {indicators.get("volume_ratio", "?")}x avg | HTF trend: {htf_label}\n\n'
            f'JSON: {{"approve":bool,"confidence":0-100,"reasoning":"2-3 sentences"}}'
        )

        try:
            resp = self.client.post(GROK_API_URL, headers={
                'Authorization': f'Bearer {XAI_API_KEY}',
                'Content-Type': 'application/json',
            }, json={
                'model': self.model,
                'messages': [
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': user_prompt},
                ],
                'temperature': 0.1,
                'max_tokens': 300,
            })
            resp.raise_for_status()
            content = resp.json()['choices'][0]['message']['content']
            json_match = __import__('re').search(r'\{[\s\S]*\}', content)
            if not json_match:
                self.stats['errors'] += 1
                return {'approved': False, 'confidence': 0, 'reasoning': 'AI parse failed'}

            ai_result = json.loads(json_match.group())
            approved = ai_result.get('approve', False)
            ai_confidence = (ai_result.get('confidence', 50)) / 100
            reasoning = ai_result.get('reasoning', '')

            # Blend TA + AI confidence (matching production)
            ta_conf = signal.get('confidence', 0.7)
            blended = ta_conf * self.ta_weight + ai_confidence * self.ai_weight

            entry = {
                'symbol': signal.get('symbol', '?'),
                'patterns': patterns,
                'ta_confidence': round(ta_conf, 3),
                'ai_confidence': round(ai_confidence, 3),
                'blended': round(blended, 3),
                'approved': approved,
                'reasoning': reasoning[:120],
                'is_dip': is_dip or is_deep_value,
            }
            self.log.append(entry)

            if approved:
                self.stats['approved'] += 1
            else:
                self.stats['rejected'] += 1

            return {'approved': approved, 'confidence': blended, 'reasoning': reasoning}

        except Exception as e:
            self.stats['errors'] += 1
            return {'approved': False, 'confidence': 0, 'reasoning': f'AI error: {e}'}

    def print_summary(self):
        """Print AI validation summary."""
        print(f'\n  AI VALIDATION SUMMARY (Grok: {self.model})')
        print(f'  Total validated:   {self.stats["total"]}')
        print(f'  Approved:          {self.stats["approved"]} ({self.stats["approved"]/max(self.stats["total"],1)*100:.0f}%)')
        print(f'  Rejected:          {self.stats["rejected"]} ({self.stats["rejected"]/max(self.stats["total"],1)*100:.0f}%)')
        if self.stats['errors']:
            print(f'  Errors:            {self.stats["errors"]}')

        if self.log:
            print(f'\n  PER-SIGNAL AI DECISIONS')
            ai_table = []
            for entry in self.log:
                status = 'PASS' if entry['approved'] else 'REJECT'
                ai_table.append([
                    entry['symbol'].replace('/USDC', ''),
                    ' + '.join(entry['patterns'])[:30],
                    f'{entry["ta_confidence"]*100:.0f}%',
                    f'{entry["ai_confidence"]*100:.0f}%',
                    f'{entry["blended"]*100:.0f}%',
                    status,
                    entry['reasoning'][:60],
                ])
            print(tabulate(ai_table,
                           headers=['Symbol', 'Patterns', 'TA', 'AI', 'Blend', 'Status', 'Reasoning'],
                           tablefmt='simple'))


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
    dip_focus_mode: bool = False
    value_patterns: List[str] = field(default_factory=lambda: ['DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE'])
    trending_adx_threshold: float = 100.0  # effectively disabled by default

    @classmethod
    def from_toml(cls, symbol: str = 'BTC/USDC', days: int = 30) -> 'BacktestConfig':
        """Create config from cryonix.toml to match live system."""
        from src.core.config import get_toml
        return cls(
            symbol=symbol,
            days=days,
            timeframe=get_toml('engine', 'timeframe', '15m'),
            capital=17.0,  # actual account size
            fee_pct=0.001,
            max_positions=get_toml('limits', 'max_open_positions', 3),
            position_size_pct=get_toml('capital', 'max_position_size_pct', 0.35),
            min_confidence=get_toml('risk', 'min_confidence', 0.70),
            trailing_stop_pct=get_toml('exits', 'trailing_stop_pct', 3.0) / 100,
            trailing_profit_threshold=get_toml('exits', 'trailing_activation_pct', 3.0) / 100,
            dip_focus_mode=get_toml('patterns', 'dip_focus_mode', True),
            value_patterns=get_toml('patterns', 'value_patterns', ['DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE']),
            trending_adx_threshold=get_toml('patterns', 'trending_adx_threshold', 30),
        )


# ---------------------------------------------------------------------------
# DataFetcher — paginated CCXT OHLCV
# ---------------------------------------------------------------------------

class DataFetcher:
    """Fetches multi-timeframe OHLCV data via CCXT (public, no API key)."""

    TF_CONFIG = {
        '5m':  {'ms': 5 * 60 * 1000,   'extra': 200},
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

    # Higher timeframes always fetched for QuantGuild HTF context
    HTF_ALWAYS = {'1h', '4h', '1d'}

    def fetch_all(self) -> Dict[str, List[list]]:
        """Fetch primary + higher timeframes. Returns {tf: [[ts,o,h,l,c,v], ...]}."""
        data = {}
        # Fetch primary TF + always-needed higher TFs
        tfs_to_fetch = {self.primary_tf} | self.HTF_ALWAYS
        for tf in tfs_to_fetch:
            cfg = self.TF_CONFIG[tf]
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

    def __init__(self, config: BacktestConfig, signal_filter=None):
        self.config = config
        self.quant = QuantGuild()
        self.pm = PositionManager(config)
        self.equity_curve: List[EquityPoint] = []
        self.signals_generated = 0
        self.signals_filtered = 0
        self.signal_filter = signal_filter  # Optional callable(signal, result) -> bool

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
                # Dip focus mode filter (matches live auto-trade route)
                if self.config.dip_focus_mode:
                    sig_patterns = signal.get('patterns', [])
                    has_value = any(p in self.config.value_patterns for p in sig_patterns)
                    if not has_value:
                        # ADX trending exception
                        adx = result.get('indicators', {}).get('adx', 0)
                        htf = result.get('htf_trend', {})
                        htf_bullish = htf.get('trend') == 'bullish' if htf else False
                        has_trend = any(p in ('MACD_BULLISH_CROSS', 'EMA_BULLISH_CROSS') for p in sig_patterns)
                        if not (has_trend and adx >= self.config.trending_adx_threshold and htf_bullish):
                            self.signals_filtered += 1
                            continue
                # Optional external filter (e.g. Grok validation)
                if self.signal_filter and not self.signal_filter(signal, result):
                    self.signals_filtered += 1
                    continue
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

def _to_camel_case_metrics(m: Dict[str, Any]) -> Dict[str, Any]:
    """Convert snake_case metrics dict to camelCase for DB consistency with TS backtester."""
    mapping = {
        'total_trades': 'totalTrades',
        'winning_trades': 'winningTrades',
        'losing_trades': 'losingTrades',
        'win_rate': 'winRate',
        'total_pnl': 'totalReturn',
        'total_fees': 'totalFees',
        'total_return_pct': 'totalReturnPercent',
        'annualized_return_pct': 'annualizedReturn',
        'avg_win': 'averageWin',
        'avg_loss': 'averageLoss',
        'largest_win': 'largestWin',
        'largest_loss': 'largestLoss',
        'profit_factor': 'profitFactor',
        'expectancy': 'expectancy',
        'sharpe_ratio': 'sharpeRatio',
        'sortino_ratio': 'sortinoRatio',
        'calmar_ratio': 'calmarRatio',
        'max_drawdown': 'maxDrawdown',
        'max_drawdown_pct': 'maxDrawdownPercent',
        'max_dd_duration_days': 'maxDrawdownDuration',
        'max_consec_wins': 'maxConsecutiveWins',
        'max_consec_losses': 'maxConsecutiveLosses',
        'exit_reasons': 'exitReasons',
        'trading_days': 'tradingDays',
        'initial_capital': 'initialCapital',
        'final_equity': 'finalEquity',
    }
    return {mapping.get(k, k): v for k, v in m.items()}


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

        # Convert snake_case → camelCase for DB consistency with TS backtester
        metrics = _to_camel_case_metrics(metrics)

        # Separate pattern_performance and monthly_returns for dedicated columns
        pattern_perf = metrics.get('patternPerformance', metrics.get('pattern_performance', {}))
        monthly_ret = metrics.get('monthlyReturns', metrics.get('monthly_returns', {}))

        # Clean metrics for the metrics column (remove nested dicts)
        # Replace Infinity/NaN with finite values for JSON/Postgres compatibility
        def _sanitize(v):
            if isinstance(v, float) and (math.isinf(v) or math.isnan(v)):
                return 999.99 if v > 0 else (-999.99 if v < 0 else 0.0)
            return v

        metrics_clean = {k: _sanitize(v) for k, v in metrics.items()
                        if k not in ('patternPerformance', 'monthlyReturns',
                                     'pattern_performance', 'monthly_returns')}

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

def run_single(config: BacktestConfig, save: bool = True, json_output: bool = False,
               grok_validator: Optional['GrokValidator'] = None) -> Dict[str, Any]:
    """Run backtest for a single symbol. Returns metrics dict."""
    print(f'\n  Symbol: {config.symbol} | Days: {config.days} | TF: {config.timeframe}')
    print(f'  Capital: ${config.capital:,.2f} | Fee: {config.fee_pct*100}%')
    print(f'  Confidence: {config.min_confidence} | Dip Focus: {config.dip_focus_mode}')
    print(f'  Position Size: {config.position_size_pct*100}% | Max Positions: {config.max_positions}')
    if grok_validator:
        print(f'  AI Validation: ENABLED ({grok_validator.model})')
    print(f'\n  Fetching data...')

    fetcher = DataFetcher(config.symbol, config.days, config.timeframe)
    data = fetcher.fetch_all()

    # If AI validation enabled, create a signal_filter that calls Grok
    signal_filter = None
    if grok_validator:
        def ai_filter(signal, result):
            # Add symbol to signal for Grok context
            signal['symbol'] = config.symbol
            ai_result = grok_validator.validate(signal, result)
            if not ai_result['approved']:
                return False
            # Blend confidence like production
            signal['confidence'] = ai_result['confidence']
            return True
        signal_filter = ai_filter

    bt = Backtester(config, signal_filter=signal_filter)
    trades, equity_curve = bt.run(data)

    print(f'\n  Signals generated: {bt.signals_generated} | Filtered (dip focus): {bt.signals_filtered}')
    if grok_validator:
        print(f'  AI filtered: {bt.signals_filtered if not signal_filter else grok_validator.stats["rejected"]}')
    print(f'  Trades executed: {len(trades)}')

    metrics = MetricsCalculator.compute(trades, equity_curve, config.capital, config.days)

    if json_output:
        print(json.dumps(metrics, indent=2, default=str))
    else:
        print_report(config, metrics)

    if save:
        save_to_postgres(config, metrics, trades, equity_curve)

    return metrics


def run_multi(symbols: List[str], days: int, live_config: bool,
              save: bool = True, json_output: bool = False,
              grok_validator: Optional['GrokValidator'] = None):
    """Run backtest across multiple symbols and print aggregate summary."""
    all_metrics = {}
    total_pnl = 0.0
    total_trades = 0
    total_wins = 0

    for sym in symbols:
        print(f'\n{"=" * 72}')
        print(f'  BACKTESTING: {sym}')
        print(f'{"=" * 72}')

        if live_config:
            config = BacktestConfig.from_toml(symbol=sym, days=days)
        else:
            config = BacktestConfig(symbol=sym, days=days)

        try:
            metrics = run_single(config, save=save, json_output=False, grok_validator=grok_validator)
            all_metrics[sym] = metrics
            total_pnl += metrics.get('total_pnl', 0)
            total_trades += metrics.get('total_trades', 0)
            total_wins += metrics.get('winning_trades', 0)
        except Exception as e:
            print(f'  ERROR backtesting {sym}: {e}')
            all_metrics[sym] = {'error': str(e)}

    # Aggregate summary
    print(f'\n{"=" * 72}')
    print(f'  AGGREGATE SUMMARY ({len(symbols)} symbols, {days} days)')
    print(f'{"=" * 72}')
    print(f'  Total P&L:      ${total_pnl:+.4f}')
    print(f'  Total Trades:    {total_trades}')
    win_rate = (total_wins / total_trades * 100) if total_trades > 0 else 0
    print(f'  Win Rate:        {win_rate:.1f}%')
    print(f'  Avg P&L/Trade:   ${total_pnl / total_trades:.4f}' if total_trades > 0 else '  Avg P&L/Trade:   N/A')

    # Per-symbol table
    print(f'\n  PER-SYMBOL BREAKDOWN')
    sym_table = []
    for sym in symbols:
        m = all_metrics.get(sym, {})
        if 'error' in m:
            sym_table.append([sym, 'ERROR', '-', '-', '-', '-'])
        else:
            sym_table.append([
                sym.replace('/USDC', ''),
                m.get('total_trades', 0),
                f'{m.get("win_rate", 0):.0f}%',
                f'${m.get("total_pnl", 0):+.4f}',
                f'{m.get("profit_factor", 0):.2f}',
                f'{m.get("sharpe_ratio", 0):.2f}',
            ])
    print(tabulate(sym_table, headers=['Symbol', 'Trades', 'Win%', 'P&L', 'PF', 'Sharpe'],
                   tablefmt='simple'))

    # AI validation summary (if enabled)
    if grok_validator and grok_validator.stats['total'] > 0:
        grok_validator.print_summary()

    if json_output:
        print(json.dumps({'aggregate': {
            'total_pnl': round(total_pnl, 4),
            'total_trades': total_trades,
            'win_rate': round(win_rate, 1),
        }, 'per_symbol': all_metrics}, indent=2, default=str))

    print('')


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
    parser.add_argument('--live-config', action='store_true',
                        help='Use parameters from cryonix.toml (matches production)')
    parser.add_argument('--multi', action='store_true',
                        help='Run across all whitelist symbols from cryonix.toml')
    parser.add_argument('--with-ai', action='store_true',
                        help='Enable Grok AI validation (requires XAI_API_KEY)')
    args = parser.parse_args()

    print(f'\n  Cryonix Backtester v2.0')

    # Initialize Grok validator if requested
    grok = None
    if args.with_ai:
        grok = GrokValidator(capital=args.capital if not args.live_config else 17.0)
        if not grok.enabled:
            print('  WARNING: --with-ai requires XAI_API_KEY env var')
            grok = None
        else:
            print(f'  AI Validation: ENABLED ({grok.model})')

    if args.multi:
        symbols = get_toml('trading', 'symbol_whitelist', ['BTC/USDC'])
        run_multi(symbols, args.days, live_config=args.live_config,
                  save=not args.no_save, json_output=args.json, grok_validator=grok)
    elif args.live_config:
        config = BacktestConfig.from_toml(symbol=args.symbol, days=args.days)
        run_single(config, save=not args.no_save, json_output=args.json, grok_validator=grok)
    else:
        config = BacktestConfig(
            symbol=args.symbol,
            days=args.days,
            timeframe=args.timeframe,
            capital=args.capital,
        )
        run_single(config, save=not args.no_save, json_output=args.json, grok_validator=grok)


if __name__ == '__main__':
    main()
