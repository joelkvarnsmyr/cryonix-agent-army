"""
Vedic BTD Trader — Dedicated Venus Rx Buy-The-Dip trader.

Separate instance from vedic-trader.py with its own wallet.
ONLY trades during post-Venus-Rx recovery windows.

Research: 6 Rx periods × 8 symbols × 9.5 years.
  Entry Day+7 after Rx ends, hold up to 60 days.
  +24.9% avg return, 72% WR, p=0.0013.
  SL=12%, TP=40%, Sharpe 1.65.

Strategy:
  1. Track Venus Rx status via pyswisseph
  2. When Venus goes direct → start 7-day countdown
  3. Day 7-60: Buy top symbols aggressively (25% position)
  4. SKIP if Mercury is also retrograde (only losing period was 2018-10)
  5. Wide stops: SL=12%, TP=40%, trailing at +10%/-5%
  6. Max 3 concurrent positions

Redis keys (separate from vedic-trader):
  vedic_btd:wallet   — paper wallet state
  vedic_btd:trades   — trade history
  vedic_btd:stats    — performance stats
  vedic_btd:state    — BTD state machine (waiting/countdown/active/cooldown)

Run: python scripts/services/vedic-btd-trader.py
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
from src.vedic.scoring import compute_vedic_score, compute_symbol_transits
from src.vedic.natal import CRYPTO_GENESIS

# ── Configuration ─────────────────────────────────────────────────
INITIAL_BALANCE = 500.0            # $500 paper money (dedicated BTD fund)
POSITION_SIZE_PCT = 0.25           # 25% per trade (aggressive, research-backed)
MAX_POSITIONS = 3
SCAN_INTERVAL = 600                # 10 min (no rush, BTD is a swing strategy)
REDIS_TTL = 86400 * 90             # 90 days

# BTD-specific parameters (research-optimized)
BTD_ENTRY_DELAY_DAYS = 7           # Wait 7 days after Venus goes direct
BTD_WINDOW_DAYS = 60               # BTD window lasts 60 days
STOP_LOSS_PCT = 0.12               # -12% SL (very wide, research: best Sharpe)
TAKE_PROFIT_PCT = 0.40             # +40% TP (let winners run)
TRAILING_ACTIVATION_PCT = 0.10     # Activate trailing at +10%
TRAILING_STOP_PCT = 0.05           # Trail at -5% from peak

# Top BTD symbols (highest post-Rx recovery in research)
BTD_SYMBOLS = ["SOL", "ETH", "AVAX", "XRP", "ADA", "BTC", "BNB", "LTC"]

# ── Paper Wallet ──────────────────────────────────────────────────
@dataclass
class BTDWallet:
    balance: float = INITIAL_BALANCE
    positions: Dict = field(default_factory=dict)
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    best_trade_pnl: float = 0.0
    worst_trade_pnl: float = 0.0
    per_symbol_pnl: Dict = field(default_factory=dict)
    created_at: float = field(default_factory=lambda: time.time())


# ── BTD State Machine ─────────────────────────────────────────────
# States:
#   WAITING      — Venus is direct, no recent Rx. Normal idle.
#   VENUS_RX     — Venus is retrograde. Don't trade, wait for it to end.
#   COUNTDOWN    — Venus just went direct. Waiting 7 days before entry.
#   ACTIVE       — BTD window open (day 7-60). Aggressively buying.
#   COOLDOWN     — BTD window expired (day 60+). Back to waiting.

@dataclass
class BTDState:
    phase: str = "WAITING"           # WAITING, VENUS_RX, COUNTDOWN, ACTIVE, COOLDOWN
    venus_rx_start: float = 0.0      # When Venus entered Rx
    venus_direct_at: float = 0.0     # When Venus went direct
    days_since_direct: float = 0.0   # Days since Venus went direct
    entries_this_cycle: int = 0      # How many BTD entries in this cycle
    cycle_id: str = ""               # Unique ID for this BTD cycle


class VedicBTDTrader:
    def __init__(self):
        kv_url = os.getenv("KV_URL", "redis://localhost:6379")
        self.redis = aioredis.from_url(kv_url, decode_responses=True)
        self.name = "VedicBTD"
        self.wallet: Optional[BTDWallet] = None
        self.state = BTDState()
        self.prev_venus_rx = None  # Track transitions

    async def load_wallet(self):
        raw = await self.redis.get("vedic_btd:wallet")
        if raw:
            data = json.loads(raw)
            data.setdefault("positions", {})
            data.setdefault("per_symbol_pnl", {})
            self.wallet = BTDWallet(**data)
            print(f"[{self.name}] Loaded wallet: ${self.wallet.balance:.2f} | "
                  f"Positions: {len(self.wallet.positions)} | "
                  f"Trades: {self.wallet.total_trades} | "
                  f"P&L: ${self.wallet.total_pnl:.2f}")
        else:
            self.wallet = BTDWallet()
            await self.save_wallet()
            print(f"[{self.name}] Created new BTD wallet: ${INITIAL_BALANCE:.2f}")

        # Load state
        state_raw = await self.redis.get("vedic_btd:state")
        if state_raw:
            data = json.loads(state_raw)
            self.state = BTDState(**data)
            print(f"[{self.name}] Loaded state: {self.state.phase}")

    async def save_wallet(self):
        await self.redis.set("vedic_btd:wallet", json.dumps(asdict(self.wallet)), ex=REDIS_TTL)

    async def save_state(self):
        await self.redis.set("vedic_btd:state", json.dumps(asdict(self.state)), ex=REDIS_TTL)

    async def log_trade(self, trade_data: dict):
        await self.redis.lpush("vedic_btd:trades", json.dumps(trade_data))
        await self.redis.ltrim("vedic_btd:trades", 0, 199)
        await self.redis.expire("vedic_btd:trades", REDIS_TTL)

    async def update_stats(self):
        if not self.wallet:
            return
        stats = {
            "balance": self.wallet.balance,
            "initial_balance": INITIAL_BALANCE,
            "total_return_pct": round(((self.wallet.balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100, 2),
            "total_pnl": round(self.wallet.total_pnl, 2),
            "total_trades": self.wallet.total_trades,
            "wins": self.wallet.wins,
            "losses": self.wallet.losses,
            "win_rate": round((self.wallet.wins / max(self.wallet.total_trades, 1)) * 100, 1),
            "open_positions": len(self.wallet.positions),
            "btd_phase": self.state.phase,
            "days_since_direct": round(self.state.days_since_direct, 1),
            "entries_this_cycle": self.state.entries_this_cycle,
            "timestamp": time.time(),
        }
        await self.redis.set("vedic_btd:stats", json.dumps(stats), ex=REDIS_TTL)

    # ── Price Fetching ────────────────────────────────────────────
    async def fetch_prices(self, symbols: List[str]) -> Dict[str, float]:
        try:
            import ccxt.async_support as ccxt_async
            exchange = ccxt_async.binance({"enableRateLimit": True})
            pairs = [f"{s}/USDC" for s in symbols]
            tickers = await exchange.fetch_tickers(pairs)
            await exchange.close()
            prices = {}
            for sym in symbols:
                pair = f"{sym}/USDC"
                if pair in tickers and tickers[pair].get("last"):
                    prices[sym] = tickers[pair]["last"]
            return prices
        except Exception as e:
            print(f"[{self.name}] Price fetch failed: {e}")
            return {}

    # ── State Machine ─────────────────────────────────────────────
    def update_state_machine(self, venus_rx: bool, merc_rx: bool):
        """Update BTD state based on Venus Rx status."""
        now = time.time()

        if venus_rx:
            if self.state.phase != "VENUS_RX":
                print(f"[{self.name}] Venus entered Rx — switching to VENUS_RX phase")
                self.state.phase = "VENUS_RX"
                self.state.venus_rx_start = now
                self.state.entries_this_cycle = 0
            return

        # Venus is direct
        if self.prev_venus_rx is True and not venus_rx:
            # Transition: Venus just went direct!
            self.state.phase = "COUNTDOWN"
            self.state.venus_direct_at = now
            cycle_date = datetime.now(timezone.utc).strftime("%Y%m%d")
            self.state.cycle_id = f"btd_{cycle_date}"
            print(f"[{self.name}] VENUS WENT DIRECT! Starting {BTD_ENTRY_DELAY_DAYS}-day countdown")
            print(f"[{self.name}] BTD cycle: {self.state.cycle_id}")

        if self.state.venus_direct_at > 0:
            self.state.days_since_direct = (now - self.state.venus_direct_at) / 86400

        # State transitions based on days
        if self.state.phase == "COUNTDOWN":
            if self.state.days_since_direct >= BTD_ENTRY_DELAY_DAYS:
                self.state.phase = "ACTIVE"
                print(f"[{self.name}] BTD WINDOW ACTIVE — {BTD_WINDOW_DAYS - BTD_ENTRY_DELAY_DAYS} days to trade!")

        elif self.state.phase == "ACTIVE":
            if self.state.days_since_direct >= BTD_WINDOW_DAYS:
                self.state.phase = "COOLDOWN"
                print(f"[{self.name}] BTD window closed — entering cooldown")

        elif self.state.phase == "COOLDOWN":
            if self.state.days_since_direct >= BTD_WINDOW_DAYS + 30:
                self.state.phase = "WAITING"
                self.state.venus_direct_at = 0
                self.state.days_since_direct = 0
                print(f"[{self.name}] Cooldown complete — back to WAITING")

    # ── Trading Logic ─────────────────────────────────────────────
    def should_buy(self, symbol: str, vedic_score, merc_rx: bool) -> Tuple[bool, str]:
        """BTD buy logic — only during ACTIVE phase."""
        if self.state.phase != "ACTIVE":
            return False, f"Not in ACTIVE phase (current: {self.state.phase})"

        # KEY FILTER: Skip if Mercury is also retrograde
        # Research: only losing BTD period was 2018-10 when both Venus+Mercury Rx
        if merc_rx:
            return False, "Mercury Rx — skip BTD (2018-10 lesson)"

        day = self.state.days_since_direct
        reasons = [
            f"BTD Day+{day:.0f}",
            f"cycle={self.state.cycle_id}",
            f"v3={vedic_score.overall_score}",
        ]
        return True, " | ".join(reasons)

    def should_sell(self, symbol: str, price: float, position: dict) -> Tuple[bool, str]:
        """BTD sell logic — wide stops, let winners run."""
        entry_price = position["entry_price"]
        pnl_pct = (price - entry_price) / entry_price

        peak = position.get("peak_price", entry_price)
        if price > peak:
            peak = price
            position["peak_price"] = peak

        # Trailing stop
        peak_gain = (peak - entry_price) / entry_price
        if peak_gain >= TRAILING_ACTIVATION_PCT:
            position["trailing_active"] = True
            trail_price = peak * (1 - TRAILING_STOP_PCT)
            if price <= trail_price:
                return True, f"BTD TRAILING ({pnl_pct*100:+.1f}%, peak ${peak:,.0f})"

        # Hard SL
        if pnl_pct <= -STOP_LOSS_PCT:
            return True, f"BTD STOP LOSS ({pnl_pct*100:.1f}%)"

        # Hard TP
        if pnl_pct >= TAKE_PROFIT_PCT:
            return True, f"BTD TAKE PROFIT ({pnl_pct*100:.1f}%)"

        # Venus goes Rx again while in position — exit with any profit
        if self.state.phase == "VENUS_RX" and pnl_pct > 0:
            return True, f"New Venus Rx + profit ({pnl_pct*100:.1f}%)"

        return False, "Hold"

    # ── Execution ─────────────────────────────────────────────────
    async def execute_buy(self, symbol: str, price: float, reason: str):
        size_usd = self.wallet.balance * POSITION_SIZE_PCT
        if size_usd < 5:
            return

        quantity = size_usd / price
        self.wallet.balance -= size_usd

        position = {
            "symbol": f"{symbol}/USDC",
            "base_asset": symbol,
            "entry_price": price,
            "quantity": quantity,
            "entry_time": time.time(),
            "entry_reason": reason,
            "peak_price": price,
            "trailing_active": False,
            "btd_cycle": self.state.cycle_id,
            "btd_day": round(self.state.days_since_direct),
        }
        self.wallet.positions[symbol] = position
        self.state.entries_this_cycle += 1
        await self.save_wallet()
        await self.save_state()

        trade_log = {
            "action": "BUY", "symbol": f"{symbol}/USDC", "base_asset": symbol,
            "price": price, "quantity": quantity, "usd_value": size_usd,
            "reason": reason, "btd_cycle": self.state.cycle_id,
            "btd_day": round(self.state.days_since_direct),
            "timestamp": time.time(),
            "datetime": datetime.now(timezone.utc).isoformat(),
        }
        await self.log_trade(trade_log)
        print(f"[{self.name}] BUY {symbol} {quantity:.6f} @ ${price:,.2f} (${size_usd:.2f}) | {reason}")

    async def execute_sell(self, symbol: str, price: float, reason: str):
        pos = self.wallet.positions.get(symbol)
        if not pos:
            return

        quantity = pos["quantity"]
        entry_price = pos["entry_price"]
        sell_value = quantity * price
        pnl = sell_value - (quantity * entry_price)
        pnl_pct = (price - entry_price) / entry_price * 100

        self.wallet.balance += sell_value
        self.wallet.total_trades += 1
        self.wallet.total_pnl += pnl
        self.wallet.per_symbol_pnl[symbol] = self.wallet.per_symbol_pnl.get(symbol, 0) + pnl

        if pnl > 0:
            self.wallet.wins += 1
        else:
            self.wallet.losses += 1
        if pnl > self.wallet.best_trade_pnl:
            self.wallet.best_trade_pnl = pnl
        if pnl < self.wallet.worst_trade_pnl:
            self.wallet.worst_trade_pnl = pnl

        del self.wallet.positions[symbol]
        await self.save_wallet()

        hold_hours = (time.time() - pos["entry_time"]) / 3600
        emoji = "WIN" if pnl > 0 else "LOSS"
        print(f"[{self.name}] {emoji} SELL {symbol} @ ${price:,.2f} | "
              f"P&L: ${pnl:+.2f} ({pnl_pct:+.1f}%) | Hold: {hold_hours:.1f}h | {reason}")

        trade_log = {
            "action": "SELL", "symbol": f"{symbol}/USDC", "base_asset": symbol,
            "price": price, "quantity": quantity, "usd_value": sell_value,
            "entry_price": entry_price, "pnl": round(pnl, 2), "pnl_pct": round(pnl_pct, 2),
            "hold_hours": round(hold_hours, 1), "reason": reason,
            "btd_cycle": pos.get("btd_cycle", ""),
            "timestamp": time.time(),
            "datetime": datetime.now(timezone.utc).isoformat(),
        }
        await self.log_trade(trade_log)
        await self.send_telegram(trade_log)

    async def send_telegram(self, trade: dict):
        bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "")
        chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
        if not bot_token or not chat_id:
            return
        try:
            import httpx
            pnl = trade.get("pnl", 0)
            emoji = "+" if pnl > 0 else "-"
            msg = (f"Vedic BTD {emoji}\n"
                   f"SELL {trade['base_asset']}/USDC\n"
                   f"Entry: ${trade['entry_price']:,.2f} -> Exit: ${trade['price']:,.2f}\n"
                   f"P&L: ${trade['pnl']:+.2f} ({trade['pnl_pct']:+.1f}%)\n"
                   f"Cycle: {trade.get('btd_cycle', '?')}")
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"https://api.telegram.org/bot{bot_token}/sendMessage",
                    json={"chat_id": chat_id, "text": msg},
                )
        except Exception:
            pass

    # ── Main Loop ─────────────────────────────────────────────────
    async def scan_cycle(self):
        sky = get_sky_state()
        vedic_score = compute_vedic_score(sky)
        venus_rx = vedic_score.label == "venus_rx_block"
        merc_rx = vedic_score.is_mercury_retrograde

        # Update state machine
        old_phase = self.state.phase
        self.update_state_machine(venus_rx, merc_rx)
        self.prev_venus_rx = venus_rx

        if self.state.phase != old_phase:
            await self.save_state()

        # Log
        n_pos = len(self.wallet.positions)
        wr = self.wallet.wins / max(self.wallet.total_trades, 1) * 100
        print(f"[{self.name}] Phase={self.state.phase} | "
              f"Day={self.state.days_since_direct:.0f} | "
              f"V3={vedic_score.overall_score} | MercRx={merc_rx} | "
              f"Pos={n_pos}/{MAX_POSITIONS} | "
              f"Balance=${self.wallet.balance:.2f} | "
              f"P&L=${self.wallet.total_pnl:+.2f} ({wr:.0f}% WR)")

        # Check existing positions for SELL
        if self.wallet.positions:
            held_symbols = list(self.wallet.positions.keys())
            prices = await self.fetch_prices(held_symbols)
            for sym in list(self.wallet.positions.keys()):
                price = prices.get(sym)
                if not price:
                    continue
                pos = self.wallet.positions[sym]
                should, reason = self.should_sell(sym, price, pos)
                if should:
                    await self.execute_sell(sym, price, reason)
                else:
                    await self.save_wallet()  # Persist peak updates

        # Check for BUY (only in ACTIVE phase)
        if self.state.phase == "ACTIVE":
            open_slots = MAX_POSITIONS - len(self.wallet.positions)
            if open_slots > 0:
                # Rank symbols by transit score
                transits = compute_symbol_transits(BTD_SYMBOLS, sky)
                candidates = sorted(
                    [(s, t.score) for s, t in transits.items() if s not in self.wallet.positions],
                    key=lambda x: x[1], reverse=True,
                )

                # Fetch prices for top candidates
                top_syms = [s for s, _ in candidates[:5]]
                prices = await self.fetch_prices(top_syms)

                for sym, _ in candidates:
                    if open_slots <= 0:
                        break
                    if sym in self.wallet.positions:
                        continue
                    price = prices.get(sym)
                    if not price:
                        continue

                    should, reason = self.should_buy(sym, vedic_score, merc_rx)
                    if should:
                        await self.execute_buy(sym, price, reason)
                        open_slots -= 1

        await self.update_stats()

    async def run(self):
        print(f"[{self.name}] Starting Venus Rx BTD Trader")
        print(f"[{self.name}] Wallet: ${INITIAL_BALANCE} | Size: {POSITION_SIZE_PCT*100}% | "
              f"Max: {MAX_POSITIONS} positions")
        print(f"[{self.name}] SL={STOP_LOSS_PCT*100}% TP={TAKE_PROFIT_PCT*100}% "
              f"Trail={TRAILING_ACTIVATION_PCT*100}%/{TRAILING_STOP_PCT*100}%")
        print(f"[{self.name}] Entry delay: {BTD_ENTRY_DELAY_DAYS}d | "
              f"Window: {BTD_WINDOW_DAYS}d | Symbols: {len(BTD_SYMBOLS)}")
        print(f"[{self.name}] Scan interval: {SCAN_INTERVAL}s")

        await self.load_wallet()

        # Detect current Venus state on startup
        sky = get_sky_state()
        venus_rx = sky.planets["Venus"].is_retrograde
        self.prev_venus_rx = venus_rx
        if venus_rx:
            self.state.phase = "VENUS_RX"
            print(f"[{self.name}] Venus currently Rx — waiting for direct")
        else:
            print(f"[{self.name}] Venus currently direct — monitoring for next Rx")

        while True:
            try:
                await self.scan_cycle()
            except Exception as e:
                print(f"[{self.name}] Error: {e}")
                traceback.print_exc()
                await asyncio.sleep(60)
                continue

            await asyncio.sleep(SCAN_INTERVAL)


async def main():
    trader = VedicBTDTrader()
    await trader.run()


if __name__ == "__main__":
    asyncio.run(main())
