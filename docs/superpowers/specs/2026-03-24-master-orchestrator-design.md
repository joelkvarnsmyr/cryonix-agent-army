# Master Orchestrator — Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Author:** Joel + Claude

## Summary

A master prompt (`MASTER_ORCHESTRATOR.md`) for Claude Code CLI that orchestrates the entire Cryonix Agent Army. Runs locally on Windows (32GB RAM), SSH to Azure VM for data/deploys, manages 10+ trading agents with profit as the primary objective.

## Problem

The Cryonix Agent Army has 10+ trading subsystems running independently. Each has its own brain/evolution but there is no centralized orchestration that:
- Cross-analyzes agent performance holistically
- Detects inter-agent conflicts (duplicate trades, opposing signals)
- Reallocates capital from losers to winners
- Discovers and creates new alpha sources
- Provides a unified profit dashboard

## Solution

A Claude Code CLI master orchestrator that runs every 4 hours via Windows Task Scheduler, executing a 6-phase cycle:

1. Health Check (VM services, stuck positions, circuit breakers)
2. Data Collection (Postgres trades/positions, Redis state, TOML configs via SSH)
3. Parallel Agent Audit (5 batches × 2 agents, max 5 parallel `claude -p`)
4. Meta-Analysis (cross-agent patterns, profit acceleration, pipeline health)
5. Mutation (TOML tweaks, code changes based on findings)
6. Report (Telegram summary + local full reports)

## Architecture

### Execution Model

```
Windows Task Scheduler (every 4h)
  └─ run_master_orchestrator.bat
       └─ claude -p --dangerously-skip-permissions --system-prompt-file MASTER_ORCHESTRATOR.md
            ├─ SSH → VM (Postgres, Redis, Docker)
            ├─ 5× parallel claude -p (agent audits)
            └─ Telegram API (reports)
```

### Autonomy Tiers

| Tier | Action | Approval |
|------|--------|----------|
| GREEN | TOML tweaks within bounds, pause agent, analyze, git commit | Self-approve, report after |
| YELLOW | Code mutation <100 lines, new paper agent, capital reallocation >20%, VM deploy | Self-approve with 15min Telegram veto window |
| RED | Paper→live promotion, delete agent, API key changes, emergency close-all | Must wait for human approval via Telegram |

### Constraints

- Max 5 parallel `claude -p` instances (32GB RAM - Docker overhead)
- Never run `docker compose build` directly (use `safe-deploy.sh`)
- Never mutate during baseline freeze
- Never commit secrets
- Max 100 lines diff per code mutation
- Always read current TOML values before changing

### Reporting

- **Telegram bot:** `@cryptoOrchestrator_bot` (dedicated, separate from existing bots)
- **Token env var:** `TELEGRAM_ORCHESTRATOR_BOT_TOKEN`
- **Local reports:** `reports/master-orchestrator/YYYY-MM-DD_HHMM/`
- Per-agent audit files + cycle summary + correlation matrix (weekly)

### Weekly/Monthly Extensions

- **Weekly (Sunday):** Alpha research sprint, correlation audit, cost coverage analysis
- **Monthly (1st):** Deep 30d audit, benchmark vs BTC/SPX, lifecycle review (promote/shutdown agents)

## Files

| File | Purpose |
|------|---------|
| `MASTER_ORCHESTRATOR.md` | The master prompt (system prompt file) |
| `scripts/orchestrator/run_orchestrator.bat` | Windows Task Scheduler entry point |
| `scripts/orchestrator/run_agent_audit.sh` | Parallel agent audit launcher |
| `scripts/orchestrator/watchdog.sh` | Monitors cron health, Telegram alerts |
| `reports/master-orchestrator/` | Output directory for cycle reports |

## Implementation Plan

To be created via writing-plans skill after spec approval.

## Dependencies

- Claude Code CLI installed locally with Max plan
- SSH key access to VM (`ssh azureuser@openclaw-vm`)
- `TELEGRAM_ORCHESTRATOR_BOT_TOKEN` env var set locally
- `TELEGRAM_ORCHESTRATOR_CHAT_ID` env var set locally
- Windows Task Scheduler configured

## Risks

| Risk | Mitigation |
|------|------------|
| PC off → missed cycles | Catch-up mechanism: run immediately on startup if >4h since last run |
| Parallel claude instances OOM | Hard cap at 5, monitor with watchdog |
| Bad mutation breaks system | Baseline freeze, backup before mutation, type-check after |
| Token cost explosion | Monitor tokens per cycle in reports, weekly cost analysis |
| VM SSH unavailable | Health check in Fas 1, skip cycle with Telegram alert |
