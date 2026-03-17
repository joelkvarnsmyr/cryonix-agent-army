"""
Vedic Futures Paper Trader — Short-term Bayesian-driven trading with LONG + SHORT.

Separate from vedic-trader.py. Uses Bayesian posterior for entry decisions
instead of V3 composite score — more responsive, trades more frequently.

Features:
  - LONG positions when Bayes P(up) > 60%
  - SHORT positions when Bayes P(up) < 40% (paper futures simulation)
  - Shorter hold times (SL=5%, TP=10%, trail 3%/1.5%)
  - Scans every 5 minutes
  - Bayesian self-learning: updates after every trade

Research basis:
  - Venus Rx SHORT: Sharpe 4.49, 96.4% WR (futures-validated)
  - Bayes posterior: combines 9 vedic signals with learned likelihood ratios
  - P(up) thresholds calibrated from 2000-day research

Redis keys:
  vedic_futures:wallet   — paper wallet (balance, long_positions, short_positions)
  vedic_futures:trades   — trade history
  vedic_futures:stats    — performance stats

Run: python scripts/services/vedic-futures-paper.py
"""
import asyncio
import json
import os
import sys
import time
import traceback
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import redis.asyncio as aioredis

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine'))

from src.vedic.ephemeris import get_sky_state
from src.vedic.scoring import compute_vedic_score
from src.vedic.natal import CRYPTO_GENESIS
from src.vedic.bayesian import BayesianVedic

# ── Configuration ─────────────────────────────────────────────────
INITIAL_BALANCE = 500.0
POSITION_SIZE_PCT = 0.15          # 15% per trade
MAX_POSITIONS = 4                 # 2 long + 2 short possible
SCAN_INTERVAL = 300               # 5 minutes
REDIS_TTL = 86400 * 30

# Entry thresholds (Bayesian probability)
LONG_THRESHOLD = 0.55             # P(up) > 55% → go long (V4 aligned)
SHORT_THRESHOLD = 0.40            # P(up) < 40% → go short
EXIT_NEUTRAL_ZONE = (0.45, 0.55)  # Close if signal fades to neutral

# Stop losses (tighter for short-term)
LONG_SL = 0.05                   # -5%
LONG_TP = 0.10                   # +10%
SHORT_SL = 0.05                  # -5% (price goes UP 5%)
SHORT_TP = 0.10                  # +10% (price goes DOWN 10%)
TRAILING_ACT = 0.03              # Activate at 3%
TRAILING_STOP = 0.015            # Trail at 1.5%

# Symbols to trade
SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "AVAX", "LTC"]
WATCHLIST = {sym: f"{sym}/USDC" for sym in SYMBOLS}


@dataclass
class FuturesWallet:
    balance: float = INITIAL_BALANCE
    positions: Dict = field(default_factory=dict)  # {symbol: position_dict}
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    long_wins: int = 0
    long_losses: int = 0
    short_wins: int = 0
    short_losses: int = 0
    created_at: float = field(default_factory=lambda: time.time())


class VedicFuturesPaper:
    def __init__(self):
        kv_url = os.getenv("KV_URL", "redis://localhost:6379")
        self.redis = aioredis.from_url(kv_url, decode_responses=True)
        self.name = "VedicFutures"
        self.wallet: Optional[FuturesWallet] = None
        self.bayes = BayesianVedic()
        self._bayes_loaded = False

    async def load_wallet(self):
        raw = await self.redis.get("vedic_futures:wallet")
        if raw:
            data = json.loads(raw)
            data.setdefault("positions", {})
            data.setdefault("long_wins", 0)
            data.setdefault("long_losses", 0)
            data.setdefault("short_wins", 0)
            data.setdefault("short_losses", 0)
            self.wallet = FuturesWallet(**data)
            n = len(self.wallet.positions)
            print(f"[{self.name}] Loaded wallet: ${self.wallet.balance:.2f} | "
                  f"Pos: {n} | Trades: {self.wallet.total_trades} | P&L: ${self.wallet.total_pnl:.2f}")
        else:
            self.wallet = FuturesWallet()
            await self.save_wallet()
            print(f"[{self.name}] Created new futures wallet: ${INITIAL_BALANCE:.2f}")

    async def save_wallet(self):
        await self.redis.set("vedic_futures:wallet", json.dumps(asdict(self.wallet)), ex=REDIS_TTL)

    async def log_trade(self, trade: dict):
        await self.redis.lpush("vedic_futures:trades", json.dumps(trade))
        await self.redis.ltrim("vedic_futures:trades", 0, 499)
        await self.redis.expire("vedic_futures:trades", REDIS_TTL)

    async def update_stats(self):
        if not self.wallet:
            return
        long_trades = self.wallet.long_wins + self.wallet.long_losses
        short_trades = self.wallet.short_wins + self.wallet.short_losses
        stats = {
            "balance": self.wallet.balance,
            "initial": INITIAL_BALANCE,
            "return_pct": round(((self.wallet.balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100, 2),
            "total_pnl": round(self.wallet.total_pnl, 2),
            "total_trades": self.wallet.total_trades,
            "wins": self.wallet.wins,
            "losses": self.wallet.losses,
            "win_rate": round(self.wallet.wins / max(self.wallet.total_trades, 1) * 100, 1),
            "long_trades": long_trades,
            "long_wr": round(self.wallet.long_wins / max(long_trades, 1) * 100, 1),
            "short_trades": short_trades,
            "short_wr": round(self.wallet.short_wins / max(short_trades, 1) * 100, 1),
            "open_positions": len(self.wallet.positions),
            "timestamp": time.time(),
        }
        await self.redis.set("vedic_futures:stats", json.dumps(stats), ex=REDIS_TTL)

    # ── Price ─────────────────────────────────────────────────────
    async def fetch_prices(self, symbols: List[str]) -> Dict[str, float]:
        try:
            import ccxt.async_support as ccxt_async
            exchange = ccxt_async.binance({"enableRateLimit": True})
            pairs = [f"{s}/USDC" for s in symbols]
            tickers = await exchange.fetch_tickers(pairs)
            await exchange.close()
            return {s: tickers[f"{s}/USDC"]["last"]
                    for s in symbols if f"{s}/USDC" in tickers and tickers[f"{s}/USDC"].get("last")}
        except Exception as e:
            print(f"[{self.name}] Price fetch failed: {e}")
            return {}

    # ── Trading Logic ─────────────────────────────────────────────
    def evaluate_entry(self, symbol: str, prob: float, bayes_details: dict,
                       vedic_score) -> Tuple[Optional[str], str]:
        """Decide: LONG, SHORT, or None based on Bayesian posterior."""
        # Venus Rx = absolute SHORT signal
        if vedic_score.label == "venus_rx_block":
            return "SHORT", f"Venus Rx block P(up)={prob:.1%}"

        if prob >= LONG_THRESHOLD:
            signals = []
            for sig, d in bayes_details.get("signals", {}).items():
                if d["direction"] == "bullish" and d["lr"] > 1.1:
                    signals.append(f"{sig}={d['state']}")
            return "LONG", f"P(up)={prob:.1%} [{', '.join(signals[:3])}]"

        if prob <= SHORT_THRESHOLD:
            signals = []
            for sig, d in bayes_details.get("signals", {}).items():
                if d["direction"] == "bearish" and d["lr"] < 0.9:
                    signals.append(f"{sig}={d['state']}")
            return "SHORT", f"P(up)={prob:.1%} [{', '.join(signals[:3])}]"

        return None, f"Neutral P(up)={prob:.1%}"

    def should_close(self, pos: dict, price: float, prob: float) -> Tuple[bool, str]:
        """Check if position should be closed."""
        entry = pos["entry_price"]
        side = pos["side"]  # "LONG" or "SHORT"

        if side == "LONG":
            pnl_pct = (price - entry) / entry
            peak = pos.get("peak_price", entry)
            if price > peak:
                peak = price
                pos["peak_price"] = peak
        else:  # SHORT
            pnl_pct = (entry - price) / entry  # Profit when price goes DOWN
            peak = pos.get("trough_price", entry)
            if price < peak:
                peak = price
                pos["trough_price"] = peak

        sl = LONG_SL if side == "LONG" else SHORT_SL
        tp = LONG_TP if side == "LONG" else SHORT_TP

        # Stop loss
        if pnl_pct <= -sl:
            return True, f"SL ({pnl_pct*100:.1f}%)"

        # Take profit
        if pnl_pct >= tp:
            return True, f"TP ({pnl_pct*100:.1f}%)"

        # Trailing stop
        if side == "LONG":
            peak_gain = (pos.get("peak_price", entry) - entry) / entry
        else:
            peak_gain = (entry - pos.get("trough_price", entry)) / entry

        if peak_gain >= TRAILING_ACT:
            pos["trailing_active"] = True
            if side == "LONG":
                trail = pos["peak_price"] * (1 - TRAILING_STOP)
                if price <= trail:
                    return True, f"Trail ({pnl_pct*100:.1f}%)"
            else:
                trail = pos["trough_price"] * (1 + TRAILING_STOP)
                if price >= trail:
                    return True, f"Trail ({pnl_pct*100:.1f}%)"

        # Signal reversal: close if Bayes flips to opposite side
        if side == "LONG" and prob < EXIT_NEUTRAL_ZONE[0] and pnl_pct > -0.01:
            return True, f"Signal fade P(up)={prob:.1%}"
        if side == "SHORT" and prob > EXIT_NEUTRAL_ZONE[1] and pnl_pct > -0.01:
            return True, f"Signal fade P(up)={prob:.1%}"

        return False, "Hold"

    # ── Execution ─────────────────────────────────────────────────
    async def open_position(self, symbol: str, price: float, side: str, reason: str,
                            bayes_signals: dict):
        size = self.wallet.balance * POSITION_SIZE_PCT
        if size < 5:
            return

        qty = size / price
        self.wallet.balance -= size

        pos = {
            "symbol": f"{symbol}/USDC", "base_asset": symbol,
            "side": side, "entry_price": price, "quantity": qty,
            "entry_time": time.time(), "entry_reason": reason,
            "peak_price": price, "trough_price": price,
            "trailing_active": False,
            "bayes_signals": bayes_signals,
        }
        self.wallet.positions[symbol] = pos
        await self.save_wallet()

        emoji = "LONG" if side == "LONG" else "SHORT"
        print(f"[{self.name}] {emoji} {symbol} {qty:.6f} @ ${price:,.2f} (${size:.2f}) | {reason}")

        await self.log_trade({
            "action": "OPEN", "side": side, "base_asset": symbol,
            "price": price, "quantity": qty, "usd_value": size,
            "reason": reason, "timestamp": time.time(),
            "datetime": datetime.now(timezone.utc).isoformat(),
        })

    async def close_position(self, symbol: str, price: float, reason: str):
        pos = self.wallet.positions.get(symbol)
        if not pos:
            return

        qty = pos["quantity"]
        entry = pos["entry_price"]
        side = pos["side"]

        if side == "LONG":
            pnl = (price - entry) * qty
            pnl_pct = (price - entry) / entry * 100
        else:  # SHORT
            pnl = (entry - price) * qty
            pnl_pct = (entry - price) / entry * 100

        self.wallet.balance += (qty * entry) + pnl  # Return margin + P&L
        self.wallet.total_trades += 1
        self.wallet.total_pnl += pnl

        won = pnl > 0
        if won:
            self.wallet.wins += 1
        else:
            self.wallet.losses += 1

        if side == "LONG":
            if won:
                self.wallet.long_wins += 1
            else:
                self.wallet.long_losses += 1
        else:
            if won:
                self.wallet.short_wins += 1
            else:
                self.wallet.short_losses += 1

        # Bayesian update
        bayes_signals = pos.get("bayes_signals")
        if bayes_signals:
            if not self._bayes_loaded:
                await self.bayes.load(self.redis)
                self._bayes_loaded = True
            self.bayes.update(bayes_signals, won=won)
            await self.bayes.save(self.redis)

        del self.wallet.positions[symbol]
        await self.save_wallet()

        hold_h = (time.time() - pos["entry_time"]) / 3600
        emoji = "WIN" if won else "LOSS"
        print(f"[{self.name}] {emoji} CLOSE {side} {symbol} @ ${price:,.2f} | "
              f"P&L: ${pnl:+.2f} ({pnl_pct:+.1f}%) | {hold_h:.1f}h | {reason}")

        await self.log_trade({
            "action": "CLOSE", "side": side, "base_asset": symbol,
            "price": price, "quantity": qty, "entry_price": entry,
            "pnl": round(pnl, 2), "pnl_pct": round(pnl_pct, 2),
            "hold_hours": round(hold_h, 1), "reason": reason,
            "timestamp": time.time(),
            "datetime": datetime.now(timezone.utc).isoformat(),
        })

    # ── Main Loop ─────────────────────────────────────────────────
    async def scan_cycle(self):
        sky = get_sky_state()
        vedic_score = compute_vedic_score(sky)

        # Load Bayes
        if not self._bayes_loaded:
            await self.bayes.load(self.redis)
            self._bayes_loaded = True

        # Compute Bayesian posterior
        raw_signals = {
            "venus_rx": vedic_score.label == "venus_rx_block",
            "mercury_rx": vedic_score.is_mercury_retrograde,
            "n_retrogrades": len(vedic_score.retrogrades),
            "paksha": vedic_score.lunar_paksha,
            "tithi_number": vedic_score.tithi_number,
            "moon_speed": sky.planets["Moon"].speed,
            "v3_score": vedic_score.overall_score,
            "jupiter_rx": sky.planets["Jupiter"].is_retrograde,
            "saturn_rx": sky.planets["Saturn"].is_retrograde,
        }
        prob, details = self.bayes.predict(raw_signals)

        # Count positions by side
        longs = [s for s, p in self.wallet.positions.items() if p["side"] == "LONG"]
        shorts = [s for s, p in self.wallet.positions.items() if p["side"] == "SHORT"]

        wr = self.wallet.wins / max(self.wallet.total_trades, 1) * 100
        print(f"[{self.name}] Bayes P(up)={prob:.1%} score={details['score']} | "
              f"V3={vedic_score.overall_score} | "
              f"L={len(longs)} S={len(shorts)} | "
              f"Bal=${self.wallet.balance:.0f} P&L=${self.wallet.total_pnl:+.2f} "
              f"({self.wallet.total_trades}T {wr:.0f}%WR)")

        # Fetch prices
        held = list(self.wallet.positions.keys())
        candidates = [s for s in SYMBOLS if s not in self.wallet.positions][:6]
        all_syms = list(set(held + candidates))
        prices = await self.fetch_prices(all_syms)
        if not prices:
            return

        # Check existing positions
        for sym in list(self.wallet.positions.keys()):
            price = prices.get(sym)
            if not price:
                continue
            pos = self.wallet.positions[sym]
            should_close, reason = self.should_close(pos, price, prob)
            if should_close:
                await self.close_position(sym, price, reason)
            else:
                await self.save_wallet()

        # Check new entries
        open_slots = MAX_POSITIONS - len(self.wallet.positions)
        if open_slots > 0:
            for sym in candidates:
                if open_slots <= 0:
                    break
                if sym in self.wallet.positions:
                    continue
                price = prices.get(sym)
                if not price:
                    continue

                side, reason = self.evaluate_entry(sym, prob, details, vedic_score)
                if side:
                    await self.open_position(sym, price, side, reason, raw_signals)
                    open_slots -= 1

        await self.update_stats()

    async def run(self):
        print(f"[{self.name}] Starting Vedic Futures Paper Trader")
        print(f"[{self.name}] Wallet: ${INITIAL_BALANCE} | Size: {POSITION_SIZE_PCT*100}% | Max: {MAX_POSITIONS}")
        print(f"[{self.name}] LONG threshold: P(up)>{LONG_THRESHOLD:.0%} | SHORT: P(up)<{SHORT_THRESHOLD:.0%}")
        print(f"[{self.name}] SL={LONG_SL*100}% TP={LONG_TP*100}% Trail={TRAILING_ACT*100}%/{TRAILING_STOP*100}%")
        print(f"[{self.name}] Scan: {SCAN_INTERVAL}s | Symbols: {len(SYMBOLS)}")

        await self.load_wallet()

        while True:
            try:
                await self.scan_cycle()
            except Exception as e:
                print(f"[{self.name}] Error: {e}")
                traceback.print_exc()
                await asyncio.sleep(60)
                continue
            await asyncio.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    asyncio.run(VedicFuturesPaper().run())
