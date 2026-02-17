# Design: Centralized Configuration (cryonix.toml)

**Date:** 2026-02-16
**Status:** ALL PHASES COMPLETE — deployed & running in production

## Progress

| Phase | Status | Commit | Notes |
|-------|--------|--------|-------|
| 1. Config Loader | Done | `c986299` | TS `loadConfig()` + Python `get_toml()` + Docker mounts |
| 2. auto-trade/route.ts | Done | `8192be5` | 30 hardcoded values migrated |
| 3. Python engine | Done | `2484bc9` | ~47 values across quant.py, risk_manager.py, tanks |
| 4. Scripts | Done | (this commit) | auto-trader, ws-server, telegram-bot read from TOML |
| 5. Fix conflicts & clean | Done (implicitly) | Via Phase 2-3 | All 3 conflicts resolved through TOML |
| 6. Validation & logging | Done | (this commit) | Config hash in /api/health, TOML hash logged on startup |

## Problem

89+ config values spread across 12 files. 3 critical conflicts found:
- MAX_OPEN_POSITIONS: TS=3, Python=5
- MAX_POSITION_SIZE_PCT: TS=25%, Python=15%
- TRADING_MODE: code='spot', docker-compose default='margin'

Changing a parameter requires searching multiple files. Risk of silent drift.

## Solution

Single `cryonix.toml` at repo root, mounted as Docker volume into all containers.
Both TypeScript and Python read from the same file. Secrets stay in `.env`.

## Architecture

```
cryonix.toml (repo root)
    │
    ├── TypeScript: loadConfig() in apps/web/src/lib/config.ts
    │     └── Reads TOML, exports typed CONFIG object
    │     └── Used by: auto-trade/route.ts, all API routes
    │
    ├── Python: load_config() in packages/engine/src/core/config.py
    │     └── Reads TOML via tomllib (stdlib Python 3.11+)
    │     └── Used by: quant.py, risk_manager.py, risk_gate.py, tanks
    │
    └── Docker: volume mount in docker-compose.prod.yml
          └── ./cryonix.toml:/app/cryonix.toml:ro
```

## Migration Plan

### Phase 1: Config Loader (no behavior change) — DONE

**Commit:** `c986299`

Implemented:
- **TypeScript:** `apps/web/src/lib/config.ts` — `loadConfig()` returns typed CONFIG, `fullConfig()` returns raw TOML object. Uses `@iarna/toml`.
- **Python:** `packages/engine/src/core/config.py` — `load_toml_config()` + `get_toml(section, key, default)`. Uses `tomllib` (stdlib). Fixed `IndexError` for Docker path depth.
- **Docker:** `./cryonix.toml:/app/cryonix.toml:ro` mounted to web, engine, auto-trader, ws-server, telegram-bot.
- **Pattern:** Both loaders cache on first call, log source path, fall back gracefully.

### Phase 2: Migrate auto-trade/route.ts — DONE

**Commit:** `8192be5`

Migrated 30 hardcoded values using pattern `TOML?.section.key ?? fallback`:
- **Timing (7):** cycle interval, health check, regime refresh, queue poll, instance lock TTL, reconcile interval
- **Regime (6):** volatile/trending/ranging multipliers, volatile risk reduction
- **Position sizing (3):** min order value, boost allocations
- **AI validation (5):** confidence thresholds, temperature, timeout, model
- **Exits (4):** trailing stop, profit lock, spread limit
- **Boosting (3):** gainer thresholds, telegram boost
- **Risk (3):** daily drawdown limit, reconciliation variance

Key fix: Moved CONFIG/TOML declarations before INSTANCE_LOCK section to resolve TypeScript temporal dead zone error.

### Phase 3: Migrate Python engine — DONE

**Commit:** `2484bc9`

Migrated ~47 values across 5 files using pattern `get_toml('section', 'key', default)`:

- **`quant.py` (~25 values):** RSI period, Bollinger period/std, MACD params, EMA periods, ADX period. Pattern thresholds: dip buy drawdown/lookback/max_rsi, deep value threshold/rug pull velocity, volume spike/Bollinger squeeze. Consensus boosts. Exit SL/TP ATR multipliers. Regime: volatile ATR expansion, ADX trending, volume confirmation.
- **`risk_manager.py` (~15 values):** RiskLimits dataclass uses `__post_init__` to load TOML overrides for max_daily_loss_pct, max_position_size_pct, max_open_positions, min_confidence, etc. ATR-based SL/TP multipliers. Kelly fraction multiplier.
- **`market_scout.py` (~5 values):** timeframe, candle_limit, regime TTL, gainer min change, volume confirmation.
- **`news_scout.py` (2 values):** sentiment expiration, scan interval.
- **`config.py` fix:** Wrapped `Path(__file__).parents[4]` in try/except for Docker path depth.

### Phase 4: Migrate scripts — DONE

Created `scripts/lib/load-toml.mjs` — minimal TOML parser for ESM scripts (no dependencies).
Updated `Dockerfile.scripts` to copy `scripts/lib/`.

Migrated:
- **`auto-trader.mjs` (2 values):** `POLL_INTERVAL` → `timing.auto_trader_poll_ms`, `HEALTH_CHECK_INTERVAL` → `timing.health_check_interval_ms`
- **`ws-server.mjs` (2 values):** heartbeat interval → `timing.ws_heartbeat_ms`, timeout → `timing.ws_timeout_ms`
- **`telegram-interactive.mjs` (3 values):** `POLL_INTERVAL` → `timing.telegram_poll_ms`, `HEALTH_INTERVAL` → `timing.health_check_interval_ms`, `TRADE_POLL` → `timing.trade_alert_poll_ms`

All scripts log `[CONFIG] Loaded cryonix.toml from /app/cryonix.toml` on startup.

### Phase 5: Fix conflicts & clean docker-compose — DONE (resolved via Phase 2-3)

All 3 critical conflicts are resolved — both TS and Python now read from the same TOML:
- **MAX_OPEN_POSITIONS:** `limits.max_open_positions = 3` (was TS=3, Python=5)
- **MAX_POSITION_SIZE_PCT:** `capital.max_position_size_pct = 0.25` (was TS=25%, Python=15%)
- **TRADING_MODE:** `trading.mode = "spot"` (was code='spot', compose default='margin')

Remaining cleanup (low priority):
- Remove TRADING_MODE/DEFAULT_LEVERAGE defaults from docker-compose.prod.yml environment
- Clean non-secret config from .env

### Phase 6: Validation & logging — DONE

Implemented:
- **Config hash in /api/health:** `configHash()` export in `config.ts` computes SHA-256 of raw TOML content. Health endpoint returns `"configHash": "46e48c474ffa"` — use this to verify all containers run the same config.
- **Startup logging:** All loaders (TS, Python, ESM scripts) log source path and hash on first load.
- **Schema validation:** Not implemented as separate step — the typed `CryonixConfig` interface in `config.ts` acts as implicit schema, and all code has fallback defaults for missing keys.

## TypeScript Config Loader (lib/config.ts)

```typescript
import { readFileSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';

interface CryonixConfig {
  trading: { mode: string; spot_only: boolean; margin_type: string; default_leverage: number };
  capital: { max_position_size_pct: number; min_order_value: number; /* ... */ };
  limits: { max_open_positions: number; /* ... */ };
  risk: { max_daily_loss_pct: number; min_confidence: number; /* ... */ };
  exits: { trailing_stop_pct: number; /* ... */ };
  // ... all sections
}

let cached: CryonixConfig | null = null;

export function loadConfig(): CryonixConfig {
  if (cached) return cached;

  const paths = [
    '/app/cryonix.toml',              // Docker
    join(process.cwd(), 'cryonix.toml'),  // Dev (repo root)
    join(__dirname, '../../../../cryonix.toml'),  // Fallback
  ];

  for (const p of paths) {
    try {
      const raw = readFileSync(p, 'utf-8');
      cached = parse(raw) as unknown as CryonixConfig;
      console.log(`[CONFIG] Loaded from ${p}`);
      return cached;
    } catch { continue; }
  }

  throw new Error('[CONFIG] cryonix.toml not found');
}
```

## Python Config Loader (config.py)

```python
import tomllib
from pathlib import Path

_cached = None

def load_config() -> dict:
    global _cached
    if _cached:
        return _cached

    paths = [
        Path("/app/cryonix.toml"),           # Docker
        Path(__file__).parents[4] / "cryonix.toml",  # Dev
    ]

    for p in paths:
        if p.exists():
            with open(p, "rb") as f:
                _cached = tomllib.load(f)
                print(f"[CONFIG] Loaded from {p}")
                return _cached

    raise FileNotFoundError("[CONFIG] cryonix.toml not found")
```

## Docker Volume Mount

```yaml
# docker-compose.prod.yml — add to each service
services:
  web:
    volumes:
      - ./cryonix.toml:/app/cryonix.toml:ro
  engine:
    volumes:
      - ./cryonix.toml:/app/cryonix.toml:ro
  auto-trader:
    volumes:
      - ./cryonix.toml:/app/cryonix.toml:ro
  ws-server:
    volumes:
      - ./cryonix.toml:/app/cryonix.toml:ro
  telegram-bot:
    volumes:
      - ./cryonix.toml:/app/cryonix.toml:ro
```

## What stays in .env

Only secrets:
- BINANCE_API_KEY, BINANCE_API_SECRET
- XAI_API_KEY
- POSTGRES_URL, KV_URL
- TELEGRAM_BOT_TOKEN, TELEGRAM_INTERACTIVE_BOT_TOKEN
- TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION
- TELEGRAM_CHANNELS

## Risk Mitigation

- **Phase 1 is zero-risk:** TOML is read but code falls back to hardcoded values
- **Each phase is independently deployable** — partial migration is safe
- **`:ro` mount** prevents containers from modifying the config
- **Config caching** means TOML is read once at startup, not on every request

## cryonix.toml Documentation

The TOML file (658 lines) contains comprehensive inline documentation for every value:
- Section headers explain the category, when to change it, and what it affects
- Every value has comments explaining what it does, the math behind it, and practical guidance
- Values are grouped into 16 sections: trading, capital, limits, risk, exits, indicators, patterns, consensus, regime, boosting, timing, engine, sentiment, ai, ev_model, grid

To edit configuration: modify `cryonix.toml` at repo root, then redeploy affected containers.
No code changes needed — all values have safe fallback defaults in the code itself.

## Migration Complete

All 6 phases are done. The system is fully centralized on `cryonix.toml`.
