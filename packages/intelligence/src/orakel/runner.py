"""
ORAKEL runner — main orchestration loop for the forecast engine.

Runs two cycles:
  - Hourly: XGBoost direction predictions + Kalman signal fusion + funding rates
  - Daily: HMM regime refit + GARCH volatility refit

All results are written to Redis with TTLs so downstream consumers
(auto-trade, dashboard) can read fresh forecasts or detect stale data.
"""

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Optional

import ccxt.async_support as ccxt_async
import numpy as np
import pandas as pd
import redis.asyncio as aioredis

from src.orakel.features import FeatureEngine
from src.orakel.xgboost_model import DirectionPredictor
from src.orakel.regime import RegimeDetector
from src.orakel.volatility import VolatilityForecaster
from src.orakel.kalman_fusion import SignalFusion, SOURCE_RELIABILITY
from src.orakel.funding import FundingCollector

logger = logging.getLogger(__name__)

# Redis TTLs
HOURLY_TTL = 7200   # 2 hours — expires if orakel stops producing
DAILY_TTL = 90000   # 25 hours — regime/vol valid until next daily cycle

# Rate limit pause between CCXT fetches (seconds)
FETCH_DELAY = 0.3

# Retrain interval default (days)
DEFAULT_RETRAIN_INTERVAL_DAYS = 7

# OHLCV fetch limits
HOURLY_CANDLE_LIMIT = 200
DAILY_CANDLE_LIMIT = 365
TRAIN_CANDLE_LIMIT = 120 * 24  # 120 days of 1h candles


class OrakelRunner:
    """Main ORAKEL orchestration loop.

    Coordinates all forecast modules (XGBoost, HMM, GARCH, Kalman, Funding)
    and publishes results to Redis for consumption by the auto-trader.
    """

    def __init__(self, redis_url: str, symbols: list[str]) -> None:
        self.redis_url = redis_url
        self.symbols = symbols

        # Redis connection (created async in _ensure_redis)
        self._redis: Optional[aioredis.Redis] = None

        # CCXT exchanges — public API only, no auth keys needed
        self.exchange = ccxt_async.binance({
            "enableRateLimit": True,
            "options": {"defaultType": "spot"},
        })
        # Separate futures exchange for funding rates
        self.futures_exchange = ccxt_async.binance({
            "enableRateLimit": True,
            "options": {"defaultType": "swap"},
        })

        # Forecast modules
        self.feature_engine = FeatureEngine()
        self.predictors: dict[str, DirectionPredictor] = {
            symbol: DirectionPredictor(symbol) for symbol in symbols
        }
        self.regime_detector = RegimeDetector()
        self.volatility_forecaster = VolatilityForecaster()
        self.signal_fusion = SignalFusion()
        self.funding_collector = FundingCollector(self.futures_exchange)

        # Cached BTC returns for cross-momentum features
        self.btc_returns: Optional[pd.Series] = None

        # Timestamps for cycle control
        self._last_hourly: float = 0
        self._last_daily: float = 0
        self._last_retrain: float = 0

        # Config (can be overridden from cryonix.toml)
        self.hourly_interval = int(os.getenv("ORAKEL_HOURLY_INTERVAL", "3600"))
        self.daily_hour_utc = int(os.getenv("ORAKEL_DAILY_HOUR", "0"))
        self.retrain_interval_days = int(
            os.getenv("ORAKEL_RETRAIN_DAYS", str(DEFAULT_RETRAIN_INTERVAL_DAYS))
        )

        # Status tracking
        self._last_hourly_time: Optional[str] = None
        self._last_daily_time: Optional[str] = None
        self._last_retrain_time: Optional[str] = None
        self._hourly_errors: int = 0
        self._daily_errors: int = 0

    async def _ensure_redis(self) -> aioredis.Redis:
        """Lazily create or return the async Redis connection."""
        if self._redis is None:
            self._redis = aioredis.from_url(
                self.redis_url, decode_responses=True
            )
        return self._redis

    async def run_loop(self) -> None:
        """Main loop with hourly and daily cycles.

        Runs indefinitely. Each cycle is wrapped in try/except so a single
        failure does not kill the loop. Sleeps between iterations to avoid
        busy-waiting.
        """
        logger.info(
            "ORAKEL runner starting: symbols=%s, hourly_interval=%ds, daily_hour=%d UTC",
            self.symbols, self.hourly_interval, self.daily_hour_utc,
        )

        # Load exchange markets once
        try:
            await self.exchange.load_markets()
            logger.info("Spot markets loaded: %d markets", len(self.exchange.markets))
        except Exception as e:
            logger.error("Failed to load spot markets: %s", e)

        try:
            await self.futures_exchange.load_markets()
            logger.info("Futures markets loaded: %d markets", len(self.futures_exchange.markets))
        except Exception as e:
            logger.warning("Failed to load futures markets (funding rates disabled): %s", e)

        while True:
            now = time.time()
            utc_now = datetime.now(timezone.utc)

            # -- Hourly cycle --
            if now - self._last_hourly >= self.hourly_interval:
                try:
                    logger.info("--- ORAKEL hourly cycle start ---")
                    await self._hourly_cycle()
                    self._last_hourly = time.time()
                    self._last_hourly_time = datetime.now(timezone.utc).isoformat()
                    logger.info("--- ORAKEL hourly cycle complete ---")
                except Exception as e:
                    self._hourly_errors += 1
                    logger.error(
                        "Hourly cycle failed (errors=%d): %s",
                        self._hourly_errors, e, exc_info=True,
                    )

            # -- Daily cycle (at configured UTC hour) --
            daily_due = (
                utc_now.hour == self.daily_hour_utc
                and utc_now.minute < 10
                and now - self._last_daily >= 82800  # at least 23h since last run
            )
            if daily_due:
                try:
                    logger.info("--- ORAKEL daily cycle start ---")
                    await self._daily_cycle()
                    self._last_daily = time.time()
                    self._last_daily_time = datetime.now(timezone.utc).isoformat()
                    logger.info("--- ORAKEL daily cycle complete ---")
                except Exception as e:
                    self._daily_errors += 1
                    logger.error(
                        "Daily cycle failed (errors=%d): %s",
                        self._daily_errors, e, exc_info=True,
                    )

            # -- Weekly retrain check --
            retrain_interval_s = self.retrain_interval_days * 86400
            if now - self._last_retrain >= retrain_interval_s:
                try:
                    logger.info("--- ORAKEL retrain cycle start ---")
                    await self._retrain_models()
                    self._last_retrain = time.time()
                    self._last_retrain_time = datetime.now(timezone.utc).isoformat()
                    logger.info("--- ORAKEL retrain cycle complete ---")
                except Exception as e:
                    logger.error("Retrain cycle failed: %s", e, exc_info=True)

            # Sleep 30s between loop iterations
            await asyncio.sleep(30)

    async def _hourly_cycle(self) -> None:
        """Hourly cycle: XGBoost predictions + Kalman fusion + funding rates.

        1. Fetch BTC 1h OHLCV and compute BTC returns for cross-momentum.
        2. For each symbol: build features, predict direction, fuse signals.
        3. Fetch funding rates.
        4. Write all results to Redis.
        """
        r = await self._ensure_redis()

        # Step 1: BTC returns for cross-momentum
        try:
            btc_df = await self._fetch_ohlcv("BTC/USDC", "1h", HOURLY_CANDLE_LIMIT)
            if btc_df is not None and len(btc_df) > 10:
                self.btc_returns = np.log(
                    btc_df["close"] / btc_df["close"].shift(1)
                )
            else:
                logger.warning("BTC OHLCV fetch returned insufficient data")
        except Exception as e:
            logger.warning("Failed to fetch BTC returns: %s", e)

        # Step 2: Per-symbol direction prediction + fusion
        summary = []
        for symbol in self.symbols:
            try:
                result = await self._process_symbol(symbol, r)
                if result:
                    summary.append(result)
            except Exception as e:
                logger.error("Symbol %s failed in hourly cycle: %s", symbol, e)

        # Step 3: Funding rates
        try:
            funding_data = await self.funding_collector.fetch_funding_rates(self.symbols)
            for symbol, data in funding_data.items():
                key = f"orakel:funding:{symbol.replace('/', '_')}"
                payload = {
                    **data,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                await r.set(key, json.dumps(payload), ex=HOURLY_TTL)
        except Exception as e:
            logger.warning("Funding rate fetch failed: %s", e)

        # Log summary
        if summary:
            logger.info(
                "Hourly cycle: processed %d/%d symbols. Highlights: %s",
                len(summary), len(self.symbols),
                "; ".join(
                    f"{s['symbol']}={s['direction']:.2f}({s['confidence']:.2f})"
                    for s in summary[:4]
                ),
            )

    async def _process_symbol(
        self, symbol: str, r: aioredis.Redis
    ) -> Optional[dict[str, Any]]:
        """Process a single symbol: features -> prediction -> fusion -> Redis.

        Returns a summary dict or None on failure.
        """
        safe_symbol = symbol.replace("/", "_")

        # Fetch OHLCV
        df = await self._fetch_ohlcv(symbol, "1h", HOURLY_CANDLE_LIMIT)
        if df is None or len(df) < 30:
            logger.warning("Insufficient OHLCV data for %s, skipping", symbol)
            return None

        # Build features
        features_df = self.feature_engine.build_features(
            df, symbol, btc_returns=self.btc_returns,
        )
        if features_df.empty:
            logger.warning("Feature engineering returned empty for %s", symbol)
            return None

        # XGBoost prediction
        predictor = self.predictors.get(symbol)
        if predictor is None:
            predictor = DirectionPredictor(symbol)
            self.predictors[symbol] = predictor

        direction_prob, xgb_confidence = predictor.predict(features_df)

        # Write direction prediction to Redis
        direction_payload = {
            "probability": round(direction_prob, 4),
            "confidence": round(xgb_confidence, 4),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        await r.set(
            f"orakel:{safe_symbol}:direction",
            json.dumps(direction_payload),
            ex=HOURLY_TTL,
        )

        # Gather existing signals from Redis for fusion
        signals = await self._gather_fusion_signals(symbol, direction_prob, xgb_confidence, r)

        # Kalman fusion
        fused_confidence = self.signal_fusion.fuse_signals(signals)
        sources_used = list(signals.keys())

        fused_payload = {
            "confidence": round(fused_confidence, 4),
            "sources_used": sources_used,
            "source_count": len(sources_used),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        await r.set(
            f"orakel:{safe_symbol}:fused",
            json.dumps(fused_payload),
            ex=HOURLY_TTL,
        )

        return {
            "symbol": symbol,
            "direction": direction_prob,
            "confidence": xgb_confidence,
            "fused": fused_confidence,
            "sources": len(sources_used),
        }

    async def _gather_fusion_signals(
        self,
        symbol: str,
        direction_prob: float,
        xgb_confidence: float,
        r: aioredis.Redis,
    ) -> dict[str, tuple[float, float]]:
        """Read existing signal sources from Redis and package for fusion.

        Returns dict of {source_name: (value, reliability)} suitable for
        SignalFusion.fuse_signals().
        """
        signals: dict[str, tuple[float, float]] = {}

        # XGBoost prediction (always available if model loaded)
        if xgb_confidence > 0:
            signals["xgboost"] = (direction_prob, SOURCE_RELIABILITY.get("xgboost", 0.75))

        # QuantGuild confidence from engine
        qg_val = await self._read_redis_signal(r, f"quantguild:{symbol.replace('/', '_')}:confidence")
        if qg_val is not None:
            # QuantGuild confidence is 0-100, normalize to 0-1
            signals["quantguild"] = (qg_val / 100.0, SOURCE_RELIABILITY.get("quantguild", 0.7))

        # Grok AI score
        grok_val = await self._read_redis_signal(r, f"grok:validation:{symbol.replace('/', '_')}")
        if grok_val is not None:
            signals["grok_ai"] = (grok_val / 100.0, SOURCE_RELIABILITY.get("grok_ai", 0.8))

        # Fear & Greed index (global, not per-symbol)
        fg_raw = await self._read_redis_signal(r, "cmc:fear_greed")
        if fg_raw is not None:
            # F&G is 0-100. Contrarian: extreme fear is somewhat bullish.
            fg_normalized = 0.2 + 0.6 * (fg_raw / 100.0)
            signals["fear_greed"] = (fg_normalized, SOURCE_RELIABILITY.get("fear_greed", 0.4))

        # Polymarket crypto sentiment
        poly_val = await self._read_redis_signal(r, "polymarket:crypto")
        if poly_val is not None:
            signals["polymarket"] = (poly_val / 100.0, SOURCE_RELIABILITY.get("polymarket", 0.5))

        # Funding rate (per-symbol)
        safe_sym = symbol.replace("/", "_")
        funding_raw = await self._read_redis_json(r, f"orakel:funding:{safe_sym}")
        if funding_raw and "rate" in funding_raw:
            # Negative funding = bullish (shorts paying), positive = bearish
            rate_pct = funding_raw["rate"]  # already in percentage form
            # Map: -0.1% -> 0.7, 0 -> 0.5, +0.1% -> 0.3
            funding_signal = max(0.1, min(0.9, 0.5 - rate_pct * 5.0))
            signals["funding"] = (funding_signal, SOURCE_RELIABILITY.get("funding", 0.6))

        return signals

    async def _daily_cycle(self) -> None:
        """Daily cycle: HMM regime refit + GARCH volatility refit.

        Uses BTC/USDC daily candles as the reference asset for both
        regime and volatility estimation.
        """
        r = await self._ensure_redis()

        # Fetch BTC daily OHLCV
        btc_daily = await self._fetch_ohlcv("BTC/USDC", "1d", DAILY_CANDLE_LIMIT)
        if btc_daily is None or len(btc_daily) < 100:
            logger.error(
                "Insufficient BTC daily data for daily cycle: %d rows",
                0 if btc_daily is None else len(btc_daily),
            )
            return

        close = btc_daily["close"].astype(float)
        daily_returns = np.log(close / close.shift(1)).dropna()
        realized_vol_20d = daily_returns.rolling(20).std()

        # -- HMM Regime Detection --
        try:
            self.regime_detector.fit(daily_returns, realized_vol_20d.dropna())
            regime_result = self.regime_detector.detect_and_update(
                daily_returns, realized_vol_20d.dropna(),
            )

            # Add position multiplier
            multiplier = self.regime_detector.get_position_multiplier()
            regime_payload = {
                **regime_result,
                "position_multiplier": multiplier,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            await r.set("orakel:regime", json.dumps(regime_payload), ex=DAILY_TTL)
            logger.info("Regime written to Redis: %s", regime_result.get("regime"))
        except Exception as e:
            logger.error("HMM regime detection failed: %s", e, exc_info=True)

        # -- GARCH Volatility Forecast --
        try:
            vol_result = self.volatility_forecaster.fit_and_forecast(
                daily_returns, horizon=5,
            )

            position_scale = VolatilityForecaster.get_position_scale(
                vol_result.get("vol_ratio", 1.0)
            )

            vol_payload = {
                "forecast_5d": vol_result.get("predicted_vol", []),
                "vol_ratio": vol_result.get("vol_ratio", 1.0),
                "spike_warning": vol_result.get("spike_warning", False),
                "position_scale": position_scale,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            await r.set("orakel:volatility", json.dumps(vol_payload), ex=DAILY_TTL)
            logger.info(
                "Volatility written to Redis: ratio=%.2f, spike=%s",
                vol_result.get("vol_ratio", 1.0),
                vol_result.get("spike_warning", False),
            )
        except Exception as e:
            logger.error("GARCH volatility forecast failed: %s", e, exc_info=True)

    async def _retrain_models(self) -> None:
        """Retrain XGBoost models for all symbols.

        Fetches 120 days of 1h OHLCV, builds features, computes targets
        (4h forward return > 0), and runs walk-forward training.
        """
        logger.info("Starting model retrain for %d symbols", len(self.symbols))

        # Fetch BTC returns for cross-momentum during training
        try:
            btc_train_df = await self._fetch_ohlcv("BTC/USDC", "1h", TRAIN_CANDLE_LIMIT)
            if btc_train_df is not None and len(btc_train_df) > 50:
                btc_train_returns = np.log(
                    btc_train_df["close"] / btc_train_df["close"].shift(1)
                )
            else:
                btc_train_returns = None
        except Exception:
            btc_train_returns = None

        results = {}
        for symbol in self.symbols:
            try:
                result = await self._retrain_symbol(symbol, btc_train_returns)
                results[symbol] = result
            except Exception as e:
                logger.error("Retrain failed for %s: %s", symbol, e)
                results[symbol] = {"error": str(e)}

            # Rate limit between symbols
            await asyncio.sleep(FETCH_DELAY * 3)

        # Log summary
        successes = sum(1 for r in results.values() if "accuracy" in r)
        logger.info(
            "Retrain complete: %d/%d symbols succeeded. Results: %s",
            successes, len(self.symbols),
            {s: f"acc={r.get('accuracy', 'N/A')}" for s, r in results.items()},
        )

    async def _retrain_symbol(
        self, symbol: str, btc_returns: Optional[pd.Series]
    ) -> dict:
        """Retrain a single symbol's XGBoost model."""
        df = await self._fetch_ohlcv(symbol, "1h", TRAIN_CANDLE_LIMIT)
        if df is None or len(df) < 500:
            return {"error": f"insufficient_data ({0 if df is None else len(df)} candles)"}

        # Build features
        features_df = self.feature_engine.build_features(
            df, symbol, btc_returns=btc_returns
        )
        if features_df.empty or len(features_df) < 500:
            return {"error": f"insufficient_features ({len(features_df)} rows)"}

        # Build targets: 1 if close is higher 4 candles later
        targets = DirectionPredictor.make_targets(
            df["close"].loc[features_df.index],
            horizon=DirectionPredictor.FORWARD_HORIZON,
        )

        # Align features and targets, drop NaN targets
        aligned = features_df.loc[targets.dropna().index]
        aligned_targets = targets.loc[aligned.index]

        if len(aligned) < 500:
            return {"error": f"insufficient_aligned_data ({len(aligned)} rows)"}

        predictor = self.predictors.get(symbol)
        if predictor is None:
            predictor = DirectionPredictor(symbol)
            self.predictors[symbol] = predictor

        metrics = predictor.train(aligned, aligned_targets)
        return metrics

    async def _read_redis_signal(self, r: aioredis.Redis, key: str) -> Optional[float]:
        """Read a numeric signal value from Redis.

        Handles both plain numeric strings and JSON objects with a 'value'
        or 'score' field.
        """
        try:
            raw = await r.get(key)
            if raw is None:
                return None

            # Try plain float first
            try:
                return float(raw)
            except (ValueError, TypeError):
                pass

            # Try JSON with common field names
            try:
                data = json.loads(raw)
                for field in ("value", "score", "confidence", "index"):
                    if field in data:
                        return float(data[field])
            except (json.JSONDecodeError, TypeError, KeyError):
                pass

            return None

        except Exception as e:
            logger.debug("Failed to read Redis key %s: %s", key, e)
            return None

    async def _read_redis_json(self, r: aioredis.Redis, key: str) -> Optional[dict]:
        """Read a JSON object from Redis."""
        try:
            raw = await r.get(key)
            if raw is None:
                return None
            return json.loads(raw)
        except Exception as e:
            logger.debug("Failed to read Redis JSON key %s: %s", key, e)
            return None

    async def _fetch_ohlcv(
        self, symbol: str, timeframe: str, limit: int
    ) -> Optional[pd.DataFrame]:
        """Fetch OHLCV candles from Binance via CCXT with pagination.

        CCXT Binance returns max 1000 candles per request. For larger
        requests, this method paginates automatically using the `since`
        parameter.

        Args:
            symbol: Trading pair (e.g. "BTC/USDC").
            timeframe: Candle interval (e.g. "1h", "1d").
            limit: Maximum number of candles to fetch.

        Returns:
            DataFrame with columns [timestamp, open, high, low, close, volume]
            or None on failure.
        """
        MAX_PER_REQUEST = 1000

        try:
            all_candles: list = []

            if limit <= MAX_PER_REQUEST:
                # Single request
                all_candles = await self.exchange.fetch_ohlcv(
                    symbol, timeframe=timeframe, limit=limit
                )
                await asyncio.sleep(FETCH_DELAY)
            else:
                # Paginated: compute start timestamp and fetch in chunks
                tf_ms = self._timeframe_to_ms(timeframe)
                now_ms = int(time.time() * 1000)
                since = now_ms - (limit * tf_ms)

                remaining = limit
                while remaining > 0:
                    batch_size = min(remaining, MAX_PER_REQUEST)
                    batch = await self.exchange.fetch_ohlcv(
                        symbol, timeframe=timeframe, since=since, limit=batch_size
                    )
                    if not batch:
                        break

                    all_candles.extend(batch)
                    since = batch[-1][0] + tf_ms  # Next candle after last
                    remaining -= len(batch)
                    await asyncio.sleep(FETCH_DELAY)

                    if len(batch) < batch_size:
                        break  # No more data available

            if not all_candles:
                logger.warning("Empty OHLCV response for %s %s", symbol, timeframe)
                return None

            df = pd.DataFrame(
                all_candles,
                columns=["timestamp", "open", "high", "low", "close", "volume"],
            )

            # Remove duplicates (pagination overlap)
            df = df.drop_duplicates(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)

            # Ensure numeric types
            for col in ["open", "high", "low", "close", "volume"]:
                df[col] = pd.to_numeric(df[col], errors="coerce")

            return df

        except Exception as e:
            logger.error("OHLCV fetch failed for %s %s: %s", symbol, timeframe, e)
            return None

    @staticmethod
    def _timeframe_to_ms(timeframe: str) -> int:
        """Convert CCXT timeframe string to milliseconds."""
        multipliers = {
            "1m": 60_000, "5m": 300_000, "15m": 900_000,
            "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
        }
        return multipliers.get(timeframe, 3_600_000)

    def get_status(self) -> dict:
        """Return runner status for the /status endpoint."""
        models_loaded = {
            symbol: predictor.model is not None
            for symbol, predictor in self.predictors.items()
        }
        return {
            "symbols": self.symbols,
            "models_loaded": models_loaded,
            "regime_fitted": self.regime_detector._is_fitted,
            "last_hourly": self._last_hourly_time,
            "last_daily": self._last_daily_time,
            "last_retrain": self._last_retrain_time,
            "hourly_errors": self._hourly_errors,
            "daily_errors": self._daily_errors,
            "hourly_interval_s": self.hourly_interval,
        }

    async def shutdown(self) -> None:
        """Clean up resources."""
        try:
            await self.exchange.close()
        except Exception:
            pass
        try:
            await self.futures_exchange.close()
        except Exception:
            pass
        if self._redis:
            try:
                await self._redis.close()
            except Exception:
                pass
        logger.info("ORAKEL runner shut down")
