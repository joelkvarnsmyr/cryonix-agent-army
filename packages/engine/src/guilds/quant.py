"""
Quant Guild - Technical Analysis Engine
Calculates indicators and detects patterns from OHLCV data
"""
import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional
from dataclasses import dataclass
from src.core.config import get_toml

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

    # Pattern classification for regime filtering
    MEAN_REVERSION_PATTERNS = {'RSI_OVERSOLD', 'RSI_OVERBOUGHT', 'BOLLINGER_SQUEEZE'}
    TREND_FOLLOWING_PATTERNS = {'EMA_BULLISH_CROSS', 'EMA_BEARISH_CROSS', 'MACD_BULLISH_CROSS', 'MACD_BEARISH_CROSS', 'MOMENTUM_GAINER'}
    REGIME_AGNOSTIC_PATTERNS = {'DEEP_VALUE_CRASH', 'VOLUME_SPIKE_UP', 'VOLUME_SPIKE_DOWN'}

    def __init__(self):
        self.min_candles = get_toml('indicators', 'min_candles', 50)
        self.deep_value_threshold = get_toml('patterns', 'deep_value_threshold', 0.08)

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

        # Calculate HTF indicators for pattern confirmation
        htf_indicators = self._calculate_htf_indicators(multi_tf_data)

        # Run pattern detectors
        patterns = self._detect_patterns(df, indicators, htf_indicators=htf_indicators)

        # Deep value crash detection (multi-timeframe)
        deep_value = self._detect_deep_value(df, indicators, multi_tf_data)
        if deep_value:
            patterns.append(deep_value)

        # Generate final signal (with multi-TF trend filter)
        htf_trend = self._get_higher_tf_trend(multi_tf_data)
        self._current_multi_tf = multi_tf_data
        signal = self._generate_signal(patterns, indicators, df, htf_trend)
        self._current_multi_tf = None

        return {
            "status": "success",
            "symbol": symbol,
            "indicators": indicators,
            "patterns": patterns,
            "signal": signal,
            "htf_trend": htf_trend,
            "candles_analyzed": len(df),
        }

    def _calculate_indicators(self, df: pd.DataFrame) -> Dict[str, Any]:
        """Calculate all technical indicators"""
        close = df['close']
        high = df['high']
        low = df['low']
        volume = df['volume']

        # RSI
        rsi = self._calculate_rsi(close, get_toml('indicators', 'rsi_period', 14))

        # Bollinger Bands
        bb_mid, bb_upper, bb_lower, bb_width = self._calculate_bollinger(
            close, get_toml('indicators', 'bollinger_period', 20), get_toml('indicators', 'bollinger_std', 2))

        # ATR for volatility
        atr = self._calculate_atr(high, low, close, get_toml('indicators', 'atr_period', 14))

        # Volume SMA
        vol_sma = volume.rolling(get_toml('indicators', 'volume_sma_period', 20)).mean()

        # MACD
        macd, macd_signal, macd_hist = self._calculate_macd(
            close, get_toml('indicators', 'macd_fast', 12), get_toml('indicators', 'macd_slow', 26), get_toml('indicators', 'macd_signal', 9))

        # ADX for market regime detection
        adx, plus_di, minus_di = self._calculate_adx(high, low, close, get_toml('indicators', 'adx_period', 14))

        # EMA fast/slow for trend direction
        ema9 = close.ewm(span=get_toml('indicators', 'ema_fast', 9)).mean()
        ema21 = close.ewm(span=get_toml('indicators', 'ema_slow', 21)).mean()

        # Get latest values
        latest_idx = -1

        return {
            "rsi": round(rsi.iloc[latest_idx], 2) if not pd.isna(rsi.iloc[latest_idx]) else 50,
            "bb_upper": float(bb_upper.iloc[latest_idx]),
            "bb_mid": float(bb_mid.iloc[latest_idx]),
            "bb_lower": float(bb_lower.iloc[latest_idx]),
            "bb_width": round(bb_width.iloc[latest_idx], 4),
            "bb_width_percentile": self._percentile(bb_width, bb_width.iloc[latest_idx]),
            "atr": float(atr.iloc[latest_idx]) if not pd.isna(atr.iloc[latest_idx]) else 0,
            "atr_percent": round((atr.iloc[latest_idx] / close.iloc[latest_idx]) * 100, 2) if close.iloc[latest_idx] > 0 else 0,
            "volume_ratio": round(volume.iloc[latest_idx] / vol_sma.iloc[latest_idx], 2) if vol_sma.iloc[latest_idx] > 0 else 1,
            "macd": round(macd.iloc[latest_idx], 4) if not pd.isna(macd.iloc[latest_idx]) else 0,
            "macd_signal": round(macd_signal.iloc[latest_idx], 4) if not pd.isna(macd_signal.iloc[latest_idx]) else 0,
            "macd_hist": round(macd_hist.iloc[latest_idx], 4) if not pd.isna(macd_hist.iloc[latest_idx]) else 0,
            "price": float(close.iloc[latest_idx]),
            "adx": round(float(adx.iloc[latest_idx]), 2) if not pd.isna(adx.iloc[latest_idx]) else 0,
            "plus_di": round(float(plus_di.iloc[latest_idx]), 2) if not pd.isna(plus_di.iloc[latest_idx]) else 0,
            "minus_di": round(float(minus_di.iloc[latest_idx]), 2) if not pd.isna(minus_di.iloc[latest_idx]) else 0,
            "ema9": round(float(ema9.iloc[latest_idx]), 8),
            "ema21": round(float(ema21.iloc[latest_idx]), 8),
            "market_regime": self._classify_regime(
                float(adx.iloc[latest_idx]) if not pd.isna(adx.iloc[latest_idx]) else 0,
                float(atr.iloc[latest_idx]) if not pd.isna(atr.iloc[latest_idx]) else 0,
                atr, bb_width
            ),
        }

    def _detect_patterns(self, df: pd.DataFrame, indicators: Dict, htf_indicators: Optional[Dict] = None) -> List[Dict]:
        """Run all pattern detectors"""
        patterns = []

        # 1. Bollinger Squeeze
        squeeze = self._detect_bollinger_squeeze(df, indicators, htf_indicators=htf_indicators)
        if squeeze:
            patterns.append(squeeze)

        # 2. RSI Extremes
        rsi_signal = self._detect_rsi_extreme(indicators, htf_indicators=htf_indicators)
        if rsi_signal:
            patterns.append(rsi_signal)

        # 3. Volume Spike
        vol_signal = self._detect_volume_spike(df, indicators, htf_indicators=htf_indicators)
        if vol_signal:
            patterns.append(vol_signal)

        # 4. MACD Crossover
        macd_signal = self._detect_macd_crossover(df, indicators, htf_indicators=htf_indicators)
        if macd_signal:
            patterns.append(macd_signal)

        # 5. Mean Reversion / Dip Buy
        dip_signal = self._detect_dip_buy(df, indicators, htf_indicators=htf_indicators)
        if dip_signal:
            patterns.append(dip_signal)

        # 6. EMA Crossover (9/21)
        ema_signal = self._detect_ema_crossover(df, htf_indicators=htf_indicators)
        if ema_signal:
            patterns.append(ema_signal)

        return patterns

    def _detect_bollinger_squeeze(self, df: pd.DataFrame, indicators: Dict, htf_indicators: Optional[Dict] = None) -> Optional[Dict]:
        """
        Bollinger Squeeze: When bands narrow significantly, expect breakout.
        """
        bb_width_pct = indicators['bb_width_percentile']
        price = indicators['price']
        bb_upper = indicators['bb_upper']
        bb_lower = indicators['bb_lower']

        # Squeeze detected when width is in bottom N%
        if bb_width_pct < get_toml('indicators', 'bollinger_squeeze_pct', 20):
            # Multi-TF confirmation: 1h BB width also squeezed
            if htf_indicators and htf_indicators.get('1h'):
                if htf_indicators['1h'].get('bb_width_percentile', 50) >= 30:
                    return None  # 1h not in squeeze

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

    def _detect_rsi_extreme(self, indicators: Dict, htf_indicators: Optional[Dict] = None) -> Optional[Dict]:
        """
        RSI Extremes: Oversold (<30) or Overbought (>70)
        Widened BUY zone for micro-budget spot trading
        """
        rsi = indicators['rsi']

        rsi_oversold = get_toml('indicators', 'rsi_oversold', 30)
        rsi_overbought = get_toml('indicators', 'rsi_overbought', 70)

        if rsi < rsi_oversold:
            # Multi-TF confirmation: 1h RSI must also be < 40
            if htf_indicators and htf_indicators.get('1h'):
                if htf_indicators['1h'].get('rsi', 50) >= 40:
                    return None  # 1h RSI not confirming oversold

            confidence = 0.75 + (rsi_oversold - rsi) / 80
            return {
                "pattern": "RSI_OVERSOLD",
                "action": "BUY",
                "confidence": min(0.92, confidence),
                "reason": f"RSI oversold at {rsi:.1f}",
            }
        elif rsi > rsi_overbought:
            # Multi-TF confirmation: 1h RSI must also be > 60
            if htf_indicators and htf_indicators.get('1h'):
                if htf_indicators['1h'].get('rsi', 50) <= 60:
                    return None

            confidence = 0.70 + (rsi - rsi_overbought) / 100
            return {
                "pattern": "RSI_OVERBOUGHT",
                "action": "SELL",
                "confidence": min(0.90, confidence),
                "reason": f"RSI overbought at {rsi:.1f}",
            }

        return None

    def _detect_volume_spike(self, df: pd.DataFrame, indicators: Dict, htf_indicators: Optional[Dict] = None) -> Optional[Dict]:
        """
        Volume Spike: Current volume > 2x average
        """
        vol_ratio = indicators['volume_ratio']

        if vol_ratio > get_toml('indicators', 'volume_spike_threshold', 2.0):
            # Multi-TF confirmation: 1h volume also elevated
            if htf_indicators and htf_indicators.get('1h'):
                if htf_indicators['1h'].get('volume_ratio', 1.0) < 1.5:
                    return None

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

    def _detect_macd_crossover(self, df: pd.DataFrame, indicators: Dict, htf_indicators: Optional[Dict] = None) -> Optional[Dict]:
        """
        MACD Crossover: Signal line cross
        """
        macd = indicators['macd']
        signal = indicators['macd_signal']
        hist = indicators['macd_hist']

        # Need at least 2 candles to detect crossover
        close = df['close']
        ema12 = close.ewm(span=get_toml('indicators', 'macd_fast', 12)).mean()
        ema26 = close.ewm(span=get_toml('indicators', 'macd_slow', 26)).mean()
        macd_line = ema12 - ema26
        signal_line = macd_line.ewm(span=get_toml('indicators', 'macd_signal', 9)).mean()

        prev_hist = (macd_line.iloc[-2] - signal_line.iloc[-2])
        curr_hist = hist

        # Bullish crossover
        if prev_hist < 0 and curr_hist > 0:
            # Multi-TF: 1h MACD histogram must also be positive
            if htf_indicators and htf_indicators.get('1h'):
                if htf_indicators['1h'].get('macd_hist', 0) < 0:
                    return None

            return {
                "pattern": "MACD_BULLISH_CROSS",
                "action": "BUY",
                "confidence": 0.62,  # Lowered: MACD alone is weak signal
                "reason": "MACD bullish crossover",
            }
        # Bearish crossover
        elif prev_hist > 0 and curr_hist < 0:
            # Multi-TF: 1h MACD histogram must also be negative
            if htf_indicators and htf_indicators.get('1h'):
                if htf_indicators['1h'].get('macd_hist', 0) > 0:
                    return None

            return {
                "pattern": "MACD_BEARISH_CROSS",
                "action": "SELL",
                "confidence": 0.62,  # Lowered: MACD alone is weak signal
                "reason": "MACD bearish crossover",
            }

        return None

    def _detect_dip_buy(self, df: pd.DataFrame, indicators: Dict, htf_indicators: Optional[Dict] = None) -> Optional[Dict]:
        """
        Mean Reversion: Price dropped significantly from recent high,
        now showing signs of recovery. Good for spot buying on dips.
        """
        close = df['close']
        dip_lookback = get_toml('patterns', 'dip_buy_lookback', 20)
        high_20 = close.rolling(dip_lookback).max().iloc[-1]
        current = close.iloc[-1]
        prev = close.iloc[-2]

        if high_20 <= 0:
            return None

        drawdown = (high_20 - current) / high_20
        is_recovering = current > prev

        dip_min_drawdown = get_toml('patterns', 'dip_buy_drawdown', 0.05)
        if drawdown >= dip_min_drawdown and is_recovering:
            rsi = indicators.get('rsi', 50)
            dip_max_rsi = get_toml('patterns', 'dip_buy_max_rsi', 50)
            if rsi < dip_max_rsi:
                # Multi-TF: 4h RSI must not be overbought
                if htf_indicators and htf_indicators.get('4h'):
                    if htf_indicators['4h'].get('rsi', 50) >= 45:
                        return None

                confidence = 0.70 + drawdown * 2  # More drawdown = more confidence
                return {
                    "pattern": "DIP_BUY",
                    "action": "BUY",
                    "confidence": min(0.85, confidence),
                    "reason": f"Dip buy: {drawdown:.1%} below 20-bar high, RSI {rsi:.0f}, recovering",
                }

        return None

    def _detect_ema_crossover(self, df: pd.DataFrame, htf_indicators: Optional[Dict] = None) -> Optional[Dict]:
        """
        EMA 9/21 Crossover: Fast EMA crosses above slow EMA = bullish
        """
        close = df['close']
        ema_fast = close.ewm(span=get_toml('indicators', 'ema_fast', 9)).mean()
        ema_slow = close.ewm(span=get_toml('indicators', 'ema_slow', 21)).mean()

        prev_diff = ema_fast.iloc[-2] - ema_slow.iloc[-2]
        curr_diff = ema_fast.iloc[-1] - ema_slow.iloc[-1]

        # Bullish crossover
        if prev_diff < 0 and curr_diff > 0:
            # Multi-TF: 1h EMA9 must already be > EMA21 (trend aligned)
            if htf_indicators and htf_indicators.get('1h'):
                htf = htf_indicators['1h']
                if htf.get('ema9', 0) <= htf.get('ema21', 0):
                    return None

            return {
                "pattern": "EMA_BULLISH_CROSS",
                "action": "BUY",
                "confidence": 0.60,  # Raised from 0.55: HTF confirmation improves quality
                "reason": "EMA 9/21 bullish crossover",
            }
        # Bearish crossover
        elif prev_diff > 0 and curr_diff < 0:
            # Multi-TF: 1h EMA9 must already be < EMA21 (trend aligned)
            if htf_indicators and htf_indicators.get('1h'):
                htf = htf_indicators['1h']
                if htf.get('ema9', 0) >= htf.get('ema21', 0):
                    return None

            return {
                "pattern": "EMA_BEARISH_CROSS",
                "action": "SELL",
                "confidence": 0.60,  # Raised from 0.55: HTF confirmation improves quality
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
        high_idx = close.iloc[-20:].idxmax() if len(close) >= 20 else 0
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

        # Multi-TF RSI oversold boost/penalty
        if rsi_15m < 35:
            htf_oversold = True
            htf_conflict = False
            if rsi_1h is not None:
                if rsi_1h < 35:
                    pass  # confirms oversold
                else:
                    htf_conflict = True  # 1h NOT oversold = conflicting
            if rsi_4h is not None:
                if rsi_4h < 35:
                    pass
                else:
                    htf_conflict = True

            if htf_conflict:
                base_confidence -= 0.03
                boosts.append(f"HTF RSI conflict (15m:{rsi_15m:.0f}, 1h:{rsi_1h}, 4h:{rsi_4h})")
            elif rsi_1h is not None or rsi_4h is not None:
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
        if drop_velocity > get_toml('patterns', 'deep_value_rug_pull_velocity', 20.0):
            confidence *= 0.7  # Heavy penalty
            boosts.append(f"WARNING: extreme velocity ({drop_velocity:.1f}%/h)")

        # --- Recovery check: is price showing any sign of bounce? ---
        # Require at least a green candle. Without recovery, deep value entries
        # are catching a falling knife (OP/USDC 0% WR without bounce).
        is_recovering = current_price > close.iloc[-2]  # Green candle
        if not is_recovering:
            confidence *= 0.70  # Aggressive penalty: DEEP_VALUE without recovery has 0% WR (OP/USDC -$0.91)
            boosts.append("no recovery candle yet (falling knife penalty)")

        # --- SL/TP: wider than normal (3*ATR SL, 4*ATR TP) ---
        atr = indicators['atr']
        entry_price = current_price
        dec = 2 if entry_price >= 1 else (4 if entry_price >= 0.01 else (6 if entry_price >= 0.0001 else 8))
        stop_loss = round(entry_price - get_toml('exits', 'deep_value_sl_atr', 3.0) * atr, dec)
        target_price = round(entry_price + get_toml('exits', 'deep_value_tp_atr', 4.0) * atr, dec)

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
        df: pd.DataFrame,
        htf_trend: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        Combine all patterns into a final trading signal.

        Multi-Indicator Consensus Logic:
        - Single pattern: base confidence
        - 2 patterns: +10% confidence boost
        - 3+ patterns: +15% confidence boost
        - Trend alignment (price vs MA): +5% boost
        - Volume confirmation: +5% boost
        - Higher timeframe alignment: +5% boost / -10% penalty
        """
        price = indicators['price']
        atr = indicators['atr']
        # Smart rounding: more decimals for low-price coins
        decimals = 2 if price >= 1 else (4 if price >= 0.01 else (6 if price >= 0.0001 else 8))
        def rp(v): return round(v, decimals)

        if not patterns:
            return {
                "action": "HOLD",
                "confidence": 0.5,
                "reason": "No clear pattern detected",
                "patterns": [],
                "entry_price": price,
                "stop_loss": rp(price * 0.98),
                "target_price": rp(price * 1.02),
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

        # ── HTF hard veto: block counter-trend trades ──
        dominant_action = 'BUY' if len(buy_signals) >= len(sell_signals) else 'SELL'
        if buy_signals or sell_signals:
            htf_gate = self._passes_htf_gate(dominant_action, getattr(self, '_current_multi_tf', None))
            if not htf_gate['allowed']:
                return {
                    "action": "HOLD",
                    "confidence": 0.3,
                    "reason": f"{htf_gate['reason']} — {len(buy_signals)} buy / {len(sell_signals)} sell patterns blocked",
                    "patterns": [p['pattern'] for p in patterns],
                    "entry_price": price,
                    "stop_loss": rp(price * 0.98),
                    "target_price": rp(price * 1.02),
                    "consensus_score": 0,
                    "filtered_by": "htf_gate",
                }

        # ── Regime gate: filter patterns by market type ──
        regime = indicators.get('market_regime', 'unknown')
        ema21 = indicators.get('ema21', price)
        patterns = self._filter_by_regime(patterns, regime, ema21=ema21, price=price)

        if not patterns:
            return {
                "action": "HOLD",
                "confidence": 0.3,
                "reason": f"All patterns filtered by {regime} regime gate",
                "patterns": [],
                "entry_price": price,
                "stop_loss": rp(price * 0.98),
                "target_price": rp(price * 1.02),
                "consensus_score": 0,
                "filtered_by": "regime_gate",
            }

        # Re-split after regime filtering
        buy_signals = [p for p in patterns if p['action'] == 'BUY']
        sell_signals = [p for p in patterns if p['action'] == 'SELL']

        # ── Consensus gate: require 2+ confirming patterns ──
        # Single-pattern signals (e.g. RSI_OVERSOLD alone) have 25% win rate.
        # Combo signals (e.g. BOLLINGER + RSI) have 50%+ win rate.
        # DEEP_VALUE_CRASH is exempt (handled above with its own multi-TF logic).
        if buy_signals and len(buy_signals) < 2 and not sell_signals:
            return {
                "action": "HOLD",
                "confidence": max(p['confidence'] for p in buy_signals) * 0.5,
                "reason": f"Single pattern ({buy_signals[0]['pattern']}) — need 2+ for consensus",
                "patterns": [p['pattern'] for p in buy_signals],
                "entry_price": price,
                "stop_loss": rp(price * 0.98),
                "target_price": rp(price * 1.02),
                "consensus_score": 0,
                "filtered_by": "consensus_gate",
            }
        if sell_signals and len(sell_signals) < 2 and not buy_signals:
            return {
                "action": "HOLD",
                "confidence": max(p['confidence'] for p in sell_signals) * 0.5,
                "reason": f"Single pattern ({sell_signals[0]['pattern']}) — need 2+ for consensus",
                "patterns": [p['pattern'] for p in sell_signals],
                "entry_price": price,
                "stop_loss": rp(price * 1.02),
                "target_price": rp(price * 0.98),
                "consensus_score": 0,
                "filtered_by": "consensus_gate",
            }

        # Check for trend alignment (price vs BB middle)
        bb_mid = indicators.get('bb_mid', price)
        trend_bullish = bool(price > bb_mid)
        trend_bearish = bool(price < bb_mid)

        # Check volume confirmation
        volume_ratio = indicators.get('volume_ratio', 1)
        volume_confirmed = bool(volume_ratio > get_toml('indicators', 'volume_confirmation', 1.2))

        # Higher timeframe and regime context
        htf_bullish = htf_trend and htf_trend.get('bias') == 'bullish'
        htf_bearish = htf_trend and htf_trend.get('bias') == 'bearish'
        market_regime = indicators.get('market_regime', 'unknown')

        def calculate_consensus_confidence(signals: List[Dict], trend_aligned: bool, action: str) -> tuple:
            """Calculate confidence with consensus boosts"""
            if not signals:
                return 0, []

            base_confidence = sum(p['confidence'] for p in signals) / len(signals)
            boosts = []

            # Multi-pattern consensus boost
            three_boost = get_toml('consensus', 'three_pattern_boost', 0.15)
            two_boost = get_toml('consensus', 'two_pattern_boost', 0.10)
            if len(signals) >= 3:
                base_confidence += three_boost
                boosts.append(f"+{three_boost:.0%} (3+ confirming patterns)")
            elif len(signals) >= 2:
                base_confidence += two_boost
                boosts.append(f"+{two_boost:.0%} (2 confirming patterns)")

            # Trend alignment boost
            if trend_aligned:
                base_confidence += 0.05
                boosts.append("+5% (trend aligned)")

            # Volume confirmation boost
            if volume_confirmed:
                base_confidence += 0.05
                boosts.append("+5% (volume confirmed)")

            # Higher timeframe alignment
            if htf_trend:
                if (action == 'BUY' and htf_bullish) or (action == 'SELL' and htf_bearish):
                    base_confidence += 0.05
                    boosts.append(f"+5% (HTF {htf_trend['bias']})")
                elif (action == 'BUY' and htf_bearish) or (action == 'SELL' and htf_bullish):
                    base_confidence -= 0.10
                    boosts.append(f"-10% (against HTF {htf_trend['bias']})")

            # Market regime penalty for trend signals in ranging markets
            if market_regime == 'ranging':
                trend_patterns = {'MACD_BULLISH_CROSS', 'MACD_BEARISH_CROSS', 'EMA_BULLISH_CROSS', 'EMA_BEARISH_CROSS'}
                if any(p.get('pattern') in trend_patterns for p in signals):
                    ranging_penalty = get_toml('consensus', 'ranging_trend_penalty', 0.05)
                    base_confidence -= ranging_penalty
                    boosts.append(f"-{ranging_penalty:.0%} (trend signal in ranging market)")

            return min(0.95, base_confidence), boosts

        # Calculate weighted confidence for each direction
        if buy_signals and not sell_signals:
            confidence, boosts = calculate_consensus_confidence(buy_signals, trend_bullish, 'BUY')
            reasons = [p['reason'] for p in buy_signals]

            return {
                "action": "BUY",
                "confidence": round(confidence, 4),
                "reason": " | ".join(reasons),
                "patterns": [p['pattern'] for p in buy_signals],
                "entry_price": price,
                "stop_loss": rp(price - get_toml('exits', 'sl_atr_multiplier', 3.5) * atr),
                "target_price": rp(price + get_toml('exits', 'tp_atr_multiplier', 5.0) * atr),
                "consensus_score": len(buy_signals),
                "consensus_boosts": boosts,
                "trend_aligned": trend_bullish,
                "volume_confirmed": volume_confirmed,
                "htf_trend": htf_trend.get('bias') if htf_trend else None,
                "market_regime": market_regime,
            }

        elif sell_signals and not buy_signals:
            confidence, boosts = calculate_consensus_confidence(sell_signals, trend_bearish, 'SELL')
            reasons = [p['reason'] for p in sell_signals]

            return {
                "action": "SELL",
                "confidence": round(confidence, 4),
                "reason": " | ".join(reasons),
                "patterns": [p['pattern'] for p in sell_signals],
                "entry_price": price,
                "stop_loss": rp(price + get_toml('exits', 'sl_atr_multiplier', 3.5) * atr),
                "target_price": rp(price - get_toml('exits', 'tp_atr_multiplier', 5.0) * atr),
                "consensus_score": len(sell_signals),
                "consensus_boosts": boosts,
                "trend_aligned": trend_bearish,
                "volume_confirmed": volume_confirmed,
                "htf_trend": htf_trend.get('bias') if htf_trend else None,
                "market_regime": market_regime,
            }

        else:
            # Conflicting signals - compare strength
            buy_strength = sum(p['confidence'] for p in buy_signals)
            sell_strength = sum(p['confidence'] for p in sell_signals)

            # If one side is significantly stronger (>1.5x), go with it
            # Use max individual confidence from winning side (don't average down strong single patterns)
            if buy_strength > sell_strength * 1.5:
                best_buy = max(p['confidence'] for p in buy_signals)
                confidence = max(best_buy * 0.85, (buy_strength / (buy_strength + sell_strength)) * 0.7)
                return {
                    "action": "BUY",
                    "confidence": round(min(0.85, confidence), 4),
                    "reason": f"BUY (conflicting: {len(buy_signals)} buy vs {len(sell_signals)} sell)",
                    "patterns": [p['pattern'] for p in buy_signals],
                    "entry_price": price,
                    "stop_loss": rp(price - 2 * atr),
                    "target_price": rp(price + 3 * atr),
                    "consensus_score": 0,
                    "conflicting": True,
                }
            elif sell_strength > buy_strength * 1.5:
                best_sell = max(p['confidence'] for p in sell_signals)
                confidence = max(best_sell * 0.85, (sell_strength / (buy_strength + sell_strength)) * 0.7)
                return {
                    "action": "SELL",
                    "confidence": round(min(0.85, confidence), 4),
                    "reason": f"SELL (conflicting: {len(sell_signals)} sell vs {len(buy_signals)} buy)",
                    "patterns": [p['pattern'] for p in sell_signals],
                    "entry_price": price,
                    "stop_loss": rp(price + 2 * atr),
                    "target_price": rp(price - 3 * atr),
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
                    "stop_loss": rp(price * 0.98),
                    "target_price": rp(price * 1.02),
                    "consensus_score": 0,
                    "conflicting": True,
                }

    # === Helper Methods ===

    def _filter_by_regime(self, patterns: List[Dict], regime: str, ema21: float = 0, price: float = 0) -> List[Dict]:
        """Filter patterns by market regime. Returns only patterns appropriate for current regime."""
        if not patterns:
            return []

        filtered = []
        for p in patterns:
            name = p['pattern']

            # Regime-agnostic patterns always pass
            if name in self.REGIME_AGNOSTIC_PATTERNS:
                filtered.append(p)
                continue

            if regime == 'trending':
                if name in self.MEAN_REVERSION_PATTERNS:
                    continue
                if name == 'DIP_BUY':
                    if price <= ema21:
                        continue  # Block dip buying in downtrend
                filtered.append(p)

            elif regime == 'ranging':
                if name in self.TREND_FOLLOWING_PATTERNS:
                    continue
                filtered.append(p)

            elif regime == 'volatile':
                continue  # Block everything except regime-agnostic (handled above)

            else:
                filtered.append(p)

        return filtered

    def _passes_htf_gate(self, action: str, multi_tf_data: Optional[Dict[str, List[list]]] = None) -> Dict[str, Any]:
        """
        Higher-timeframe hard veto.
        Block BUY if BOTH 1h and 4h are bearish (EMA9 < EMA21 AND price < EMA21).
        Block SELL if BOTH 1h and 4h are bullish.
        Single TF opposing: allow with -15% penalty. Both confirming: +10% boost.
        """
        if not multi_tf_data:
            return {'allowed': True, 'confidence_adj': 0, 'reason': 'no HTF data'}

        bullish_count = 0
        bearish_count = 0
        tf_count = 0

        for tf_name in ['1h', '4h']:
            data = multi_tf_data.get(tf_name)
            if not data or len(data) < 21:
                continue
            tf_count += 1
            df = pd.DataFrame(data, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
            ema9 = df['close'].ewm(span=9).mean().iloc[-1]
            ema21 = df['close'].ewm(span=21).mean().iloc[-1]
            price = df['close'].iloc[-1]

            if price > ema21 and ema9 > ema21:
                bullish_count += 1
            elif price < ema21 and ema9 < ema21:
                bearish_count += 1

        if tf_count == 0:
            return {'allowed': True, 'confidence_adj': 0, 'reason': 'no HTF data'}

        if action == 'BUY' and bearish_count == 2:
            return {'allowed': False, 'confidence_adj': 0, 'reason': 'HTF hard veto: 1h+4h bearish'}
        if action == 'SELL' and bullish_count == 2:
            return {'allowed': False, 'confidence_adj': 0, 'reason': 'HTF hard veto: 1h+4h bullish'}
        if action == 'BUY' and bullish_count == 2:
            return {'allowed': True, 'confidence_adj': 0.10, 'reason': 'HTF confirms: 1h+4h bullish'}
        if action == 'SELL' and bearish_count == 2:
            return {'allowed': True, 'confidence_adj': 0.10, 'reason': 'HTF confirms: 1h+4h bearish'}
        if action == 'BUY' and bearish_count >= 1:
            return {'allowed': True, 'confidence_adj': -0.15, 'reason': f'HTF partial conflict: {bearish_count} bearish TF'}
        if action == 'SELL' and bullish_count >= 1:
            return {'allowed': True, 'confidence_adj': -0.15, 'reason': f'HTF partial conflict: {bullish_count} bullish TF'}

        return {'allowed': True, 'confidence_adj': 0, 'reason': 'HTF neutral'}

    def _calculate_htf_indicators(self, multi_tf_data: Optional[Dict[str, List[list]]]) -> Dict[str, Dict]:
        """Calculate indicators on higher timeframes for pattern confirmation."""
        result = {}
        if not multi_tf_data:
            return result

        for tf_name in ['1h', '4h']:
            data = multi_tf_data.get(tf_name)
            if not data or len(data) < 30:
                continue

            df = pd.DataFrame(data, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
            close = df['close']
            volume = df['volume']

            rsi = self._calculate_rsi(close, 14)
            bb_mid, bb_upper, bb_lower, bb_width = self._calculate_bollinger(close, 20, 2)
            macd, macd_signal, macd_hist = self._calculate_macd(close, 12, 26, 9)
            vol_sma = volume.rolling(20).mean()
            ema9 = close.ewm(span=9).mean()
            ema21 = close.ewm(span=21).mean()

            result[tf_name] = {
                'rsi': round(float(rsi.iloc[-1]), 2) if not pd.isna(rsi.iloc[-1]) else 50,
                'macd_hist': round(float(macd_hist.iloc[-1]), 6) if not pd.isna(macd_hist.iloc[-1]) else 0,
                'bb_width_percentile': self._percentile(bb_width, bb_width.iloc[-1]),
                'volume_ratio': round(float(volume.iloc[-1] / vol_sma.iloc[-1]), 2) if vol_sma.iloc[-1] > 0 else 1,
                'ema9': float(ema9.iloc[-1]),
                'ema21': float(ema21.iloc[-1]),
                'price': float(close.iloc[-1]),
            }

        return result

    def _get_higher_tf_trend(self, multi_tf_data: Optional[Dict[str, List[list]]]) -> Optional[Dict]:
        """Determine the higher-timeframe trend bias from 1h and 4h data"""
        if not multi_tf_data:
            return None

        bullish_votes = 0
        bearish_votes = 0
        details = {}

        for tf_name in ['1h', '4h']:
            data = multi_tf_data.get(tf_name)
            if not data or len(data) < 21:
                continue
            df = pd.DataFrame(data, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
            ema9 = df['close'].ewm(span=9).mean().iloc[-1]
            ema21 = df['close'].ewm(span=21).mean().iloc[-1]
            price = df['close'].iloc[-1]

            if price > ema21 and ema9 > ema21:
                bullish_votes += 1
                details[tf_name] = 'bullish'
            elif price < ema21 and ema9 < ema21:
                bearish_votes += 1
                details[tf_name] = 'bearish'
            else:
                details[tf_name] = 'neutral'

        if bullish_votes > bearish_votes:
            bias = 'bullish'
        elif bearish_votes > bullish_votes:
            bias = 'bearish'
        else:
            bias = 'neutral'

        return {'bias': bias, 'details': details}

    def _calculate_adx(self, high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14):
        """Calculate ADX, +DI, -DI for market regime detection"""
        plus_dm = high.diff()
        minus_dm = -low.diff()
        plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0)
        minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0)

        tr = pd.concat([
            high - low,
            (high - close.shift()).abs(),
            (low - close.shift()).abs()
        ], axis=1).max(axis=1)

        atr = tr.rolling(window=period).mean()
        plus_di = 100 * (plus_dm.rolling(window=period).mean() / atr.replace(0, np.nan))
        minus_di = 100 * (minus_dm.rolling(window=period).mean() / atr.replace(0, np.nan))

        dx = (100 * ((plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)))
        adx = dx.rolling(window=period).mean()
        return adx.fillna(0), plus_di.fillna(0), minus_di.fillna(0)

    def _classify_regime(self, adx: float, atr_now: float, atr_series: pd.Series, bb_width_series: pd.Series) -> str:
        """Classify market regime: trending, ranging, or volatile"""
        atr_mean = float(atr_series.rolling(50).mean().iloc[-1]) if len(atr_series) >= 50 else float(atr_series.mean())
        atr_expansion = atr_now / atr_mean if atr_mean > 0 else 1.0

        if atr_expansion > get_toml('regime', 'volatile_atr_expansion', 2.0):
            return "volatile"
        elif adx >= get_toml('indicators', 'adx_trending_threshold', 25):
            return "trending"
        else:
            return "ranging"

    def _calculate_rsi(self, prices: pd.Series, period: int = 14) -> pd.Series:
        """Calculate RSI using Wilder's EMA (handles zero-loss and zero-gain edge cases)"""
        delta = prices.diff()
        gain = (delta.where(delta > 0, 0)).ewm(alpha=1/period, adjust=False).mean()
        loss = (-delta.where(delta < 0, 0)).ewm(alpha=1/period, adjust=False).mean()
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
