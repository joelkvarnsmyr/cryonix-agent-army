# ADR-005: GROK AI Validation — Fail-Closed
**Date:** 2026-02-14 | **Status:** Active

## Context (Why)
Technical signals alone had too many false positives. We needed a second opinion that could assess broader context (news, market structure, pattern quality). The question was: what happens when the AI is unavailable?

## Decision (What)
- Every BUY signal passes through GROK AI validation before execution
- **Fail-closed**: If AI is unavailable (timeout, error, rate limit), the signal is REJECTED
- AI blends its confidence with the signal's technical confidence
- Uses `grok-3-mini-fast` model for speed and cost

## Consequences (How)
- No accidental trades during AI outages
- Added latency (~2-5s per signal) but acceptable for swing trading
- AI reasoning stored in `validation_history` for post-trade analysis
- Retry with escalating timeout (60s, 120s, 180s) added in Phase 3
