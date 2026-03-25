# scripts/strategy-lab/

Offline analysis, calibration, backtesting, and diagnostic tools for evaluating and improving Cryonix trading strategies. All scripts connect to Postgres and/or Redis via the shared `db.py` helper.

## Files

| File | Description |
|------|-------------|
| `calibrate.py` | Calculates per-pattern Expected Value (EV), win rates, profit factors, and confidence weights from historical trade data. Writes results to Redis key `calibration:patterns` (consumed by the auto-trade EV filter). Supports compound pattern expansion. |
| `morning_report.py` | Generates a detailed morning report: trade overview, per-pattern breakdown, exit analysis (SL/TP/trailing), what-if stop-loss scenarios at various multipliers, open position age warnings, missed GainerScanner opportunities, and prioritized action items. |
| `x_sentiment.py` | X/Twitter sentiment scanner. Calls the Grok xAI API (`grok-3-mini` with live search) to score sentiment (-3 to +3) for a 13-coin watchlist. Writes `x-sentiment:latest` (15min TTL), per-symbol `sentiment:{SYMBOL}` (1h TTL), and alert keys to Redis. |
| `engine_diagnostik.py` | Read-only diagnostic tool for the Python engine container. Parses Docker logs for tracebacks and error patterns, checks container health/resource usage, verifies connectivity to Redis/Postgres/Engine API, reports all container statuses, and generates a diagnosis summary with fix recommendations. |
| `backtest.py` | Full backtester that runs historical OHLCV data (fetched via CCXT) through the real QuantGuild engine. Simulates position management (SL/TP/trailing stop), computes Sharpe/Sortino/Calmar ratios, drawdown, pattern breakdown, monthly returns, and production readiness checks. Saves results to Postgres `backtest_results` table. |
| `backtest_momentum.py` | Momentum-specific backtest. Compares MOMENTUM_GAINER trades against other patterns, analyzes GainerScanner coverage, and simulates hypothetical outcomes of filtering out weak patterns (MACD/EMA). |
| `pnl_verify.py` | P&L verification tool. Compares Postgres trade history against actual Binance balances via CCXT. Detects discrepancies, estimates fees, and cross-references open positions across Postgres, Redis, and Binance to find orphaned records. |
| `reconcile_orphans.py` | Interactive orphan position reconciliation tool. Identifies positions that exist in the internal state (DB/Redis) but not on the exchange, and guides the user through marking them as closed. |
| `self_calibrate.py` | Signal prediction accuracy tracker. Compares signal predictions against actual trade outcomes and hypothetical outcomes for skipped signals. Measures per-pattern hit rates, filter effectiveness (acted vs skipped accuracy), and writes results to Redis key `calibration:accuracy` (48h TTL). |
| `db.py` | Shared database connection helper. Provides `get_pg()` (psycopg2) and `get_redis()` functions. Loads `.env` from the project root. |
| `run.sh` | Daily wrapper script. Runs `calibrate.py` (30-day window) followed by `morning_report.py` (24h window). Logs output to `logs/strategy-lab/`. Intended for cron at 06:00 UTC. |
| `requirements.txt` | Python dependencies: psycopg2-binary, redis, pandas, tabulate, python-dotenv. |

## Usage

```bash
# Install dependencies
pip install -r scripts/strategy-lab/requirements.txt

# Run calibration (writes EV data to Redis)
python3 scripts/strategy-lab/calibrate.py --days 30 --min-trades 3

# Generate morning report
python3 scripts/strategy-lab/morning_report.py --hours 24 --save report.txt

# Run X sentiment scan
python3 scripts/strategy-lab/x_sentiment.py
python3 scripts/strategy-lab/x_sentiment.py --dry-run

# Engine diagnostics
python3 scripts/strategy-lab/engine_diagnostik.py --lines 500 --hours 24

# Backtest a symbol
python3 scripts/strategy-lab/backtest.py --symbol BTC/USDC --days 30 --capital 42

# P&L verification
python3 scripts/strategy-lab/pnl_verify.py --days 7 --verbose

# Self-calibration (prediction accuracy)
python3 scripts/strategy-lab/self_calibrate.py --hours 24

# Orphan reconciliation (interactive)
python3 scripts/strategy-lab/reconcile_orphans.py

# Daily cron wrapper (calibration + morning report)
bash scripts/strategy-lab/run.sh
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `POSTGRES_URL` / `POSTGRES_PASSWORD` | Postgres connection string. |
| `KV_URL` | Redis connection URL (default: `redis://localhost:6379`). |
| `XAI_API_KEY` | xAI API key for Grok sentiment scanning (`x_sentiment.py`). |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | Binance API credentials (for `pnl_verify.py`, `backtest.py`, `reconcile_orphans.py`). |

## Dependencies

- Python 3.11+
- psycopg2-binary >= 2.9
- redis >= 5.0
- pandas >= 2.0
- tabulate >= 0.9
- python-dotenv >= 1.0
- ccxt (optional, for backtest and P&L verification)
- openai (optional, for x_sentiment.py)
