# On-Chain Warning Detection Design

**Date:** 2026-03-10
**Status:** Approved

## Overview

Detect on-chain warnings (suspicious exchange deposits, whale moves, hacks, exploits) via X/Twitter search and automatically protect open positions. Two-component design: detection extends the existing X sentiment scanner, response hooks into the existing position monitoring loop.

## Problem

Open positions have no protection against sudden on-chain events (hacks, exploits, whale dumps) that move price faster than standard stop-loss orders can react. The existing `sentiment:alert:{SYMBOL}` Redis key already blocks new BUY signals for flagged symbols, but no mechanism exists to protect positions that are already open when an alert fires.

## Architecture

### Component 1 — Detection (`scripts/strategy-lab/x_sentiment.py`)

Add a second Grok query per symbol that searches specifically for on-chain warnings on X. Runs alongside the existing sentiment query every 15 minutes.

**Query prompt per symbol:**
```
Search X/Twitter for on-chain warnings about ${symbol} in the last 2 hours.
Look for: suspicious exchange deposits, whale moves to exchanges,
hack reports, exploit alerts, rug pulls, contract issues.

Respond JSON only:
{"alert": true/false, "severity": "critical|warning",
  "reason": "one sentence", "source": "@handle or null"}

critical = hack/exploit/rug/contract vulnerability
warning = large exchange deposits, whale sell preparation
```

**Output:** write `sentiment:alert:{SYMBOL}` as JSON to Redis (TTL: 3600s = 60 min)
```json
{
  "severity": "critical|warning",
  "reason": "...",
  "source": "@handle or null",
  "detected_at": "ISO timestamp"
}
```

**Idempotency:** if `sentiment:alert:{SYMBOL}` already exists in Redis with the same severity, do not overwrite and do not send a duplicate Telegram notification.

**Failure mode:** if the Grok query fails (timeout, rate limit), log a warning and do nothing — fail-open for detection. Positions are not touched on query failure.

### Component 2 — Response (`apps/web/src/app/api/auto-trade/route.ts`)

In the position monitoring loop (runs every 30s), add an alert check per open position:

```
If sentiment:alert:{SYMBOL} exists:
  severity=critical  → market sell (force close position)
  severity=warning   → move stop-loss to entry price (breakeven)
  → Telegram notification with warning + action taken
  → Log to agent_actions table
```

**Severity mapping:**

| Keywords | Severity | Action |
|----------|----------|--------|
| hack, exploit, rug, vulnerability, drained | critical | Force close (market sell) |
| exchange deposit, whale move, suspicious, large transfer, dump | warning | Tighten SL to entry (breakeven) |

### Backward Compatibility

`sentiment:alert:{SYMBOL}` changes from a plain string to a JSON object. The existing BUY-block logic in `auto-trade/route.ts` reads this key. Update the read to parse JSON, but fall back to treating it as a plain string if JSON parsing fails — no breaking change for any existing alert values.

## Telegram Notifications

**Warning (severity=warning):**
```
⚠️ On-chain varning: BARD/USDC

Källa: @rektfeed
Varning: Suspicious exchange deposits
Åtgärd: Stop-loss dragit till entry (0.0821)
```

**Critical (severity=critical):**
```
🚨 Kritisk varning: XYZ/USDC

Källa: @rektfeed
Varning: Exploit reported
Åtgärd: Position stängd (market sell)
```

## Logging

Actions logged to the existing `agent_actions` table:

| Field | Value |
|-------|-------|
| `action_type` | `"onchain_alert_exit"` or `"onchain_alert_sl_tighten"` |
| `details` | `{ symbol, severity, reason, source, old_sl, new_sl }` |

## Error Handling

| Step | On failure |
|------|-----------|
| Grok on-chain query fails | Log warning, skip — do not touch positions |
| Alert already in Redis (same severity) | Skip — no duplicate Telegram notification |
| Force close fails (Binance API error) | Log error, send Telegram alert, leave position |
| SL update fails | Log error, send Telegram alert |

## Files Changed

| File | Change |
|------|--------|
| `scripts/strategy-lab/x_sentiment.py` | Add on-chain warning query per symbol |
| `apps/web/src/app/api/auto-trade/route.ts` | Alert-check in position monitoring loop + JSON parsing of alert key |

## Not In Scope

- New data sources (Whale Alert API, Etherscan, Nansen, CryptoQuant)
- New containers or services
- Historical on-chain analytics
- Alert UI in the dashboard
