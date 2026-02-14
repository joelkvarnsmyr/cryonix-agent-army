"""
MarketScout Tank - Real Market Scanner
Scans markets using CCXT and analyzes with QuantGuild
"""
from typing import Dict, Any
from src.tanks.base import BaseTank, TankState
from src.core.market_data import market_data
from src.guilds.quant import quant


class MarketScoutTank(BaseTank):
    """
    The 'Scout' Tank - Eyes of the Trading System.

    Responsibilities:
    - Fetch real OHLCV data from Binance via CCXT
    - Run technical analysis via QuantGuild
    - Generate trading signals with confidence scores
    - Push high-confidence signals to approval queue
    """

    def __init__(self):
        # Monitor 15 liquid USDC pairs across tiers
        super().__init__(
            name="MarketScout",
            symbols=[
                # Tier 1: Core (ultra-liquid)
                "BTC/USDC", "ETH/USDC", "SOL/USDC",
                # Tier 2: Major alts
                "BNB/USDC", "XRP/USDC", "AVAX/USDC", "ADA/USDC", "LINK/USDC",
                # Tier 3: L2 / DeFi
                "NEAR/USDC", "DOGE/USDC", "ARB/USDC", "OP/USDC",
                # Tier 4: Emerging
                "SUI/USDC", "ATOM/USDC", "ICP/USDC",
            ]
        )
        self.timeframe = "15m"  # 15-minute candles
        self.candle_limit = 100  # Fetch last 100 candles

    async def scan_market(self, state: TankState) -> TankState:
        """
        Fetch real OHLCV data from Binance.
        """
        symbol = state['symbol']
        print(f"[{self.name}] Fetching {self.timeframe} candles for {symbol}...")

        try:
            # Fetch real market data via CCXT
            ohlcv = market_data.fetch_ohlcv(
                symbol=symbol,
                timeframe=self.timeframe,
                limit=self.candle_limit
            )

            if not ohlcv:
                print(f"[{self.name}] No data received for {symbol}")
                return {
                    "symbol": symbol,
                    "price": 0,
                    "status": "no_data",
                    "error": "Failed to fetch OHLCV"
                }

            # Get current price from last candle
            current_price = ohlcv[-1][4]  # Close price

            print(f"[{self.name}] {symbol} @ ${current_price:,.2f} ({len(ohlcv)} candles)")

            return {
                "symbol": symbol,
                "price": current_price,
                "ohlcv": ohlcv,
                "status": "scanned"
            }

        except Exception as e:
            print(f"[{self.name}] Error fetching {symbol}: {e}")
            return {
                "symbol": symbol,
                "price": 0,
                "status": "error",
                "error": str(e)
            }

    async def analyze_signal(self, state: TankState) -> TankState:
        """
        Run technical analysis via QuantGuild.
        Detects patterns: RSI extremes, Bollinger squeeze, Volume spikes, MACD crossovers,
        and Deep Value crashes (multi-timeframe).
        """
        symbol = state['symbol']
        ohlcv = state.get('ohlcv', [])

        if not ohlcv or state.get('status') == 'error':
            return {
                "symbol": symbol,
                "signal": {
                    "action": "HOLD",
                    "confidence": 0,
                    "reason": "No market data available"
                },
                "status": "skipped"
            }

        print(f"[{self.name}] Analyzing {symbol} with QuantGuild...")

        try:
            # Pre-filter: check for potential deep value crash (8%+ drawdown)
            # This is cheap - just check last 20 candles before fetching multi-TF data
            multi_tf_data = None
            if len(ohlcv) >= 20:
                closes = [c[4] for c in ohlcv[-20:]]  # Close prices
                recent_high = max(closes)
                current = closes[-1]
                drawdown = (recent_high - current) / recent_high if recent_high > 0 else 0

                if drawdown >= 0.08:  # 8% threshold
                    print(f"[{self.name}] {symbol} DEEP VALUE pre-filter triggered: {drawdown:.1%} drawdown")
                    multi_tf_data = market_data.fetch_multi_timeframe(symbol)

            # Run full technical analysis (with optional multi-TF data for deep value)
            analysis = quant.analyze(ohlcv, symbol, multi_tf_data=multi_tf_data)

            if analysis['status'] != 'success':
                print(f"[{self.name}] Analysis failed: {analysis.get('status')}")
                return {
                    "symbol": symbol,
                    "signal": {
                        "action": "HOLD",
                        "confidence": 0,
                        "reason": f"Analysis failed: {analysis.get('status')}"
                    },
                    "status": "analysis_failed"
                }

            # Extract signal from analysis
            signal = analysis['signal']
            indicators = analysis['indicators']
            patterns = analysis.get('patterns', [])

            # Log detected patterns
            if patterns:
                pattern_names = [p['pattern'] for p in patterns]
                print(f"[{self.name}] {symbol} patterns: {pattern_names}")

            # Build comprehensive signal
            trading_signal = {
                "symbol": symbol,
                "action": signal['action'],
                "confidence": signal['confidence'],
                "reason": signal['reason'],
                "patterns": signal.get('patterns', []),
                "entry_price": signal['entry_price'],
                "stop_loss": signal['stop_loss'],
                "target_price": signal['target_price'],
                "indicators": {
                    "rsi": indicators['rsi'],
                    "bb_width_pct": indicators['bb_width_percentile'],
                    "volume_ratio": indicators['volume_ratio'],
                    "atr_pct": indicators['atr_percent'],
                }
            }

            # Include deep value metrics if present
            if signal.get('is_deep_value') and signal.get('deep_value_metrics'):
                trading_signal['is_deep_value'] = True
                trading_signal['indicators'].update({
                    'drawdown_pct': signal['deep_value_metrics']['drawdown_pct'],
                    'drop_velocity': signal['deep_value_metrics']['drop_velocity'],
                    'rsi_1h': signal['deep_value_metrics'].get('rsi_1h'),
                    'rsi_4h': signal['deep_value_metrics'].get('rsi_4h'),
                    'support_level': signal['deep_value_metrics'].get('support_level'),
                    'recent_high': signal['deep_value_metrics'].get('recent_high'),
                })

            action_emoji = {"BUY": "🟢", "SELL": "🔴", "HOLD": "⏸️"}.get(signal['action'], "❓")
            print(f"[{self.name}] {symbol} {action_emoji} {signal['action']} "
                  f"(conf: {signal['confidence']:.1%}) - {signal['reason'][:50]}...")

            return {
                "symbol": symbol,
                "signal": trading_signal,
                "indicators": indicators,
                "status": "analyzed"
            }

        except Exception as e:
            print(f"[{self.name}] Analysis error for {symbol}: {e}")
            import traceback
            traceback.print_exc()
            return {
                "symbol": symbol,
                "signal": {
                    "action": "HOLD",
                    "confidence": 0,
                    "reason": f"Analysis error: {str(e)}"
                },
                "status": "error"
            }
