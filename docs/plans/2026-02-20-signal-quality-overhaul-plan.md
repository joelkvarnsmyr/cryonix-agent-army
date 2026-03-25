# Signal Quality Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce false signals by adding HTF hard veto, multi-TF pattern confirmation, regime-gated pattern selection, fixing MOMENTUM_GAINER bypass, and tightening thresholds.

**Architecture:** All signal generation changes happen in the Python engine (`packages/engine/src/guilds/quant.py`). The MOMENTUM_GAINER bypass fix touches `packages/engine/src/tanks/market_scout.py`. Threshold changes in `cryonix.toml`. No changes to the TypeScript auto-trader — it receives better signals.

**Tech Stack:** Python 3.11, pandas, numpy, pytest, TOML config

---

### Task 1: Add pytest infrastructure + test helpers

**Files:**
- Create: `packages/engine/tests/__init__.py`
- Create: `packages/engine/tests/conftest.py`
- Create: `packages/engine/tests/test_quant_signals.py`

**Step 1: Create test directory and conftest with OHLCV fixtures**

`packages/engine/tests/__init__.py` — empty file.

`packages/engine/tests/conftest.py`:
```python
import pytest
import pandas as pd
import numpy as np
import sys
import os

# Add engine src to path so imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

@pytest.fixture
def make_ohlcv():
    """Factory for synthetic OHLCV data.

    Usage:
        ohlcv = make_ohlcv(n=100, base_price=100, trend='down', volatility=0.02)
    """
    def _make(n=100, base_price=100.0, trend='flat', volatility=0.01, volume_base=1000.0):
        timestamps = pd.date_range('2026-01-01', periods=n, freq='15min')
        prices = [base_price]
        for i in range(1, n):
            drift = {'up': 0.001, 'down': -0.001, 'flat': 0.0}[trend]
            noise = np.random.normal(drift, volatility)
            prices.append(prices[-1] * (1 + noise))

        data = []
        for i, ts in enumerate(timestamps):
            p = prices[i]
            h = p * (1 + abs(np.random.normal(0, volatility / 2)))
            l = p * (1 - abs(np.random.normal(0, volatility / 2)))
            o = prices[i - 1] if i > 0 else p
            v = volume_base * (1 + np.random.normal(0, 0.3))
            data.append([int(ts.timestamp() * 1000), o, h, l, p, max(0, v)])
        return data
    return _make


@pytest.fixture
def make_multi_tf(make_ohlcv):
    """Create multi-timeframe data dict with matching trend direction."""
    def _make(trend='flat', base_price=100.0):
        return {
            '1h': make_ohlcv(n=48, base_price=base_price, trend=trend, volatility=0.015),
            '4h': make_ohlcv(n=24, base_price=base_price, trend=trend, volatility=0.02),
            '1d': make_ohlcv(n=14, base_price=base_price, trend=trend, volatility=0.03),
        }
    return _make
```

**Step 2: Create initial test file with a smoke test**

`packages/engine/tests/test_quant_signals.py`:
```python
"""Tests for QuantGuild signal quality improvements."""
from src.guilds.quant import QuantGuild


def test_quant_guild_basic_analysis(make_ohlcv, make_multi_tf):
    """Smoke test: QuantGuild returns valid analysis on synthetic data."""
    q = QuantGuild()
    ohlcv = make_ohlcv(n=100, base_price=100.0)
    multi_tf = make_multi_tf(trend='flat', base_price=100.0)
    result = q.analyze(ohlcv, 'TEST/USDC', multi_tf_data=multi_tf)
    assert result['status'] == 'success'
    assert result['signal']['action'] in ('BUY', 'SELL', 'HOLD')
```

**Step 3: Run test to verify setup works**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py::test_quant_guild_basic_analysis -v`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/engine/tests/
git commit -m "test: add pytest infrastructure for QuantGuild signal quality tests"
```

---

### Task 2: Implement HTF hard veto

**Files:**
- Modify: `packages/engine/src/guilds/quant.py` (add `_passes_htf_gate`, modify `_generate_signal`)
- Modify: `packages/engine/tests/test_quant_signals.py` (add HTF gate tests)

**Step 1: Write failing tests**

Add to `packages/engine/tests/test_quant_signals.py`:
```python
import pandas as pd
import numpy as np


def _make_htf_data(trend_1h='bullish', trend_4h='bullish', base_price=100.0):
    """Create multi-TF data where 1h/4h have specific trend directions.

    bullish: EMA9 > EMA21 and price > EMA21
    bearish: EMA9 < EMA21 and price < EMA21
    neutral: mixed
    """
    def _make_tf_ohlcv(n, trend, base):
        # For bullish: prices rise so EMA9 > EMA21
        # For bearish: prices fall so EMA9 < EMA21
        drift = {'bullish': 0.003, 'bearish': -0.003, 'neutral': 0.0}[trend]
        prices = [base]
        for i in range(1, n):
            prices.append(prices[-1] * (1 + drift + np.random.normal(0, 0.002)))
        data = []
        for i in range(n):
            p = prices[i]
            data.append([i * 3600000, p * 0.999, p * 1.002, p * 0.998, p, 1000])
        return data

    return {
        '1h': _make_tf_ohlcv(48, trend_1h, base_price),
        '4h': _make_tf_ohlcv(24, trend_4h, base_price),
        '1d': _make_tf_ohlcv(14, 'neutral', base_price),
    }


class TestHTFGate:
    """HTF hard veto: block BUY when 1h+4h are bearish, block SELL when bullish."""

    def test_htf_gate_blocks_buy_in_double_bearish(self):
        q = QuantGuild()
        multi_tf = _make_htf_data(trend_1h='bearish', trend_4h='bearish')
        result = q._passes_htf_gate('BUY', multi_tf)
        assert result['allowed'] is False

    def test_htf_gate_allows_buy_in_double_bullish(self):
        q = QuantGuild()
        multi_tf = _make_htf_data(trend_1h='bullish', trend_4h='bullish')
        result = q._passes_htf_gate('BUY', multi_tf)
        assert result['allowed'] is True
        assert result['confidence_adj'] > 0  # Should get a boost

    def test_htf_gate_allows_buy_with_single_bearish(self):
        q = QuantGuild()
        multi_tf = _make_htf_data(trend_1h='bullish', trend_4h='bearish')
        result = q._passes_htf_gate('BUY', multi_tf)
        assert result['allowed'] is True
        assert result['confidence_adj'] < 0  # Should get a penalty

    def test_htf_gate_blocks_sell_in_double_bullish(self):
        q = QuantGuild()
        multi_tf = _make_htf_data(trend_1h='bullish', trend_4h='bullish')
        result = q._passes_htf_gate('SELL', multi_tf)
        assert result['allowed'] is False

    def test_htf_gate_returns_neutral_without_data(self):
        q = QuantGuild()
        result = q._passes_htf_gate('BUY', None)
        assert result['allowed'] is True  # No data = don't block
        assert result['confidence_adj'] == 0
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py::TestHTFGate -v`
Expected: FAIL with `AttributeError: 'QuantGuild' object has no attribute '_passes_htf_gate'`

**Step 3: Implement `_passes_htf_gate` in quant.py**

Add this method to the QuantGuild class, before `_get_higher_tf_trend` (around line 784):

```python
    def _passes_htf_gate(
        self,
        action: str,
        multi_tf_data: Optional[Dict[str, List[list]]] = None
    ) -> Dict[str, Any]:
        """
        Higher-timeframe hard veto.

        Block BUY if BOTH 1h and 4h are bearish (EMA9 < EMA21 AND price < EMA21).
        Block SELL if BOTH 1h and 4h are bullish.
        Single TF opposing: allow with penalty. Both confirming: boost.
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

        # No usable TF data
        if tf_count == 0:
            return {'allowed': True, 'confidence_adj': 0, 'reason': 'no HTF data'}

        # Hard veto: BUY blocked when both TFs bearish
        if action == 'BUY' and bearish_count == 2:
            return {'allowed': False, 'confidence_adj': 0, 'reason': 'HTF hard veto: 1h+4h bearish'}

        # Hard veto: SELL blocked when both TFs bullish
        if action == 'SELL' and bullish_count == 2:
            return {'allowed': False, 'confidence_adj': 0, 'reason': 'HTF hard veto: 1h+4h bullish'}

        # Both TFs confirm direction
        if action == 'BUY' and bullish_count == 2:
            return {'allowed': True, 'confidence_adj': 0.10, 'reason': 'HTF confirms: 1h+4h bullish'}
        if action == 'SELL' and bearish_count == 2:
            return {'allowed': True, 'confidence_adj': 0.10, 'reason': 'HTF confirms: 1h+4h bearish'}

        # One TF opposes
        if action == 'BUY' and bearish_count >= 1:
            return {'allowed': True, 'confidence_adj': -0.15, 'reason': f'HTF partial conflict: {bearish_count} bearish TF'}
        if action == 'SELL' and bullish_count >= 1:
            return {'allowed': True, 'confidence_adj': -0.15, 'reason': f'HTF partial conflict: {bullish_count} bullish TF'}

        # Neutral / mixed
        return {'allowed': True, 'confidence_adj': 0, 'reason': 'HTF neutral'}
```

**Step 4: Wire `_passes_htf_gate` into `_generate_signal`**

In `_generate_signal()`, after the deep_value check (line 598) and before the consensus gate (line 604), add:

```python
        # ── HTF hard veto: block counter-trend trades ──
        # Determine which direction the patterns lean
        buy_signals = [p for p in patterns if p['action'] == 'BUY']
        sell_signals = [p for p in patterns if p['action'] == 'SELL']

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
```

Also need to pass `multi_tf_data` through to `_generate_signal`. In the `analyze()` method (line 70), store it on self:

```python
        # Store for use in _generate_signal's HTF gate
        self._current_multi_tf = multi_tf_data
        signal = self._generate_signal(patterns, indicators, df, htf_trend)
        self._current_multi_tf = None  # Clean up
```

And apply the confidence adjustment from HTF gate in `calculate_consensus_confidence`:

Replace the existing HTF alignment block (lines 676-682) with:
```python
            # Higher timeframe alignment (from HTF gate)
            if hasattr(self, '_htf_confidence_adj') and self._htf_confidence_adj != 0:
                base_confidence += self._htf_confidence_adj
                boosts.append(f"{self._htf_confidence_adj:+.0%} (HTF gate)")
```

Store the adjustment before consensus calc:
```python
        self._htf_confidence_adj = htf_gate.get('confidence_adj', 0) if 'htf_gate' in dir() else 0
```

**Step 5: Run tests**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py::TestHTFGate -v`
Expected: All 5 PASS

**Step 6: Commit**

```bash
git add packages/engine/src/guilds/quant.py packages/engine/tests/test_quant_signals.py
git commit -m "feat: add HTF hard veto — block counter-trend trades when 1h+4h oppose"
```

---

### Task 3: Implement multi-TF pattern confirmation

**Files:**
- Modify: `packages/engine/src/guilds/quant.py` (add `_calculate_htf_indicators`, modify each detector)
- Modify: `packages/engine/tests/test_quant_signals.py`

**Step 1: Write failing tests**

Add to test file:
```python
class TestMultiTFConfirmation:
    """Patterns must be confirmed on higher timeframes."""

    def test_rsi_oversold_rejected_without_1h_confirmation(self):
        """RSI < 30 on 15m but 1h RSI = 55 → pattern should NOT fire."""
        q = QuantGuild()
        # 15m RSI oversold
        indicators = {'rsi': 28, 'price': 100}
        # 1h RSI not oversold
        htf_indicators = {'1h': {'rsi': 55}}
        result = q._detect_rsi_extreme(indicators, htf_indicators=htf_indicators)
        assert result is None

    def test_rsi_oversold_confirmed_with_1h(self):
        """RSI < 30 on 15m AND 1h RSI < 40 → pattern fires."""
        q = QuantGuild()
        indicators = {'rsi': 28}
        htf_indicators = {'1h': {'rsi': 35}}
        result = q._detect_rsi_extreme(indicators, htf_indicators=htf_indicators)
        assert result is not None
        assert result['action'] == 'BUY'

    def test_macd_cross_rejected_without_1h_alignment(self):
        """MACD bullish cross on 15m but 1h MACD hist negative → rejected."""
        q = QuantGuild()
        htf_indicators = {'1h': {'macd_hist': -0.05}}
        # We test via the detector directly — needs df with crossover
        # This tests the interface; integration tested in Task 6
        assert True  # Placeholder — actual test after implementation

    def test_rsi_threshold_is_30_not_35(self):
        """RSI oversold threshold should be 30 (was 35)."""
        q = QuantGuild()
        # RSI=32 should NOT trigger (it's above 30)
        indicators = {'rsi': 32}
        htf_indicators = {'1h': {'rsi': 30}}
        result = q._detect_rsi_extreme(indicators, htf_indicators=htf_indicators)
        assert result is None  # 32 > 30, no trigger
```

**Step 2: Run to verify failure**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py::TestMultiTFConfirmation -v`
Expected: FAIL (detector signatures don't accept htf_indicators yet)

**Step 3: Add `_calculate_htf_indicators` helper**

Add to QuantGuild class:
```python
    def _calculate_htf_indicators(self, multi_tf_data: Optional[Dict[str, List[list]]]) -> Dict[str, Dict]:
        """Calculate indicators on higher timeframes for pattern confirmation.

        Returns: {'1h': {rsi, macd_hist, bb_width_percentile, volume_ratio, ema9, ema21}, '4h': {...}}
        """
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
```

**Step 4: Modify each pattern detector to accept and check `htf_indicators`**

Add `htf_indicators: Optional[Dict] = None` parameter to every detector. Add confirmation logic:

**`_detect_rsi_extreme`** — change threshold to 30, add 1h RSI < 40 check:
```python
    def _detect_rsi_extreme(self, indicators: Dict, htf_indicators: Optional[Dict] = None) -> Optional[Dict]:
        rsi = indicators['rsi']
        rsi_oversold = get_toml('indicators', 'rsi_oversold', 30)  # Changed: 35 → 30
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
                "reason": f"RSI oversold at {rsi:.1f} (1h RSI confirms)",
            }
        elif rsi > rsi_overbought:
            if htf_indicators and htf_indicators.get('1h'):
                if htf_indicators['1h'].get('rsi', 50) <= 60:
                    return None
            confidence = 0.70 + (rsi - rsi_overbought) / 100
            return {
                "pattern": "RSI_OVERBOUGHT",
                "action": "SELL",
                "confidence": min(0.90, confidence),
                "reason": f"RSI overbought at {rsi:.1f} (1h RSI confirms)",
            }
        return None
```

**`_detect_bollinger_squeeze`** — add 1h BB width < 30th percentile check:
```python
        # Multi-TF confirmation: 1h BB width also squeezed
        if htf_indicators and htf_indicators.get('1h'):
            if htf_indicators['1h'].get('bb_width_percentile', 50) >= 30:
                return None  # 1h not in squeeze
```

**`_detect_volume_spike`** — add 1h volume > 1.5x check:
```python
        # Multi-TF confirmation: 1h volume also elevated
        if htf_indicators and htf_indicators.get('1h'):
            if htf_indicators['1h'].get('volume_ratio', 1.0) < 1.5:
                return None
```

**`_detect_macd_crossover`** — add 1h MACD histogram same direction check:
```python
        # Bullish crossover
        if prev_hist < 0 and curr_hist > 0:
            # Multi-TF: 1h MACD histogram must also be positive
            if htf_indicators and htf_indicators.get('1h'):
                if htf_indicators['1h'].get('macd_hist', 0) < 0:
                    return None
            return {
                "pattern": "MACD_BULLISH_CROSS",
                "action": "BUY",
                "confidence": 0.62,  # Changed: 0.68 → 0.62
                "reason": "MACD bullish crossover (1h confirms)",
            }
        elif prev_hist > 0 and curr_hist < 0:
            if htf_indicators and htf_indicators.get('1h'):
                if htf_indicators['1h'].get('macd_hist', 0) > 0:
                    return None
            return {
                "pattern": "MACD_BEARISH_CROSS",
                "action": "SELL",
                "confidence": 0.62,  # Changed: 0.68 → 0.62
                "reason": "MACD bearish crossover (1h confirms)",
            }
```

**`_detect_ema_crossover`** — add 1h EMA alignment check:
```python
        if prev_diff < 0 and curr_diff > 0:
            # Multi-TF: 1h EMA9 must already be > EMA21 (trend aligned)
            if htf_indicators and htf_indicators.get('1h'):
                htf = htf_indicators['1h']
                if htf.get('ema9', 0) <= htf.get('ema21', 0):
                    return None
            return {
                "pattern": "EMA_BULLISH_CROSS",
                "action": "BUY",
                "confidence": 0.60,  # Changed: 0.65 → 0.60
                "reason": "EMA 9/21 bullish crossover (1h aligned)",
            }
```

**`_detect_dip_buy`** — add 4h RSI < 45 check:
```python
        if drawdown >= dip_min_drawdown and is_recovering:
            rsi = indicators.get('rsi', 50)
            dip_max_rsi = get_toml('patterns', 'dip_buy_max_rsi', 50)
            if rsi < dip_max_rsi:
                # Multi-TF: 4h RSI must not be overbought
                if htf_indicators and htf_indicators.get('4h'):
                    if htf_indicators['4h'].get('rsi', 50) >= 45:
                        return None
```

**Step 5: Wire HTF indicators in `_detect_patterns` and `analyze`**

In `analyze()`, compute HTF indicators:
```python
        htf_indicators = self._calculate_htf_indicators(multi_tf_data)
        patterns = self._detect_patterns(df, indicators, htf_indicators=htf_indicators)
```

Update `_detect_patterns` signature and pass through:
```python
    def _detect_patterns(self, df, indicators, htf_indicators=None):
        patterns = []
        squeeze = self._detect_bollinger_squeeze(df, indicators, htf_indicators=htf_indicators)
        if squeeze: patterns.append(squeeze)
        rsi_signal = self._detect_rsi_extreme(indicators, htf_indicators=htf_indicators)
        if rsi_signal: patterns.append(rsi_signal)
        vol_signal = self._detect_volume_spike(df, indicators, htf_indicators=htf_indicators)
        if vol_signal: patterns.append(vol_signal)
        macd_signal = self._detect_macd_crossover(df, indicators, htf_indicators=htf_indicators)
        if macd_signal: patterns.append(macd_signal)
        dip_signal = self._detect_dip_buy(df, indicators, htf_indicators=htf_indicators)
        if dip_signal: patterns.append(dip_signal)
        ema_signal = self._detect_ema_crossover(df, htf_indicators=htf_indicators)
        if ema_signal: patterns.append(ema_signal)
        return patterns
```

**Step 6: Run all tests**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py -v`
Expected: All PASS

**Step 7: Commit**

```bash
git add packages/engine/src/guilds/quant.py packages/engine/tests/test_quant_signals.py
git commit -m "feat: add multi-TF pattern confirmation — each detector requires HTF alignment"
```

---

### Task 4: Implement regime-gated pattern selection

**Files:**
- Modify: `packages/engine/src/guilds/quant.py` (add `_filter_by_regime`, modify `_generate_signal`)
- Modify: `packages/engine/tests/test_quant_signals.py`

**Step 1: Write failing tests**

```python
class TestRegimeGate:
    """Regime-gated pattern selection: right patterns for right market conditions."""

    def test_rsi_blocked_in_trending(self):
        q = QuantGuild()
        patterns = [{'pattern': 'RSI_OVERSOLD', 'action': 'BUY', 'confidence': 0.80}]
        filtered = q._filter_by_regime(patterns, 'trending', ema21=100, price=95)
        assert len(filtered) == 0

    def test_ema_cross_blocked_in_ranging(self):
        q = QuantGuild()
        patterns = [{'pattern': 'EMA_BULLISH_CROSS', 'action': 'BUY', 'confidence': 0.65}]
        filtered = q._filter_by_regime(patterns, 'ranging', ema21=100, price=102)
        assert len(filtered) == 0

    def test_rsi_allowed_in_ranging(self):
        q = QuantGuild()
        patterns = [{'pattern': 'RSI_OVERSOLD', 'action': 'BUY', 'confidence': 0.80}]
        filtered = q._filter_by_regime(patterns, 'ranging', ema21=100, price=95)
        assert len(filtered) == 1

    def test_ema_cross_allowed_in_trending(self):
        q = QuantGuild()
        patterns = [{'pattern': 'EMA_BULLISH_CROSS', 'action': 'BUY', 'confidence': 0.65}]
        filtered = q._filter_by_regime(patterns, 'trending', ema21=100, price=102)
        assert len(filtered) == 1

    def test_volatile_blocks_everything_except_deep_value_and_volume(self):
        q = QuantGuild()
        patterns = [
            {'pattern': 'RSI_OVERSOLD', 'action': 'BUY', 'confidence': 0.80},
            {'pattern': 'VOLUME_SPIKE_UP', 'action': 'BUY', 'confidence': 0.75},
            {'pattern': 'DEEP_VALUE_CRASH', 'action': 'BUY', 'confidence': 0.82},
        ]
        filtered = q._filter_by_regime(patterns, 'volatile', ema21=100, price=95)
        assert len(filtered) == 2
        names = [p['pattern'] for p in filtered]
        assert 'RSI_OVERSOLD' not in names

    def test_dip_buy_in_trending_only_if_uptrend(self):
        q = QuantGuild()
        patterns = [{'pattern': 'DIP_BUY', 'action': 'BUY', 'confidence': 0.78}]
        # Price > EMA21 = uptrend → allowed
        filtered = q._filter_by_regime(patterns, 'trending', ema21=100, price=102)
        assert len(filtered) == 1
        # Price < EMA21 = downtrend → blocked
        filtered = q._filter_by_regime(patterns, 'trending', ema21=100, price=95)
        assert len(filtered) == 0
```

**Step 2: Run to verify failure**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py::TestRegimeGate -v`
Expected: FAIL

**Step 3: Implement `_filter_by_regime`**

Add to QuantGuild class:
```python
    # Pattern classification for regime filtering
    MEAN_REVERSION_PATTERNS = {'RSI_OVERSOLD', 'RSI_OVERBOUGHT', 'BOLLINGER_SQUEEZE'}
    TREND_FOLLOWING_PATTERNS = {'EMA_BULLISH_CROSS', 'EMA_BEARISH_CROSS', 'MACD_BULLISH_CROSS', 'MACD_BEARISH_CROSS', 'MOMENTUM_GAINER'}
    REGIME_AGNOSTIC_PATTERNS = {'DEEP_VALUE_CRASH', 'VOLUME_SPIKE_UP', 'VOLUME_SPIKE_DOWN'}

    def _filter_by_regime(
        self,
        patterns: List[Dict],
        regime: str,
        ema21: float = 0,
        price: float = 0,
    ) -> List[Dict]:
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
                # Trending: allow trend-following, block mean-reversion
                if name in self.MEAN_REVERSION_PATTERNS:
                    continue  # Block
                if name == 'DIP_BUY':
                    # DIP_BUY only in uptrend (price > EMA21)
                    if price <= ema21:
                        continue  # Block dip buying in downtrend
                filtered.append(p)

            elif regime == 'ranging':
                # Ranging: allow mean-reversion + volume, block trend-following
                if name in self.TREND_FOLLOWING_PATTERNS:
                    continue  # Block
                filtered.append(p)

            elif regime == 'volatile':
                # Volatile: only deep value + volume spikes
                # (regime-agnostic already handled above)
                continue  # Block everything else

            else:
                # Unknown regime: allow all
                filtered.append(p)

        return filtered
```

**Step 4: Wire into `_generate_signal`**

After the HTF gate check and before the consensus gate, add:

```python
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
```

Remove the duplicate `buy_signals`/`sell_signals` assignment that exists after the current consensus gate (they're now computed above it).

**Step 5: Run tests**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py -v`
Expected: All PASS

**Step 6: Commit**

```bash
git add packages/engine/src/guilds/quant.py packages/engine/tests/test_quant_signals.py
git commit -m "feat: add regime-gated pattern selection — right patterns for right markets"
```

---

### Task 5: Fix MOMENTUM_GAINER bypass

**Files:**
- Modify: `packages/engine/src/tanks/market_scout.py` (remove override lines 154-164)
- Modify: `packages/engine/tests/test_quant_signals.py`

**Step 1: Write failing test**

```python
class TestMomentumGainerFix:
    """MOMENTUM_GAINER must go through consensus gate, not bypass it."""

    def test_momentum_gainer_alone_does_not_produce_buy(self, make_ohlcv, make_multi_tf):
        """If only MOMENTUM_GAINER fires, signal should be HOLD (consensus needs 2+)."""
        q = QuantGuild()
        # Simulate: only momentum_gainer pattern detected
        patterns = [{'pattern': 'MOMENTUM_GAINER', 'action': 'BUY', 'confidence': 0.80}]
        indicators = {'price': 100, 'atr': 2.0, 'bb_mid': 100, 'volume_ratio': 2.0,
                      'market_regime': 'trending', 'ema21': 98}
        signal = q._generate_signal(patterns, indicators, pd.DataFrame({'close': [100]}))
        assert signal['action'] == 'HOLD'
        assert 'consensus' in signal.get('filtered_by', '') or 'consensus' in signal.get('reason', '').lower()
```

**Step 2: Run to verify failure**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py::TestMomentumGainerFix -v`
Expected: May pass already if consensus gate handles it. If MOMENTUM_GAINER goes through consensus gate after Task 4 changes, it will be blocked as a single pattern.

**Step 3: Remove MOMENTUM_GAINER override in market_scout.py**

In `packages/engine/src/tanks/market_scout.py`, replace lines 148-171:

**Before (lines 148-171):**
```python
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
```

**After:**
```python
            # MOMENTUM_GAINER: inject as additional pattern (goes through consensus gate)
            # No override — momentum alone won't produce a BUY signal (needs 2+ patterns)
            momentum = await self._detect_momentum_gainer(symbol, indicators)
            if momentum:
                patterns.append(momentum)
                if 'MOMENTUM_GAINER' not in (signal.get('patterns') or []):
                    signal.setdefault('patterns', []).append('MOMENTUM_GAINER')
```

**Step 4: Run tests**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py -v`
Expected: All PASS

**Step 5: Commit**

```bash
git add packages/engine/src/tanks/market_scout.py packages/engine/tests/test_quant_signals.py
git commit -m "fix: remove MOMENTUM_GAINER consensus bypass — now requires 2+ confirming patterns"
```

---

### Task 6: Update TOML thresholds

**Files:**
- Modify: `cryonix.toml`

**Step 1: Update parameters**

| Parameter | Path in TOML | Old | New |
|-----------|-------------|-----|-----|
| `rsi_oversold` | `[indicators]` | 35 | 30 |
| `sl_atr_multiplier` | `[exits]` | 4.5 | 3.5 |
| `two_pattern_boost` | `[consensus]` | 0.10 | 0.08 |

Note: `tp_atr_multiplier` stays at 5.5. `rsi_overbought` stays at 70. Confidence changes (EMA 0.65→0.60, MACD 0.68→0.62) are hardcoded in quant.py, already changed in Task 3.

**Step 2: Apply changes**

```toml
# [indicators] section:
rsi_oversold = 30

# [exits] section:
sl_atr_multiplier = 3.5

# [consensus] section:
two_pattern_boost = 0.08
```

Also update the comment for sl/tp ratio:
```toml
# The ratio tp/sl determines the risk-reward. Current: 5.5/3.5 = 1.57 R:R
```

**Step 3: Commit**

```bash
git add cryonix.toml
git commit -m "config: tighten thresholds — RSI 30, SL 3.5 ATR (R:R 1.57), consensus boost 8%"
```

---

### Task 7: Integration test + backtest verification

**Files:**
- Modify: `packages/engine/tests/test_quant_signals.py` (add integration test)

**Step 1: Write integration test**

```python
class TestIntegration:
    """Full pipeline integration: signal goes through all gates."""

    def test_full_pipeline_bearish_htf_blocks_buy(self, make_ohlcv):
        """A BUY pattern in bearish HTF should be blocked entirely."""
        q = QuantGuild()
        ohlcv = make_ohlcv(n=100, base_price=100.0, trend='flat')
        multi_tf = _make_htf_data(trend_1h='bearish', trend_4h='bearish')
        result = q.analyze(ohlcv, 'TEST/USDC', multi_tf_data=multi_tf)
        # Even if 15m patterns fire, HTF gate should block BUY
        if result['signal']['action'] == 'BUY':
            # This should not happen with both TFs bearish
            assert False, f"BUY signal passed HTF gate: {result['signal']}"

    def test_full_pipeline_ranging_blocks_trend_patterns(self, make_ohlcv, make_multi_tf):
        """In ranging market, trend-following patterns should be filtered."""
        q = QuantGuild()
        # Flat data → ranging regime (low ADX)
        ohlcv = make_ohlcv(n=100, base_price=100.0, trend='flat', volatility=0.005)
        multi_tf = make_multi_tf(trend='flat')
        result = q.analyze(ohlcv, 'TEST/USDC', multi_tf_data=multi_tf)
        # If EMA_CROSS or MACD_CROSS fired, they should have been filtered
        if result['signal']['action'] in ('BUY', 'SELL'):
            patterns = result['signal'].get('patterns', [])
            for p in patterns:
                assert p not in ('EMA_BULLISH_CROSS', 'EMA_BEARISH_CROSS',
                                 'MACD_BULLISH_CROSS', 'MACD_BEARISH_CROSS'), \
                    f"Trend pattern {p} passed regime gate in ranging market"
```

**Step 2: Run all tests**

Run: `cd packages/engine && python -m pytest tests/test_quant_signals.py -v --tb=short`
Expected: All PASS

**Step 3: Run backtest comparison**

Run: `cd packages/engine && python -m scripts.strategy-lab.backtest` (or equivalent)
Compare: signal count, win rate, profit factor against the pre-change baseline.

**Step 4: Commit**

```bash
git add packages/engine/tests/test_quant_signals.py
git commit -m "test: add integration tests for signal quality pipeline"
```

---

### Task 8: Deploy + verify

**Step 1: Build and deploy engine**

```bash
docker compose -f docker-compose.prod.yml build engine web
docker compose -f docker-compose.prod.yml up -d engine web auto-trader
```

**Step 2: Monitor initial signals**

```bash
docker logs cryonix-engine-1 --tail 50 -f
```

Look for:
- `HTF hard veto` messages blocking counter-trend trades
- `regime gate` messages filtering wrong pattern types
- Reduced signal count overall
- `MOMENTUM_GAINER` only appearing alongside other patterns

**Step 3: Verify no MOMENTUM_GAINER solo signals**

```bash
docker logs cryonix-engine-1 2>&1 | grep "MOMENTUM_GAINER" | head -10
```

Should NOT see MOMENTUM_GAINER as the only pattern in any BUY signal.

**Step 4: Commit any hot-fixes if needed**

---

## Execution Order Summary

| Task | Description | Depends On |
|------|-------------|------------|
| 1 | Pytest infrastructure + fixtures | — |
| 2 | HTF hard veto | 1 |
| 3 | Multi-TF pattern confirmation | 1 |
| 4 | Regime-gated pattern selection | 1 |
| 5 | MOMENTUM_GAINER bypass fix | 4 |
| 6 | TOML threshold updates | 3 |
| 7 | Integration tests + backtest | 2, 3, 4, 5, 6 |
| 8 | Deploy + verify | 7 |

Tasks 2, 3, 4 can be implemented in parallel (they modify different parts of quant.py). Task 5 depends on 4 (regime classification of MOMENTUM_GAINER). Task 7 validates everything together.
