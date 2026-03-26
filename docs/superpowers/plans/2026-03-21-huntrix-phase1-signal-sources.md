# Huntrix Phase 1 — Signal Source Expansion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 new free signal sources to Huntrix's ManipulationScanner — GoPlus Security (token safety), DeFi Llama hacks API (exploit alerts), RSS feeds (security/regulatory), and Binance order book spoofing detection — increasing detection coverage from 3 to 7 sources. Exploit/regulatory signals feed a **defensive blacklist** (block entry) rather than triggering trades.

**Architecture:** Each new source gets its own scanner class in `scanners/` subdirectory. Two signal flows: (1) **detection signals** feed into `fullScan()` for trade opportunities (existing P&D/shill flow), (2) **defensive signals** (exploits, enforcement, honeypots) write to Redis blacklist `huntrix:blacklist:{SYMBOL}` which `EntryValidator` checks before approving. All APIs are free, no auth keys needed.

**Tech Stack:** TypeScript, ioredis, native fetch (Node 18+), CCXT (existing)

**Research:** `Research/huntrix-manipulation-signal-sources.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/agents/src/huntrix/types.ts` | Add source types, `GoPlusTokenSecurity`, `DefiLlamaHack`, `RSSAlert`, `SpoofDetection`, extend `HuntrixConfig` |
| `packages/agents/src/huntrix/scanners/goplus.ts` | GoPlus Security API — honeypot, mint, tax checks + symbol-to-contract mapping |
| `packages/agents/src/huntrix/scanners/defi-llama-hacks.ts` | DeFi Llama hacks API — exploit/hack alerts → defensive blacklist |
| `packages/agents/src/huntrix/scanners/rss-feeds.ts` | RSS poller (6 feeds) — security firms + regulators → defensive blacklist |
| `packages/agents/src/huntrix/scanners/orderbook.ts` | Order book spoofing detection via CCXT snapshot comparison |
| `packages/agents/src/huntrix/manipulation-scanner.ts` | Wire scanners into `fullScan()` + `scanDefensiveBlacklist()` |
| `packages/agents/src/huntrix/entry-validator.ts` | Add GoPlus + blacklist checks |
| `packages/agents/src/huntrix/config.ts` | Add `scanner.sources` defaults |
| `packages/agents/src/huntrix/__tests__/goplus.test.ts` | GoPlus tests |
| `packages/agents/src/huntrix/__tests__/defi-llama-hacks.test.ts` | DeFi Llama tests |
| `packages/agents/src/huntrix/__tests__/rss-feeds.test.ts` | RSS tests |
| `packages/agents/src/huntrix/__tests__/orderbook.test.ts` | Spoofing tests |
| `huntrix.toml` | `[scanner.sources]` config |

---

## Tasks

### Task 1: Types + config

Expand `ManipulationSignal.source` union, add 4 new interfaces, add `scanner.sources` to `HuntrixConfig`, update config defaults and TOML.

### Task 2: GoPlus scanner + tests (7 tests)

Token safety via `api.gopluslabs.io`. Includes `SYMBOL_CONTRACTS` mapping for BSC/ETH tokens. `checkSymbol()` resolves symbols, `checkToken()` calls API. Redis cache 1h TTL.

### Task 3: DeFi Llama hacks scanner + tests (4 tests)

`api.llama.fi/hacks` — recent exploit/hack data. `extractSymbols()` maps chains/protocols to symbols. Redis cache 30min TTL.

### Task 4: RSS feed scanner + tests (5 tests)

6 verified feeds (Protos, Halborn×2, Chainalysis, CFTC, FCA). Simple regex XML parser for RSS 2.0 + Atom. `classifyArticle()` categorizes by keyword. Redis dedup via seen set.

### Task 5: Order book spoofing detector + tests (3 tests)

Snapshot comparison: detects large walls ($50K+) that disappear (80%+) without price filling through. `fromCCXT()` helper for integration.

### Task 6: Wire into ManipulationScanner

Import all 4 scanners. `scanDefensiveBlacklist()` writes DeFi Llama + RSS alerts to `huntrix:blacklist:{SYMBOL}` Redis keys (24h TTL). `scanOrderBook()` generates detection signals. Update `fullScan()` Promise.all. Config-gated via `scanner.sources.*_enabled`.

### Task 7: GoPlus + blacklist in EntryValidator

Check `huntrix:blacklist:{SYMBOL}` before approving entry. Check GoPlus cached data for honeypot/mintable/sell tax/risk score.

### Task 8: Tests + type check

Run all 4 test files (~20 tests). Full monorepo type check.

### Task 9: Deploy to VM

Archive → SSH → build → restart → verify logs + Redis keys.

---

See the full task details with code in the previous version of this file (git history), or ask the implementing agent to read the research document and existing scanner code for context.
