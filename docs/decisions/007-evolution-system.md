# ADR-007: Evolution System — Autonomous Code Mutation
**Date:** 2026-02-15 | **Status:** Active

## Context (Why)
Trading parameters need continuous optimization as market conditions change. Manual tuning creates a bottleneck and is always reactive. We needed a system that could propose and test parameter changes autonomously.

## Decision (What)
Claude Code CLI-driven evolution engine (`copilot-evolution.mjs`) every 2 hours:
- Analyzes pattern P&L from trades + position_history
- Generates mutation plan via Claude Code
- Backs up cryonix.toml before each mutation
- Applies mutation + verification scripts
- Logs structured TOML diffs to `evolution_runs` table

## Consequences (How)
- Respects baseline freeze
- Backups in `.evolution-backups/{run_id}/`
- Commits with `[Auto-Evolution {run_id}]` prefix
- Structured `changes_made` JSONB: `[{param, section, old, new}]`
- Three systems can mutate params: Evolution (2h), AI Brain (6h), Calibration (6h)
