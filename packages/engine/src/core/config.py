from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # App
    APP_NAME: str = "Cryonix Engine"
    ENV: str = "development"
    
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

    class Config:
        env_file = ".env"

settings = Settings()
