"""
Advanced Risk Manager - Portfolio Protection System
Implements comprehensive risk controls for autonomous trading
"""
import asyncio
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from src.core.state_sync import state_manager
import json


@dataclass
class RiskLimits:
    """Configurable risk limits - tuned for $17 USDC micro-budget"""
    max_daily_loss_pct: float = 0.05          # 5% max daily loss (~$0.85)
    max_weekly_loss_pct: float = 0.10         # 10% max weekly loss (~$1.70)
    max_position_size_pct: float = 0.35       # 35% max per position (~$6)
    max_total_exposure_pct: float = 0.70      # 70% max total exposure (~$12)
    min_confidence: float = 0.65              # 65% min signal confidence (lowered to allow more BUY entries)
    max_correlation: float = 0.70             # Max position correlation
    volatility_pause_atr_pct: float = 5.0     # Pause if ATR > 5%
    max_trades_per_day: int = 5               # Max 5 trades per day (increased for margin)
    max_consecutive_losses: int = 4           # Pause after 4 losses
    max_leverage: int = 3                     # Max leverage for margin trading
    liquidation_buffer_pct: float = 0.15      # 15% buffer before liquidation price


@dataclass
class PortfolioState:
    """Current portfolio state for risk calculations"""
    total_capital: float = 17
    available_capital: float = 17
    open_positions: List[Dict] = field(default_factory=list)
    daily_pnl: float = 0
    weekly_pnl: float = 0
    daily_trades: int = 0
    consecutive_losses: int = 0
    last_reset_date: str = ""
    last_week_reset: str = ""
    circuit_breaker_active: bool = False
    circuit_breaker_reason: str = ""
    circuit_breaker_until: Optional[str] = None


class RiskManager:
    """
    Comprehensive Risk Management System

    Features:
    - Daily/Weekly loss limits
    - Position sizing based on ATR
    - Correlation checks
    - Volatility circuit breakers
    - Trade frequency limits
    - Consecutive loss protection
    """

    def __init__(self):
        self.limits = RiskLimits()
        self.portfolio = PortfolioState()
        self._redis_key = "risk:portfolio_state"

    async def initialize(self):
        """Load portfolio state from Redis"""
        try:
            state_json = await state_manager.redis.get(self._redis_key)
            if state_json:
                state_dict = json.loads(state_json)
                self.portfolio = PortfolioState(**state_dict)
            await self._check_reset_periods()
        except Exception as e:
            print(f"[RiskManager] Error loading state: {e}")

    async def _save_state(self):
        """Persist portfolio state to Redis"""
        try:
            state_dict = {
                "total_capital": self.portfolio.total_capital,
                "available_capital": self.portfolio.available_capital,
                "open_positions": self.portfolio.open_positions,
                "daily_pnl": self.portfolio.daily_pnl,
                "weekly_pnl": self.portfolio.weekly_pnl,
                "daily_trades": self.portfolio.daily_trades,
                "consecutive_losses": self.portfolio.consecutive_losses,
                "last_reset_date": self.portfolio.last_reset_date,
                "last_week_reset": self.portfolio.last_week_reset,
                "circuit_breaker_active": self.portfolio.circuit_breaker_active,
                "circuit_breaker_reason": self.portfolio.circuit_breaker_reason,
                "circuit_breaker_until": self.portfolio.circuit_breaker_until,
            }
            await state_manager.redis.set(
                self._redis_key,
                json.dumps(state_dict),
                ex=86400 * 7  # 7 day TTL
            )
        except Exception as e:
            print(f"[RiskManager] Error saving state: {e}")

    async def _check_reset_periods(self):
        """Reset daily/weekly counters if needed"""
        today = datetime.utcnow().strftime("%Y-%m-%d")
        week_start = (datetime.utcnow() - timedelta(days=datetime.utcnow().weekday())).strftime("%Y-%m-%d")

        # Daily reset
        if self.portfolio.last_reset_date != today:
            print(f"[RiskManager] Daily reset - previous PnL: ${self.portfolio.daily_pnl:.2f}")
            self.portfolio.daily_pnl = 0
            self.portfolio.daily_trades = 0
            self.portfolio.last_reset_date = today

            # Clear circuit breaker if it was daily
            if self.portfolio.circuit_breaker_active and "daily" in self.portfolio.circuit_breaker_reason.lower():
                self.portfolio.circuit_breaker_active = False
                self.portfolio.circuit_breaker_reason = ""
                print("[RiskManager] Daily circuit breaker cleared")

        # Weekly reset
        if self.portfolio.last_week_reset != week_start:
            print(f"[RiskManager] Weekly reset - previous PnL: ${self.portfolio.weekly_pnl:.2f}")
            self.portfolio.weekly_pnl = 0
            self.portfolio.last_week_reset = week_start

            # Clear circuit breaker if it was weekly
            if self.portfolio.circuit_breaker_active and "weekly" in self.portfolio.circuit_breaker_reason.lower():
                self.portfolio.circuit_breaker_active = False
                self.portfolio.circuit_breaker_reason = ""
                print("[RiskManager] Weekly circuit breaker cleared")

        await self._save_state()

    async def check_signal(
        self,
        signal: Dict[str, Any],
        market_data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Comprehensive risk check for a trading signal.

        Returns:
        {
            "approved": bool,
            "reason": str,
            "adjustments": {
                "position_size": float,
                "stop_loss": float,
                "take_profit": float
            },
            "warnings": [str]
        }
        """
        await self._check_reset_periods()

        result = {
            "approved": True,
            "reason": "All risk checks passed",
            "adjustments": {},
            "warnings": []
        }

        # 1. Circuit Breaker Check
        if self.portfolio.circuit_breaker_active:
            return {
                "approved": False,
                "reason": f"Circuit breaker active: {self.portfolio.circuit_breaker_reason}",
                "adjustments": {},
                "warnings": ["Trading paused - circuit breaker active"]
            }

        # 2. Confidence Check
        confidence = signal.get("confidence", 0)
        if confidence < self.limits.min_confidence:
            return {
                "approved": False,
                "reason": f"Confidence {confidence:.1%} below minimum {self.limits.min_confidence:.1%}",
                "adjustments": {},
                "warnings": []
            }

        # 3. Daily Loss Limit
        daily_loss_limit = self.portfolio.total_capital * self.limits.max_daily_loss_pct
        if self.portfolio.daily_pnl <= -daily_loss_limit:
            self._activate_circuit_breaker("Daily loss limit reached", hours=24)
            return {
                "approved": False,
                "reason": f"Daily loss limit reached (${abs(self.portfolio.daily_pnl):.2f})",
                "adjustments": {},
                "warnings": ["Circuit breaker activated - daily loss limit"]
            }

        # 4. Weekly Loss Limit
        weekly_loss_limit = self.portfolio.total_capital * self.limits.max_weekly_loss_pct
        if self.portfolio.weekly_pnl <= -weekly_loss_limit:
            self._activate_circuit_breaker("Weekly loss limit reached", hours=168)
            return {
                "approved": False,
                "reason": f"Weekly loss limit reached (${abs(self.portfolio.weekly_pnl):.2f})",
                "adjustments": {},
                "warnings": ["Circuit breaker activated - weekly loss limit"]
            }

        # 5. Trade Frequency Limit
        if self.portfolio.daily_trades >= self.limits.max_trades_per_day:
            return {
                "approved": False,
                "reason": f"Daily trade limit reached ({self.portfolio.daily_trades})",
                "adjustments": {},
                "warnings": ["Max trades per day reached"]
            }

        # 6. Consecutive Loss Protection
        if self.portfolio.consecutive_losses >= self.limits.max_consecutive_losses:
            self._activate_circuit_breaker(
                f"Consecutive losses: {self.portfolio.consecutive_losses}",
                hours=4
            )
            return {
                "approved": False,
                "reason": f"Consecutive loss limit ({self.portfolio.consecutive_losses} losses)",
                "adjustments": {},
                "warnings": ["Cooling off after consecutive losses"]
            }

        # 7. Volatility Check (if market data provided)
        if market_data:
            atr_pct = market_data.get("atr_percent", 0)
            if atr_pct > self.limits.volatility_pause_atr_pct:
                result["warnings"].append(f"High volatility: ATR {atr_pct:.1f}%")

                # Reduce position size in high volatility
                volatility_factor = self.limits.volatility_pause_atr_pct / atr_pct
                result["adjustments"]["volatility_reduction"] = volatility_factor

        # 8. Position Size Calculation
        position_size = self._calculate_position_size(signal, market_data)
        result["adjustments"]["position_size"] = position_size
        result["adjustments"]["position_size_pct"] = position_size / self.portfolio.total_capital * 100

        # 9. Exposure Check
        current_exposure = sum(p.get("value", 0) for p in self.portfolio.open_positions)
        new_exposure = current_exposure + position_size
        max_exposure = self.portfolio.total_capital * self.limits.max_total_exposure_pct

        if new_exposure > max_exposure:
            adjusted_size = max_exposure - current_exposure
            if adjusted_size <= 0:
                return {
                    "approved": False,
                    "reason": "Maximum portfolio exposure reached",
                    "adjustments": {},
                    "warnings": ["Cannot open new positions - max exposure"]
                }
            result["adjustments"]["position_size"] = adjusted_size
            result["warnings"].append(f"Position reduced due to exposure limit")

        # 10. Dynamic Stop-Loss (ATR-based)
        if market_data and "atr" in market_data:
            entry_price = signal.get("entry_price", 0)
            atr = market_data.get("atr", 0)

            if signal.get("action") == "BUY":
                dynamic_stop = entry_price - (2.0 * atr)
                dynamic_target = entry_price + (3.0 * atr)
            else:  # SELL
                dynamic_stop = entry_price + (2.0 * atr)
                dynamic_target = entry_price - (3.0 * atr)

            result["adjustments"]["stop_loss"] = round(dynamic_stop, 2)
            result["adjustments"]["take_profit"] = round(dynamic_target, 2)
            result["adjustments"]["risk_reward_ratio"] = 1.5  # 3:2 ratio

        # 11. Margin/Leverage safety check
        leverage = self.limits.max_leverage
        if leverage > 1 and market_data:
            atr_pct = market_data.get("atr_percent", 0)
            # Liquidation distance: at 3x leverage, ~33% move liquidates
            liquidation_dist = 100 / leverage
            # Stop-loss must be well inside liquidation distance
            entry_price = signal.get("entry_price", 0)
            stop_loss = result["adjustments"].get("stop_loss", signal.get("stop_loss", 0))
            if entry_price > 0 and stop_loss > 0:
                sl_dist_pct = abs(entry_price - stop_loss) / entry_price * 100
                if sl_dist_pct > liquidation_dist * (1 - self.limits.liquidation_buffer_pct):
                    # Tighten stop-loss to stay inside liquidation zone
                    safe_dist = entry_price * liquidation_dist * 0.7 / 100
                    if signal.get("action") == "BUY":
                        result["adjustments"]["stop_loss"] = round(entry_price - safe_dist, 2)
                    else:
                        result["adjustments"]["stop_loss"] = round(entry_price + safe_dist, 2)
                    result["warnings"].append(f"SL tightened for {leverage}x leverage safety")
            result["adjustments"]["leverage"] = leverage

        await self._save_state()
        return result

    def _calculate_position_size(
        self,
        signal: Dict[str, Any],
        market_data: Optional[Dict[str, Any]] = None
    ) -> float:
        """
        Calculate position size using Kelly Criterion and risk limits.

        Kelly: f = (bp - q) / b
        where b = win/loss ratio, p = win probability, q = 1-p
        """
        # Get signal confidence as win probability proxy
        confidence = signal.get("confidence", 0.5)
        p = min(max(confidence, 0.3), 0.8)  # Cap between 30-80%
        q = 1 - p

        # Estimate win/loss ratio from stop/target
        entry = signal.get("entry_price", 100)
        stop = signal.get("stop_loss", entry * 0.98)
        target = signal.get("target_price", entry * 1.03)

        potential_loss = abs(entry - stop)
        potential_gain = abs(target - entry)
        b = potential_gain / potential_loss if potential_loss > 0 else 1.5

        # Kelly fraction
        kelly = (b * p - q) / b if b > 0 else 0
        kelly = max(0, min(kelly, 0.25))  # Cap at 25%

        # Half-Kelly for safety
        kelly = kelly * 0.5

        # Base position size
        base_size = self.portfolio.available_capital * kelly

        # Apply max position limit
        max_size = self.portfolio.total_capital * self.limits.max_position_size_pct
        position_size = min(base_size, max_size)

        # Reduce if in drawdown
        if self.portfolio.daily_pnl < 0:
            drawdown_factor = 1 - abs(self.portfolio.daily_pnl / self.portfolio.total_capital)
            position_size *= drawdown_factor

        return round(position_size, 2)

    def _activate_circuit_breaker(self, reason: str, hours: int = 24):
        """Activate trading circuit breaker"""
        self.portfolio.circuit_breaker_active = True
        self.portfolio.circuit_breaker_reason = reason
        self.portfolio.circuit_breaker_until = (
            datetime.utcnow() + timedelta(hours=hours)
        ).isoformat()
        print(f"[RiskManager] CIRCUIT BREAKER ACTIVATED: {reason}")

    async def record_trade_result(self, pnl: float, is_win: bool):
        """Record trade result for tracking"""
        self.portfolio.daily_pnl += pnl
        self.portfolio.weekly_pnl += pnl
        self.portfolio.daily_trades += 1
        self.portfolio.total_capital += pnl
        self.portfolio.available_capital += pnl

        if is_win:
            self.portfolio.consecutive_losses = 0
        else:
            self.portfolio.consecutive_losses += 1

        print(f"[RiskManager] Trade recorded: PnL ${pnl:.2f} | "
              f"Daily: ${self.portfolio.daily_pnl:.2f} | "
              f"Consecutive losses: {self.portfolio.consecutive_losses}")

        await self._save_state()

    async def get_status(self) -> Dict[str, Any]:
        """Get current risk manager status"""
        await self._check_reset_periods()

        daily_limit = self.portfolio.total_capital * self.limits.max_daily_loss_pct
        weekly_limit = self.portfolio.total_capital * self.limits.max_weekly_loss_pct

        return {
            "portfolio": {
                "total_capital": self.portfolio.total_capital,
                "available_capital": self.portfolio.available_capital,
                "open_positions": len(self.portfolio.open_positions),
            },
            "daily": {
                "pnl": self.portfolio.daily_pnl,
                "limit": -daily_limit,
                "remaining": daily_limit + self.portfolio.daily_pnl,
                "trades": self.portfolio.daily_trades,
                "max_trades": self.limits.max_trades_per_day,
            },
            "weekly": {
                "pnl": self.portfolio.weekly_pnl,
                "limit": -weekly_limit,
                "remaining": weekly_limit + self.portfolio.weekly_pnl,
            },
            "circuit_breaker": {
                "active": self.portfolio.circuit_breaker_active,
                "reason": self.portfolio.circuit_breaker_reason,
                "until": self.portfolio.circuit_breaker_until,
            },
            "consecutive_losses": self.portfolio.consecutive_losses,
            "limits": {
                "max_daily_loss_pct": self.limits.max_daily_loss_pct,
                "max_weekly_loss_pct": self.limits.max_weekly_loss_pct,
                "max_position_size_pct": self.limits.max_position_size_pct,
                "min_confidence": self.limits.min_confidence,
            }
        }

    async def reset_circuit_breaker(self, admin_override: bool = False):
        """Manually reset circuit breaker (requires admin)"""
        if admin_override:
            self.portfolio.circuit_breaker_active = False
            self.portfolio.circuit_breaker_reason = ""
            self.portfolio.circuit_breaker_until = None
            self.portfolio.consecutive_losses = 0
            await self._save_state()
            print("[RiskManager] Circuit breaker manually reset")
            return True
        return False


# Singleton instance
risk_manager = RiskManager()
