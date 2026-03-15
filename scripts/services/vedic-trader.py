"""
Vedic Trader — Pure astrology-driven paper trading experiment.

Trades multiple crypto/USDC pairs using ONLY vedic astrology signals:
  - Muhurta score (auspicious timing)
  - Moon nakshatra (trading bias)
  - Planetary aspects (benefic/malefic)
  - Mercury retrograde (risk filter)
  - Natal chart transits (per-symbol)
  - Vimshottari Dasha (planetary period bias)
  - Trailing stop (activates at +3%, trails at -2% from peak)

Paper wallet — no real money, simulated balance in Redis.
Fetches real prices from CCXT (Binance) for realistic P&L tracking.

Watchlist: All 16 cryptos with natal charts, ranked by transit score.
Max 3 concurrent positions, 10% of balance per trade.

Redis keys:
  vedic_trader:wallet       — paper wallet state (balance, positions)
  vedic_trader:trades       — trade history
  vedic_trader:stats        — performance stats (win rate, total P&L)

Run: python scripts/services/vedic-trader.py
Docker: see docker-compose.prod.yml (vedic-trader service)
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

# Add project root to path for vedic module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'engine'))

from src.vedic.ephemeris import get_sky_state
from src.vedic.scoring import compute_vedic_score, compute_symbol_transits
from src.vedic.aspects import mercury_retrograde
from src.vedic.nakshatras import nakshatra_at_longitude
from src.vedic.natal import CRYPTO_GENESIS
from src.vedic.dasha import compute_all_dashas

# ── Configuration ─────────────────────────────────────────────────────

# Watchlist: all 16 cryptos with natal charts, as USDC pairs
WATCHLIST = {sym: f"{sym}/USDC" for sym in CRYPTO_GENESIS.keys()}

INITIAL_BALANCE = 1000.0          # $1000 paper money
POSITION_SIZE_PCT = 0.10          # 10% of balance per trade (reduced from 20%)
MAX_POSITIONS = 3                 # Up to 3 concurrent positions
MAX_PER_SYMBOL = 1                # Only 1 position per symbol
SCAN_INTERVAL = 300               # Check every 5 minutes
REDIS_TTL = 86400 * 30            # Keep data for 30 days

# ── Trading rules (pure vedic) ────────────────────────────────────────

# BUY when composite score > this AND no blocking conditions
BUY_SCORE_THRESHOLD = 20

# SELL when composite score < this OR stop-loss/take-profit hit
SELL_SCORE_THRESHOLD = -15

# Hard stop-loss and take-profit (safety nets)
STOP_LOSS_PCT = 0.05              # -5% from entry
TAKE_PROFIT_PCT = 0.08            # +8% from entry

# Trailing stop
TRAILING_ACTIVATION_PCT = 0.03    # Activate trailing after +3%
TRAILING_STOP_PCT = 0.02          # Trail at -2% from peak

# Mercury retrograde blocks ALL new buys
MERCURY_RETRO_BLOCKS_BUY = True

# Minimum muhurta level to buy
MIN_MUHURTA_FOR_BUY = "neutral"   # "neutral" or above
MUHURTA_LEVELS = {
    "very_inauspicious": -2,
    "inauspicious": -1,
    "neutral": 0,
    "auspicious": 1,
    "very_auspicious": 2,
}

# Moon nakshatra must have bullish or neutral bias to buy
ALLOWED_NAKSHATRA_BIAS = {"bullish", "neutral"}

# Minimum transit score to consider buying
MIN_TRANSIT_SCORE = -20

# Dasha bias threshold — skip symbols in strongly bearish dasha
MIN_DASHA_BIAS = -0.3

# ── Price fetching ────────────────────────────────────────────────────

async def fetch_prices(symbols: List[str]) -> Dict[str, float]:
    """Fetch current prices for multiple symbols from Binance via CCXT."""
    try:
        import ccxt.async_support as ccxt
        exchange = ccxt.binance({"enableRateLimit": True})

        # Fetch all tickers at once (much faster than per-symbol)
        tickers = await exchange.fetch_tickers([WATCHLIST[s] for s in symbols if s in WATCHLIST])
        await exchange.close()

        prices = {}
        for sym in symbols:
            pair = WATCHLIST.get(sym)
            if pair and pair in tickers:
                price = tickers[pair].get("last")
                if price and price > 0:
                    prices[sym] = price
        return prices

    except Exception as e:
        print(f"[VedicTrader] Price fetch failed: {e}")
        return {}


# ── Paper Wallet ──────────────────────────────────────────────────────

@dataclass
class PaperWallet:
    balance: float = INITIAL_BALANCE
    positions: Dict = field(default_factory=dict)  # {symbol: position_dict}
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    best_trade_pnl: float = 0.0
    worst_trade_pnl: float = 0.0
    per_symbol_pnl: Dict = field(default_factory=dict)  # {symbol: total_pnl}
    created_at: float = field(default_factory=lambda: time.time())


# ── Main Trader ───────────────────────────────────────────────────────

class VedicTrader:
    def __init__(self):
        kv_url = os.getenv("KV_URL", "redis://localhost:6379")
        self.redis = aioredis.from_url(kv_url, decode_responses=True)
        self.name = "VedicTrader"
        self.wallet: Optional[PaperWallet] = None

    async def load_wallet(self):
        """Load or create paper wallet from Redis. Handles migration from v1 format."""
        raw = await self.redis.get("vedic_trader:wallet")
        if raw:
            data = json.loads(raw)

            # Migration: v1 had 'position' (singular), v2 has 'positions' (dict)
            if "position" in data and "positions" not in data:
                old_pos = data.pop("position")
                data["positions"] = {}
                if old_pos is not None:
                    symbol = old_pos.get("symbol", "BTC/USDC").split("/")[0]
                    data["positions"][symbol] = old_pos
                data.setdefault("per_symbol_pnl", {})

            # Ensure new fields exist
            data.setdefault("positions", {})
            data.setdefault("per_symbol_pnl", {})

            self.wallet = PaperWallet(**data)
            n_pos = len(self.wallet.positions)
            print(f"[{self.name}] Loaded wallet: ${self.wallet.balance:.2f} | "
                  f"Positions: {n_pos} | Trades: {self.wallet.total_trades} | "
                  f"P&L: ${self.wallet.total_pnl:.2f}")
        else:
            self.wallet = PaperWallet()
            await self.save_wallet()
            print(f"[{self.name}] Created new paper wallet: ${INITIAL_BALANCE:.2f}")

    async def save_wallet(self):
        """Persist wallet to Redis."""
        await self.redis.set(
            "vedic_trader:wallet",
            json.dumps(asdict(self.wallet)),
            ex=REDIS_TTL,
        )

    async def log_trade(self, trade_data: dict):
        """Append trade to history list in Redis."""
        await self.redis.lpush("vedic_trader:trades", json.dumps(trade_data))
        await self.redis.ltrim("vedic_trader:trades", 0, 499)  # Keep last 500
        await self.redis.expire("vedic_trader:trades", REDIS_TTL)

    async def update_stats(self):
        """Update stats key for dashboard/reporting."""
        if not self.wallet:
            return

        # Top/bottom symbols by P&L
        symbol_pnl = self.wallet.per_symbol_pnl
        top_symbols = sorted(symbol_pnl.items(), key=lambda x: x[1], reverse=True)[:3]
        bottom_symbols = sorted(symbol_pnl.items(), key=lambda x: x[1])[:3]

        stats = {
            "balance": self.wallet.balance,
            "initial_balance": INITIAL_BALANCE,
            "total_return_pct": round(
                ((self.wallet.balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100, 2
            ),
            "total_pnl": round(self.wallet.total_pnl, 2),
            "total_trades": self.wallet.total_trades,
            "wins": self.wallet.wins,
            "losses": self.wallet.losses,
            "win_rate": round(
                (self.wallet.wins / max(self.wallet.total_trades, 1)) * 100, 1
            ),
            "best_trade": round(self.wallet.best_trade_pnl, 2),
            "worst_trade": round(self.wallet.worst_trade_pnl, 2),
            "open_positions": len(self.wallet.positions),
            "max_positions": MAX_POSITIONS,
            "watchlist_size": len(WATCHLIST),
            "top_symbols": top_symbols,
            "bottom_symbols": bottom_symbols,
            "positions": list(self.wallet.positions.keys()),
            "timestamp": time.time(),
        }
        await self.redis.set("vedic_trader:stats", json.dumps(stats), ex=REDIS_TTL)

    # ── Trading Logic ─────────────────────────────────────────────────

    def should_buy(
        self, symbol: str, vedic_score, transit_score, dasha_state
    ) -> Tuple[bool, str]:
        """Evaluate vedic conditions for a BUY on a specific symbol."""

        reasons = []

        # 1. Composite score check
        if vedic_score.overall_score < BUY_SCORE_THRESHOLD:
            return False, f"Score {vedic_score.overall_score} < {BUY_SCORE_THRESHOLD}"
        reasons.append(f"score={vedic_score.overall_score}")

        # 2. Mercury retrograde block
        if MERCURY_RETRO_BLOCKS_BUY and vedic_score.is_mercury_retrograde:
            return False, "Mercury retrograde"

        # 3. Muhurta check
        muhurta_level = MUHURTA_LEVELS.get(vedic_score.muhurta_label, -99)
        min_level = MUHURTA_LEVELS.get(MIN_MUHURTA_FOR_BUY, 0)
        if muhurta_level < min_level:
            return False, f"Muhurta {vedic_score.muhurta_label} below minimum"
        reasons.append(f"muhurta={vedic_score.muhurta_label}")

        # 4. Moon nakshatra bias
        if vedic_score.moon_nakshatra_bias not in ALLOWED_NAKSHATRA_BIAS:
            return False, f"Moon in {vedic_score.moon_nakshatra} ({vedic_score.moon_nakshatra_bias})"
        reasons.append(f"moon={vedic_score.moon_nakshatra}")

        # 5. Per-symbol transit score
        if transit_score is not None and transit_score < MIN_TRANSIT_SCORE:
            return False, f"{symbol} transit {transit_score} < {MIN_TRANSIT_SCORE}"
        if transit_score is not None:
            reasons.append(f"transit={transit_score}")

        # 6. Aspect check
        if vedic_score.aspect_score < -0.4:
            return False, f"Malefic aspects ({vedic_score.aspect_score:.2f})"

        # 7. Dasha check — skip if strongly bearish period
        if dasha_state is not None:
            if dasha_state.combined_bias < MIN_DASHA_BIAS:
                return False, (
                    f"{symbol} in {dasha_state.maha_dasha_lord}/{dasha_state.antar_dasha_lord} "
                    f"dasha (bias={dasha_state.combined_bias})"
                )
            reasons.append(f"dasha={dasha_state.maha_dasha_lord}/{dasha_state.antar_dasha_lord}")

        return True, " | ".join(reasons)

    def should_sell(
        self, symbol: str, vedic_score, current_price: float, position: dict
    ) -> Tuple[bool, str]:
        """Evaluate vedic conditions + safety nets + trailing stop for SELL."""

        entry_price = position["entry_price"]
        pnl_pct = (current_price - entry_price) / entry_price

        # Update peak price for trailing stop
        peak = position.get("peak_price", entry_price)
        if current_price > peak:
            peak = current_price
            position["peak_price"] = peak

        # ── Trailing stop ──
        pnl_from_entry_to_peak = (peak - entry_price) / entry_price
        if pnl_from_entry_to_peak >= TRAILING_ACTIVATION_PCT:
            position["trailing_active"] = True
            trailing_stop_price = peak * (1 - TRAILING_STOP_PCT)
            position["trailing_stop_price"] = trailing_stop_price

            if current_price <= trailing_stop_price:
                return True, (
                    f"TRAILING STOP ({symbol}: peak ${peak:,.0f}, "
                    f"trail ${trailing_stop_price:,.0f}, now ${current_price:,.0f}, "
                    f"P&L {pnl_pct*100:+.1f}%)"
                )

        # Hard stop-loss
        if pnl_pct <= -STOP_LOSS_PCT:
            return True, f"STOP LOSS {symbol} ({pnl_pct*100:.1f}%)"

        # Hard take-profit
        if pnl_pct >= TAKE_PROFIT_PCT:
            return True, f"TAKE PROFIT {symbol} ({pnl_pct*100:.1f}%)"

        # Vedic score turns very negative
        if vedic_score.overall_score < SELL_SCORE_THRESHOLD:
            return True, f"Vedic bearish ({vedic_score.overall_score})"

        # Mercury goes retrograde while in profit
        if vedic_score.is_mercury_retrograde and pnl_pct > 0:
            return True, f"Mercury Rx + profit ({pnl_pct*100:.1f}%) — lock gains"

        # Moon enters bearish nakshatra while in profit
        if vedic_score.moon_nakshatra_bias == "bearish" and pnl_pct > 0.01:
            return True, f"Moon in {vedic_score.moon_nakshatra} + profit — lock gains"

        return False, "Hold"

    # ── Execution ─────────────────────────────────────────────────────

    async def execute_buy(
        self, symbol: str, price: float, reason: str, vedic_score, dasha_state
    ):
        """Execute a paper BUY for a specific symbol."""
        size_usd = self.wallet.balance * POSITION_SIZE_PCT
        if size_usd < 5:
            return

        quantity = size_usd / price
        self.wallet.balance -= size_usd

        dasha_info = ""
        if dasha_state:
            dasha_info = f"{dasha_state.maha_dasha_lord}/{dasha_state.antar_dasha_lord}"

        position = {
            "symbol": f"{symbol}/USDC",
            "base_asset": symbol,
            "entry_price": price,
            "quantity": quantity,
            "entry_time": time.time(),
            "entry_reason": reason,
            "vedic_score_at_entry": vedic_score.overall_score,
            "moon_nakshatra_at_entry": vedic_score.moon_nakshatra,
            "dasha_at_entry": dasha_info,
            "peak_price": price,
            "trailing_active": False,
            "trailing_stop_price": 0.0,
        }
        self.wallet.positions[symbol] = position
        await self.save_wallet()

        trade_log = {
            "action": "BUY",
            "symbol": f"{symbol}/USDC",
            "base_asset": symbol,
            "price": price,
            "quantity": quantity,
            "usd_value": size_usd,
            "reason": reason,
            "vedic_score": vedic_score.overall_score,
            "muhurta": vedic_score.muhurta_label,
            "moon_nakshatra": vedic_score.moon_nakshatra,
            "mercury_rx": vedic_score.is_mercury_retrograde,
            "dasha": dasha_info,
            "timestamp": time.time(),
            "datetime": datetime.now(timezone.utc).isoformat(),
        }
        await self.log_trade(trade_log)

        print(
            f"[{self.name}] BUY {symbol} {quantity:.6f} @ ${price:,.2f} "
            f"(${size_usd:.2f}) | {reason}"
        )

    async def execute_sell(
        self, symbol: str, price: float, reason: str, vedic_score
    ):
        """Execute a paper SELL for a specific symbol."""
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

        # Per-symbol P&L tracking
        self.wallet.per_symbol_pnl[symbol] = (
            self.wallet.per_symbol_pnl.get(symbol, 0.0) + pnl
        )

        if pnl > 0:
            self.wallet.wins += 1
        else:
            self.wallet.losses += 1

        if pnl > self.wallet.best_trade_pnl:
            self.wallet.best_trade_pnl = pnl
        if pnl < self.wallet.worst_trade_pnl:
            self.wallet.worst_trade_pnl = pnl

        # Remove position
        del self.wallet.positions[symbol]
        await self.save_wallet()

        hold_hours = (time.time() - pos["entry_time"]) / 3600
        trailing_info = ""
        if pos.get("trailing_active"):
            trailing_info = f" | Trail: peak=${pos['peak_price']:,.0f}"

        trade_log = {
            "action": "SELL",
            "symbol": f"{symbol}/USDC",
            "base_asset": symbol,
            "price": price,
            "quantity": quantity,
            "usd_value": sell_value,
            "entry_price": entry_price,
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct, 2),
            "hold_hours": round(hold_hours, 1),
            "reason": reason,
            "vedic_score": vedic_score.overall_score,
            "moon_nakshatra": vedic_score.moon_nakshatra,
            "trailing_active": pos.get("trailing_active", False),
            "peak_price": pos.get("peak_price", entry_price),
            "timestamp": time.time(),
            "datetime": datetime.now(timezone.utc).isoformat(),
        }
        await self.log_trade(trade_log)

        emoji = "WIN" if pnl > 0 else "LOSS"
        print(
            f"[{self.name}] {emoji} SELL {symbol} {quantity:.6f} @ ${price:,.2f} "
            f"| P&L: ${pnl:+.2f} ({pnl_pct:+.1f}%) | Hold: {hold_hours:.1f}h"
            f"{trailing_info} | {reason}"
        )

        await self.send_telegram_alert(trade_log)

    # ── Telegram ──────────────────────────────────────────────────────

    async def send_telegram_alert(self, trade: dict):
        """Send trade alert to Telegram."""
        bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "")
        chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
        if not bot_token or not chat_id:
            return

        try:
            import httpx

            pnl = trade.get("pnl", 0)
            emoji = "+" if pnl > 0 else "-"
            trailing = " (trailing)" if trade.get("trailing_active") else ""
            symbol = trade.get("base_asset", "?")

            msg = (
                f"Vedic Trader {emoji}\n"
                f"SELL {symbol}/USDC{trailing}\n"
                f"Entry: ${trade['entry_price']:,.2f} -> Exit: ${trade['price']:,.2f}\n"
                f"P&L: ${trade['pnl']:+.2f} ({trade['pnl_pct']:+.1f}%)\n"
                f"Hold: {trade['hold_hours']:.1f}h\n"
                f"Reason: {trade['reason']}\n"
                f"Score: {trade['vedic_score']} | Moon: {trade['moon_nakshatra']}"
            )

            async with httpx.AsyncClient() as client:
                await client.post(
                    f"https://api.telegram.org/bot{bot_token}/sendMessage",
                    json={
                        "chat_id": chat_id,
                        "text": msg,
                        "parse_mode": "Markdown",
                    },
                )
        except Exception as e:
            print(f"[{self.name}] Telegram alert failed: {e}")

    # ── Main Loop ─────────────────────────────────────────────────────

    async def scan_cycle(self):
        """Single scan cycle: compute vedic state, rank symbols, decide buy/sell."""

        # 1. Get current sky state + vedic score (global, same for all symbols)
        sky = get_sky_state()
        vedic_score = compute_vedic_score(sky)

        # 2. Compute per-symbol transit scores for all watchlist symbols
        all_symbols = list(WATCHLIST.keys())
        transits = compute_symbol_transits(all_symbols, sky)

        # 3. Compute dasha states for all symbols
        dashas = compute_all_dashas()

        # 4. Fetch prices for symbols we care about
        #    (held positions + top candidates by transit score)
        held_symbols = list(self.wallet.positions.keys())

        # Rank candidates by transit score (descending)
        candidates = []
        for sym in all_symbols:
            if sym in self.wallet.positions:
                continue  # Already holding
            ts = transits.get(sym)
            score = ts.score if ts else 0
            candidates.append((sym, score))
        candidates.sort(key=lambda x: x[1], reverse=True)

        # Only fetch prices for held + top 5 candidates
        symbols_to_price = set(held_symbols)
        for sym, _ in candidates[:5]:
            symbols_to_price.add(sym)

        prices = await fetch_prices(list(symbols_to_price))
        if not prices:
            print(f"[{self.name}] No prices — skipping cycle")
            return

        # 5. Log global state
        n_pos = len(self.wallet.positions)
        pos_str = ", ".join(
            f"{s}({(prices.get(s,0)-p['entry_price'])/p['entry_price']*100:+.1f}%)"
            for s, p in self.wallet.positions.items()
            if s in prices
        )
        print(
            f"[{self.name}] Vedic={vedic_score.overall_score} ({vedic_score.label}) | "
            f"Muhurta={vedic_score.muhurta_label} | "
            f"Moon={vedic_score.moon_nakshatra} ({vedic_score.moon_nakshatra_bias}) | "
            f"MercRx={vedic_score.is_mercury_retrograde} | "
            f"Pos={n_pos}/{MAX_POSITIONS}"
            f"{' | ' + pos_str if pos_str else ''}"
        )

        # 6. Check existing positions for SELL
        for symbol in list(self.wallet.positions.keys()):
            price = prices.get(symbol)
            if price is None:
                continue

            pos = self.wallet.positions[symbol]
            should, reason = self.should_sell(symbol, vedic_score, price, pos)
            if should:
                await self.execute_sell(symbol, price, reason, vedic_score)
            else:
                # Persist peak_price updates from trailing stop tracking
                await self.save_wallet()

        # 7. Check candidates for BUY (if we have open slots)
        open_slots = MAX_POSITIONS - len(self.wallet.positions)
        if open_slots > 0:
            for sym, transit_sc in candidates:
                if open_slots <= 0:
                    break
                if sym in self.wallet.positions:
                    continue

                price = prices.get(sym)
                if price is None:
                    continue

                ts = transits.get(sym)
                t_score = ts.score if ts else None
                dasha = dashas.get(sym)

                should, reason = self.should_buy(sym, vedic_score, t_score, dasha)
                if should:
                    await self.execute_buy(sym, price, reason, vedic_score, dasha)
                    open_slots -= 1

        # 8. Update stats
        await self.update_stats()

    async def run(self):
        """Main loop."""
        print(f"[{self.name}] Starting Vedic Paper Trader v2 (multi-symbol)")
        print(f"[{self.name}] Watchlist: {len(WATCHLIST)} symbols | "
              f"Max positions: {MAX_POSITIONS} | Size: {POSITION_SIZE_PCT*100}%")
        print(f"[{self.name}] Paper balance: ${INITIAL_BALANCE} | "
              f"SL={STOP_LOSS_PCT*100}% TP={TAKE_PROFIT_PCT*100}% "
              f"Trail={TRAILING_ACTIVATION_PCT*100}%/{TRAILING_STOP_PCT*100}%")
        print(f"[{self.name}] Scan interval: {SCAN_INTERVAL}s")

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


async def main():
    trader = VedicTrader()
    await trader.run()


if __name__ == "__main__":
    asyncio.run(main())
