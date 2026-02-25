# ADR-002: Hybrid Architecture — Python Engine + TypeScript Dashboard
**Date:** 2026-02-13 | **Status:** Active

## Context (Why)
Crypto trading requires both fast numerical analysis (technical indicators, pattern detection) and a responsive web dashboard (real-time monitoring, trade execution). Python excels at numerical/ML work; TypeScript/Next.js excels at web UIs and API routes.

## Decision (What)
Hybrid monorepo:
- **Python FastAPI engine** (Docker): Market scanning, QuantGuild pattern detection, risk gate
- **Next.js 15 app** (Docker): Dashboard UI, API routes, Binance execution via CCXT
- **Redis**: Message bus between engine and web (trades:pending queue)
- **Postgres**: Persistent storage for trades, signals, positions, analytics

## Consequences (How)
- Engine and web can scale independently
- Redis decouples signal generation from execution
- Both containers share the same Postgres for consistency
- Docker Compose orchestrates all 7+ containers on single Azure VM
- Complexity cost: two languages, two build systems, Docker networking
