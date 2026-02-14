"""
Quant Guild - Technical Analysis Engine
Calculates indicators and detects patterns from OHLCV data
"""
import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional
from dataclasses import dataclass

@dataclass
class PatternSignal:
    """Represents a detected pattern signal"""
    pattern: str
    action: str  # BUY, SELL, HOLD
    confidence: float
    reason: str
    entry_price: float
    stop_loss: float
    target_price: float


class QuantGuild:
    """
    The 'Math Brain' of the Engine.
    Responsibilities:
    - Calculate Technical Indicators (RSI, MACD, BB, ATR)
    - Detect Chart Patterns (Bollinger Squeeze, Volume Spike, RSI Divergence)
    - Detect Deep Value crashes (multi-timeframe analysis)
    - Generate trading signals with confidence scores
    """

    def __init__(self):
        self.min_candles = 50  # Minimum candles needed for analysis
        self.deep_value_threshold = 0.08  # 8% drawdown triggers deep value analysis

    def analyze(self, ohlcv: List[list], symbol: str, multi_tf_data: Optional[Dict[str, List[list]]] = None) -> Dict[str, Any]:
        """
        Main analysis entry point.
        Takes OHLCV data and returns comprehensive analysis with signals.
        multi_tf_data: optional dict of {'1h': [...], '4h': [...], '1d': [...]} for deep value
        """
        if not ohlcv or len(ohlcv) < self.min_candles:
            return {
                "status": "insufficient_data",
                "candles": len(ohlcv) if ohlcv else 0,
                "required": self.min_candles
            }

        # Convert to DataFrame
        df = pd.DataFrame(
            ohlcv,
            columns=['timestamp', 'open', 'high', 'low', 'close', 'volume']
        )
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')

        # Calculate all indicators
        indicators = self._calculate_indicators(df)

        # Run pattern detectors
        patterns = self._detect_patterns(df, indicators)

        # Deep value crash detection (multi-timeframe)
        deep_value = self._detect_deep_value(df, indicators, multi_tf_data)
        if deep_value:
            patterns.append(deep_value)

        # Generate final signal
        signal = self._generate_signal(patterns, indicators, df)

        return {
            "status": "success",
            "symbol": symbol,
            "indicators": indicators,
            "patterns": patterns,
            "signal": signal,
            "candles_analyzed": len(df),
        }

    def _calculate_indicators(self, df: pd.DataFrame) -> Dict[str, Any]:
        """Calculate all technical indicators"""
        close = df['close']
        high = df['high']
        low = df['low']
        volume = df['volume']

        # RSI (14-period)
        rsi = self._calculate_rsi(close, 14)

        # Bollinger Bands (20-period, 2 std)
        bb_mid, bb_upper, bb_lower, bb_width = self._calculate_bollinger(close, 20, 2)

        # ATR (14-period) for volatility
        atr = self._calculate_atr(high, low, close, 14)

        # Volume SMA (20-period)
        vol_sma = volume.rolling(20).mean()

        # MACD
        macd, macd_signal, macd_hist = self._calculate_macd(close)

        # Get latest values
        latest_idx = -1

        return {
            "rsi": round(rsi.iloc[latest_idx], 2) if not pd.isna(rsi.iloc[latest_idx]) else 50,
            "bb_upper": round(bb_upper.iloc[latest_idx], 2),
            "bb_mid": round(bb_mid.iloc[latest_idx], 2),
            "bb_lower": round(bb_lower.iloc[latest_idx], 2),
            "bb_width": round(bb_width.iloc[latest_idx], 4),
            "bb_width_percentile": self._percentile(bb_width, bb_width.iloc[latest_idx]),
            "atr": round(atr.iloc[latest_idx], 2) if not pd.isna(atr.iloc[latest_idx]) else 0,
            "atr_percent": round((atr.iloc[latest_idx] / close.iloc[latest_idx]) * 100, 2) if close.iloc[latest_idx] > 0 else 0,
            "volume_ratio": round(volume.iloc[latest_idx] / vol_sma.iloc[latest_idx], 2) if vol_sma.iloc[latest_idx] > 0 else 1,
            "macd": round(macd.iloc[latest_idx], 4) if not pd.isna(macd.iloc[latest_idx]) else 0,
            "macd_signal": round(macd_signal.iloc[latest_idx], 4) if not pd.isna(macd_signal.iloc[latest_idx]) else 0,
            "macd_hist": round(macd_hist.iloc[latest_idx], 4) if not pd.isna(macd_hist.iloc[latest_idx]) else 0,
            "price": round(close.iloc[latest_idx], 2),
        }

    def _detect_patterns(self, df: pd.DataFrame, indicators: Dict) -> List[Dict]:
        """Run all pattern detectors"""
        patterns = []

        # 1. Bollinger Squeeze
        squeeze = self._detect_bollinger_squeeze(df, indicators)
        if squeeze:
            patterns.append(squeeze)

        # 2. RSI Extremes
        rsi_signal = self._detect_rsi_extreme(indicators)
        if rsi_signal:
            patterns.append(rsi_signal)

        # 3. Volume Spike
        vol_signal = self._detect_volume_spike(df, indicators)
        if vol_signal:
            patterns.append(vol_signal)

        # 4. MACD Crossover
        macd_signal = self._detect_macd_crossover(df, indicators)
        if macd_signal:
            patterns.append(macd_signal)

        # 5. Mean Reversion / Dip Buy
        dip_signal = self._detect_dip_buy(df, indicators)
        if dip_signal:
            patterns.append(dip_signal)

        # 6. EMA Crossover (9/21)
        ema_signal = self._detect_ema_crossover(df)
        if ema_signal:
            patterns.append(ema_signal)

        return patterns

    def _detect_bollinger_squeeze(self, df: pd.DataFrame, indicators: Dict) -> Optional[Dict]:
        """
        Bollinger Squeeze: When bands narrow significantly, expect breakout.
        """
        bb_width_pct = indicators['bb_width_percentile']
        price = indicators['price']
        bb_upper = indicators['bb_upper']
        bb_lower = indicators['bb_lower']

        # Squeeze detected when width is in bottom 20%
        if bb_width_pct < 20:
            # Determine direction based on price position
            position = (price - bb_lower) / (bb_upper - bb_lower) if (bb_upper - bb_lower) > 0 else 0.5

            if position < 0.3:
                # Price near lower band in squeeze = mean reversion BUY
                action = "BUY"
                confidence = 0.75 + (0.2 - bb_width_pct / 100) * 0.5
                reason = f"Bollinger Squeeze: price near lower band ({position:.0%}), expecting bounce"
            elif position > 0.7:
                # Price near upper band in squeeze = exhaustion SELL
                action = "SELL"
                confidence = 0.75 + (0.2 - bb_width_pct / 100) * 0.5
                reason = f"Bollinger Squeeze: price near upper band ({position:.0%}), expecting pullback"
            else:
                return None  # No clear direction

            return {
                "pattern": "BOLLINGER_SQUEEZE",
                "action": action,
                "confidence": min(0.95, confidence),
                "reason": reason,
            }

        return None

    def _detect_rsi_extreme(self, indicators: Dict) -> Optional[Dict]:
        """
        RSI Extremes: Oversold (<35) or Overbought (>70)
        Widened BUY zone for micro-budget spot trading
        """
        rsi = indicators['rsi']

        if rsi < 35:
            confidence = 0.70 + (35 - rsi) / 100  # Higher confidence for lower RSI
            return {
                "pattern": "RSI_OVERSOLD",
                "action": "BUY",
                "confidence": min(0.90, confidence),
                "reason": f"RSI oversold at {rsi:.1f}",
            }
        elif rsi > 70:
            confidence = 0.70 + (rsi - 70) / 100
            return {
                "pattern": "RSI_OVERBOUGHT",
                "action": "SELL",
                "confidence": min(0.90, confidence),
                "reason": f"RSI overbought at {rsi:.1f}",
            }

        return None

    def _detect_volume_spike(self, df: pd.DataFrame, indicators: Dict) -> Optional[Dict]:
        """
        Volume Spike: Current volume > 2x average
        """
        vol_ratio = indicators['volume_ratio']

        if vol_ratio > 2.0:
            # Check if price is moving up or down with the volume
            price_change = (df['close'].iloc[-1] - df['close'].iloc[-2]) / df['close'].iloc[-2]

            if price_change > 0.005:  # +0.5%
                return {
                    "pattern": "VOLUME_SPIKE_UP",
                    "action": "BUY",
                    "confidence": min(0.85, 0.65 + vol_ratio * 0.05),
                    "reason": f"Volume spike ({vol_ratio:.1f}x) with upward momentum",
                }
            elif price_change < -0.005:  # -0.5%
                return {
                    "pattern": "VOLUME_SPIKE_DOWN",
                    "action": "SELL",
                    "confidence": min(0.85, 0.65 + vol_ratio * 0.05),
                    "reason": f"Volume spike ({vol_ratio:.1f}x) with downward momentum",
                }

        return None

    def _detect_macd_crossover(self, df: pd.DataFrame, indicators: Dict) -> Optional[Dict]:
        """
        MACD Crossover: Signal line cross
        """
        macd = indicators['macd']
        signal = indicators['macd_signal']
        hist = indicators['macd_hist']

        # Need at least 2 candles to detect crossover
        close = df['close']
        ema12 = close.ewm(span=12).mean()
        ema26 = close.ewm(span=26).mean()
        macd_line = ema12 - ema26
        signal_line = macd_line.ewm(span=9).mean()

        prev_hist = (macd_line.iloc[-2] - signal_line.iloc[-2])
        curr_hist = hist

        # Bullish crossover
        if prev_hist < 0 and curr_hist > 0:
            return {
                "pattern": "MACD_BULLISH_CROSS",
                "action": "BUY",
                "confidence": 0.76,
                "reason": "MACD bullish crossover",
            }
        # Bearish crossover
        elif prev_hist > 0 and curr_hist < 0:
            return {
                "pattern": "MACD_BEARISH_CROSS",
                "action": "SELL",
                "confidence": 0.76,
                "reason": "MACD bearish crossover",
            }

        return None

    def _detect_dip_buy(self, df: pd.DataFrame, indicators: Dict) -> Optional[Dict]:
        """
        Mean Reversion: Price dropped significantly from recent high,
        now showing signs of recovery. Good for spot buying on dips.
        """
        close = df['close']
        high_20 = close.rolling(20).max().iloc[-1]  # 20-bar high
        current = close.iloc[-1]
        prev = close.iloc[-2]

        if high_20 <= 0:
            return None

        # Price is 5%+ below recent high AND current candle is green (recovering)
        drawdown = (high_20 - current) / high_20
        is_recovering = current > prev

        if drawdown >= 0.05 and is_recovering:
            # RSI should be below 50 (not overbought)
            rsi = indicators.get('rsi', 50)
            if rsi < 50:
                confidence = 0.70 + drawdown * 2  # More drawdown = more confidence
                return {
                    "pattern": "DIP_BUY",
                    "action": "BUY",
                    "confidence": min(0.85, confidence),
                    "reason": f"Dip buy: {drawdown:.1%} below 20-bar high, RSI {rsi:.0f}, recovering",
                }

        return None

    def _detect_ema_crossover(self, df: pd.DataFrame) -> Optional[Dict]:
        """
        EMA 9/21 Crossover: Fast EMA crosses above slow EMA = bullish
        """
        close = df['close']
        ema9 = close.ewm(span=9).mean()
        ema21 = close.ewm(span=21).mean()

        prev_diff = ema9.iloc[-2] - ema21.iloc[-2]
        curr_diff = ema9.iloc[-1] - ema21.iloc[-1]

        # Bullish crossover
        if prev_diff < 0 and curr_diff > 0:
            return {
                "pattern": "EMA_BULLISH_CROSS",
                "action": "BUY",
                "confidence": 0.74,
                "reason": "EMA 9/21 bullish crossover",
            }
        # Bearish crossover
        elif prev_diff > 0 and curr_diff < 0:
            return {
                "pattern": "EMA_BEARISH_CROSS",
                "action": "SELL",
                "confidence": 0.74,
                "reason": "EMA 9/21 bearish crossover",
            }

        return None

    def _detect_deep_value(
        self,
        df: pd.DataFrame,
        indicators: Dict,
        multi_tf_data: Optional[Dict[str, List[list]]] = None
    ) -> Optional[Dict]:
        """
        Deep Value / Fat Pitch Detector.
        Detects significant crashes (8%+) that represent buying opportunities.

        Pre-filter on 15m data (cheap), then uses multi-timeframe confirmation.
        Distinguishes panic selling (opportunity) from sustained collapse (avoid).
        """
        close = df['close']
        high = df['high']
        volume = df['volume']

        # --- Pre-filter: check drawdown from recent high ---
        high_20 = close.rolling(20).max().iloc[-1]
        current_price = close.iloc[-1]

        if high_20 <= 0:
            return None

        drawdown = (high_20 - current_price) / high_20

        if drawdown < self.deep_value_threshold:
            return None  # Not a deep enough drop

        # --- Calculate drop velocity (% per hour) ---
        # Find when the high occurred and calculate time elapsed
        high_idx = close.rolling(20).max().iloc[-20:].idxmax() if len(close) >= 20 else 0
        bars_since_high = len(close) - 1 - high_idx if high_idx > 0 else 20
        # Assuming 15m bars: bars * 0.25 = hours
        hours_elapsed = max(bars_since_high * 0.25, 0.25)
        drop_velocity = (drawdown * 100) / hours_elapsed  # %/hour

        # --- Volume analysis: capitulation = 3x+ average ---
        vol_sma = volume.rolling(20).mean()
        vol_ratio = volume.iloc[-1] / vol_sma.iloc[-1] if vol_sma.iloc[-1] > 0 else 1
        # Also check if recent bars had sustained high volume (not just a single spike)
        recent_vol_avg = volume.iloc[-5:].mean()
        sustained_vol_ratio = recent_vol_avg / vol_sma.iloc[-1] if vol_sma.iloc[-1] > 0 else 1

        # --- 15m RSI (already calculated) ---
        rsi_15m = indicators['rsi']

        # --- Multi-timeframe confirmation ---
        rsi_1h = None
        rsi_4h = None
        support_level = None

        if multi_tf_data:
            # Calculate RSI on 1h data
            if multi_tf_data.get('1h') and len(multi_tf_data['1h']) >= 20:
                df_1h = pd.DataFrame(multi_tf_data['1h'], columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
                rsi_1h_series = self._calculate_rsi(df_1h['close'], 14)
                rsi_1h = round(rsi_1h_series.iloc[-1], 2) if not pd.isna(rsi_1h_series.iloc[-1]) else None

            # Calculate RSI on 4h data
            if multi_tf_data.get('4h') and len(multi_tf_data['4h']) >= 20:
                df_4h = pd.DataFrame(multi_tf_data['4h'], columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
                rsi_4h_series = self._calculate_rsi(df_4h['close'], 14)
                rsi_4h = round(rsi_4h_series.iloc[-1], 2) if not pd.isna(rsi_4h_series.iloc[-1]) else None

            # Find support level from 1d data (lowest low in last 14 days)
            if multi_tf_data.get('1d') and len(multi_tf_data['1d']) >= 7:
                df_1d = pd.DataFrame(multi_tf_data['1d'], columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
                support_level = round(df_1d['low'].min(), 2)

        # --- Confidence scoring ---
        # Base confidence by drawdown magnitude
        if drawdown >= 0.18:
            base_confidence = 0.82
        elif drawdown >= 0.12:
            base_confidence = 0.78
        else:
            base_confidence = 0.72

        boosts = []

        # Capitulation volume boost (3x+ average)
        if vol_ratio >= 3.0 or sustained_vol_ratio >= 2.0:
            base_confidence += 0.05
            boosts.append(f"capitulation volume ({vol_ratio:.1f}x)")

        # Multi-TF RSI oversold boost (all < 35)
        mtf_oversold = rsi_15m < 35
        if rsi_1h is not None and rsi_1h < 35:
            mtf_oversold = mtf_oversold and True
        if rsi_4h is not None and rsi_4h < 35:
            mtf_oversold = mtf_oversold and True

        if mtf_oversold and (rsi_1h is not None or rsi_4h is not None):
            base_confidence += 0.05
            boosts.append(f"multi-TF RSI oversold (15m:{rsi_15m:.0f}, 1h:{rsi_1h}, 4h:{rsi_4h})")

        # Near support level boost
        if support_level and support_level > 0:
            distance_to_support = (current_price - support_level) / support_level
            if distance_to_support < 0.03:  # Within 3% of support
                base_confidence += 0.05
                boosts.append(f"near support ${support_level}")

        confidence = min(0.95, base_confidence)

        # --- Reject if drop is too fast (potential rug pull / flash crash artifact) ---
        if drop_velocity > 20:  # >20% per hour is suspicious
            confidence *= 0.7  # Heavy penalty
            boosts.append(f"WARNING: extreme velocity ({drop_velocity:.1f}%/h)")

        # --- Recovery check: is price showing any sign of bounce? ---
        is_recovering = current_price > close.iloc[-2]  # Green candle
        if not is_recovering:
            confidence *= 0.9  # Slight penalty if still falling
            boosts.append("no recovery candle yet")

        # --- SL/TP: wider than normal (3*ATR SL, 4*ATR TP) ---
        atr = indicators['atr']
        entry_price = current_price
        stop_loss = round(entry_price - 3 * atr, 2)
        target_price = round(entry_price + 4 * atr, 2)

        reason_parts = [
            f"Deep value crash: {drawdown:.1%} drawdown from recent high",
            f"velocity {drop_velocity:.1f}%/h",
            f"vol {vol_ratio:.1f}x",
            f"RSI 15m:{rsi_15m:.0f}",
        ]
        if rsi_1h is not None:
            reason_parts.append(f"1h:{rsi_1h:.0f}")
        if rsi_4h is not None:
            reason_parts.append(f"4h:{rsi_4h:.0f}")
        if boosts:
            reason_parts.append(f"[{', '.join(boosts)}]")

        return {
            "pattern": "DEEP_VALUE_CRASH",
            "action": "BUY",
            "confidence": round(confidence, 4),
            "reason": " | ".join(reason_parts),
            "entry_price": entry_price,
            "stop_loss": stop_loss,
            "target_price": target_price,
            "deep_value_metrics": {
                "drawdown_pct": round(drawdown * 100, 2),
                "drop_velocity": round(drop_velocity, 2),
                "volume_ratio": round(vol_ratio, 2),
                "sustained_vol_ratio": round(sustained_vol_ratio, 2),
                "rsi_15m": round(rsi_15m, 1),
                "rsi_1h": rsi_1h,
                "rsi_4h": rsi_4h,
                "support_level": support_level,
                "recent_high": round(high_20, 2),
                "is_recovering": is_recovering,
            },
        }

    def _generate_signal(
        self,
        patterns: List[Dict],
        indicators: Dict,
        df: pd.DataFrame
    ) -> Dict[str, Any]:
        """
        Combine all patterns into a final trading signal.

        Multi-Indicator Consensus Logic:
        - Single pattern: base confidence
        - 2 patterns: +10% confidence boost
        - 3+ patterns: +15% confidence boost
        - Trend alignment (price vs MA): +5% boost
        - Volume confirmation: +5% boost
        """
        price = indicators['price']
        atr = indicators['atr']

        if not patterns:
            return {
                "action": "HOLD",
                "confidence": 0.5,
                "reason": "No clear pattern detected",
                "patterns": [],
                "entry_price": price,
                "stop_loss": round(price * 0.98, 2),
                "target_price": round(price * 1.02, 2),
                "consensus_score": 0,
            }

        # Check for deep value crash - it overrides normal consensus logic
        deep_value = next((p for p in patterns if p['pattern'] == 'DEEP_VALUE_CRASH'), None)
        if deep_value:
            # Deep value uses its own wider SL/TP and confidence
            signal = {
                "action": "BUY",
                "confidence": deep_value['confidence'],
                "reason": deep_value['reason'],
                "patterns": [p['pattern'] for p in patterns],
                "entry_price": deep_value['entry_price'],
                "stop_loss": deep_value['stop_loss'],
                "target_price": deep_value['target_price'],
                "consensus_score": len(patterns),
                "is_deep_value": True,
                "deep_value_metrics": deep_value.get('deep_value_metrics', {}),
            }
            # Boost confidence if other patterns also confirm BUY
            other_buys = [p for p in patterns if p['action'] == 'BUY' and p['pattern'] != 'DEEP_VALUE_CRASH']
            if other_buys:
                signal['confidence'] = min(0.95, signal['confidence'] + 0.05 * len(other_buys))
                signal['reason'] += f" | +{len(other_buys)} confirming patterns"
            return signal

        # Aggregate signals
        buy_signals = [p for p in patterns if p['action'] == 'BUY']
        sell_signals = [p for p in patterns if p['action'] == 'SELL']

        # Check for trend alignment (price vs BB middle)
        bb_mid = indicators.get('bb_mid', price)
        trend_bullish = price > bb_mid
        trend_bearish = price < bb_mid

        # Check volume confirmation
        volume_ratio = indicators.get('volume_ratio', 1)
        volume_confirmed = volume_ratio > 1.2  # 20% above average

        def calculate_consensus_confidence(signals: List[Dict], trend_aligned: bool) -> tuple:
            """Calculate confidence with consensus boosts"""
            if not signals:
                return 0, []

            base_confidence = sum(p['confidence'] for p in signals) / len(signals)
            boosts = []

            # Multi-pattern consensus boost
            if len(signals) >= 3:
                base_confidence += 0.15
                boosts.append("+15% (3+ confirming patterns)")
            elif len(signals) >= 2:
                base_confidence += 0.10
                boosts.append("+10% (2 confirming patterns)")

            # Trend alignment boost
            if trend_aligned:
                base_confidence += 0.05
                boosts.append("+5% (trend aligned)")

            # Volume confirmation boost
            if volume_confirmed:
                base_confidence += 0.05
                boosts.append("+5% (volume confirmed)")

            return min(0.95, base_confidence), boosts

        # Calculate weighted confidence for each direction
        if buy_signals and not sell_signals:
            confidence, boosts = calculate_consensus_confidence(buy_signals, trend_bullish)
            reasons = [p['reason'] for p in buy_signals]

            return {
                "action": "BUY",
                "confidence": round(confidence, 4),
                "reason": " | ".join(reasons),
                "patterns": [p['pattern'] for p in buy_signals],
                "entry_price": price,
                "stop_loss": round(price - 2 * atr, 2),
                "target_price": round(price + 3 * atr, 2),
                "consensus_score": len(buy_signals),
                "consensus_boosts": boosts,
                "trend_aligned": trend_bullish,
                "volume_confirmed": volume_confirmed,
            }

        elif sell_signals and not buy_signals:
            confidence, boosts = calculate_consensus_confidence(sell_signals, trend_bearish)
            reasons = [p['reason'] for p in sell_signals]

            return {
                "action": "SELL",
                "confidence": round(confidence, 4),
                "reason": " | ".join(reasons),
                "patterns": [p['pattern'] for p in sell_signals],
                "entry_price": price,
                "stop_loss": round(price + 2 * atr, 2),
                "target_price": round(price - 3 * atr, 2),
                "consensus_score": len(sell_signals),
                "consensus_boosts": boosts,
                "trend_aligned": trend_bearish,
                "volume_confirmed": volume_confirmed,
            }

        else:
            # Conflicting signals - compare strength
            buy_strength = sum(p['confidence'] for p in buy_signals)
            sell_strength = sum(p['confidence'] for p in sell_signals)

            # If one side is significantly stronger (>1.5x), go with it but reduce confidence
            if buy_strength > sell_strength * 1.5:
                confidence = (buy_strength / (buy_strength + sell_strength)) * 0.6  # Max 60% on conflict
                return {
                    "action": "BUY",
                    "confidence": round(confidence, 4),
                    "reason": f"Weak BUY (conflicting: {len(buy_signals)} buy vs {len(sell_signals)} sell)",
                    "patterns": [p['pattern'] for p in buy_signals],
                    "entry_price": price,
                    "stop_loss": round(price - 1.5 * atr, 2),  # Tighter stop on conflict
                    "target_price": round(price + 2 * atr, 2),
                    "consensus_score": 0,
                    "conflicting": True,
                }
            elif sell_strength > buy_strength * 1.5:
                confidence = (sell_strength / (buy_strength + sell_strength)) * 0.6
                return {
                    "action": "SELL",
                    "confidence": round(confidence, 4),
                    "reason": f"Weak SELL (conflicting: {len(sell_signals)} sell vs {len(buy_signals)} buy)",
                    "patterns": [p['pattern'] for p in sell_signals],
                    "entry_price": price,
                    "stop_loss": round(price + 1.5 * atr, 2),
                    "target_price": round(price - 2 * atr, 2),
                    "consensus_score": 0,
                    "conflicting": True,
                }
            else:
                # True conflict - HOLD
                return {
                    "action": "HOLD",
                    "confidence": 0.4,
                    "reason": f"Conflicting signals ({len(buy_signals)} buy vs {len(sell_signals)} sell)",
                    "patterns": [p['pattern'] for p in patterns],
                    "entry_price": price,
                    "stop_loss": round(price * 0.98, 2),
                    "target_price": round(price * 1.02, 2),
                    "consensus_score": 0,
                    "conflicting": True,
                }

    # === Helper Methods ===

    def _calculate_rsi(self, prices: pd.Series, period: int = 14) -> pd.Series:
        """Calculate RSI (handles zero-loss and zero-gain edge cases)"""
        delta = prices.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        # Avoid division by zero: when loss=0 -> RSI=100, when gain=0 -> RSI=0
        # Clamp to [1, 99] since true 0/100 are unrealistic in real markets
        rs = gain / loss.replace(0, np.nan)
        rsi = 100 - (100 / (1 + rs))
        # Where loss was 0 (all gains), RSI should be near 100
        rsi = rsi.fillna(99.0)
        # Where gain was 0 (all losses), rs=0, RSI=0 -> clamp to 1
        rsi = rsi.clip(lower=1.0, upper=99.0)
        return rsi

    def _calculate_bollinger(
        self, prices: pd.Series, period: int = 20, std: int = 2
    ) -> tuple:
        """Calculate Bollinger Bands"""
        mid = prices.rolling(period).mean()
        std_dev = prices.rolling(period).std()
        upper = mid + std * std_dev
        lower = mid - std * std_dev
        width = (upper - lower) / mid
        return mid, upper, lower, width

    def _calculate_atr(
        self, high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14
    ) -> pd.Series:
        """Calculate Average True Range"""
        tr1 = high - low
        tr2 = abs(high - close.shift())
        tr3 = abs(low - close.shift())
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        return tr.rolling(period).mean()

    def _calculate_macd(
        self, prices: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9
    ) -> tuple:
        """Calculate MACD"""
        ema_fast = prices.ewm(span=fast).mean()
        ema_slow = prices.ewm(span=slow).mean()
        macd = ema_fast - ema_slow
        macd_signal = macd.ewm(span=signal).mean()
        macd_hist = macd - macd_signal
        return macd, macd_signal, macd_hist

    def _percentile(self, series: pd.Series, value: float) -> float:
        """Calculate percentile of value in series"""
        return round((series < value).sum() / len(series) * 100, 1)


# Singleton instance
quant = QuantGuild()
