# ADR-008: AI Brain — Autonomous Parameter Tuning
**Date:** 2026-02-18 | **Status:** Active

## Context (Why)
Manual parameter tuning was slow and reactive. By the time we noticed a pattern was losing money, it had already cost us many trades. We needed automated analysis that could respond faster than humans.

## Decision (What)
AI Brain (`ai_brain.py`) runs every 6h + acute trigger on 3+ consecutive losses:
- Collects: closed trades, open positions, calibration data, pipeline stats, capital state
- Calls Grok API for analysis + action recommendations
- Validates actions against safety bounds (range limits, delta limits, minimum patterns)
- Actions: adjust confidence, block/unblock patterns, adjust stop-loss, flag stale positions

## Consequences (How)
- Respects baseline freeze (exits early when `[baseline] frozen = true`)
- All actions logged to `autopilot_actions` table + `config_changes`
- Writes `evolution:directives` to Redis for code-level insights
- Sends Telegram report after each run
- Safety: bounded parameter ranges prevent extreme changes
