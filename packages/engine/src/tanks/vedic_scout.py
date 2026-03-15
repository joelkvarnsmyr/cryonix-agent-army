"""
VedicScout — Vedic astrology intelligence layer.

Computes planetary positions, nakshatras, aspects, muhurta scores,
and per-symbol transit analysis using Swiss Ephemeris (pyswisseph).

Writes structured data to Redis for the auto-trader to consume:
  - vedic:score              — composite market-timing score (-100 to +100)
  - vedic:moon               — moon phase, nakshatra, tithi
  - vedic:planets            — all planet positions + retrogrades
  - vedic:aspects            — active planetary aspects
  - vedic:muhurta            — current muhurta assessment
  - vedic:transit:{SYMBOL}   — per-symbol natal transit scores
  - vedic:dasha:{SYMBOL}    — per-symbol Vimshottari dasha state

Runs every 15 minutes (planetary positions change slowly).
All computation is local — no external API calls.
"""
import asyncio
import json
import time
from dataclasses import asdict
from typing import Any, Dict, List

from src.core.config import get_toml
from src.core.state_sync import state_manager
from src.vedic.ephemeris import get_sky_state
from src.vedic.scoring import compute_vedic_score, compute_symbol_transits
from src.vedic.aspects import detect_aspects, detect_retrogrades
from src.vedic.natal import CRYPTO_GENESIS
from src.vedic.dasha import compute_all_dashas

# Symbols we trade that have natal charts
TRACKED_SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP",
    "ADA", "AVAX", "LINK", "DOT", "ATOM",
    "NEAR", "SUI", "UNI", "AAVE", "DOGE", "LTC",
]

# Redis TTL: 30 minutes (2x poll interval)
REDIS_TTL = 1800


class VedicScout:
    """Computes vedic astrology signals and writes to Redis."""

    def __init__(self, redis_client):
        self.redis = redis_client
        self.name = "VedicScout"
        self.enabled = get_toml("vedic", "enabled", False)
        self.poll_interval = get_toml("vedic", "poll_interval_seconds", 900)  # 15 min
        self.last_run = 0.0

    async def scan(self) -> Dict[str, Any]:
        """Run full vedic scan: sky state + scoring + transits."""
        scan_start = time.time()

        # ── 1. Get current sky state ──
        sky = get_sky_state()

        # ── 2. Compute composite vedic score ──
        vedic_score = compute_vedic_score(sky)

        # ── 3. Compute per-symbol transit scores ──
        transit_scores = compute_symbol_transits(TRACKED_SYMBOLS, sky)

        # ── 4. Write everything to Redis ──
        pipe = self.redis.pipeline()

        # Overall score
        score_data = {
            "score": vedic_score.overall_score,
            "label": vedic_score.label,
            "muhurta_score": vedic_score.muhurta_score,
            "nakshatra_score": vedic_score.nakshatra_score,
            "aspect_score": vedic_score.aspect_score,
            "retrograde_penalty": vedic_score.retrograde_penalty,
            "muhurta_label": vedic_score.muhurta_label,
            "timestamp": vedic_score.timestamp,
        }
        pipe.set("vedic:score", json.dumps(score_data), ex=REDIS_TTL)

        # Moon data
        moon_data = {
            "nakshatra": vedic_score.moon_nakshatra,
            "nakshatra_bias": vedic_score.moon_nakshatra_bias,
            "tithi": vedic_score.tithi_name,
            "tithi_number": vedic_score.tithi_number,
            "moon_phase_pct": vedic_score.moon_phase_pct,
            "hora_lord": vedic_score.hora_lord,
            "vara": vedic_score.vara_day,
            "timestamp": vedic_score.timestamp,
        }
        pipe.set("vedic:moon", json.dumps(moon_data), ex=REDIS_TTL)

        # Planet positions
        planet_data = {}
        for name, pos in sky.planets.items():
            planet_data[name] = {
                "longitude": round(pos.longitude, 4),
                "sign": pos.sign,
                "degrees_in_sign": round(pos.degrees_in_sign, 2),
                "speed": round(pos.speed, 4),
                "is_retrograde": pos.is_retrograde,
            }
        planets_payload = {
            "planets": planet_data,
            "retrogrades": vedic_score.retrogrades,
            "mercury_retrograde": vedic_score.is_mercury_retrograde,
            "ayanamsa": round(sky.ayanamsa, 4),
            "timestamp": vedic_score.timestamp,
        }
        pipe.set("vedic:planets", json.dumps(planets_payload), ex=REDIS_TTL)

        # Aspects
        aspects_data = {
            "aspects": vedic_score.active_aspects,
            "dominant_nature": "benefic" if vedic_score.aspect_score > 0.2
                else "malefic" if vedic_score.aspect_score < -0.2
                else "neutral",
            "aspect_score": vedic_score.aspect_score,
            "timestamp": vedic_score.timestamp,
        }
        pipe.set("vedic:aspects", json.dumps(aspects_data), ex=REDIS_TTL)

        # Muhurta
        muhurta_data = {
            "score": vedic_score.muhurta_score,
            "label": vedic_score.muhurta_label,
            "tithi": vedic_score.tithi_name,
            "nakshatra": vedic_score.moon_nakshatra,
            "hora_lord": vedic_score.hora_lord,
            "vara": vedic_score.vara_day,
            "factors": {
                "tithi": vedic_score.muhurta_score,  # Simplified
                "nakshatra": vedic_score.nakshatra_score,
            },
            "timestamp": vedic_score.timestamp,
        }
        pipe.set("vedic:muhurta", json.dumps(muhurta_data), ex=REDIS_TTL)

        # Per-symbol dasha states
        dasha_states = compute_all_dashas()
        dashas_written = 0
        for symbol, ds in dasha_states.items():
            dasha_data = {
                "maha_lord": ds.maha_dasha_lord,
                "maha_start": ds.maha_dasha_start.isoformat(),
                "maha_end": ds.maha_dasha_end.isoformat(),
                "maha_years": ds.maha_years_total,
                "antar_lord": ds.antar_dasha_lord,
                "antar_start": ds.antar_dasha_start.isoformat(),
                "antar_end": ds.antar_dasha_end.isoformat(),
                "antar_months": ds.antar_months_total,
                "interpretation": ds.market_interpretation,
                "maha_bias": ds.maha_bias,
                "antar_bias": ds.antar_bias,
                "combined_bias": ds.combined_bias,
                "timestamp": vedic_score.timestamp,
            }
            pipe.set(f"vedic:dasha:{symbol}", json.dumps(dasha_data), ex=REDIS_TTL)
            dashas_written += 1

        # Per-symbol transits
        symbols_with_transits = 0
        for symbol, ts in transit_scores.items():
            transit_data = {
                "score": ts.score,
                "label": ts.label,
                "hits": ts.hits,
                "summary": ts.summary,
                "timestamp": ts.timestamp,
            }
            pipe.set(f"vedic:transit:{symbol}", json.dumps(transit_data), ex=REDIS_TTL)
            symbols_with_transits += 1

        await pipe.execute()

        scan_duration = round(time.time() - scan_start, 2)

        # ── 5. Log summary ──
        retro_str = ", ".join(vedic_score.retrogrades) if vedic_score.retrogrades else "none"
        aspect_count = len(vedic_score.active_aspects)

        print(
            f"[{self.name}] Score={vedic_score.overall_score} ({vedic_score.label}) | "
            f"Moon={vedic_score.moon_nakshatra} ({vedic_score.moon_nakshatra_bias}) | "
            f"Tithi={vedic_score.tithi_name} #{vedic_score.tithi_number} | "
            f"Muhurta={vedic_score.muhurta_label} | "
            f"Aspects={aspect_count} | Retro=[{retro_str}] | "
            f"Mercury Rx={vedic_score.is_mercury_retrograde} | "
            f"Transits={symbols_with_transits} symbols | "
            f"Dashas={dashas_written} | "
            f"{scan_duration}s"
        )

        # Update agent status
        await state_manager.set_agent_status(self.name, "active", {
            "message": f"Score={vedic_score.overall_score} ({vedic_score.label})",
            "vedic_score": vedic_score.overall_score,
            "muhurta": vedic_score.muhurta_label,
            "moon_nakshatra": vedic_score.moon_nakshatra,
            "mercury_retrograde": vedic_score.is_mercury_retrograde,
        })

        return {
            "status": "ok",
            "score": vedic_score.overall_score,
            "label": vedic_score.label,
            "symbols_with_transits": symbols_with_transits,
            "scan_duration": scan_duration,
        }

    async def run_loop(self):
        """Periodically compute vedic intelligence."""
        if not self.enabled:
            print(f"[{self.name}] Disabled (vedic.enabled=false in cryonix.toml)")
            await state_manager.set_agent_status(self.name, "disabled", {
                "message": "vedic.enabled=false in cryonix.toml"
            })
            return

        print(
            f"[{self.name}] Starting vedic scout loop "
            f"(every {self.poll_interval}s, {len(TRACKED_SYMBOLS)} symbols)"
        )

        while True:
            try:
                now = time.time()
                if now - self.last_run >= self.poll_interval:
                    await self.scan()
                    self.last_run = now
            except Exception as e:
                print(f"[{self.name}] Error: {e}")
                import traceback
                traceback.print_exc()
                await state_manager.set_agent_status(self.name, "error", {
                    "message": str(e),
                })
                await asyncio.sleep(60)
                continue

            await asyncio.sleep(30)
