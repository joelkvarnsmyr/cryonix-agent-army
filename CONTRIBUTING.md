# Contributing to Cryonix

## Project Overview

Cryonix is an autonomous AI crypto trading system. See [README.md](README.md) for architecture and [AGENTS.md](AGENTS.md) for the autonomous systems.

## Quick Start

```bash
pnpm install
cp .env.example apps/web/.env.local  # Fill in your keys
docker compose up -d                  # Start postgres + redis + engine
pnpm dev                              # Start Next.js dashboard
```

Prerequisites: Node 20+, Python 3.11+, pnpm 9+, Docker

## Repository Structure

- `apps/web/` — Next.js dashboard + API routes + trade execution
- `packages/engine/` — Python FastAPI scanner (Docker)
- `packages/database/` — Drizzle ORM schema (19 tables)
- `packages/types/` — Shared TypeScript types
- `packages/ui/` — shadcn/ui component library
- `scripts/` — Services, evolution, strategy lab, deploy tools

## Development Workflow

1. Make changes in a feature branch
2. Run type check: `pnpm type-check`
3. Run tests: `pnpm test`
4. Build: `pnpm build`
5. Test locally with Docker: `docker compose up -d`
6. Create a pull request with conventional commit message

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(scope):` — New feature
- `fix(scope):` — Bug fix
- `docs(scope):` — Documentation
- `refactor(scope):` — Code restructuring
- `chore(scope):` — Maintenance

Common scopes: `auto-trade`, `engine`, `dashboard`, `evolution`, `telegram`, `db`, `calibration`

## Key Guidelines

- **CLAUDE.md is the source of truth** — update it when architecture changes
- **cryonix.toml for config** — don't hardcode trading parameters
- **Fail-closed AI validation** — if AI is unavailable, reject the signal
- **SPOT_ONLY** — no short selling, no margin trading
- **Test before deploy** — `pnpm type-check && pnpm build`
- **Config version tracking** — every trade is tagged with a config hash

## AI-Assisted Development

This project uses Claude Code for development and evolution. AI-generated code is welcome.

- Mark AI-assisted commits with `Co-Authored-By: Claude <noreply@anthropic.com>`
- The evolution engine makes autonomous commits prefixed with `[Auto-Evolution]`
- Design documents go in `docs/plans/YYYY-MM-DD-<topic>.md`

## Production Deployment

See [OPS.md](OPS.md) for the full operations guide. Quick deploy:

```bash
docker compose -f docker-compose.prod.yml build <service>
docker compose -f docker-compose.prod.yml up -d <service>
```

## Documentation

| Document | Purpose |
|----------|---------|
| `CLAUDE.md` | AI context (keep updated) |
| `AGENTS.md` | Autonomous systems reference |
| `OPS.md` | Operations runbook |
| `docs/API.md` | API endpoint reference |
| `docs/ARCHITECTURE.md` | System architecture |
| `docs/ROADMAP.md` | Growth plan |
| `CHANGELOG.md` | Version history |
| `VISION.md` | Project vision and principles |
