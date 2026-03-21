from fastapi import APIRouter, HTTPException, BackgroundTasks, Query
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from src.models.analysis import AnalysisRequest, AnalysisResponse
from src.core.state_sync import state_manager
from src.backtest.engine import backtest_engine
import json
import asyncio
from datetime import datetime, timedelta, timezone

api_router = APIRouter()

# Store backtest results in memory (for demo - production would use DB)
_backtest_results: Dict[str, Any] = {}
_backtest_status: Dict[str, str] = {}


class BacktestRequest(BaseModel):
    symbol: str = "BTC/USDT"
    timeframe: str = "1h"
    days: int = 30
    min_confidence: float = 0.75
    initial_capital: float = 10000

@api_router.get("/health")
async def health_check():
    """Health check endpoint for monitoring."""
    return {
        "status": "healthy",
        "service": "cryonix-engine",
        "version": "1.0.0"
    }

@api_router.get("/tanks/status")
async def get_tanks_status():
    """Get status of all active tanks from Redis."""
    try:
        # Get MarketScout status from Redis
        scout_status = await state_manager.redis.get("agent:MarketScout:status")
        if scout_status:
            scout_data = json.loads(scout_status)
        else:
            scout_data = {"status": "offline", "details": {}}
        
        return {
            "tanks": {
                "MarketScout": scout_data
            },
            "engine_status": "online"
        }
    except Exception as e:
        return {
            "tanks": {},
            "engine_status": "error",
            "error": str(e)
        }

@api_router.get("/tanks/pending")
async def get_pending_approvals():
    """Get pending trade approvals from the queue."""
    try:
        pending = await state_manager.get_pending_approvals()
        trades = [json.loads(t) for t in pending] if pending else []
        return {"pending_trades": trades, "count": len(trades)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/analyze", response_model=AnalysisResponse)
async def analyze_signal(request: AnalysisRequest):
    """
    Analyze a trading signal using the Guilds.
    Currently a mock implementation until Guilds are fully integrated.
    """
    try:
        # Placeholder for Guild logic
        # TODO: Route to appropriate Guilds (Oracle, Scribe, Quant) based on strategy

        return AnalysisResponse(
            signal="HOLD",
            confidence=0.5,
            reasoning=[
                "Python Intelligence Layer is online",
                f"Received request for {request.symbol}",
                "Guilds are not yet fully active"
            ],
            risks=["System in initialization phase"]
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============ BACKTEST ENDPOINTS ============

def _run_backtest_sync(backtest_id: str, request: BacktestRequest):
    """Run backtest synchronously (for background task)"""
    try:
        _backtest_status[backtest_id] = "running"

        backtest_engine.initial_capital = request.initial_capital
        result = backtest_engine.run_backtest(
            symbol=request.symbol,
            timeframe=request.timeframe,
            days=request.days,
            min_confidence=request.min_confidence
        )

        # Convert to dict for JSON serialization
        _backtest_results[backtest_id] = {
            "symbol": result.symbol,
            "timeframe": result.timeframe,
            "start_date": result.start_date,
            "end_date": result.end_date,
            "initial_capital": result.initial_capital,
            "final_capital": result.final_capital,
            "total_return": result.total_return,
            "total_return_pct": result.total_return_pct,
            "total_trades": result.total_trades,
            "winning_trades": result.winning_trades,
            "losing_trades": result.losing_trades,
            "win_rate": result.win_rate,
            "avg_win": result.avg_win,
            "avg_loss": result.avg_loss,
            "profit_factor": result.profit_factor,
            "max_drawdown": result.max_drawdown,
            "max_drawdown_pct": result.max_drawdown_pct,
            "sharpe_ratio": result.sharpe_ratio,
            "sortino_ratio": result.sortino_ratio,
            "calmar_ratio": result.calmar_ratio,
            "avg_trade_duration": result.avg_trade_duration,
            "equity_curve": result.equity_curve[-100:] if result.equity_curve else [],  # Last 100 points
            "trades": [
                {
                    "symbol": t.symbol,
                    "side": t.side,
                    "entry_time": t.entry_time.isoformat() if t.entry_time else None,
                    "entry_price": t.entry_price,
                    "exit_time": t.exit_time.isoformat() if t.exit_time else None,
                    "exit_price": t.exit_price,
                    "pnl": t.pnl,
                    "pnl_percent": t.pnl_percent,
                    "exit_reason": t.exit_reason
                }
                for t in result.trades[-50:]  # Last 50 trades
            ],
            "assessment": {
                "sharpe_pass": result.sharpe_ratio >= 1.0,
                "win_rate_pass": result.win_rate >= 55,
                "drawdown_pass": result.max_drawdown_pct <= 20,
                "profit_factor_pass": result.profit_factor >= 1.5,
                "production_ready": (
                    result.sharpe_ratio >= 1.0 and
                    result.win_rate >= 55 and
                    result.max_drawdown_pct <= 20 and
                    result.profit_factor >= 1.5
                )
            }
        }
        _backtest_status[backtest_id] = "completed"

    except Exception as e:
        _backtest_status[backtest_id] = f"error: {str(e)}"
        _backtest_results[backtest_id] = {"error": str(e)}


@api_router.post("/backtest/run")
async def run_backtest(request: BacktestRequest, background_tasks: BackgroundTasks):
    """
    Start a backtest in the background.
    Returns a backtest_id to check status/results.
    """
    import uuid
    backtest_id = str(uuid.uuid4())[:8]

    _backtest_status[backtest_id] = "queued"

    # Run in background
    background_tasks.add_task(_run_backtest_sync, backtest_id, request)

    return {
        "backtest_id": backtest_id,
        "status": "queued",
        "message": f"Backtest started for {request.symbol} ({request.timeframe}, {request.days} days)",
        "check_status": f"/backtest/status/{backtest_id}",
        "get_results": f"/backtest/results/{backtest_id}"
    }


@api_router.get("/backtest/status/{backtest_id}")
async def get_backtest_status(backtest_id: str):
    """Get status of a running backtest"""
    status = _backtest_status.get(backtest_id, "not_found")
    return {"backtest_id": backtest_id, "status": status}


@api_router.get("/backtest/results/{backtest_id}")
async def get_backtest_results(backtest_id: str):
    """Get results of a completed backtest"""
    if backtest_id not in _backtest_results:
        raise HTTPException(status_code=404, detail="Backtest not found or not completed")

    return {
        "backtest_id": backtest_id,
        "status": _backtest_status.get(backtest_id, "unknown"),
        "results": _backtest_results[backtest_id]
    }


@api_router.get("/backtest/quick")
async def quick_backtest(
    symbol: str = "BTC/USDT",
    timeframe: str = "1h",
    days: int = 30
):
    """
    Run a quick backtest and return results immediately.
    For longer backtests, use POST /backtest/run instead.

    Example: /backtest/quick?symbol=BTC/USDT&timeframe=1h&days=30
    """
    try:
        result = backtest_engine.run_backtest(
            symbol=symbol,
            timeframe=timeframe,
            days=min(days, 30),  # Limit to 30 days for quick test
            min_confidence=0.75
        )

        return {
            "symbol": result.symbol,
            "timeframe": result.timeframe,
            "period": f"{result.start_date[:10]} to {result.end_date[:10]}",
            "total_return_pct": round(result.total_return_pct, 2),
            "total_trades": result.total_trades,
            "win_rate": round(result.win_rate, 1),
            "sharpe_ratio": round(result.sharpe_ratio, 2),
            "max_drawdown_pct": round(result.max_drawdown_pct, 1),
            "profit_factor": round(result.profit_factor, 2),
            "production_ready": (
                result.sharpe_ratio >= 1.0 and
                result.win_rate >= 55 and
                result.max_drawdown_pct <= 20
            )
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/backtest/list")
async def list_backtests():
    """List all backtest results"""
    return {
        "backtests": [
            {
                "id": bid,
                "status": _backtest_status.get(bid, "unknown"),
                "symbol": _backtest_results.get(bid, {}).get("symbol"),
                "total_return_pct": _backtest_results.get(bid, {}).get("total_return_pct")
            }
            for bid in _backtest_results.keys()
        ]
    }


# ============ RISK MANAGEMENT ENDPOINTS ============

from src.core.risk_gate import risk_gate


@api_router.get("/risk/status")
async def get_risk_status():
    """Get current risk manager status including limits and circuit breaker state"""
    try:
        status = await risk_gate.get_status()
        return {"status": "ok", "risk": status}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@api_router.post("/risk/check")
async def check_signal_risk(signal: Dict[str, Any]):
    """
    Check if a signal passes risk requirements.
    Useful for testing risk logic without executing.
    """
    try:
        result = await risk_gate.check_risk(signal, signal.get("indicators"))
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/risk/record-trade")
async def record_trade(pnl: float, is_win: bool):
    """Record a completed trade result for risk tracking"""
    try:
        await risk_gate.record_trade(pnl, is_win)
        status = await risk_gate.get_status()
        return {
            "recorded": True,
            "pnl": pnl,
            "is_win": is_win,
            "daily_pnl": status["daily"]["pnl"],
            "consecutive_losses": status["consecutive_losses"]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/risk/reset-circuit-breaker")
async def reset_circuit_breaker():
    """Admin endpoint to reset circuit breaker"""
    try:
        result = await risk_gate.reset_circuit_breaker()
        return {"reset": result, "message": "Circuit breaker reset" if result else "Failed to reset"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============ VEDIC HISTORICAL ENDPOINTS ============

@api_router.get("/vedic/historical")
async def vedic_historical(
    symbol: str = "BTC",
    days: int = 365,
    interval: str = "daily",
):
    """Compute historical vedic scores for a symbol.

    interval: 'daily' (1 point/day) or 'weekly' (1 point/week).
    Returns arrays of {date, score, label, muhurta, nakshatra, tithi,
    paksha, mercury_rx, transit_score, lagna_sign, bhava_score, dasha_lord}.
    """
    from src.vedic.ephemeris import get_sky_state
    from src.vedic.scoring import compute_vedic_score, compute_symbol_transits
    from src.vedic.dasha import compute_dasha_for_symbol

    max_days = 730  # 2 years max
    days = min(days, max_days)

    step = timedelta(days=7) if interval == "weekly" else timedelta(days=1)
    now = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    start = now - timedelta(days=days)

    points = []
    cursor = start
    while cursor <= now:
        try:
            sky = get_sky_state(cursor)
            vs = compute_vedic_score(sky)
            ts = compute_symbol_transits([symbol.upper()], sky)
            sym_transit = ts.get(symbol.upper())
            ds = compute_dasha_for_symbol(symbol.upper(), cursor)

            points.append({
                "date": cursor.strftime("%Y-%m-%d"),
                "score": vs.overall_score,
                "label": vs.label,
                "muhurta": vs.muhurta_label,
                "muhurta_score": vs.muhurta_score,
                "nakshatra": vs.moon_nakshatra,
                "nakshatra_score": vs.nakshatra_score,
                "tithi": vs.tithi_name,
                "tithi_number": vs.tithi_number,
                "paksha": vs.lunar_paksha,
                "moon_phase": vs.moon_phase_pct,
                "mercury_rx": vs.is_mercury_retrograde,
                "aspect_score": vs.aspect_score,
                "retrogrades": vs.retrogrades,
                "transit_score": sym_transit.score if sym_transit else 0,
                "lagna_sign": sym_transit.lagna_sign if sym_transit else "",
                "bhava_score": sym_transit.bhava_score if sym_transit else 0.0,
                "dasha_lord": ds.maha_dasha_lord if ds else "",
                "dasha_bias": ds.combined_bias if ds else 0.0,
            })
        except Exception:
            pass

        cursor += step

    return {
        "symbol": symbol.upper(),
        "days": days,
        "interval": interval,
        "points": len(points),
        "data": points,
    }

