# ADR-015: Centralized Configuration via cryonix.toml
**Date:** 2026-02-16 | **Status:** Active

**Origin:** `docs/plans/2026-02-16-centralized-config-design.md`

### Context (Why)

89+ config values were spread across 12 files in both TypeScript and Python. An audit found 3 critical conflicts where the two runtimes disagreed on the same parameter:

- `MAX_OPEN_POSITIONS`: TypeScript = 3, Python = 5
- `MAX_POSITION_SIZE_PCT`: TypeScript = 25%, Python = 15%
- `TRADING_MODE`: code = "spot", docker-compose default = "margin"

Changing a single parameter required searching multiple files with the risk of silent drift between the Python engine and the TypeScript auto-trade route. There was no single source of truth and no way to verify all containers were running the same configuration.

### Decision (What)

Centralize all non-secret configuration into a single `cryonix.toml` file at the repo root, mounted as a read-only Docker volume into all containers.

Key design choices:
- **Both runtimes read the same file**: TypeScript via `@iarna/toml` (`loadConfig()` in `apps/web/src/lib/config.ts`), Python via stdlib `tomllib` (`get_toml()` in `packages/engine/src/core/config.py`), ESM scripts via a minimal custom parser (`scripts/lib/load-toml.mjs`).
- **Caching**: All loaders cache on first call (read once at startup, not per request).
- **Fallback defaults in code**: Every value has a hardcoded fallback so partial TOML is safe. The typed `CryonixConfig` interface acts as implicit schema validation.
- **Secrets stay in `.env`**: API keys, database URLs, and tokens are not in TOML.
- **Config hash tracking**: `configHash()` computes SHA-256 of raw TOML content. Health endpoint returns the hash, and every trade is tagged with an 8-char config version for impact analysis.

Migration was executed in 6 phases (loader, auto-trade route, Python engine, scripts, conflict resolution, validation/logging), each independently deployable and zero-risk due to fallback defaults.

### Consequences (How)

- **Positive**: Single source of truth for ~89 parameters. All 3 conflicts resolved. Config changes require editing one file and redeploying affected containers -- no code changes needed. Config version tracking enables measuring impact of parameter changes on trade outcomes.
- **Positive**: `:ro` Docker mount prevents containers from modifying config at runtime.
- **Trade-off**: TOML is read once at startup, so config changes require container restarts. No hot-reload, but this is acceptable for a trading system where predictability matters.
- **Trade-off**: No formal schema validation step -- relies on TypeScript interface + Python code defaults. Invalid TOML keys are silently ignored rather than flagged.
- **16 TOML sections** (658 lines with inline docs): trading, capital, limits, risk, exits, indicators, patterns, consensus, regime, boosting, timing, engine, sentiment, ai, ev_model, grid.
