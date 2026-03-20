"""
XGBoost direction predictor for ORAKEL forecast engine.

Walk-forward trained binary classifier predicting whether price will
move up or down over the next 4 candles.
"""

import logging
import os
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

logger = logging.getLogger(__name__)


class DirectionPredictor:
    """XGBoost-based binary direction predictor with walk-forward training."""

    MODEL_DIR = "/app/models"

    # Walk-forward parameters (in candles, 1h basis)
    TRAIN_WINDOW = 90 * 24     # 90 days of hourly candles
    TEST_WINDOW = 30 * 24      # 30 days of hourly candles
    PURGE_GAP = 2 * 24         # 2-day gap to prevent leakage
    FORWARD_HORIZON = 4        # predict 4 candles ahead

    XGB_PARAMS = {
        "max_depth": 4,
        "n_estimators": 200,
        "learning_rate": 0.05,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "eval_metric": "logloss",
        "objective": "binary:logistic",
        "random_state": 42,
        "verbosity": 0,
    }

    def __init__(self, symbol: str) -> None:
        self.symbol = symbol
        self._safe_symbol = symbol.replace("/", "_").replace(":", "_")
        self.model: xgb.XGBClassifier | None = None
        self.feature_names: list[str] | None = None

        # Try loading persisted model
        self.load()

    def train(self, features: pd.DataFrame, targets: pd.Series) -> dict:
        """Walk-forward train the XGBoost direction model.

        Args:
            features: Feature DataFrame from FeatureEngine (index-aligned).
            targets: Binary target series (1 = price up after 4 candles, 0 = down).

        Returns:
            Dict with accuracy, sharpe_estimate, and feature_importances.
        """
        if len(features) < self.TRAIN_WINDOW + self.PURGE_GAP + self.TEST_WINDOW:
            raise ValueError(
                f"Insufficient data for walk-forward: {len(features)} rows, "
                f"need at least {self.TRAIN_WINDOW + self.PURGE_GAP + self.TEST_WINDOW}"
            )

        self.feature_names = list(features.columns)
        logger.info(
            "Starting walk-forward training for %s with %d samples",
            self.symbol,
            len(features),
        )

        all_predictions: list[float] = []
        all_actuals: list[int] = []

        # Walk-forward splits
        start = 0
        fold = 0
        while start + self.TRAIN_WINDOW + self.PURGE_GAP + self.TEST_WINDOW <= len(features):
            train_end = start + self.TRAIN_WINDOW
            test_start = train_end + self.PURGE_GAP
            test_end = test_start + self.TEST_WINDOW

            if test_end > len(features):
                break

            x_train = features.iloc[start:train_end]
            y_train = targets.iloc[start:train_end]
            x_test = features.iloc[test_start:test_end]
            y_test = targets.iloc[test_start:test_end]

            # Train with early stopping
            model = xgb.XGBClassifier(
                **self.XGB_PARAMS,
                early_stopping_rounds=20,
            )

            model.fit(
                x_train,
                y_train,
                eval_set=[(x_test, y_test)],
                verbose=False,
            )

            preds = model.predict_proba(x_test)[:, 1]
            all_predictions.extend(preds.tolist())
            all_actuals.extend(y_test.tolist())

            fold += 1
            start += self.TEST_WINDOW  # Roll forward by test window size

        if not all_predictions:
            raise ValueError("No walk-forward folds completed")

        # Final model: train on all data for deployment
        self.model = xgb.XGBClassifier(**self.XGB_PARAMS)
        self.model.fit(features, targets, verbose=False)

        # Compute metrics
        preds_arr = np.array(all_predictions)
        actuals_arr = np.array(all_actuals)
        pred_binary = (preds_arr > 0.5).astype(int)
        accuracy = float(np.mean(pred_binary == actuals_arr))

        # Sharpe estimate from predicted-direction returns
        signed_returns = np.where(preds_arr > 0.5, 1.0, -1.0)
        actual_returns = np.where(actuals_arr == 1, 1.0, -1.0)
        strategy_returns = signed_returns * actual_returns
        sharpe = float(
            np.mean(strategy_returns) / (np.std(strategy_returns) + 1e-8) * np.sqrt(252 * 24)
        )

        # Feature importances from final model
        importances = dict(
            zip(self.feature_names, self.model.feature_importances_.tolist())
        )

        self.save()

        result = {
            "accuracy": accuracy,
            "sharpe_estimate": sharpe,
            "feature_importances": importances,
            "folds": fold,
            "total_oos_samples": len(all_predictions),
        }
        logger.info(
            "Walk-forward complete for %s: accuracy=%.3f, sharpe=%.2f, folds=%d",
            self.symbol,
            accuracy,
            sharpe,
            fold,
        )
        return result

    def predict(self, features: pd.DataFrame) -> tuple[float, float]:
        """Predict direction probability and confidence.

        Args:
            features: Single row (or last row used) feature DataFrame.

        Returns:
            Tuple of (direction_probability, confidence).
            direction_probability: 0.0 = definitely down, 1.0 = definitely up.
            confidence: how certain the model is, 0.0-1.0.
        """
        if self.model is None:
            logger.warning("No trained model for %s, returning neutral", self.symbol)
            return 0.5, 0.0

        try:
            # Use last row if multiple provided
            row = features.iloc[[-1]] if len(features) > 1 else features
            proba = self.model.predict_proba(row)[:, 1]
            direction_prob = float(proba[0])
            confidence = abs(direction_prob - 0.5) * 2.0
            return direction_prob, confidence

        except Exception as e:
            logger.error("Prediction failed for %s: %s", self.symbol, e)
            return 0.5, 0.0

    def save(self) -> None:
        """Save model to disk in XGBoost native JSON format."""
        if self.model is None:
            return

        model_dir = Path(self.MODEL_DIR)
        model_dir.mkdir(parents=True, exist_ok=True)
        path = model_dir / f"{self._safe_symbol}_xgb.json"

        try:
            self.model.save_model(str(path))
            logger.info("Model saved for %s at %s", self.symbol, path)
        except Exception as e:
            logger.error("Failed to save model for %s: %s", self.symbol, e)

    def load(self) -> None:
        """Load model from disk if it exists."""
        path = Path(self.MODEL_DIR) / f"{self._safe_symbol}_xgb.json"

        if not path.exists():
            logger.debug("No saved model found for %s at %s", self.symbol, path)
            return

        try:
            self.model = xgb.XGBClassifier()
            self.model.load_model(str(path))
            logger.info("Model loaded for %s from %s", self.symbol, path)
        except Exception as e:
            logger.warning("Failed to load model for %s: %s", self.symbol, e)
            self.model = None

    @staticmethod
    def make_targets(close: pd.Series, horizon: int = 4) -> pd.Series:
        """Helper to create binary target from close prices.

        Args:
            close: Close price series.
            horizon: Number of candles to look ahead.

        Returns:
            Binary series: 1 if price is higher after `horizon` candles, 0 otherwise.
        """
        future_return = close.shift(-horizon) / close - 1.0
        return (future_return > 0).astype(int)
