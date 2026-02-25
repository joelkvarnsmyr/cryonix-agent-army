# ADR-013: Self-Calibration Cron
**Date:** 2026-02-25 | **Status:** Active

## Context (Why)
`calibrate.py` (pattern EV) ran every 6h via cron, but `self_calibrate.py` (signal accuracy -- did our predictions actually come true?) was never scheduled. This meant we had no automated measurement of filter effectiveness or opportunity cost of skipped signals.

## Decision (What)
Add `self_calibrate.py --hours 48` to cron at `:30` offset (avoids collision with `calibrate.py` at `:00`).

## Consequences (How)
- Runs every 6h: `30 */6 * * *`
- Writes to Redis `calibration:accuracy` (48h TTL) + Postgres `calibration_history`
- Measures: per-pattern hit rate, acted vs skipped accuracy, filter effectiveness score
- Data available for AI Brain and Evolution system to make informed decisions
