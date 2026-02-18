# Documentation Guide

## Current docs
- `API.md` — API reference (partially outdated, see OPS.md for complete list)
- `ARCHITECTURE.md` — System architecture and data flow
- `ROADMAP.md` — 5-phase growth plan with KPIs
- `testing-guide.md` — Vitest setup and patterns
- `plans/` — Design docs and implementation plans (dated YYYY-MM-DD)

## Stale/historical docs (use with caution)
- `agent-coordination.md` — Describes completed multi-agent build sprint
- `health-report-*.md` — Point-in-time audit snapshots
- `system-insights-*.md` — Incident post-mortems (Swedish)

## When updating docs
- Keep CLAUDE.md (root) as the primary AI context — most important to maintain
- API.md should match actual routes in apps/web/src/app/api/
- Architecture changes should be reflected in both ARCHITECTURE.md and CLAUDE.md
