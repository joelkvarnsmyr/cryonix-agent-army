import json
import redis.asyncio as redis
from typing import Optional, Dict, Any
from src.core.config import settings

class StateManager:
    """
    Manages shared state between the Python Engine (Brain) and Next.js (Face).
    Uses Redis as the 'Whiteboard'.
    """
    
    def __init__(self):
        self.redis = redis.from_url(settings.KV_URL, decode_responses=True)
        
    async def set_agent_status(self, agent_id: str, status: str, details: Dict[str, Any] = None):
        """Update heartbeat and status for an agent."""
        key = f"agent:{agent_id}:status"
        payload = {
            "status": status,
            "last_active": "NOW",  # TODO: Timestamp
            "details": details or {}
        }
        await self.redis.set(key, json.dumps(payload))
        
    async def get_pending_approvals(self) -> list:
        """Fetch trades waiting for user approval."""
        # Simple list implementation for now
        return await self.redis.lrange("trades:pending", 0, -1)
        
    async def request_approval(self, signal: Dict[str, Any]):
        """Push a trade to the approval queue."""
        await self.redis.rpush("trades:pending", json.dumps(signal))
        
    async def close(self):
        await self.redis.close()

state_manager = StateManager()
