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
