import asyncio
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from src.api.router import api_router
from src.core.state_sync import state_manager
from src.tanks.market_scout import MarketScoutTank
from src.tanks.news_scout import NewsScoutTank
from src.tanks.gainer_scanner import GainerScanner
from contextlib import asynccontextmanager

# Get Redis URL from environment
kv_url = os.getenv("KV_URL", "redis://localhost:6379")

# Initialize Tanks
scout_tank = MarketScoutTank()
news_tank = NewsScoutTank(kv_url=kv_url)
gainer_scanner = GainerScanner(redis_client=state_manager.redis)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Start Tank Loops
    print("🚀 Cryonix Engine Starting...")
    asyncio.create_task(scout_tank.run_loop())
    asyncio.create_task(news_tank.run_loop())
    asyncio.create_task(gainer_scanner.run_loop())
    
    yield
    
    # Shutdown: Clean up connections
    print("🛑 Cryonix Engine Stopping...")
    await state_manager.close()

app = FastAPI(
    title="Cryonix Engine (The Brain)",
    description="Python LangGraph Engine for Autonomous Trading",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)

@app.get("/")
async def root():
    return {"status": "online", "mode": "Glass Tank Hybrid"}
