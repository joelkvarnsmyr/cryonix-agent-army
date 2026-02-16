# Design: Centralized Configuration (cryonix.toml)

**Date:** 2026-02-16
**Status:** Approved for implementation

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

### Phase 1: Config Loader (no behavior change)

**Goal:** Add TOML reading capability. All values still come from code defaults but TOML overrides if present.

1. **Add `@iarna/toml` to apps/web** — TypeScript TOML parser
2. **Create `apps/web/src/lib/config.ts`:**
   - Read `/app/cryonix.toml` (Docker) or `../../cryonix.toml` (dev)
   - Export typed CONFIG object matching current shape
   - Fallback to current hardcoded values if TOML missing
3. **Update Python `config.py`:**
   - Read `/app/cryonix.toml` via `tomllib` (Python 3.11 stdlib)
   - Export config dict matching current shape
   - Fallback to current hardcoded values if TOML missing
4. **Mount TOML in docker-compose.prod.yml:**
   ```yaml
   volumes:
     - ./cryonix.toml:/app/cryonix.toml:ro
   ```
   Add to: web, engine, auto-trader, ws-server, telegram-bot
5. **Verify:** Deploy, check logs — no behavior change expected

### Phase 2: Migrate auto-trade/route.ts

**Goal:** Replace hardcoded CONFIG object with TOML-loaded values.

1. **Replace CONFIG block** (lines 43-65) with:
   ```typescript
   import { loadConfig } from '@/lib/config';
   const CONFIG = loadConfig();
   ```
2. **Remove hardcoded values** from:
   - `calculatePositionSize()` — uses CONFIG.* already
   - `executeBuy()` — uses CONFIG.* already
   - `monitorPositions()` — trailing stop, dust prevention
   - Capital allocator — regime adjustments
3. **Remove hardcoded spread/slippage** — use CONFIG.exits.*
4. **Verify:** Build, deploy, check that auto-trader behaves identically

### Phase 3: Migrate Python engine

**Goal:** Replace hardcoded values in quant.py and risk_manager.py.

1. **Update `quant.py`:**
   - Replace hardcoded indicator periods (RSI 14, BB 20, etc.)
   - Replace pattern thresholds (dip_buy_drawdown, deep_value_threshold)
   - Replace consensus gate multipliers
   - Replace ATR-based SL/TP multipliers
2. **Update `risk_manager.py`:**
   - Replace max_position_size_pct, max_open_positions, etc.
   - Remove conflicting values (now aligned via TOML)
3. **Update `risk_gate.py`:**
   - Read min_confidence from config
4. **Update tanks:**
   - market_scout.py: timeframe, candle_limit from config
   - news_scout.py: scan interval, sentiment expiration from config
5. **Verify:** Restart engine, check scanning/signal generation unchanged

### Phase 4: Migrate scripts

**Goal:** Scripts read timing values from TOML.

1. **auto-trader.mjs:** POLL_INTERVAL, HEALTH_CHECK_INTERVAL from TOML
2. **ws-server.mjs:** heartbeat, timeout from TOML
3. **telegram-interactive.mjs:** poll intervals from TOML
4. **Verify:** Restart all workers, check polling behavior

### Phase 5: Fix conflicts & clean docker-compose

**Goal:** Resolve the 3 critical conflicts found in audit.

1. **Remove TRADING_MODE default from docker-compose.prod.yml** — TOML is source of truth
2. **Remove DEFAULT_LEVERAGE from docker-compose.prod.yml** — TOML handles it
3. **Verify MAX_OPEN_POSITIONS=3** in TOML (resolves TS=3 vs Python=5 conflict)
4. **Verify MAX_POSITION_SIZE_PCT=0.25** in TOML (resolves TS=25% vs Python=15%)
5. **Clean .env:** Remove non-secret config that's now in TOML

### Phase 6: Validation & logging

**Goal:** Make config changes visible and safe.

1. **Log loaded config on startup** — each container logs key values
2. **Add config hash to /api/health** — verify all containers use same TOML
3. **TOML schema validation** — reject startup if required keys missing

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

## Estimated Effort per Phase

- Phase 1: Config loaders + Docker mount — small
- Phase 2: Migrate auto-trade/route.ts — medium (largest file, most values)
- Phase 3: Migrate Python engine — medium (quant.py has ~30 values)
- Phase 4: Migrate scripts — small (5-6 values each)
- Phase 5: Fix conflicts + clean compose — small
- Phase 6: Validation + logging — small
