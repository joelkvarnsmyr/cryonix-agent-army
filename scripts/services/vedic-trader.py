"""
Vedic Trader V3 — Research-validated astrology-driven paper trading.

V3 model (2026-03-15): Built from 6 symbols × 2000 days of deep research.
Regime-controlled, walk-forward validated (OOS +3.4%, 5/6 symbols positive).

PRIMARY signal: Venus Retrograde (ABSOLUTE BUY BLOCK)
  - 7d: Direct +1.63% vs Rx -3.57%, p<0.0001 in ALL market regimes
  - ~40 days every 18 months. Strongest signal found.

SECONDARY: Mercury Rx (mild), Retrograde count, Paksha (weak).
REMOVED from V2: Muhurta, Nakshatra bias, Aspects, Bhava, Hora (all noise).

Paper wallet — no real money, simulated balance in Redis.
Fetches real prices from CCXT (Binance) for realistic P&L tracking.

Watchlist: All 16 cryptos with natal charts, ranked by transit score.
Max 3 concurrent positions, 15% of balance per trade.

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
from src.vedic.bayesian import BayesianVedic

# ── Configuration ─────────────────────────────────────────────────────

# Watchlist: all 16 cryptos with natal charts, as USDC pairs
WATCHLIST = {sym: f"{sym}/USDC" for sym in CRYPTO_GENESIS.keys()}

INITIAL_BALANCE = 1000.0          # $1000 paper money
POSITION_SIZE_PCT = 0.15          # 15% of balance per trade (V3: wider stops allow larger size)
MAX_POSITIONS = 3                 # Up to 3 concurrent positions
MAX_PER_SYMBOL = 1                # Only 1 position per symbol
SCAN_INTERVAL = 300               # Check every 5 minutes
REDIS_TTL = 86400 * 30            # Keep data for 30 days

# ── Trading rules (research-calibrated) ──────────────────────────────
# Calibrated based on: Yuan et al (2006), Dichev & Janes, Crawford,
# Kashyap's vedic risk framework, and our 60-day backtest results.

# BUY when composite score > this AND no blocking conditions
# Lowered from 20 to 10: the reweighted muhurta (45% lunar phase) produces
# more granular scores. Old threshold blocked too many trades (27% WR).
BUY_SCORE_THRESHOLD = 8  # V4: "buy" label starts at 8 (aligned with backtest)

# SELL when composite score < this OR stop-loss/take-profit hit
SELL_SCORE_THRESHOLD = -25

# V3 optimized stops: wider = better returns (backtest: +59% at SL=8/TP=20)
STOP_LOSS_PCT = 0.08              # -8% from entry (wider, avoid whipsaws)
TAKE_PROFIT_PCT = 0.20            # +20% from entry (let winners run)

# Trailing stop: wider activation, wider trail
TRAILING_ACTIVATION_PCT = 0.06    # Activate at +6%
TRAILING_STOP_PCT = 0.03          # Trail at -3% from peak

# Venus Rx: ABSOLUTE BLOCK (strongest signal, p<0.0001 all regimes)
VENUS_RX_BLOCKS_BUY = True

# Mercury Rx: mild drag, NOT a hard block in V3 (Rx START is bullish)
MERCURY_RETRO_BLOCKS_BUY = False

# V2 noise gates REMOVED:
# Muhurta, Nakshatra bias, Paksha requirement, Aspect check, Transit min, Dasha min

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
        self.bayes = BayesianVedic()
        self._bayes_loaded = False
        # Venus Rx BTD state tracking
        self.prev_venus_rx = False
        self.venus_rx_ended_at: Optional[float] = None  # timestamp when Venus went direct
        self.btd_mode = False  # True = aggressively buying post-Venus-Rx dip

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
        self, symbol: str, vedic_score, transit_score, dasha_state,
        btd_window: bool = False,
    ) -> Tuple[bool, str]:
        """V3: Evaluate vedic conditions for a BUY.

        Normal mode: Venus Rx block + V3 score threshold.
        BTD mode: Override score threshold during post-Venus-Rx recovery window.
        Research: BTD at Day+7, hold 60d = +24.9% avg, 72% WR, p=0.0013.
        """
        reasons = []

        # 1. Venus Retrograde: ABSOLUTE BLOCK (strongest signal)
        if VENUS_RX_BLOCKS_BUY and vedic_score.label == "venus_rx_block":
            return False, "Venus retrograde — absolute block (p<0.0001)"

        # 2. BTD mode: lower score threshold, buy more aggressively
        if btd_window:
            # In BTD window: buy regardless of score (research shows +24.9% avg)
            # Only gate: Mercury must NOT be Rx (the only losing BTD was Merc+Venus Rx)
            if vedic_score.is_mercury_retrograde:
                return False, "BTD window but Mercury Rx — skip (2018-10 lesson)"
            reasons.append(f"BTD_MODE (post-Venus-Rx recovery)")
            reasons.append(f"v3={vedic_score.overall_score}")
            return True, " | ".join(reasons)

        # 3. Normal mode: V3 Composite score check
        if vedic_score.overall_score < BUY_SCORE_THRESHOLD:
            return False, f"V3 score {vedic_score.overall_score} < {BUY_SCORE_THRESHOLD}"
        reasons.append(f"v3={vedic_score.overall_score} ({vedic_score.label})")

        # 4. Mercury Rx: not a hard block in V3, just logged
        if vedic_score.is_mercury_retrograde:
            reasons.append("MercRx(mild)")

        # 5. Log retrogrades count
        n_retro = len(vedic_score.retrogrades)
        reasons.append(f"retro={n_retro}")

        return True, " | ".join(reasons)

    def should_sell(
        self, symbol: str, vedic_score, current_price: float, position: dict
    ) -> Tuple[bool, str]:
        """V3: Evaluate sell conditions. Simplified — only validated signals.

        Sell triggers:
        1. Hard SL/TP
        2. Trailing stop
        3. Venus Rx entry (with any profit)
        4. V3 score drops to strong_avoid
        V2 noise exits removed (full moon, Krishna paksha, bearish nakshatra).
        """
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

        # Check if this is a BTD position (wider stops)
        is_btd = "BTD_MODE" in position.get("entry_reason", "")
        sl = 0.12 if is_btd else STOP_LOSS_PCT  # BTD: -12% SL (research: very wide = best)
        tp = 0.40 if is_btd else TAKE_PROFIT_PCT  # BTD: +40% TP

        # Hard stop-loss
        if pnl_pct <= -sl:
            return True, f"STOP LOSS {symbol} ({pnl_pct*100:.1f}%)"

        # Hard take-profit
        if pnl_pct >= tp:
            return True, f"TAKE PROFIT {symbol} ({pnl_pct*100:.1f}%)"

        # Venus Rx exit: sell with any profit (strongest signal)
        if vedic_score.label == "venus_rx_block" and pnl_pct > 0:
            return True, f"Venus Rx + profit ({pnl_pct*100:.1f}%) — protect gains"

        # V3 score drops to strong_avoid with profit
        if vedic_score.overall_score < SELL_SCORE_THRESHOLD and pnl_pct > 0:
            return True, f"V3 strong_avoid ({vedic_score.overall_score}) + profit"

        return False, "Hold"

    # ── Execution ─────────────────────────────────────────────────────

    async def execute_buy(
        self, symbol: str, price: float, reason: str, vedic_score, dasha_state,
        pos_size_override: float = None,
    ):
        """Execute a paper BUY for a specific symbol."""
        pct = pos_size_override or POSITION_SIZE_PCT
        size_usd = self.wallet.balance * pct
        if size_usd < 5:
            return

        quantity = size_usd / price
        self.wallet.balance -= size_usd

        dasha_info = ""
        if dasha_state:
            dasha_info = f"{dasha_state.maha_dasha_lord}/{dasha_state.antar_dasha_lord}"

        # Capture vedic signals at entry for Bayesian update on close
        sky = get_sky_state()
        bayes_entry_signals = {
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
            "bayes_signals": bayes_entry_signals,
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

        # Bayesian update: teach the model from this trade outcome
        bayes_signals = pos.get("bayes_signals")
        if bayes_signals:
            if not self._bayes_loaded:
                await self.bayes.load(self.redis)
                self._bayes_loaded = True
            self.bayes.update(bayes_signals, won=(pnl > 0))
            await self.bayes.save(self.redis)
            print(f"[{self.name}] Bayes updated: {'WIN' if pnl > 0 else 'LOSS'} "
                  f"(total={self.bayes.state.total_trades})")

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

        # 4b. Venus Rx BTD mode tracking
        # Research: After Venus Rx ends, wait 7 days then buy aggressively.
        # +24.9% avg return at 60d hold, 72% WR, p=0.0013.
        # BUT: skip if Mercury is also Rx (only losing period was 2018-10 when both Rx).
        venus_rx_now = vedic_score.label == "venus_rx_block"

        if self.prev_venus_rx and not venus_rx_now:
            # Venus just went direct! Start BTD countdown.
            self.venus_rx_ended_at = time.time()
            print(f"[{self.name}] VENUS WENT DIRECT — BTD countdown started (enter in ~7 days)")

        self.prev_venus_rx = venus_rx_now

        # Check if we're in BTD window (7-60 days after Venus Rx ended)
        btd_window = False
        btd_days_since = 0
        if self.venus_rx_ended_at:
            btd_days_since = (time.time() - self.venus_rx_ended_at) / 86400
            if 7 <= btd_days_since <= 60:
                # Only enter BTD if Mercury is NOT retrograde
                if not vedic_score.is_mercury_retrograde:
                    btd_window = True
                else:
                    print(f"[{self.name}] BTD window active but Mercury Rx — skipping")
            elif btd_days_since > 60:
                self.venus_rx_ended_at = None  # BTD window expired
                self.btd_mode = False

        # 5. Log global state
        n_pos = len(self.wallet.positions)
        pos_str = ", ".join(
            f"{s}({(prices.get(s,0)-p['entry_price'])/p['entry_price']*100:+.1f}%)"
            for s, p in self.wallet.positions.items()
            if s in prices
        )
        paksha = getattr(vedic_score, 'lunar_paksha', '?')
        btd_str = f" | BTD day {btd_days_since:.0f}" if btd_window else ""
        print(
            f"[{self.name}] V3={vedic_score.overall_score} ({vedic_score.label}) | "
            f"Moon={vedic_score.moon_nakshatra} | "
            f"Tithi={vedic_score.tithi_name} ({paksha}) | "
            f"MercRx={vedic_score.is_mercury_retrograde} | "
            f"Retro={len(vedic_score.retrogrades)} | "
            f"Pos={n_pos}/{MAX_POSITIONS}"
            f"{btd_str}"
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
        # In BTD mode: use larger position size (25%) and wider stops
        effective_pos_size = POSITION_SIZE_PCT
        if btd_window:
            effective_pos_size = 0.25  # 25% during BTD (research: aggressive works)
            print(f"[{self.name}] BTD MODE ACTIVE — 25% position size, wide stops")

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

                should, reason = self.should_buy(sym, vedic_score, t_score, dasha, btd_window)
                if should:
                    await self.execute_buy(sym, price, reason, vedic_score, dasha,
                                          pos_size_override=effective_pos_size)
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
