# scripts/

Operational scripts for the Cryonix trading system: deployment, background services, autonomous evolution, strategy analysis, and signal ingestion.

## Subdirectories

| Directory | Description |
|-----------|-------------|
| [deploy/](deploy/README.md) | Deployment automation, Postgres backups, and health monitoring. |
| [services/](services/README.md) | Docker background services: auto-trader, WebSocket server, Telegram bots. |
| [evolution/](evolution/README.md) | Autonomous code mutation engine using Claude Code CLI. |
| [strategy-lab/](strategy-lab/README.md) | Calibration, backtesting, diagnostics, and strategy analysis tools. |
| [telegram-scraper/](telegram-scraper/README.md) | Telegram channel signal scraper (Telethon/Python, Docker). |
| [lib/](lib/) | Shared utilities (`load-toml.mjs` -- TOML config loader for ESM scripts). |
