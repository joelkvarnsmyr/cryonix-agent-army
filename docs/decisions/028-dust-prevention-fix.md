# ADR-028: Fix Dust Prevention Threshold

**Date:** 2026-03-17
**Status:** Accepted

## Context

After fixing capital allocation to allow $15 trades on a $40 account, the system entered a **dust loop**: buying positions at ~$14.97 and immediately selling them as "dust" on the next 30-second cycle.

The root cause: dust prevention used `CONFIG.MIN_ORDER_VALUE` ($15) as the threshold, but this is our *desired* minimum buy size, not Binance's actual minimum. A $14.97 position is 3x above Binance's real NOTIONAL minimum ($5).

## Impact

6 trades overnight burned ~$0.64 in spread/fees for zero market exposure:
- LINK × 3, DOT × 1, XRP × 1: bought and sold within 30 seconds
- UNI: survived 4.6h but eventually dust-sold at -2.9%

## Decision

Use Binance's actual NOTIONAL minimum ($5) with safety buffer (1.5× = $7.50) for dust prevention, not our internal $15 minimum.

**Before:** `currentValue < CONFIG.MIN_ORDER_VALUE ($15)` → sell as dust
**After:** `currentValue < pairNotional × buffer ($7.50)` → sell as dust

Also applied 95% tolerance to both pre-execution checks (post-rounding and safe-min notional) to prevent $14.97 vs $15.00 floating-point rejections.

## Consequences

- Positions at $14-15 are no longer incorrectly flagged as dust
- Real dust protection still works at $7.50 (50% above Binance's $5 minimum)
- A position must drop ~50% before becoming actual dust
