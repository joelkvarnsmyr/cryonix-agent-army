# CoinglassScout Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CoinglassScout Python tank that fetches funding rates, open interest, and long/short ratio (with CCXT fallback), writing to Redis so the auto-trade route can apply confidence boosts/penalties.

**Architecture:** A new `CoinglassScout` tank in the Python engine follows the same pattern as `CMCScout` — polling every 10 minutes, writing structured JSON to Redis with a 20-minute TTL. When `[coinglass] enabled = false` (default), it falls back to Binance USDT-M futures via the already-integrated CCXT library for funding rates + OI. Long/short ratio is skipped in fallback mode (Coinglass API only). The auto-trade route gets a new STEP 3d block that reads three Redis keys and applies additive confidence adjustments, consistent with the existing CMC block (STEP 3c).

**Tech Stack:** Python 3.11, `ccxt.async_support` (binanceusdm), `httpx`, Redis pipeline, TypeScript/Next.js (auto-trade route), `@iarna/toml` config.

**Spec:** `docs/superpowers/specs/2026-03-10-coinglass-scout-design.md`

---

## Chunk 1: Python Engine

### Task 1: Add `[coinglass]` section to cryonix.toml

**Files:**
- Modify: `cryonix.toml` (after `[coinmarketcap]` section, around line 860)

- [ ] **Step 1: Add config section**

Append after the `[coinmarketcap]` block (after line 860):

```toml
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  COINGLASS — Derivatives market intelligence                           ║
# ║  Provides funding rates, open interest, and long/short ratio.          ║
# ║  Fallback: CCXT Binance futures (funding + OI, no L/S ratio).          ║
# ║  Full data: requires COINGLASS_API_KEY in .env + enabled = true.       ║
# ╚══════════════════════════════════════════════════════════════════════════╝

[coinglass]

# Master switch. When false, CoinglassScout uses CCXT Binance futures
# for funding rates + OI. Set true after adding COINGLASS_API_KEY to .env.
enabled = false

# Poll interval in seconds.
# CCXT fallback: 600 (10 min) — no API cost, all 45 symbols.
# Coinglass API (enabled=true): set to 21600 (6h) — free tier is ~100 req/day,
# so 4 cycles/day × 15 symbols × 3 endpoints = 180 req/day fits within limits.
poll_interval_seconds = 600

# ── Funding Rate Thresholds ────────────────────────────────────────────
# Funding rate is paid every 8 hours between longs and shorts.
# Negative = shorts pay longs (bearish positioning → squeeze potential).
# Positive = longs pay shorts (bullish crowding → dump risk).
#
# Rates are expressed as decimals (e.g. -0.0005 = -0.05% per 8h).
funding_extreme_negative_threshold = -0.0005   # -0.05% → strong squeeze signal
funding_negative_threshold = -0.0002           # -0.02% → mild squeeze signal
funding_extreme_positive_threshold = 0.001     # +0.10% → crowded long warning
funding_positive_threshold = 0.0005            # +0.05% → mild crowding

# Confidence adjustments for funding rate signals.
funding_squeeze_boost = 0.08       # +8% when funding extremely negative
funding_bearish_boost = 0.04       # +4% when funding mildly negative
funding_crowded_penalty = 0.08     # -8% when funding extremely positive
funding_positive_penalty = 0.04    # -4% when funding mildly positive

# ── Open Interest Thresholds ──────────────────────────────────────────
# OI 24h change as a decimal (0.10 = 10% rise in 24h).
oi_surge_threshold = 0.10          # 10% OI increase

# Confidence adjustments for OI changes.
oi_trend_boost = 0.05              # +5% OI surge + rising price (trend confirmation)
oi_capitulation_boost = 0.04       # +4% OI drop (capitulation → potential bottom for dip patterns)
oi_panic_penalty = 0.05            # -5% OI drop + falling price (panic exit, not a dip)

# ── Long/Short Ratio Thresholds (Coinglass API only) ──────────────────
# Ratio of long accounts to short accounts on perpetual futures.
# < 1.0 means more short accounts than long accounts.
ls_short_squeeze_threshold = 0.8   # below this → squeeze setup
ls_crowded_long_threshold = 2.5    # above this → crowded long trade

# Confidence adjustments for L/S ratio signals.
ls_squeeze_boost = 0.06            # +6% when shorts dominant
ls_crowded_penalty = 0.06          # -6% when longs dominant
```

- [ ] **Step 2: Verify TOML parses cleanly**

```bash
cd packages/engine
python3 -c "import tomllib; tomllib.load(open('../../cryonix.toml', 'rb')); print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add cryonix.toml
git commit -m "feat(config): add [coinglass] section to cryonix.toml"
```

---

### Task 2: CoinglassScout tank

**Files:**
- Create: `packages/engine/src/tanks/coinglass_scout.py`

- [ ] **Step 1: Create the file**

```python
"""
CoinglassScout — Derivatives market intelligence layer.

Fetches funding rates, open interest, and long/short ratio from:
  - Coinglass Open API v1 (when enabled=true + COINGLASS_API_KEY set)
  - CCXT Binance USDT-M futures (fallback: funding + OI only, no L/S ratio)

Writes to Redis every 10 minutes (configurable):
  - coinglass:funding:{BASE}  → { rate, annualized_rate, timestamp }
  - coinglass:oi:{BASE}       → { oi_usd, oi_change_24h_pct, timestamp }
  - coinglass:ls:{BASE}       → { long_ratio, short_ratio, timestamp }  (API only)

BASE is the asset symbol without quote (e.g. BTC, ETH, SOL).
"""
import asyncio
import json
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
import ccxt.async_support as ccxt

from src.core.config import get_toml
from src.core.state_sync import state_manager

# Base assets we track (matches CMCScout TRACKED_SYMBOLS)
TRACKED_SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP",
    "ADA", "AVAX", "LINK", "DOT", "ATOM",
    "NEAR", "SUI", "UNI", "AAVE", "TAO",
    "ARB", "OP", "INJ", "FET", "RENDER",
    "TIA", "SEI", "JUP", "WLD", "ICP",
    "APT", "FIL", "POL", "ALGO", "THETA",
    "STRK", "PYTH", "JTO", "WIF", "PENDLE",
    "DOGE", "PEPE", "SHIB", "BONK", "FLOKI",
    "LTC", "ETC", "XLM", "VET", "HBAR",
]

COINGLASS_BASE_URL = "https://open-api.coinglass.com"
REDIS_TTL = 1200  # 20 minutes (2× poll interval as buffer)


class CoinglassScout:
    """Fetches derivatives market intelligence and writes to Redis."""

    def __init__(self, redis_client):
        self.redis = redis_client
        self.name = "CoinglassScout"
        self.api_key = os.environ.get("COINGLASS_API_KEY", "")
        self.use_api = bool(self.api_key) and get_toml("coinglass", "enabled", False)
        self.poll_interval = get_toml("coinglass", "poll_interval_seconds", 600)
        self.last_run = 0.0

    def _cg_headers(self) -> Dict[str, str]:
        return {
            "Accept": "application/json",
            "coinglassSecret": self.api_key,
        }

    # ── Coinglass API mode ─────────────────────────────────────────────

    async def _fetch_coinglass_funding(
        self, client: httpx.AsyncClient, symbol: str
    ) -> Optional[Dict]:
        """GET /api/pro/v1/futures/funding-rate — current funding rate per exchange."""
        try:
            resp = await client.get(
                f"{COINGLASS_BASE_URL}/api/pro/v1/futures/funding-rate",
                headers=self._cg_headers(),
                params={"symbol": symbol},
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json().get("data", [])
            # Find Binance entry
            binance = next(
                (d for d in data if d.get("exchangeName", "").lower() == "binance"),
                data[0] if data else None,
            )
            if not binance:
                return None
            rate = float(binance.get("fundingRate", 0))
            # Annualize: 3 payments/day × 365 days
            return {
                "rate": rate,
                "annualized_rate": rate * 3 * 365,
                "next_funding_time": binance.get("nextFundingTime"),
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] Coinglass funding fetch failed for {symbol}: {e}")
            return None

    async def _fetch_coinglass_oi(
        self, client: httpx.AsyncClient, symbol: str
    ) -> Optional[Dict]:
        """GET /api/pro/v1/futures/openInterest — open interest + 24h change."""
        try:
            resp = await client.get(
                f"{COINGLASS_BASE_URL}/api/pro/v1/futures/openInterest",
                headers=self._cg_headers(),
                params={"symbol": symbol},
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json().get("data", {})
            # Aggregate across exchanges or use "All" entry
            all_entry = data.get("All") or (list(data.values())[0] if data else None)
            if not all_entry:
                return None
            oi_usd = float(all_entry.get("openInterest", 0))
            oi_change = float(all_entry.get("openInterestChangePercent24h", 0)) / 100
            return {
                "oi_usd": oi_usd,
                "oi_change_24h_pct": oi_change,
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] Coinglass OI fetch failed for {symbol}: {e}")
            return None

    async def _fetch_coinglass_ls(
        self, client: httpx.AsyncClient, symbol: str
    ) -> Optional[Dict]:
        """GET /api/pro/v1/futures/global-long-short-account-ratio — L/S ratio."""
        try:
            resp = await client.get(
                f"{COINGLASS_BASE_URL}/api/pro/v1/futures/global-long-short-account-ratio",
                headers=self._cg_headers(),
                params={"symbol": symbol, "interval": "h1", "limit": 1},
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json().get("data", [])
            latest = data[-1] if data else None
            if not latest:
                return None
            long_ratio = float(latest.get("longAccount", 0.5))
            short_ratio = float(latest.get("shortAccount", 0.5))
            ls_ratio = long_ratio / short_ratio if short_ratio > 0 else 1.0
            return {
                "long_ratio": long_ratio,
                "short_ratio": short_ratio,
                "ls_ratio": ls_ratio,
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] Coinglass L/S fetch failed for {symbol}: {e}")
            return None

    async def _scan_via_api(self) -> Dict[str, Any]:
        """Fetch data from Coinglass API.

        NOTE: Coinglass free tier is ~100 req/day. At 10-minute poll intervals,
        even 1 symbol × 3 endpoints × 144 cycles/day = 432 req/day exceeds the limit.
        In API mode, poll_interval_seconds should be set to 21600 (6h) so that
        15 symbols × 3 endpoints × 4 cycles/day = 180 req/day, within the free tier.
        The CCXT fallback covers all 45 symbols every 10 minutes for free.
        """
        # Top 15 symbols only in API mode.
        # At 6h poll interval: 15 × 3 endpoints × 4 cycles/day = 180 req/day.
        TOP_SYMBOLS = [
            "BTC", "ETH", "SOL", "BNB", "XRP",
            "ADA", "AVAX", "LINK", "DOT", "ATOM",
            "NEAR", "SUI", "UNI", "AAVE", "TAO",
        ]
        results: Dict[str, Any] = {}
        async with httpx.AsyncClient() as client:
            for symbol in TOP_SYMBOLS:
                funding, oi, ls = await asyncio.gather(
                    self._fetch_coinglass_funding(client, symbol),
                    self._fetch_coinglass_oi(client, symbol),
                    self._fetch_coinglass_ls(client, symbol),
                )
                results[symbol] = {"funding": funding, "oi": oi, "ls": ls}
                # Pace requests to avoid bursting
                await asyncio.sleep(0.3)
        return results

    # ── CCXT fallback mode ────────────────────────────────────────────

    async def _fetch_ccxt_data(
        self, exchange: ccxt.binanceusdm, symbol: str
    ) -> Tuple[Optional[Dict], Optional[Dict]]:
        """Fetch funding rate + OI for one symbol via CCXT Binance futures."""
        futures_symbol = f"{symbol}/USDT:USDT"
        try:
            funding_data = await exchange.fetch_funding_rate(futures_symbol)
            rate = float(funding_data.get("fundingRate", 0))
            funding = {
                "rate": rate,
                "annualized_rate": rate * 3 * 365,
                "next_funding_time": funding_data.get("nextFundingDatetime"),
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] CCXT funding failed for {symbol}: {e}")
            funding = None

        try:
            oi_data = await exchange.fetch_open_interest(futures_symbol)
            current_oi = float(oi_data.get("openInterestValue", 0))

            # Compute 24h change by comparing to previous Redis value
            prev_raw = await self.redis.get(f"coinglass:oi:{symbol}")
            prev_oi = json.loads(prev_raw).get("oi_usd", 0) if prev_raw else 0
            oi_change = ((current_oi - prev_oi) / prev_oi) if prev_oi > 0 else 0.0

            oi = {
                "oi_usd": current_oi,
                "oi_change_24h_pct": oi_change,
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] CCXT OI failed for {symbol}: {e}")
            oi = None

        return funding, oi

    async def _scan_via_ccxt(self) -> Dict[str, Any]:
        """Fetch funding + OI for all tracked symbols via CCXT (no API key required)."""
        exchange = ccxt.binanceusdm({"options": {"defaultType": "future"}})
        results: Dict[str, Any] = {}
        try:
            for symbol in TRACKED_SYMBOLS:
                funding, oi = await self._fetch_ccxt_data(exchange, symbol)
                results[symbol] = {"funding": funding, "oi": oi, "ls": None}
        finally:
            await exchange.close()
        return results

    # ── Main scan ─────────────────────────────────────────────────────

    async def scan(self) -> Dict[str, Any]:
        """Run full Coinglass scan and write results to Redis."""
        mode = "api" if self.use_api else "ccxt"
        print(f"[{self.name}] Scanning via {mode.upper()}...")

        data = await self._scan_via_api() if self.use_api else await self._scan_via_ccxt()

        pipe = self.redis.pipeline()
        updated = {"funding": 0, "oi": 0, "ls": 0}

        for symbol, entry in data.items():
            if entry.get("funding"):
                pipe.set(f"coinglass:funding:{symbol}", json.dumps(entry["funding"]), ex=REDIS_TTL)
                updated["funding"] += 1
            if entry.get("oi"):
                pipe.set(f"coinglass:oi:{symbol}", json.dumps(entry["oi"]), ex=REDIS_TTL)
                updated["oi"] += 1
            if entry.get("ls"):
                pipe.set(f"coinglass:ls:{symbol}", json.dumps(entry["ls"]), ex=REDIS_TTL)
                updated["ls"] += 1

        await pipe.execute()

        summary = (
            f"funding={updated['funding']} oi={updated['oi']} ls={updated['ls']} [{mode}]"
        )
        print(f"[{self.name}] Done: {summary}")

        await state_manager.set_agent_status(self.name, "active", {"message": summary})
        return {"status": "ok", "mode": mode, **updated, "timestamp": time.time()}

    # ── Run loop ──────────────────────────────────────────────────────

    async def run_loop(self):
        """Periodically poll Coinglass (API or CCXT fallback)."""
        mode = "Coinglass API" if self.use_api else "CCXT fallback (funding + OI)"
        print(f"[{self.name}] Starting ({mode}, every {self.poll_interval}s)")

        await state_manager.set_agent_status(self.name, "active", {"message": f"Starting {mode}"})

        while True:
            try:
                now = time.time()
                if now - self.last_run >= self.poll_interval:
                    await self.scan()
                    self.last_run = now
            except Exception as e:
                print(f"[{self.name}] Error: {e}")
                await state_manager.set_agent_status(self.name, "error", {"message": str(e)})
                await asyncio.sleep(60)
                continue

            await asyncio.sleep(30)
```

- [ ] **Step 2: Verify Python syntax**

```bash
cd packages/engine
python3 -c "import ast; ast.parse(open('src/tanks/coinglass_scout.py').read()); print('Syntax OK')"
```

Expected: `Syntax OK`

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/tanks/coinglass_scout.py
git commit -m "feat(engine): add CoinglassScout tank with CCXT fallback"
```

---

### Task 3: Tests for CoinglassScout

**Files:**
- Create: `packages/engine/tests/test_coinglass_scout.py`

- [ ] **Step 1: Write tests**

```python
"""Tests for CoinglassScout — mocks Redis + CCXT/httpx to stay offline."""
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.tanks.coinglass_scout import CoinglassScout


@pytest.fixture
def mock_redis():
    redis = MagicMock()
    redis.get = AsyncMock(return_value=None)
    redis.pipeline = MagicMock(return_value=MagicMock(
        set=MagicMock(),
        execute=AsyncMock(return_value=[]),
    ))
    return redis


@pytest.fixture
def scout_ccxt(mock_redis):
    """Scout in CCXT fallback mode (no API key)."""
    with patch.dict("os.environ", {"COINGLASS_API_KEY": ""}):
        def mock_get_toml(section, key, default=None):
            if key == "enabled":
                return False
            if key == "poll_interval_seconds":
                return 600
            return default
        with patch("src.tanks.coinglass_scout.get_toml", side_effect=mock_get_toml):
            s = CoinglassScout(redis_client=mock_redis)
            assert not s.use_api
            return s


@pytest.fixture
def scout_api(mock_redis):
    """Scout in Coinglass API mode."""
    with patch.dict("os.environ", {"COINGLASS_API_KEY": "test-key-123"}):
        def mock_get_toml(section, key, default=None):
            if key == "enabled":
                return True
            if key == "poll_interval_seconds":
                return 600
            return default
        with patch("src.tanks.coinglass_scout.get_toml", side_effect=mock_get_toml):
            s = CoinglassScout(redis_client=mock_redis)
            assert s.use_api
            return s


class TestCoinglassScoutInit:
    def test_ccxt_mode_when_no_api_key(self, scout_ccxt):
        assert not scout_ccxt.use_api
        assert scout_ccxt.name == "CoinglassScout"

    def test_api_mode_when_key_and_enabled(self, scout_api):
        assert scout_api.use_api
        assert scout_api.api_key == "test-key-123"


class TestCCXTFallback:
    @pytest.mark.asyncio
    async def test_ccxt_funding_parsed_correctly(self, scout_ccxt):
        mock_exchange = AsyncMock()
        mock_exchange.fetch_funding_rate.return_value = {"fundingRate": -0.0003}
        mock_exchange.fetch_open_interest.return_value = {"openInterestValue": 500_000_000.0}
        mock_exchange.close = AsyncMock()

        funding, oi = await scout_ccxt._fetch_ccxt_data(mock_exchange, "BTC")

        assert funding is not None
        assert funding["rate"] == pytest.approx(-0.0003)
        # Annualized: -0.0003 × 3 × 365
        assert funding["annualized_rate"] == pytest.approx(-0.0003 * 3 * 365)
        assert "next_funding_time" in funding
        assert "timestamp" in funding

    @pytest.mark.asyncio
    async def test_ccxt_oi_computes_change_from_redis(self, scout_ccxt, mock_redis):
        prev_oi = {"oi_usd": 400_000_000.0, "oi_change_24h_pct": 0.0, "timestamp": time.time()}
        mock_redis.get = AsyncMock(return_value=json.dumps(prev_oi))

        mock_exchange = AsyncMock()
        mock_exchange.fetch_funding_rate.return_value = {"fundingRate": 0.0001}
        mock_exchange.fetch_open_interest.return_value = {"openInterestValue": 500_000_000.0}

        _, oi = await scout_ccxt._fetch_ccxt_data(mock_exchange, "BTC")

        assert oi is not None
        # (500M - 400M) / 400M = 0.25 = 25% increase
        assert oi["oi_change_24h_pct"] == pytest.approx(0.25)

    @pytest.mark.asyncio
    async def test_ccxt_funding_failure_returns_none(self, scout_ccxt):
        mock_exchange = AsyncMock()
        mock_exchange.fetch_funding_rate.side_effect = Exception("network error")
        mock_exchange.fetch_open_interest.return_value = {"openInterestValue": 100_000_000.0}

        funding, oi = await scout_ccxt._fetch_ccxt_data(mock_exchange, "SOL")

        assert funding is None
        assert oi is not None  # OI still works

    @pytest.mark.asyncio
    async def test_ls_is_none_in_ccxt_mode(self, scout_ccxt):
        """L/S ratio is not available in CCXT mode."""
        with patch.object(scout_ccxt, "_scan_via_ccxt", new_callable=AsyncMock) as mock_scan:
            mock_scan.return_value = {
                "BTC": {
                    "funding": {"rate": -0.0002, "annualized_rate": -0.219, "timestamp": 1.0},
                    "oi": {"oi_usd": 1e9, "oi_change_24h_pct": 0.05, "timestamp": 1.0},
                    "ls": None,
                }
            }
            with patch("src.tanks.coinglass_scout.state_manager") as mock_sm:
                mock_sm.set_agent_status = AsyncMock()
                result = await scout_ccxt.scan()

        assert result["ls"] == 0  # no L/S updates


class TestRedisWrite:
    @pytest.mark.asyncio
    async def test_scan_writes_funding_and_oi_to_redis(self, scout_ccxt, mock_redis):
        fake_data = {
            "BTC": {
                "funding": {"rate": -0.0003, "annualized_rate": -0.328, "timestamp": 1.0},
                "oi": {"oi_usd": 5e9, "oi_change_24h_pct": 0.12, "timestamp": 1.0},
                "ls": None,
            }
        }
        with patch.object(scout_ccxt, "_scan_via_ccxt", new_callable=AsyncMock, return_value=fake_data):
            with patch("src.tanks.coinglass_scout.state_manager") as mock_sm:
                mock_sm.set_agent_status = AsyncMock()
                result = await scout_ccxt.scan()

        pipe = mock_redis.pipeline.return_value
        assert pipe.set.call_count == 2  # funding + oi (no ls)
        assert result["funding"] == 1
        assert result["oi"] == 1
        assert result["ls"] == 0

    @pytest.mark.asyncio
    async def test_scan_writes_ls_when_api_mode(self, scout_api, mock_redis):
        fake_data = {
            "BTC": {
                "funding": {"rate": 0.0001, "annualized_rate": 0.109, "timestamp": 1.0},
                "oi": {"oi_usd": 5e9, "oi_change_24h_pct": 0.05, "timestamp": 1.0},
                "ls": {"long_ratio": 0.55, "short_ratio": 0.45, "ls_ratio": 1.22, "timestamp": 1.0},
            }
        }
        with patch.object(scout_api, "_scan_via_api", new_callable=AsyncMock, return_value=fake_data):
            with patch("src.tanks.coinglass_scout.state_manager") as mock_sm:
                mock_sm.set_agent_status = AsyncMock()
                result = await scout_api.scan()

        pipe = mock_redis.pipeline.return_value
        assert pipe.set.call_count == 3  # funding + oi + ls
        assert result["ls"] == 1
```

- [ ] **Step 2: Run tests (expect pass)**

```bash
cd packages/engine
python3 -m pytest tests/test_coinglass_scout.py -v
```

Expected: all tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/engine/tests/test_coinglass_scout.py
git commit -m "test(engine): add CoinglassScout unit tests"
```

---

### Task 4: Register CoinglassScout in main.py

**Files:**
- Modify: `packages/engine/src/main.py`

- [ ] **Step 1: Add import + instantiation**

In `packages/engine/src/main.py`, add after the `from src.tanks.cmc_scout import CMCScout` import:

```python
from src.tanks.coinglass_scout import CoinglassScout
```

Add after `cmc_scout = CMCScout(redis_client=state_manager.redis)`:

```python
coinglass_scout = CoinglassScout(redis_client=state_manager.redis)
```

Add after `asyncio.create_task(cmc_scout.run_loop())` in the lifespan function:

```python
    asyncio.create_task(coinglass_scout.run_loop())
```

- [ ] **Step 2: Verify engine imports cleanly**

```bash
cd packages/engine
python3 -c "from src.main import app; print('Import OK')"
```

Expected: `Import OK` (no errors)

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/main.py
git commit -m "feat(engine): register CoinglassScout in main.py"
```

---

## Chunk 2: TypeScript Auto-Trade Route

### Task 5: Add STEP 3d — Coinglass confidence block

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts`

The Coinglass block inserts between the end of STEP 3c (around line 2387) and the `parsed.sort(...)` call (line 2389).

- [ ] **Step 1: Insert STEP 3d block**

Find the closing brace of the STEP 3c block (after `} catch { /* CMC data unavailable — skip adjustments */ }`):

```typescript
    } catch { /* CMC data unavailable — skip adjustments */ }
    }
```

Insert the Coinglass block immediately after it, before `parsed.sort(...)`:

```typescript
    // STEP 3d: Coinglass derivatives adjustments (funding rate + OI + L/S ratio)
    // Always runs — CCXT fallback means data is present even without API key.
    try {
      for (const p of parsed) {
        if (p.signal.action !== 'BUY') continue;
        const base = p.signal.symbol.replace('/USDC', '').replace('/USDT', '');

        // ── Funding Rate ──
        const fundingRaw = await redis.get(`coinglass:funding:${base}`);
        if (fundingRaw) {
          const f = JSON.parse(fundingRaw) as { rate: number };
          const rate = f.rate;
          const extremeNeg = TOML?.coinglass?.funding_extreme_negative_threshold ?? -0.0005;
          const mildNeg    = TOML?.coinglass?.funding_negative_threshold        ?? -0.0002;
          const extremePos = TOML?.coinglass?.funding_extreme_positive_threshold ?? 0.001;
          const mildPos    = TOML?.coinglass?.funding_positive_threshold         ?? 0.0005;

          if (rate <= extremeNeg) {
            const boost = TOML?.coinglass?.funding_squeeze_boost ?? 0.08;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | 📉 Funding ${(rate * 100).toFixed(3)}% squeeze +${(boost * 100).toFixed(0)}%`;
          } else if (rate <= mildNeg) {
            const boost = TOML?.coinglass?.funding_bearish_boost ?? 0.04;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | 📉 Funding ${(rate * 100).toFixed(3)}% bearish +${(boost * 100).toFixed(0)}%`;
          } else if (rate >= extremePos) {
            const penalty = TOML?.coinglass?.funding_crowded_penalty ?? 0.08;
            p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
            p.signal.reason += ` | 📈 Funding ${(rate * 100).toFixed(3)}% crowded -${(penalty * 100).toFixed(0)}%`;
          } else if (rate >= mildPos) {
            const penalty = TOML?.coinglass?.funding_positive_penalty ?? 0.04;
            p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
            p.signal.reason += ` | 📈 Funding ${(rate * 100).toFixed(3)}% long-heavy -${(penalty * 100).toFixed(0)}%`;
          }
        }

        // ── Open Interest ──
        const oiRaw = await redis.get(`coinglass:oi:${base}`);
        if (oiRaw) {
          const oi = JSON.parse(oiRaw) as { oi_change_24h_pct: number };
          const oiChange = oi.oi_change_24h_pct;
          const surgeThreshold = TOML?.coinglass?.oi_surge_threshold ?? 0.10;
          const patterns = p.signal.patterns || [];
          const isDipPattern = patterns.some((pat: string) =>
            ['DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE'].includes(pat)
          );

          if (oiChange >= surgeThreshold) {
            // OI surging + this is a BUY signal → trend confirmation
            const boost = TOML?.coinglass?.oi_trend_boost ?? 0.05;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | 📊 OI +${(oiChange * 100).toFixed(1)}% trend +${(boost * 100).toFixed(0)}%`;
          } else if (oiChange <= -surgeThreshold) {
            if (isDipPattern) {
              // Deleveraging + dip pattern → capitulation signal
              const boost = TOML?.coinglass?.oi_capitulation_boost ?? 0.04;
              p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
              p.signal.reason += ` | 📊 OI ${(oiChange * 100).toFixed(1)}% capitulation +${(boost * 100).toFixed(0)}%`;
            } else {
              // Deleveraging without dip pattern → panic exit
              const penalty = TOML?.coinglass?.oi_panic_penalty ?? 0.05;
              p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
              p.signal.reason += ` | 📊 OI ${(oiChange * 100).toFixed(1)}% panic -${(penalty * 100).toFixed(0)}%`;
            }
          }
        }

        // ── Long/Short Ratio (Coinglass API only) ──
        const lsRaw = await redis.get(`coinglass:ls:${base}`);
        if (lsRaw) {
          const ls = JSON.parse(lsRaw) as { ls_ratio: number };
          const ratio = ls.ls_ratio;
          const squeezeThreshold = TOML?.coinglass?.ls_short_squeeze_threshold ?? 0.8;
          const crowdedThreshold = TOML?.coinglass?.ls_crowded_long_threshold ?? 2.5;

          if (ratio <= squeezeThreshold) {
            const boost = TOML?.coinglass?.ls_squeeze_boost ?? 0.06;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | ⚡ L/S ${ratio.toFixed(2)} squeeze +${(boost * 100).toFixed(0)}%`;
          } else if (ratio >= crowdedThreshold) {
            const penalty = TOML?.coinglass?.ls_crowded_penalty ?? 0.06;
            p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
            p.signal.reason += ` | ⚡ L/S ${ratio.toFixed(2)} crowded -${(penalty * 100).toFixed(0)}%`;
          }
        }
      }
    } catch { /* Coinglass data unavailable — skip adjustments */ }
```

- [ ] **Step 2: TypeScript check**

```bash
cd apps/web
pnpm type-check 2>&1 | tail -5
```

Expected: no new errors related to `coinglass`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(web): add STEP 3d Coinglass confidence adjustments"
```

---

### Task 6: Add COINGLASS_API_KEY to Docker Compose

**Files:**
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Add env var to engine service**

Find the `engine` service environment block in `docker-compose.prod.yml` (look for `CMC_API_KEY`). Add the Coinglass key alongside it:

```yaml
      - COINGLASS_API_KEY=${COINGLASS_API_KEY:-}
```

The `:-` default means the container starts without error if the key is absent (CCXT fallback activates automatically).

- [ ] **Step 2: Verify compose file parses**

```bash
docker compose -f docker-compose.prod.yml config --quiet && echo "Config OK"
```

Expected: `Config OK`

- [ ] **Step 3: Final commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat(docker): add COINGLASS_API_KEY env var to engine container"
```

---

## Deployment

Once all tasks are committed, deploy to VM:

```bash
# Deploy engine container only (no need to rebuild web)
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build engine"

# Verify CoinglassScout started
ssh azureuser@openclaw-vm "docker logs cryonix-engine-1 --tail 20 | grep Coinglass"
```

Expected log line: `[CoinglassScout] Starting (CCXT fallback (funding + OI), every 600s)`

## Activating Full Coinglass API (when ready)

1. Add to `~/cryonix/.env` on VM:
   ```
   COINGLASS_API_KEY=33d3bcbe347c400d99932ff4ba832242
   ```
2. In `cryonix.toml`, set `[coinglass] enabled = true`
3. Restart engine: `docker compose -f docker-compose.prod.yml restart engine`
4. Check logs for: `[CoinglassScout] Starting (Coinglass API, every 600s)`
