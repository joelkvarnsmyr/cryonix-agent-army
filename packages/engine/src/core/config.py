import tomllib
from pathlib import Path
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # App
    APP_NAME: str = "Cryonix Engine"
    ENV: str = "development"
    CRYONIX_ENV: str = "development"    # production | development — guards execution

    # Redis (State Sync)
    # Default to localhost if not provided (for local docker)
    KV_URL: str = "redis://redis:6379"

    # Binance
    BINANCE_API_KEY: str = ""
    BINANCE_API_SECRET: str = ""
    BINANCE_TESTNET: bool = True

    # Trading mode: 'spot', 'margin', 'future'
    TRADING_MODE: str = "spot"        # Synced with auto-trader (margin unavailable)
    MARGIN_TYPE: str = "cross"        # 'cross' or 'isolated'
    DEFAULT_LEVERAGE: int = 3          # Conservative 3x leverage

    # AI (Optional for now)
    XAI_API_KEY: str = ""

    @property
    def is_production(self) -> bool:
        return self.CRYONIX_ENV == "production"

    class Config:
        env_file = ".env"

settings = Settings()

# ============================================================================
# TOML Configuration Loader
# ============================================================================
# Reads cryonix.toml for centralized trading/risk/indicator parameters.
# Fallback: returns empty dict if TOML not found (code uses its own defaults).
# ============================================================================

_toml_config: dict | None = None
_toml_loaded: bool = False

def load_toml_config() -> dict:
    """Load cryonix.toml and return as dict. Cached after first call."""
    global _toml_config, _toml_loaded
    if _toml_loaded:
        return _toml_config or {}
    _toml_loaded = True

    paths = [Path("/app/cryonix.toml")]                          # Docker container
    try:
        paths.append(Path(__file__).parents[4] / "cryonix.toml")  # Dev (repo root)
    except IndexError:
        pass  # In Docker, path depth is shorter

    for p in paths:
        if p.exists():
            with open(p, "rb") as f:
                _toml_config = tomllib.load(f)
                print(f"[CONFIG] Loaded cryonix.toml from {p}")
                return _toml_config

    print("[CONFIG] cryonix.toml not found — using code defaults")
    return {}


def get_toml(section: str, key: str, default=None):
    """Get a single value from TOML config: get_toml('risk', 'min_confidence', 0.65)"""
    cfg = load_toml_config()
    return cfg.get(section, {}).get(key, default)
