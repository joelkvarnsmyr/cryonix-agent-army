# Cryonix Vision

## What is Cryonix?

Cryonix is an autonomous AI crypto trading system that scans markets, validates signals with AI, and executes trades on Binance — all without human intervention.

It started as a learning project to explore algorithmic trading and AI-driven decision-making. It evolved into a production system running 24/7 on an Azure VM, managing real capital.

## Current State

- **Capital:** ~$42 USDC
- **Mode:** Spot-only, USDC pairs on Binance
- **AI:** Grok 4.1 for trade validation (fail-closed)
- **Self-improvement:** Autonomous evolution engine mutates parameters every 2h
- **Monitoring:** Telegram bots, health checks, calibration pipeline

## Growth Plan

| Phase | Goal | Capital Range | Focus |
|-------|------|---------------|-------|
| Fas 0 | Foundation | $42 | Build and stabilize core systems |
| Fas 1 | Validation | $42-100 | Prove consistent profitability |
| Fas 2 | Scaling | $100-500 | Diversify strategies, add grid trading |
| Fas 3 | Optimization | $500-2000 | ML models, advanced risk management |
| Fas 4 | Growth | $2000-5000 | Multi-exchange, longer timeframes |
| Fas 5 | Maturity | $5000+ | Full autonomy, regulatory compliance |

See [docs/ROADMAP.md](docs/ROADMAP.md) for detailed KPIs and exit criteria per phase.

## Design Principles

1. **Fail-closed over fail-open** — If AI validation is unavailable, reject the trade. Safety first.
2. **Small bets, compounding** — Start with minimal position sizes, grow through consistent small wins.
3. **Self-improving** — The system should get better over time through calibration, evolution, and data analysis.
4. **Observable** — Every decision logged, every parameter change tracked, every trade attributed to a config version.
5. **Simple until proven otherwise** — No overengineering. Add complexity only when data shows it's needed.

## What Makes Cryonix Different

Most trading bots are black boxes that run a fixed strategy. Cryonix is designed as a **learning system**:

- **Evolution engine** autonomously adjusts parameters based on trade performance
- **Calibration pipeline** measures which patterns actually work and blocks unprofitable ones
- **Config version tracking** links every trade to the exact parameters that produced it
- **Trade journal** enables before/after analysis of every change

The goal isn't just to trade — it's to **understand why trades succeed or fail** and systematically improve.

## Technology

- **TypeScript + Python** — Next.js dashboard/execution + Python FastAPI scanner
- **Docker Compose** — 8 containers on Azure VM
- **AI stack** — Grok 4.1 (trade validation), Claude Code (evolution/development)
- **Infrastructure** — Binance (CCXT), PostgreSQL, Redis, Telegram, Caddy reverse proxy
