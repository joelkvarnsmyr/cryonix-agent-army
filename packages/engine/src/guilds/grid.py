"""
Grid Guild - Micro-Grid Trading State Manager
Manages grid configurations and checks for price triggers at grid levels.
Designed for micro-budget accounts (2-3 levels max).
"""
import json
import time
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field


@dataclass
class GridLevel:
    """A single grid buy level"""
    price: float
    tp_target: float
    filled: bool = False
    filled_at: Optional[str] = None


@dataclass
class GridConfig:
    """Grid configuration for a symbol"""
    symbol: str
    lower_bound: float
    upper_bound: float
    levels: List[GridLevel] = field(default_factory=list)
    order_size_usd: float = 6.0
    status: str = "active"  # active, completed, cancelled
    reasoning: str = ""
    created_at: str = ""
    expires_at: str = ""


class GridGuild:
    """
    Manages grid trading state and checks for price triggers.

    Flow:
    1. Grid config is created via /api/grid-config (LLM sets ranges)
    2. During each scan cycle, GridGuild checks if price hit any unfilled level
    3. If triggered, generates a GRID_BUY signal pushed to Redis
    4. Auto-trader executes the buy, marks level as filled
    5. Exit via normal TP/trailing stop mechanism
    """

    # Price proximity threshold: trigger buy when within 0.15% of grid level
    TRIGGER_PROXIMITY_PCT = 0.0015

    # Maximum age for a grid config before auto-cancel (hours)
    MAX_GRID_AGE_HOURS = 48

    def __init__(self, redis_client=None):
        self.redis = redis_client

    async def check_grid_triggers(
        self,
        symbol: str,
        current_price: float,
    ) -> Optional[Dict[str, Any]]:
        """
        Check if current price hit any unfilled grid buy level.
        Returns a GRID_BUY signal dict if triggered, None otherwise.
        """
        if not self.redis:
            return None

        config = await self._get_config(symbol)
        if not config or config.status != "active":
            return None

        # Check expiry
        if config.expires_at:
            try:
                from datetime import datetime
                if datetime.fromisoformat(config.expires_at.replace('Z', '+00:00')) < datetime.now(tz=__import__('datetime').timezone.utc):
                    config.status = "cancelled"
                    await self._save_config(symbol, config)
                    print(f"[GridGuild] {symbol} grid expired, cancelling")
                    return None
            except Exception:
                pass

        # Check if price broke below lower bound (stop loss for grid)
        if current_price < config.lower_bound * 0.97:  # 3% below lower bound
            config.status = "cancelled"
            await self._save_config(symbol, config)
            print(f"[GridGuild] {symbol} broke below grid range (${current_price:.2f} < ${config.lower_bound:.2f}), cancelling")
            return None

        # Check each unfilled level
        for i, level in enumerate(config.levels):
            if level.filled:
                continue

            # Check if price is within proximity of this level
            distance_pct = abs(current_price - level.price) / level.price
            is_below = current_price <= level.price

            if is_below or distance_pct <= self.TRIGGER_PROXIMITY_PCT:
                print(f"[GridGuild] {symbol} GRID TRIGGER: price ${current_price:.2f} hit level #{i} (${level.price:.2f})")

                # Generate GRID_BUY signal
                return {
                    "symbol": symbol,
                    "action": "BUY",
                    "confidence": 0.80,  # Grid buys have fixed confidence
                    "reason": f"Grid buy level #{i}: ${level.price:.2f} (range ${config.lower_bound:.2f}-${config.upper_bound:.2f})",
                    "patterns": ["GRID_BUY"],
                    "entry_price": current_price,
                    "stop_loss": config.lower_bound * 0.97,  # 3% below grid floor
                    "target_price": level.tp_target,
                    "indicators": {
                        "grid_level": i,
                        "grid_price": level.price,
                        "grid_tp": level.tp_target,
                        "grid_lower": config.lower_bound,
                        "grid_upper": config.upper_bound,
                    },
                    "is_grid_buy": True,
                    "position_size": config.order_size_usd / current_price,
                }

        # Check if all levels are filled -> grid complete
        if all(level.filled for level in config.levels):
            config.status = "completed"
            await self._save_config(symbol, config)
            print(f"[GridGuild] {symbol} grid completed - all levels filled")

        return None

    async def mark_level_filled(self, symbol: str, level_index: int) -> bool:
        """Mark a grid level as filled after execution."""
        config = await self._get_config(symbol)
        if not config or level_index >= len(config.levels):
            return False

        config.levels[level_index].filled = True
        config.levels[level_index].filled_at = __import__('datetime').datetime.now().isoformat()
        await self._save_config(symbol, config)

        print(f"[GridGuild] {symbol} level #{level_index} marked as filled")
        return True

    async def get_active_grids(self) -> List[str]:
        """Get list of symbols with active grids."""
        if not self.redis:
            return []
        raw = await self.redis.get('grid:active')
        if not raw:
            return []
        try:
            return json.loads(raw)
        except Exception:
            return []

    async def _get_config(self, symbol: str) -> Optional[GridConfig]:
        """Load grid config from Redis."""
        if not self.redis:
            return None
        raw = await self.redis.get(f'grid:config:{symbol}')
        if not raw:
            return None
        try:
            data = json.loads(raw)
            levels = [
                GridLevel(
                    price=l if isinstance(l, (int, float)) else l.get('price', 0),
                    tp_target=t if isinstance(t, (int, float)) else l.get('tp_target', 0),
                    filled=False,
                )
                for l, t in zip(
                    data.get('buyLevels', []),
                    data.get('tpTargets', [])
                )
            ]
            # Restore filled state if present
            for i, fl in enumerate(data.get('filledLevels', [])):
                if isinstance(fl, int) and fl < len(levels):
                    levels[fl].filled = True

            return GridConfig(
                symbol=data.get('symbol', symbol),
                lower_bound=data.get('lowerBound', 0),
                upper_bound=data.get('upperBound', 0),
                levels=levels,
                order_size_usd=data.get('orderSizeUsd', 6.0),
                status=data.get('status', 'active'),
                reasoning=data.get('reasoning', ''),
                created_at=data.get('createdAt', ''),
                expires_at=data.get('expiresAt', ''),
            )
        except Exception as e:
            print(f"[GridGuild] Error parsing config for {symbol}: {e}")
            return None

    async def _save_config(self, symbol: str, config: GridConfig) -> None:
        """Save grid config back to Redis."""
        if not self.redis:
            return
        filled_indices = [i for i, l in enumerate(config.levels) if l.filled]
        data = {
            "symbol": config.symbol,
            "lowerBound": config.lower_bound,
            "upperBound": config.upper_bound,
            "buyLevels": [l.price for l in config.levels],
            "tpTargets": [l.tp_target for l in config.levels],
            "orderSizeUsd": config.order_size_usd,
            "status": config.status,
            "filledLevels": filled_indices,
            "reasoning": config.reasoning,
            "createdAt": config.created_at,
            "expiresAt": config.expires_at,
        }
        await self.redis.set(f'grid:config:{symbol}', json.dumps(data))

        # Update active grids list
        active = await self.get_active_grids()
        if config.status == 'active' and symbol not in active:
            active.append(symbol)
        elif config.status != 'active' and symbol in active:
            active.remove(symbol)
        await self.redis.set('grid:active', json.dumps(active))
