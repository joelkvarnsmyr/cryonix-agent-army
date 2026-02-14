from typing import Dict, TypedDict, Annotated, Any
from langgraph.graph import StateGraph, END
from src.core.risk_gate import risk_gate
from src.core.state_sync import state_manager
import asyncio
import httpx
import os
import time

# Next.js API base URL for persisting signals to Postgres
# In docker-compose prod, use service name "web"; in dev, use host.docker.internal
NEXTJS_API_URL = os.getenv("NEXTJS_API_URL", "http://host.docker.internal:3000")
SPOT_ONLY = os.getenv("SPOT_ONLY", "true").lower() == "true"

# Signal cooldown: max 1 signal per symbol per 15 min
_signal_cooldown: Dict[str, float] = {}
COOLDOWN_SECONDS = 900  # 15 minutes

class TankState(TypedDict, total=False):
    """Tank state - using total=False to make all fields optional for incremental updates"""
    symbol: str
    price: float
    ohlcv: list  # OHLCV candle data from scan
    indicators: Dict[str, Any]  # Technical indicators from analysis
    signal: Dict[str, Any]
    decision: str  # 'BUY', 'SELL', 'HOLD'
    status: str
    error: str  # Error message if any

class BaseTank:
    """
    Autonomous Trading Agent (Tank) powered by LangGraph.
    Runs a continuous loop: Scan -> Analyze -> Risk -> Execute.
    """
    
    def __init__(self, name: str, symbols: list):
        self.name = name
        self.symbols = symbols
        self.graph = self._build_graph()
        self.runnable = self.graph.compile()

    def _build_graph(self):
        workflow = StateGraph(TankState)
        
        # Define Nodes
        workflow.add_node("scan", self.scan_market)
        workflow.add_node("analyze", self.analyze_signal)
        workflow.add_node("risk_check", self.check_risk)
        workflow.add_node("execute", self.execute_order)
        
        # Define Edges
        workflow.set_entry_point("scan")
        workflow.add_edge("scan", "analyze")
        workflow.add_edge("analyze", "risk_check")
        
        # Conditional Edge after Risk Check
        def route_decision(state):
            if state['decision'] == 'HOLD':
                return END
            return "execute"
            
        workflow.add_conditional_edges(
            "risk_check",
            route_decision,
            {
                "execute": "execute",
                END: END
            }
        )
        workflow.add_edge("execute", END)
        
        return workflow

    async def scan_market(self, state: TankState) -> TankState:
        # Placeholder: Fetch price/candles
        return {"price": 100.0, "status": "scanning"}
        
    async def analyze_signal(self, state: TankState) -> TankState:
        # Placeholder: Call Guilds
        return {"signal": {"action": "BUY", "confidence": 0.8}, "status": "analyzing"}
        
    async def check_risk(self, state: TankState) -> TankState:
        signal = state.get("signal", {})
        indicators = state.get("indicators", {})

        # SPOT_ONLY: skip SELL signals entirely (saves 95% of signal noise)
        if SPOT_ONLY and signal.get("action") == "SELL":
            return {"decision": "HOLD", "status": "spot_only_skip"}

        # Cooldown: max 1 signal per symbol per 15 min
        symbol = state.get("symbol", "")
        cooldown_key = f"{symbol}:{signal.get('action','')}"
        now = time.time()
        last_signal = _signal_cooldown.get(cooldown_key, 0)
        if now - last_signal < COOLDOWN_SECONDS:
            remaining = int(COOLDOWN_SECONDS - (now - last_signal))
            return {"decision": "HOLD", "status": f"cooldown_{remaining}s"}

        # Build market data for risk manager
        market_data = {
            "atr": indicators.get("atr", 0),
            "atr_percent": indicators.get("atr_percent", indicators.get("atr_pct", 0)),
            "volatility": indicators.get("bb_width_pct", 50),
            "volume_ratio": indicators.get("volume_ratio", 1),
        }

        # Use comprehensive risk check
        risk_result = await risk_gate.check_risk(signal, market_data)

        if risk_result["approved"]:
            # Record cooldown timestamp
            _signal_cooldown[cooldown_key] = now

            # Apply any adjustments from risk manager
            adjustments = risk_result.get("adjustments", {})
            if adjustments:
                # Update signal with risk-adjusted values
                if "stop_loss" in adjustments:
                    signal["stop_loss"] = adjustments["stop_loss"]
                if "take_profit" in adjustments:
                    signal["target_price"] = adjustments["take_profit"]
                if "position_size" in adjustments:
                    signal["position_size"] = adjustments["position_size"]

            return {
                "decision": signal['action'],
                "signal": signal,
                "status": "risk_approved",
                "risk_adjustments": adjustments,
                "risk_warnings": risk_result.get("warnings", [])
            }
        else:
            return {
                "decision": "HOLD",
                "status": "risk_rejected",
                "risk_reason": risk_result.get("reason", "Unknown")
            }

    async def execute_order(self, state: TankState) -> TankState:
        # In Glass Tank architecture, we don't execute immediately.
        # We Request Approval via Redis.
        redis_ok = False
        for attempt in range(3):
            try:
                await state_manager.request_approval(state['signal'])
                redis_ok = True
                break
            except Exception as e:
                print(f"[{self.name}] Redis push attempt {attempt+1}/3 failed: {e}")
                if attempt < 2:
                    await asyncio.sleep(1)

        if not redis_ok:
            print(f"[{self.name}] WARNING: Signal NOT queued in Redis after 3 attempts")

        # Also persist signal to Postgres via Next.js API
        await self._persist_signal(state)

        return {"status": "pending_approval" if redis_ok else "redis_failed"}

    async def _persist_signal(self, state: TankState):
        """Persist signal to Postgres via Next.js /api/signals"""
        signal = state.get("signal", {})
        if not signal:
            return

        try:
            payload = {
                "symbol": signal.get("symbol", state.get("symbol", "")),
                "action": signal.get("action", "HOLD"),
                "confidence": str(signal.get("confidence", 0)),
                "pattern": ", ".join(signal.get("patterns", [])) if signal.get("patterns") else signal.get("pattern", ""),
                "reasoning": signal.get("reason", ""),
                "entryPrice": str(signal.get("entry_price", 0)),
                "targetPrice": str(signal.get("target_price", 0)),
                "stopLoss": str(signal.get("stop_loss", 0)),
                "timeframe": "15m",
                "agentId": self.name,
                "executed": False,
            }

            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(f"{NEXTJS_API_URL}/api/signals", json=payload)
                if resp.status_code == 200:
                    print(f"[{self.name}] Signal persisted to DB")
                else:
                    print(f"[{self.name}] Failed to persist signal: {resp.status_code}")
        except Exception as e:
            # Non-critical - don't break the pipeline if DB save fails
            print(f"[{self.name}] Signal persist error (non-critical): {e}")

    async def run_loop(self):
        """Continuous execution loop."""
        while True:
            await state_manager.set_agent_status(self.name, "active", {"message": "Starting cycle"})
            for symbol in self.symbols:
                initial_state = {"symbol": symbol, "status": "starting"}
                async for output in self.runnable.astream(initial_state):
                    # Report status at each step
                    step_status = output.get("status", "processing")
                    await state_manager.set_agent_status(self.name, "active", {
                        "symbol": symbol,
                        "step": step_status,
                        "data": output
                    })
            await asyncio.sleep(10)  # Rate limit
