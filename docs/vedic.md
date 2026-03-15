# Vedic Astrology Trading System

Pure Jyotish-based market timing for crypto trading. Uses Swiss Ephemeris (`pyswisseph`) for sidereal planetary calculations — no external APIs, all computation is local.

## Architecture

```
VedicScout (Python, engine container, every 15min)
  -> get_sky_state() via pyswisseph (sidereal, Lahiri ayanamsa)
  -> compute_vedic_score() — composite market timing (-100 to +100)
  -> compute_symbol_transits() — per-symbol natal transit + bhava scores
  -> compute_all_dashas() — 120-year planetary period states
  -> Write to Redis (vedic:score, vedic:moon, vedic:transit:{SYM}, etc.)

VedicTrader (Python, vedic-trader container, every 5min)
  -> Read vedic scores from VedicScout computation
  -> Fetch real prices from Binance via CCXT
  -> Apply trading rules (7 gates: score, Mercury Rx, lunar phase, muhurta,
     nakshatra, transit, dasha)
  -> Execute paper trades (simulated $1000 wallet in Redis)
  -> Track P&L per symbol, trailing stops, lunar exits
```

## Module Reference

### Core Modules (`packages/engine/src/vedic/`)

#### `ephemeris.py` — Swiss Ephemeris Wrapper

Provides sidereal (nirayana) planetary positions using Lahiri ayanamsa.

| Component | Description |
|-----------|-------------|
| `PlanetPosition` | Planet in sidereal zodiac (longitude, sign, speed, retrograde) |
| `SkyState` | Complete sky snapshot — all 9 planets at a moment |
| `get_sky_state(dt)` | Compute full sky state for any datetime |
| `get_angular_distance(a, b)` | Shortest distance between two longitudes (0-180) |

**Planets:** Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn, Rahu (mean node), Ketu (Rahu + 180)

---

#### `nakshatras.py` — 27 Lunar Mansions

Each of the 27 nakshatras spans 13 20' of the zodiac and has a trading bias.

| Bias | Nakshatras |
|------|------------|
| Bullish | Ashwini, Rohini, Pushya (best), Purva Phalguni, Hasta, Vishakha, Dhanishtha, Purva/Uttara Ashadha, Revati |
| Bearish | Bharani, Ashlesha, Jyeshtha |
| Volatile | Krittika, Ardra, Swati, Mula (worst), Shatabhisha, Purva Bhadrapada |
| Neutral | Mrigashira, Magha, Uttara Phalguni, Anuradha, Shravana, Uttara Bhadrapada |

**Scoring:** `moon_nakshatra_score()` returns -1.0 to +1.0 (Pushya +0.9, Mula -0.7).

---

#### `aspects.py` — Planetary Aspects (Drishti)

Detects conjunctions and aspects between planets with market interpretations.

| Pattern | Nature | Effect |
|---------|--------|--------|
| Jupiter-Saturn conjunction/trine | Benefic | Major cycle — institutional expansion |
| Mars-Saturn conjunction | Malefic | Frustration, blocked energy |
| Jupiter-Rahu (Guru Chandal) | Mixed | Unconventional growth, speculation |
| Mars-Rahu (Angarak) | Malefic | Explosive volatility |
| Saturn-Rahu (Shrapit) | Malefic | Karmic restriction |
| Moon-Rahu (Grahan) | Malefic | Emotional chaos |

**Vedic special aspects:** Mars also aspects 4th/8th; Jupiter also 5th/9th; Saturn also 3rd/10th.

---

#### `muhurta.py` — Auspicious Timing

Research-calibrated muhurta scoring (Yuan et al 2006, Dichev & Janes).

| Factor | Weight | Source |
|--------|--------|--------|
| Tithi + Lunar phase | 45% | Yuan et al: 3-5% annual difference new vs full moon |
| Nakshatra | 35% | Traditional Jyotish |
| Vara (weekday) | 10% | Traditional |
| Hora (planetary hour) | 10% | Traditional |

**Lunar phase gradient:**
- Shukla paksha (waxing, days 1-15): Bullish. Peak buy window tithis 2-10 (+0.20)
- Krishna paksha (waning, days 16-30): Bearish (-0.15 early, -0.05 late)
- Purnima (full moon): -0.35 (strongest single-day bearish signal)
- Amavasya (new moon): +0.30 (strongest single-day bullish signal)

**Vara bias:** Thursday (Jupiter) and Wednesday/Friday most bullish. Saturday (Saturn) bearish.

---

#### `natal.py` — Crypto Genesis Charts

16 cryptocurrencies with birth timestamps and geographic coordinates.

| Symbol | Genesis Date | City | Lagna |
|--------|-------------|------|-------|
| BTC | 2009-01-03 18:15 UTC | London, UK | Cancer |
| ETH | 2015-07-30 15:26 UTC | Zug, Switzerland | Scorpio |
| BNB | 2017-07-25 00:00 UTC | Shanghai, China | Leo |
| SOL | 2020-03-16 00:00 UTC | San Francisco, CA | Leo |
| ADA | 2017-09-29 00:00 UTC | Hong Kong | — |
| XRP | 2012-06-02 00:00 UTC | San Francisco, CA | — |
| AVAX | 2020-09-21 00:00 UTC | New York City, NY | — |
| DOT | 2020-05-26 00:00 UTC | Zug, Switzerland | — |
| LINK | 2017-09-19 00:00 UTC | San Francisco, CA | — |
| ATOM | 2019-03-14 00:00 UTC | San Francisco, CA | — |
| DOGE | 2013-12-06 00:00 UTC | Portland, OR | Taurus |
| NEAR | 2020-10-13 00:00 UTC | San Francisco, CA | — |
| SUI | 2023-05-03 00:00 UTC | Palo Alto, CA | — |
| UNI | 2018-11-02 00:00 UTC | New York City, NY | — |
| AAVE | 2017-11-27 00:00 UTC | Helsinki, Finland | Virgo |
| LTC | 2011-10-07 00:00 UTC | Mountain View, CA | — |

> Lagna column shows computed Ascendant signs (all 16 are computed, only a few shown for reference).

**Transit analysis:** Checks 7 transiting planets against 5 natal planets. Slow movers (Jupiter, Saturn, Rahu, Ketu) weighted 1.5x. Tighter orb = stronger effect.

---

#### `dasha.py` — Vimshottari Dasha (120-Year Cycle)

Planetary period system based on natal Moon position.

| Lord | Years | Bias | Market Effect |
|------|-------|------|---------------|
| Ketu | 7 | -0.2 | Unexpected moves, detachment |
| Venus | 20 | +0.6 | Bull runs, luxury, gains |
| Sun | 6 | +0.1 | Regulatory focus, authority |
| Moon | 10 | 0.0 | Sentiment-driven swings |
| Mars | 7 | +0.2 | Volatile breakouts, energy |
| Rahu | 18 | +0.3 | Hype, bubbles, amplification |
| Jupiter | 16 | +0.7 | Institutional adoption (strongest bullish) |
| Saturn | 19 | -0.5 | Bear markets, consolidation (strongest bearish) |
| Mercury | 17 | +0.3 | Tech upgrades, communication |

**Combined bias** = `maha_bias * 0.7 + antar_bias * 0.3`

Symbols with `combined_bias < -0.3` are skipped by the trader.

---

#### `lagna.py` — Ascendant & House System

Computes the rising sign (Lagna) at genesis using `swe.houses()` with Whole Sign system.

**12 Houses (Bhava) — Financial Significance:**

| House | Name | Weight | Meaning |
|-------|------|--------|---------|
| 1 | Lagna | 0.0 | Self/identity — baseline |
| 2 | Dhana | +0.6 | Accumulated wealth, assets |
| 3 | Sahaja | +0.1 | Effort, initiative |
| 4 | Sukha | +0.2 | Stability, foundations |
| 5 | Putra | +0.5 | Speculation, creativity |
| 6 | Ripu | -0.4 | Obstacles, debt, competition |
| 7 | Kalatra | +0.2 | Partnerships, contracts |
| 8 | Randhra | -0.5 | Sudden crises (but also windfalls) |
| 9 | Bhagya | +0.7 | Fortune, luck — great fortune house |
| 10 | Karma | +0.4 | Public status, achievement |
| 11 | Labha | +0.8 | Gains, income — best house |
| 12 | Vyaya | -0.6 | Losses, dissolution |

**Scoring:** Benefics in wealth houses (2, 5, 9, 11) = bullish. Malefics in loss houses (6, 8, 12) = bearish. Slow movers weighted 2x.

---

#### `scoring.py` — Composite Score Engine

Combines all vedic signals into actionable scores.

**Overall Score** (-100 to +100):
```
composite = muhurta * 0.45 + nakshatra * 0.20 + aspects * 0.20 + retrogrades * 0.15
```

| Label | Score Range |
|-------|-------------|
| very_bullish | >= 40 |
| bullish | >= 15 |
| neutral | >= -15 |
| bearish | >= -40 |
| very_bearish | < -40 |

**Per-Symbol Transit Score** (-100 to +100):
```
blended = transit_aspects * 0.75 + bhava_score * 0.25
```

---

### Infrastructure

#### `vedic_scout.py` — VedicScout Tank

Runs inside the engine container. Polls every 15 minutes (configurable via `vedic.poll_interval_seconds` in `cryonix.toml`).

**Redis Keys Written** (TTL 30min):

| Key | Content |
|-----|---------|
| `vedic:score` | Overall score, label, muhurta/nakshatra/aspect sub-scores |
| `vedic:moon` | Nakshatra, tithi, phase%, paksha, full/new moon, hora, vara |
| `vedic:planets` | All 9 planet positions, retrogrades, ayanamsa |
| `vedic:aspects` | Active aspects with nature and market effect |
| `vedic:muhurta` | Muhurta score, label, factors breakdown |
| `vedic:dasha:{SYM}` | Maha/Antar dasha lord, dates, bias, interpretation |
| `vedic:transit:{SYM}` | Transit score, label, hits, lagna_sign, bhava_score |

**Config** (`cryonix.toml`):
```toml
[vedic]
enabled = true
poll_interval_seconds = 900
```

---

#### `vedic-trader.py` — Paper Trading Bot

Paper trades $1000 across 16 cryptos using only vedic signals. Fetches real Binance prices via CCXT.

**Trading Rules (7 Gates):**

1. **Score gate:** Composite vedic score >= 10
2. **Mercury Rx block:** No buys during Mercury retrograde
3. **Lunar phase gate:** Only buy during Shukla paksha (waxing moon). Full moon blocked.
4. **Muhurta gate:** Muhurta must be "neutral" or above
5. **Nakshatra gate:** Moon nakshatra must have bullish or neutral bias
6. **Transit gate:** Per-symbol transit score >= -20
7. **Dasha gate:** Symbol's combined dasha bias >= -0.3

**Sell Conditions:**
- Hard stop-loss: -4% from entry
- Hard take-profit: +10% from entry
- Trailing stop: Activates at +3% profit, trails at -1.5% from peak
- Vedic score drops below -20
- Full moon (Purnima): Profit-taking sell
- Krishna paksha (waning moon): Sell if profit > 2%

**Position Sizing:**
- 10% of balance per trade
- Max 3 concurrent positions
- Max 1 position per symbol

**Redis Keys:**

| Key | Content |
|-----|---------|
| `vedic_trader:wallet` | Balance, positions, trade count, wins/losses, P&L |
| `vedic_trader:trades` | Trade history (last 500) |
| `vedic_trader:stats` | Performance summary (win rate, P&L, per-symbol) |

---

#### `backtest_vedic.py` — Backtester

Backtest the vedic strategy against historical price data.

```bash
# Single symbol
docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/backtest_vedic.py \
  --symbol BTC --days 90

# All 16 symbols
docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/backtest_vedic.py \
  --all --days 60 --json

# Custom timeframe
docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/backtest_vedic.py \
  --symbol ETH --days 30 --timeframe 1h
```

**Metrics reported:**
- Win rate, total P&L, average return %
- Max drawdown, Sharpe ratio, Sortino ratio
- Average hold time (hours)
- Nakshatra performance breakdown
- Dasha period performance breakdown
- Mercury retrograde win rate
- Auspicious muhurta win rate

---

### Docker

**Dockerfile.vedic-trader:**
- Base: `python:3.11-slim`
- Build deps: `gcc`, `g++`, `python3-dev` (for pyswisseph C extension)
- Python packages: `pyswisseph>=2.10`, `redis>=5.0`, `ccxt>=4.2`, `httpx>=0.26`
- Env: `PYTHONUNBUFFERED=1`

**Engine Dockerfile** also requires `g++` for pyswisseph.

---

## Research Basis

The system's parameter calibration is based on published academic research:

| Source | Finding | Application |
|--------|---------|-------------|
| Yuan et al (2006) | 3-5% annual return difference new vs full moon, 48 countries | Tithi weight 45%, lunar phase gradient |
| Dichev & Janes (2003) | New moon returns = 2x full moon over 100 years | Shukla paksha buy gate |
| Crawford (Bradley Siderograph) | Planetary aspects predict turning points, not direction | Transit aspect detection |
| Kashyap (Vedic risk framework) | Astrology as discipline tool: asymmetric risk/reward (2.5:1) | SL 4% / TP 10% ratio |
| Altman (Mercury Retrograde) | Communication breakdowns correlate with market volatility | Mercury Rx buy block |

## Data Flow Diagram

```
pyswisseph (Swiss Ephemeris)
  |
  v
ephemeris.py ──> SkyState (9 planets, sidereal positions)
  |
  |──> nakshatras.py ──> Moon nakshatra + trading bias
  |──> aspects.py ──> Active aspects + market effects
  |──> muhurta.py ──> Tithi + Vara + Hora ──> MuhurtaScore
  |──> natal.py ──> Genesis charts ──> Transit analysis
  |──> dasha.py ──> 120-year planetary periods
  |──> lagna.py ──> Ascendant + 12-house placements
  |
  v
scoring.py ──> VedicScore (-100 to +100) + SymbolTransitScore per symbol
  |
  v
vedic_scout.py ──> Redis (vedic:score, vedic:transit:*, vedic:dasha:*, etc.)
  |
  v
vedic-trader.py ──> Read scores + fetch Binance prices ──> Paper trades
```
