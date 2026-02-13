"""
Backtesting Engine - Walk-Forward Strategy Validation
Tests trading strategies against historical data
"""
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from src.guilds.quant import QuantGuild
from src.core.market_data import market_data


@dataclass
class Trade:
    """Represents a completed trade"""
    symbol: str
    side: str  # BUY or SELL
    entry_time: datetime
    entry_price: float
    exit_time: Optional[datetime] = None
    exit_price: Optional[float] = None
    stop_loss: float = 0
    target_price: float = 0
    size: float = 1.0
    pnl: float = 0
    pnl_percent: float = 0
    exit_reason: str = ""  # 'target', 'stop', 'signal', 'timeout'


@dataclass
class BacktestResult:
    """Results from a backtest run"""
    symbol: str
    timeframe: str
    start_date: str
    end_date: str
    initial_capital: float
    final_capital: float
    total_return: float
    total_return_pct: float
    total_trades: int
    winning_trades: int
    losing_trades: int
    win_rate: float
    avg_win: float
    avg_loss: float
    profit_factor: float
    max_drawdown: float
    max_drawdown_pct: float
    sharpe_ratio: float
    sortino_ratio: float
    calmar_ratio: float
    avg_trade_duration: float  # in hours
    trades: List[Trade] = field(default_factory=list)
    equity_curve: List[Dict] = field(default_factory=list)


class BacktestEngine:
    """
    Walk-Forward Backtesting Engine

    Simulates trading strategy on historical data with realistic execution:
    - Entry on signal confirmation
    - Exit on stop-loss, target, or opposite signal
    - Tracks equity curve and calculates performance metrics
    """

    def __init__(self, initial_capital: float = 10000):
        self.initial_capital = initial_capital
        self.quant = QuantGuild()
        self.risk_per_trade = 0.02  # 2% risk per trade
        self.max_position_size = 0.25  # Max 25% of capital per position

    def fetch_historical_data(
        self,
        symbol: str,
        timeframe: str = '1h',
        days: int = 90
    ) -> pd.DataFrame:
        """
        Fetch historical OHLCV data for backtesting.
        Uses CCXT to get historical candles.
        """
        print(f"[Backtest] Fetching {days} days of {timeframe} data for {symbol}...")

        # Calculate how many candles we need
        candles_per_day = {
            '1m': 1440, '5m': 288, '15m': 96, '1h': 24, '4h': 6, '1d': 1
        }
        limit = min(days * candles_per_day.get(timeframe, 24), 1000)

        try:
            ohlcv = market_data.fetch_ohlcv(symbol, timeframe, limit=limit)

            if not ohlcv:
                print(f"[Backtest] No data received for {symbol}")
                return pd.DataFrame()

            df = pd.DataFrame(
                ohlcv,
                columns=['timestamp', 'open', 'high', 'low', 'close', 'volume']
            )
            df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
            df.set_index('timestamp', inplace=True)

            print(f"[Backtest] Loaded {len(df)} candles from {df.index[0]} to {df.index[-1]}")
            return df

        except Exception as e:
            print(f"[Backtest] Error fetching data: {e}")
            return pd.DataFrame()

    def run_backtest(
        self,
        symbol: str,
        timeframe: str = '1h',
        days: int = 90,
        min_confidence: float = 0.75
    ) -> BacktestResult:
        """
        Run a complete backtest on historical data.

        Walk-forward approach:
        1. Use first 50 candles for indicator warmup
        2. Generate signals for remaining candles
        3. Simulate trade execution with stops and targets
        4. Calculate performance metrics
        """
        print(f"\n{'='*60}")
        print(f"BACKTEST: {symbol} | {timeframe} | {days} days")
        print(f"{'='*60}\n")

        # Fetch data
        df = self.fetch_historical_data(symbol, timeframe, days)
        if df.empty or len(df) < 100:
            print("[Backtest] Insufficient data for backtest")
            return self._empty_result(symbol, timeframe)

        # Initialize state
        capital = self.initial_capital
        position = None  # Current position: {'side', 'entry_price', 'size', 'stop', 'target'}
        trades: List[Trade] = []
        equity_curve = []

        # Walk through each candle (skip first 50 for warmup)
        warmup = 50

        for i in range(warmup, len(df)):
            current_time = df.index[i]
            current_price = df['close'].iloc[i]
            current_high = df['high'].iloc[i]
            current_low = df['low'].iloc[i]

            # Record equity
            position_value = 0
            if position:
                if position['side'] == 'BUY':
                    position_value = position['size'] * (current_price - position['entry_price'])
                else:
                    position_value = position['size'] * (position['entry_price'] - current_price)

            equity_curve.append({
                'timestamp': current_time.isoformat(),
                'equity': capital + position_value,
                'price': current_price
            })

            # Check if position hit stop or target
            if position:
                exit_reason = None
                exit_price = None

                if position['side'] == 'BUY':
                    if current_low <= position['stop']:
                        exit_reason = 'stop'
                        exit_price = position['stop']
                    elif current_high >= position['target']:
                        exit_reason = 'target'
                        exit_price = position['target']
                else:  # SELL/SHORT
                    if current_high >= position['stop']:
                        exit_reason = 'stop'
                        exit_price = position['stop']
                    elif current_low <= position['target']:
                        exit_reason = 'target'
                        exit_price = position['target']

                if exit_reason:
                    # Close position
                    if position['side'] == 'BUY':
                        pnl = position['size'] * (exit_price - position['entry_price'])
                    else:
                        pnl = position['size'] * (position['entry_price'] - exit_price)

                    pnl_pct = pnl / (position['size'] * position['entry_price']) * 100
                    capital += pnl

                    trade = Trade(
                        symbol=symbol,
                        side=position['side'],
                        entry_time=position['entry_time'],
                        entry_price=position['entry_price'],
                        exit_time=current_time,
                        exit_price=exit_price,
                        stop_loss=position['stop'],
                        target_price=position['target'],
                        size=position['size'],
                        pnl=pnl,
                        pnl_percent=pnl_pct,
                        exit_reason=exit_reason
                    )
                    trades.append(trade)

                    print(f"[{current_time}] CLOSED {position['side']} @ {exit_price:.2f} "
                          f"({exit_reason}) | PnL: ${pnl:.2f} ({pnl_pct:.1f}%)")

                    position = None

            # Generate signal for current candle
            lookback = df.iloc[i-warmup:i+1]
            ohlcv_list = [
                [int(ts.timestamp() * 1000), row['open'], row['high'], row['low'], row['close'], row['volume']]
                for ts, row in lookback.iterrows()
            ]

            analysis = self.quant.analyze(ohlcv_list, symbol)

            if analysis['status'] != 'success':
                continue

            signal = analysis['signal']

            # Check if we should enter a position
            if not position and signal['action'] != 'HOLD' and signal['confidence'] >= min_confidence:
                # Calculate position size based on risk
                risk_amount = capital * self.risk_per_trade
                price_risk = abs(current_price - signal['stop_loss'])

                if price_risk > 0:
                    size = min(
                        risk_amount / price_risk,
                        capital * self.max_position_size / current_price
                    )
                else:
                    size = capital * self.max_position_size / current_price

                position = {
                    'side': signal['action'],
                    'entry_price': current_price,
                    'entry_time': current_time,
                    'size': size,
                    'stop': signal['stop_loss'],
                    'target': signal['target_price']
                }

                print(f"[{current_time}] OPEN {signal['action']} @ {current_price:.2f} "
                      f"| Conf: {signal['confidence']:.1%} | Stop: {signal['stop_loss']:.2f} "
                      f"| Target: {signal['target_price']:.2f}")

        # Close any remaining position at last price
        if position:
            last_price = df['close'].iloc[-1]
            if position['side'] == 'BUY':
                pnl = position['size'] * (last_price - position['entry_price'])
            else:
                pnl = position['size'] * (position['entry_price'] - last_price)

            pnl_pct = pnl / (position['size'] * position['entry_price']) * 100
            capital += pnl

            trade = Trade(
                symbol=symbol,
                side=position['side'],
                entry_time=position['entry_time'],
                entry_price=position['entry_price'],
                exit_time=df.index[-1],
                exit_price=last_price,
                stop_loss=position['stop'],
                target_price=position['target'],
                size=position['size'],
                pnl=pnl,
                pnl_percent=pnl_pct,
                exit_reason='end_of_data'
            )
            trades.append(trade)

        # Calculate metrics
        result = self._calculate_metrics(
            symbol=symbol,
            timeframe=timeframe,
            df=df,
            trades=trades,
            equity_curve=equity_curve,
            final_capital=capital
        )

        self._print_summary(result)
        return result

    def _calculate_metrics(
        self,
        symbol: str,
        timeframe: str,
        df: pd.DataFrame,
        trades: List[Trade],
        equity_curve: List[Dict],
        final_capital: float
    ) -> BacktestResult:
        """Calculate all performance metrics"""

        total_return = final_capital - self.initial_capital
        total_return_pct = (total_return / self.initial_capital) * 100

        winning_trades = [t for t in trades if t.pnl > 0]
        losing_trades = [t for t in trades if t.pnl <= 0]

        win_rate = len(winning_trades) / len(trades) * 100 if trades else 0

        avg_win = np.mean([t.pnl for t in winning_trades]) if winning_trades else 0
        avg_loss = abs(np.mean([t.pnl for t in losing_trades])) if losing_trades else 0

        gross_profit = sum(t.pnl for t in winning_trades)
        gross_loss = abs(sum(t.pnl for t in losing_trades))
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else float('inf')

        # Calculate drawdown
        equity_values = [e['equity'] for e in equity_curve]
        peak = equity_values[0]
        max_dd = 0
        max_dd_pct = 0

        for eq in equity_values:
            if eq > peak:
                peak = eq
            dd = peak - eq
            dd_pct = dd / peak * 100 if peak > 0 else 0
            if dd > max_dd:
                max_dd = dd
                max_dd_pct = dd_pct

        # Calculate Sharpe Ratio (annualized)
        if len(equity_curve) > 1:
            returns = pd.Series([
                (equity_curve[i]['equity'] - equity_curve[i-1]['equity']) / equity_curve[i-1]['equity']
                for i in range(1, len(equity_curve))
            ])

            # Annualization factor based on timeframe
            periods_per_year = {
                '1m': 525600, '5m': 105120, '15m': 35040,
                '1h': 8760, '4h': 2190, '1d': 365
            }
            ann_factor = np.sqrt(periods_per_year.get(timeframe, 8760))

            sharpe = (returns.mean() / returns.std() * ann_factor) if returns.std() > 0 else 0

            # Sortino (downside deviation only)
            downside_returns = returns[returns < 0]
            sortino = (returns.mean() / downside_returns.std() * ann_factor) if len(downside_returns) > 0 and downside_returns.std() > 0 else 0
        else:
            sharpe = 0
            sortino = 0

        # Calmar Ratio (return / max drawdown)
        calmar = total_return_pct / max_dd_pct if max_dd_pct > 0 else 0

        # Average trade duration
        durations = []
        for t in trades:
            if t.exit_time and t.entry_time:
                duration = (t.exit_time - t.entry_time).total_seconds() / 3600
                durations.append(duration)
        avg_duration = np.mean(durations) if durations else 0

        return BacktestResult(
            symbol=symbol,
            timeframe=timeframe,
            start_date=df.index[0].isoformat() if len(df) > 0 else "",
            end_date=df.index[-1].isoformat() if len(df) > 0 else "",
            initial_capital=self.initial_capital,
            final_capital=final_capital,
            total_return=total_return,
            total_return_pct=total_return_pct,
            total_trades=len(trades),
            winning_trades=len(winning_trades),
            losing_trades=len(losing_trades),
            win_rate=win_rate,
            avg_win=avg_win,
            avg_loss=avg_loss,
            profit_factor=profit_factor,
            max_drawdown=max_dd,
            max_drawdown_pct=max_dd_pct,
            sharpe_ratio=sharpe,
            sortino_ratio=sortino,
            calmar_ratio=calmar,
            avg_trade_duration=avg_duration,
            trades=trades,
            equity_curve=equity_curve
        )

    def _empty_result(self, symbol: str, timeframe: str) -> BacktestResult:
        """Return empty result for failed backtest"""
        return BacktestResult(
            symbol=symbol,
            timeframe=timeframe,
            start_date="",
            end_date="",
            initial_capital=self.initial_capital,
            final_capital=self.initial_capital,
            total_return=0,
            total_return_pct=0,
            total_trades=0,
            winning_trades=0,
            losing_trades=0,
            win_rate=0,
            avg_win=0,
            avg_loss=0,
            profit_factor=0,
            max_drawdown=0,
            max_drawdown_pct=0,
            sharpe_ratio=0,
            sortino_ratio=0,
            calmar_ratio=0,
            avg_trade_duration=0
        )

    def _print_summary(self, result: BacktestResult):
        """Print backtest summary"""
        print(f"\n{'='*60}")
        print(f"BACKTEST RESULTS: {result.symbol}")
        print(f"{'='*60}")
        print(f"Period: {result.start_date[:10]} to {result.end_date[:10]}")
        print(f"Timeframe: {result.timeframe}")
        print(f"")
        print(f"RETURNS:")
        print(f"  Initial Capital:  ${result.initial_capital:,.2f}")
        print(f"  Final Capital:    ${result.final_capital:,.2f}")
        print(f"  Total Return:     ${result.total_return:,.2f} ({result.total_return_pct:.2f}%)")
        print(f"")
        print(f"TRADES:")
        print(f"  Total Trades:     {result.total_trades}")
        print(f"  Winning Trades:   {result.winning_trades}")
        print(f"  Losing Trades:    {result.losing_trades}")
        print(f"  Win Rate:         {result.win_rate:.1f}%")
        print(f"  Avg Win:          ${result.avg_win:.2f}")
        print(f"  Avg Loss:         ${result.avg_loss:.2f}")
        print(f"  Profit Factor:    {result.profit_factor:.2f}")
        print(f"")
        print(f"RISK METRICS:")
        print(f"  Max Drawdown:     ${result.max_drawdown:,.2f} ({result.max_drawdown_pct:.1f}%)")
        print(f"  Sharpe Ratio:     {result.sharpe_ratio:.2f}")
        print(f"  Sortino Ratio:    {result.sortino_ratio:.2f}")
        print(f"  Calmar Ratio:     {result.calmar_ratio:.2f}")
        print(f"")
        print(f"Avg Trade Duration: {result.avg_trade_duration:.1f} hours")
        print(f"{'='*60}\n")

        # Performance assessment
        print("ASSESSMENT:")
        issues = []
        passes = []

        if result.sharpe_ratio >= 1.0:
            passes.append(f"  [PASS] Sharpe Ratio {result.sharpe_ratio:.2f} >= 1.0")
        else:
            issues.append(f"  [FAIL] Sharpe Ratio {result.sharpe_ratio:.2f} < 1.0")

        if result.win_rate >= 55:
            passes.append(f"  [PASS] Win Rate {result.win_rate:.1f}% >= 55%")
        else:
            issues.append(f"  [FAIL] Win Rate {result.win_rate:.1f}% < 55%")

        if result.max_drawdown_pct <= 20:
            passes.append(f"  [PASS] Max Drawdown {result.max_drawdown_pct:.1f}% <= 20%")
        else:
            issues.append(f"  [FAIL] Max Drawdown {result.max_drawdown_pct:.1f}% > 20%")

        if result.profit_factor >= 1.5:
            passes.append(f"  [PASS] Profit Factor {result.profit_factor:.2f} >= 1.5")
        else:
            issues.append(f"  [FAIL] Profit Factor {result.profit_factor:.2f} < 1.5")

        for p in passes:
            print(p)
        for i in issues:
            print(i)

        ready = len(issues) == 0
        print(f"\nPRODUCTION READY: {'YES' if ready else 'NO'}")


# Singleton
backtest_engine = BacktestEngine()
