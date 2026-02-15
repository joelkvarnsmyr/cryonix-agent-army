from pydantic import BaseModel, Field
from typing import List, Optional

class AnalysisRequest(BaseModel):
    symbol: str = Field(..., description="Trading pair symbol e.g. BTC/USDT")
    price: float = Field(..., description="Current price")
    timeframe: str = Field("1h", description="Candle timeframe")
    strategy: Optional[str] = Field("standard", description="Analysis strategy to apply")

class AnalysisResponse(BaseModel):
    signal: str = Field(..., description="BUY, SELL, or HOLD")
    confidence: float = Field(..., description="0.0 to 1.0 confidence score")
    reasoning: List[str] = Field(..., description="List of reasons for the decision")
    risks: List[str] = Field(default=[], description="Potential risks identified")
    target_price: Optional[float] = None
    stop_loss: Optional[float] = None
