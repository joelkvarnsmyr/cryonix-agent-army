from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from src.api.router import api_router

app = FastAPI(
    title="Cryonix Intelligence Layer",
    description="Python microservice for AI Trading Guilds (Oracle, Scribe, Quant)",
    version="0.1.0"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify generic origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API router
app.include_router(api_router)

@app.get("/")
async def root():
    return {"status": "online", "service": "Cryonix Intelligence Layer"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}
