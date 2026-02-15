from typing import Dict, Any, Optional
from src.core.state_sync import state_manager
from src.core.risk_manager import risk_manager


class RiskGate:
    """
    Mandatory middleware that validates EVERY trade signal.
    Uses the comprehensive RiskManager for all checks.
    """

    def __init__(self):
        self.manager = risk_manager

    async def check_risk(
        self,
        signal: Dict[str, Any],
        market_data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Comprehensive risk check using RiskManager.

        Returns dict with:
        - approved: bool
        - reason: str
        - adjustments: position size, stops, etc
        - warnings: list of warnings
        """
        # Initialize manager state from Redis
        await self.manager.initialize()

        # Run comprehensive check
        result = await self.manager.check_signal(signal, market_data)

        # Log result
        if result["approved"]:
            print(f"[RiskGate] APPROVED: {signal.get('symbol')} {signal.get('action')} "
                  f"@ {signal.get('confidence', 0):.1%} confidence")
            if result.get("warnings"):
                for w in result["warnings"]:
                    print(f"[RiskGate] Warning: {w}")
        else:
            print(f"[RiskGate] REJECTED: {result['reason']}")

        return result

    async def check_risk_simple(
        self,
        signal: Dict[str, Any],
        portfolio_state: Dict[str, Any]
    ) -> bool:
        """
        Simple boolean check for backwards compatibility.
        Returns True if approved, False if rejected.
        """
        result = await self.check_risk(signal, portfolio_state)
        return result["approved"]

    async def get_status(self) -> Dict[str, Any]:
        """Get current risk manager status"""
        return await self.manager.get_status()

    async def record_trade(self, pnl: float, is_win: bool):
        """Record completed trade for tracking"""
        await self.manager.record_trade_result(pnl, is_win)

    async def reset_circuit_breaker(self):
        """Admin reset of circuit breaker"""
        return await self.manager.reset_circuit_breaker(admin_override=True)


risk_gate = RiskGate()
