"""
MarketScout Tank - Real Market Scanner
Scans markets using CCXT and analyzes with QuantGuild
"""
import json
from typing import Dict, Any
from src.tanks.base import BaseTank, TankState
from src.core.market_data import market_data
from src.core.state_sync import state_manager
from src.guilds.quant import quant
from src.core.config import get_toml


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
        # Monitor 45 liquid USDC pairs across tiers
        super().__init__(
            name="MarketScout",
            symbols=[
                # Tier 1: Core (ultra-liquid, $5 min)
                "BTC/USDC", "ETH/USDC", "SOL/USDC", "BNB/USDC", "XRP/USDC",
                # Tier 2: Major alts ($5 min)
                "AVAX/USDC", "ADA/USDC", "LINK/USDC", "DOT/USDC", "POL/USDC",
                "NEAR/USDC", "ARB/USDC", "OP/USDC", "SUI/USDC", "ATOM/USDC",
                # Tier 3: AI & DeFi ($5 min)
                "FET/USDC", "RENDER/USDC", "INJ/USDC", "TIA/USDC", "SEI/USDC",
                "JUP/USDC", "WLD/USDC", "ICP/USDC", "APT/USDC", "FIL/USDC",
                # Tier 4: Mid-cap movers ($5 min)
                "AAVE/USDC", "UNI/USDC", "LDO/USDC", "TAO/USDC", "CRV/USDC",
                "DYDX/USDC", "STX/USDC", "IMX/USDC", "ALGO/USDC",
                # Tier 5: Meme & micro-cap ($1 min — high volatility, diversification)
                "DOGE/USDC", "SHIB/USDC", "PEPE/USDC", "BONK/USDC", "FLOKI/USDC",
                "WIF/USDC", "1000SATS/USDC", "ANIME/USDC",
                # Tier 6: Emerging narratives
                "AIXBT/USDC", "ARKM/USDC", "PYTH/USDC", "JTO/USDC",
                "STRK/USDC", "MANTA/USDC",
            ]
        )
        self.timeframe = get_toml('engine', 'timeframe', '15m')
        self.candle_limit = get_toml('engine', 'candle_limit', 100)

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

            fmt = f"${current_price:,.8f}" if current_price < 0.01 else f"${current_price:,.4f}" if current_price < 1 else f"${current_price:,.2f}"
            print(f"[{self.name}] {symbol} @ {fmt} ({len(ohlcv)} candles)")

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
            # Always fetch multi-TF data for trend context (1h + 4h)
            multi_tf_data = None
            try:
                multi_tf_data = market_data.fetch_multi_timeframe(symbol)
            except Exception as e:
                print(f"[{self.name}] Multi-TF fetch failed for {symbol}: {e}")

            # Run full technical analysis with multi-TF data
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

            # MOMENTUM_GAINER: inject pattern if symbol is a GainerScanner top mover
            # with RSI + volume confirmation (QuantGuild stays pure, no Redis dependency)
            momentum = await self._detect_momentum_gainer(symbol, indicators)
            if momentum:
                patterns.append(momentum)
                # Re-evaluate signal if QuantGuild said HOLD but momentum says BUY
                if signal['action'] == 'HOLD' and momentum['action'] == 'BUY':
                    signal = {
                        **signal,
                        'action': 'BUY',
                        'confidence': momentum['confidence'],
                        'reason': momentum['reason'],
                        'patterns': [momentum['pattern']],
                        'entry_price': indicators.get('price', 0),
                        'stop_loss': indicators.get('price', 0) * (1 - 2 * indicators.get('atr_percent', 2) / 100),
                        'target_price': indicators.get('price', 0) * (1 + 4 * indicators.get('atr_percent', 2) / 100),
                    }
                elif signal['action'] == 'BUY':
                    # Boost existing BUY signal with momentum confirmation
                    signal['confidence'] = min(0.95, signal['confidence'] + 0.08)
                    if 'MOMENTUM_GAINER' not in signal.get('reason', ''):
                        signal['reason'] += f' + MOMENTUM_GAINER ({momentum["scanner_change"]:+.1f}% 1h)'
                    if 'MOMENTUM_GAINER' not in (signal.get('patterns') or []):
                        signal.setdefault('patterns', []).append('MOMENTUM_GAINER')

            # Log detected patterns
            if patterns:
                pattern_names = [p['pattern'] for p in patterns]
                print(f"[{self.name}] {symbol} patterns: {pattern_names}")

            # Build comprehensive signal with full indicator context
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
                    "rsi": round(indicators['rsi'], 2),
                    "bb_width_pct": indicators['bb_width_percentile'],
                    "bb_upper": round(indicators.get('bb_upper', 0), 6),
                    "bb_lower": round(indicators.get('bb_lower', 0), 6),
                    "bb_mid": round(indicators.get('bb_mid', 0), 6),
                    "volume_ratio": round(indicators['volume_ratio'], 2),
                    "atr": round(indicators.get('atr', 0), 6),
                    "atr_pct": round(indicators['atr_percent'], 2),
                    "macd": round(indicators.get('macd', 0), 6),
                    "macd_signal": round(indicators.get('macd_signal', 0), 6),
                    "macd_hist": round(indicators.get('macd_hist', 0), 6),
                    "ema9": round(indicators.get('ema9', 0), 6),
                    "ema21": round(indicators.get('ema21', 0), 6),
                    "price": round(indicators.get('price', 0), 6),
                    "adx": indicators.get('adx', 0),
                    "plus_di": indicators.get('plus_di', 0),
                    "minus_di": indicators.get('minus_di', 0),
                    "market_regime": indicators.get('market_regime', 'unknown'),
                    "htf_trend": analysis.get('htf_trend', {}).get('bias') if analysis.get('htf_trend') else None,
                    "consensus_score": signal.get('consensus_score', 0),
                    "trend_aligned": bool(signal.get('trend_aligned', False)),
                    "volume_confirmed": bool(signal.get('volume_confirmed', False)),
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

            # Propagate market regime to Redis so capital allocator can read it
            regime = indicators.get('market_regime', 'unknown')
            if regime != 'unknown':
                try:
                    await state_manager.redis.set('market:regime', regime, ex=get_toml('timing', 'regime_ttl_seconds', 3600))
                except Exception:
                    pass

            # In spot-only mode, skip SELL signals early (save compute)
            if signal['action'] == 'SELL':
                print(f"[{self.name}] {symbol} SELL signal skipped (spot-only mode)")
                return {
                    "symbol": symbol,
                    "signal": trading_signal,
                    "indicators": indicators,
                    "status": "skipped_sell"
                }

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

    async def _detect_momentum_gainer(self, symbol: str, indicators: dict) -> dict | None:
        """
        MOMENTUM_GAINER pattern: GainerScanner top mover + RSI/volume confirmation.

        Triggers when:
        1. Symbol appears in scanner:top_movers with change_1h >= 3%
        2. RSI < 45 (not overbought — room to run) OR recovering from oversold
        3. Volume ratio > 1.2 (above-average interest)
        4. ADX > 18 (some directional movement)

        Returns pattern dict or None.
        """
        try:
            raw = await state_manager.redis.get('scanner:top_movers')
            if not raw:
                return None

            scanner = json.loads(raw)
            gainers = scanner.get('gainers', [])

            # Find this symbol in gainers
            match = next((g for g in gainers if g['symbol'] == symbol), None)
            if not match:
                return None

            change_1h = match.get('change_1h', 0)
            if change_1h < get_toml('boosting', 'gainer_min_change_pct', 3.0):
                return None

            # Confirmation checks
            rsi = indicators.get('rsi', 50)
            vol_ratio = indicators.get('volume_ratio', 1.0)
            adx = indicators.get('adx', 0)

            # Don't chase overbought momentum
            if rsi > 72:
                return None
            # Need some volume interest
            if vol_ratio < get_toml('indicators', 'volume_confirmation', 1.2):
                return None
            # Need some directional movement
            if adx < 18:
                return None

            # Calculate confidence
            confidence = 0.72  # Base for momentum signal

            # Stronger momentum = higher confidence
            if change_1h >= 5.0:
                confidence += 0.06
            elif change_1h >= 4.0:
                confidence += 0.03

            # Volume surge bonus
            if vol_ratio >= 2.0:
                confidence += 0.05
            elif vol_ratio >= 1.5:
                confidence += 0.03

            # RSI in sweet spot (oversold = better entry)
            if rsi < 35:
                confidence += 0.05
            elif rsi < 45:
                confidence += 0.02

            # Strong trend bonus
            if adx > 25:
                confidence += 0.03

            confidence = min(0.93, confidence)

            change_24h = match.get('change_24h', 0)
            print(f"[{self.name}] {symbol} MOMENTUM_GAINER detected: "
                  f"{change_1h:+.1f}% 1h, {change_24h:+.1f}% 24h, "
                  f"RSI={rsi:.0f}, vol={vol_ratio:.1f}x, ADX={adx:.0f}, "
                  f"conf={confidence:.0%}")

            return {
                'pattern': 'MOMENTUM_GAINER',
                'action': 'BUY',
                'confidence': confidence,
                'reason': (f'GainerScanner top mover {change_1h:+.1f}% (1h), '
                           f'{change_24h:+.1f}% (24h) with RSI={rsi:.0f} '
                           f'vol={vol_ratio:.1f}x ADX={adx:.0f}'),
                'scanner_change': change_1h,
            }

        except Exception as e:
            # Scanner data unavailable — silently skip
            return None
