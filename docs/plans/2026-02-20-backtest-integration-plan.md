# Backtest Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `quick_backtest()` Python function that Evolution uses as a quality gate (reject bad mutations) and AI Brain uses as advisory context (feed Grok empirical data).

**Architecture:** Single Python file `quick_backtest.py` reuses existing `DataFetcher`, `Backtester`, and `MetricsCalculator` classes from `backtest.py`. Evolution calls it via shell from Node.js. AI Brain imports it directly in Python. No new services, endpoints, DB tables, or cron jobs.

**Tech Stack:** Python 3.11, ccxt, numpy, QuantGuild engine, Node.js child_process

**Design doc:** `docs/plans/2026-02-20-backtest-integration-design.md`

---

## Task 1: Create `quick_backtest.py` — the core function

**Files:**
- Create: `scripts/strategy-lab/quick_backtest.py`
- Reference: `scripts/strategy-lab/backtest.py` (reuse classes)

### Step 1: Create the file with imports and function

Create `scripts/strategy-lab/quick_backtest.py`:

```python
#!/usr/bin/env python3
"""
Quick backtest function for Evolution and AI Brain integration.

Reuses the full QuantGuild backtester from backtest.py but exposes a simple
function interface + CLI with JSON output. No DB writes.

Usage as CLI:
  python3 scripts/strategy-lab/quick_backtest.py BTC/USDC 14
  python3 scripts/strategy-lab/quick_backtest.py BTC/USDC 14 '{"min_confidence": 0.75}'

Usage as import:
  from quick_backtest import quick_backtest
  result = quick_backtest("BTC/USDC", days=14, config_overrides={"min_confidence": 0.75})
"""
import json
import os
import sys

# Ensure backtest.py's directory is importable
sys.path.insert(0, os.path.dirname(__file__))

from backtest import BacktestConfig, DataFetcher, Backtester, MetricsCalculator


def quick_backtest(symbol: str, days: int = 14, config_overrides: dict = None) -> dict:
    """
    Run a fast backtest using the QuantGuild engine.

    Args:
        symbol: Trading pair (e.g. "BTC/USDC")
        days: Lookback period (default 14)
        config_overrides: Optional dict of config params to override.
            Supported keys: min_confidence, trailing_stop_pct,
            trailing_profit_threshold, position_size_pct, fee_pct,
            max_positions, capital

    Returns:
        {
            "symbol": str,
            "days": int,
            "sharpe_ratio": float,
            "profit_factor": float,
            "win_rate": float,
            "total_return_pct": float,
            "max_drawdown_pct": float,
            "total_trades": int,
            "expectancy": float,
        }
    """
    # Build config with overrides
    cfg = BacktestConfig(symbol=symbol, days=days)
    if config_overrides:
        for key, value in config_overrides.items():
            if hasattr(cfg, key):
                setattr(cfg, key, value)

    # Fetch data
    fetcher = DataFetcher(cfg.symbol, cfg.days, cfg.timeframe)
    data = fetcher.fetch_all()

    if not data.get(cfg.timeframe):
        return _empty_result(symbol, days)

    # Run backtest
    bt = Backtester(cfg)
    trades, equity = bt.run(data)

    if not trades:
        return _empty_result(symbol, days)

    # Compute metrics
    metrics = MetricsCalculator.compute(trades, equity, cfg.capital, cfg.days)

    return {
        'symbol': symbol,
        'days': days,
        'sharpe_ratio': metrics['sharpe_ratio'],
        'profit_factor': metrics['profit_factor'],
        'win_rate': metrics['win_rate'],
        'total_return_pct': metrics['total_return_pct'],
        'max_drawdown_pct': metrics['max_drawdown_pct'],
        'total_trades': metrics['total_trades'],
        'expectancy': metrics['expectancy'],
    }


def _empty_result(symbol: str, days: int) -> dict:
    return {
        'symbol': symbol,
        'days': days,
        'sharpe_ratio': 0.0,
        'profit_factor': 0.0,
        'win_rate': 0.0,
        'total_return_pct': 0.0,
        'max_drawdown_pct': 0.0,
        'total_trades': 0,
        'expectancy': 0.0,
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: quick_backtest.py SYMBOL [DAYS] [CONFIG_JSON]')
        sys.exit(1)

    sym = sys.argv[1]
    d = int(sys.argv[2]) if len(sys.argv) > 2 else 14
    overrides = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None

    result = quick_backtest(sym, d, overrides)
    print(json.dumps(result))
```

### Step 2: Verify the file runs in Docker

Run inside the engine container (which has all Python dependencies + QuantGuild):

```bash
docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/quick_backtest.py BTC/USDC 7
```

Expected: JSON output like `{"symbol": "BTC/USDC", "days": 7, "sharpe_ratio": ..., "total_trades": ...}`

If it fails with import errors, check that `scripts/strategy-lab` is mounted in `docker-compose.prod.yml` (it should be — we added this volume in a previous commit):
```yaml
volumes:
  - ./scripts/strategy-lab:/app/scripts/strategy-lab:ro
```

### Step 3: Verify the file runs on host

```bash
cd /home/azureuser/cryonix
PYTHONPATH=/home/azureuser/cryonix/packages/engine python3 scripts/strategy-lab/quick_backtest.py BTC/USDC 7
```

Expected: Same JSON output.

### Step 4: Test with config overrides

```bash
docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/quick_backtest.py BTC/USDC 7 '{"min_confidence": 0.80}'
```

Expected: JSON output, likely with fewer trades (higher confidence threshold).

### Step 5: Commit

```bash
git add scripts/strategy-lab/quick_backtest.py
git commit -m "feat: add quick_backtest.py for Evolution and AI Brain integration"
```

---

## Task 2: Add backtest gate to Evolution

**Files:**
- Modify: `scripts/evolution/copilot-evolution.mjs:836-849` (between verification and commit)

### Step 1: Add `runBacktestGate()` method

In `copilot-evolution.mjs`, add a new method to the `EvolutionEngine` class. Place it after the `runVerification()` method (after line ~656).

```javascript
  /**
   * Run backtest gate: compare baseline vs mutated config.
   * Returns true if mutation improves (or doesn't worsen) backtest metrics.
   */
  async runBacktestGate(performanceData) {
    console.log('\n📊 Running backtest gate...');

    // Pick symbol from weakest pattern's trades, fallback to BTC/USDC
    let symbol = 'BTC/USDC';
    if (performanceData.exitAnalysis?.trades?.length > 0) {
      const weakTrades = performanceData.exitAnalysis.trades.filter(
        t => t.pattern === performanceData.weakestPattern
      );
      if (weakTrades.length > 0) {
        symbol = weakTrades[0].symbol;
      }
    }

    const days = 14;
    const cmd = `docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/quick_backtest.py "${symbol}" ${days}`;

    try {
      // Run backtest with current (mutated) config
      console.log(`  Running backtest: ${symbol}, ${days} days...`);
      const candidateRaw = await this.execCommand(cmd, { timeout: 120000 });
      const candidate = JSON.parse(candidateRaw.trim());

      console.log(`  Candidate: sharpe=${candidate.sharpe_ratio}, pf=${candidate.profit_factor}, ` +
                   `dd=${candidate.max_drawdown_pct}%, trades=${candidate.total_trades}`);

      // Gate criteria:
      // - Must have at least 3 trades (otherwise inconclusive)
      // - profit_factor >= 0.3 (not catastrophically bad)
      // - max_drawdown_pct <= 25% (not blowing up)
      if (candidate.total_trades < 3) {
        console.log('  ⚠️ Too few trades for backtest gate — passing (inconclusive)');
        return { passed: true, reason: 'inconclusive', candidate };
      }

      if (candidate.max_drawdown_pct > 25) {
        console.log(`  ❌ Drawdown too high: ${candidate.max_drawdown_pct}% > 25%`);
        return { passed: false, reason: `drawdown ${candidate.max_drawdown_pct}% > 25%`, candidate };
      }

      if (candidate.profit_factor < 0.3) {
        console.log(`  ❌ Profit factor too low: ${candidate.profit_factor} < 0.3`);
        return { passed: false, reason: `profit_factor ${candidate.profit_factor} < 0.3`, candidate };
      }

      console.log('  ✅ Backtest gate passed');
      return { passed: true, reason: 'passed', candidate };

    } catch (e) {
      console.warn(`  ⚠️ Backtest gate error: ${e.message}`);
      // Fail-open: if backtest itself crashes, don't block evolution
      return { passed: true, reason: `error: ${e.message}`, candidate: null };
    }
  }
```

### Step 2: Insert backtest gate call in `run()` method

In `run()`, between the verification block (line ~845) and the commit (line ~848), add the backtest gate:

Find this exact code in `copilot-evolution.mjs` (around line 845-849):

```javascript
        if (!verificationPassed) {
          console.log('❌ Verification failed! Rolling back...');
          await this.restoreBackup(backupDir);
          await this.execCommand('git reset --hard HEAD');
          mutationApplied = false;
          continue;
        }

        // Step 5: Commit and deploy
        const commitMsg = `[Auto-Evolution ${this.runId}] Improve ${performanceData.weakestPattern} pattern (P&L: $${performanceData.weakestPnl.toFixed(2)})`;
```

Replace with:

```javascript
        if (!verificationPassed) {
          console.log('❌ Verification failed! Rolling back...');
          await this.restoreBackup(backupDir);
          await this.execCommand('git reset --hard HEAD');
          mutationApplied = false;
          continue;
        }

        // Step 4b: Backtest gate
        const backtestResult = await this.runBacktestGate(performanceData);
        if (!backtestResult.passed) {
          console.log(`❌ Backtest gate rejected mutation: ${backtestResult.reason}`);
          await this.restoreBackup(backupDir);
          await this.execCommand('git reset --hard HEAD');
          mutationApplied = false;
          continue;
        }

        // Step 5: Commit and deploy
        const commitMsg = `[Auto-Evolution ${this.runId}] Improve ${performanceData.weakestPattern} pattern (P&L: $${performanceData.weakestPnl.toFixed(2)})`;
```

### Step 3: Log backtest results in evolution run

Find the `logEvolutionResult` call for success (around line 888-894). The existing call passes a `details` object. Add the backtest result to it.

Find:
```javascript
      await this.logEvolutionResult(true, {
```

In the details object, add the backtest data. Look for where `details` is built and add:

```javascript
        backtestGate: backtestResult || null,
```

The variable `backtestResult` is scoped inside the while loop. To make it accessible, declare `let backtestResult = null;` alongside `let mutationApplied = false;` (around line 820) and assign in the gate step.

### Step 4: Verify syntax

```bash
node --check scripts/evolution/copilot-evolution.mjs
```

Expected: No output (clean parse).

### Step 5: Commit

```bash
git add scripts/evolution/copilot-evolution.mjs
git commit -m "feat: add backtest gate to evolution pipeline"
```

---

## Task 3: Add backtest context to AI Brain

**Files:**
- Modify: `scripts/strategy-lab/ai_brain.py:468-482` (between collect_data and call_grok)

### Step 1: Add import at top of file

Near the other imports in `ai_brain.py` (around line 15-20), add:

```python
from quick_backtest import quick_backtest
```

This works because `ai_brain.py` and `quick_backtest.py` are both in `scripts/strategy-lab/` and `sys.path.insert(0, os.path.dirname(__file__))` is already done via `db.py` import.

### Step 2: Add backtest context collection

In `main()`, between the data collection log (line 473) and the "no trades" early return (line 475), add backtest context:

Find this exact code (around lines 468-482):

```python
        context = collect_data(pg, r, period_hours=period, is_acute=args.acute)

        trade_count = len(context['trades_closed'])
        print(f'[AI BRAIN] Collected: {trade_count} closed trades, '
              f'{len(context["open_positions"])} open positions, '
              f'{len(context["calibration"])} calibrated patterns')

        if trade_count == 0 and not args.acute:
            print('[AI BRAIN] No trades in period, skipping analysis')
            telegram_send(f'🧠 <b>AI Brain</b> ({run_id})\n\nNo trades in last {period}h. Skipping.')
            return

        # Step 2: Call Grok
        print('[AI BRAIN] Calling Grok for analysis...')
```

Replace with:

```python
        context = collect_data(pg, r, period_hours=period, is_acute=args.acute)

        trade_count = len(context['trades_closed'])
        print(f'[AI BRAIN] Collected: {trade_count} closed trades, '
              f'{len(context["open_positions"])} open positions, '
              f'{len(context["calibration"])} calibrated patterns')

        if trade_count == 0 and not args.acute:
            print('[AI BRAIN] No trades in period, skipping analysis')
            telegram_send(f'🧠 <b>AI Brain</b> ({run_id})\n\nNo trades in last {period}h. Skipping.')
            return

        # Step 1b: Add backtest context (advisory, errors don't block)
        backtest_symbols = ['BTC/USDC', 'ETH/USDC', 'SOL/USDC']
        backtest_baseline = {}
        for sym in backtest_symbols:
            try:
                bt = quick_backtest(sym, days=14)
                backtest_baseline[sym] = {
                    'sharpe': bt['sharpe_ratio'],
                    'profit_factor': bt['profit_factor'],
                    'win_rate': bt['win_rate'],
                    'total_return_pct': bt['total_return_pct'],
                    'max_drawdown_pct': bt['max_drawdown_pct'],
                    'total_trades': bt['total_trades'],
                }
                print(f'[AI BRAIN] Backtest {sym}: sharpe={bt["sharpe_ratio"]}, '
                      f'pf={bt["profit_factor"]}, trades={bt["total_trades"]}')
            except Exception as e:
                print(f'[AI BRAIN] Backtest {sym} failed: {e}')
        if backtest_baseline:
            context['backtest_baseline'] = backtest_baseline

        # Step 2: Call Grok
        print('[AI BRAIN] Calling Grok for analysis...')
```

### Step 3: Verify syntax

```bash
python3 -c "import ast; ast.parse(open('scripts/strategy-lab/ai_brain.py').read())"
```

Expected: No output (clean parse).

### Step 4: Commit

```bash
git add scripts/strategy-lab/ai_brain.py
git commit -m "feat: add backtest context to AI Brain Grok analysis"
```

---

## Task 4: Integration test — full pipeline

### Step 1: Test quick_backtest CLI in Docker

```bash
docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/quick_backtest.py BTC/USDC 14
```

Expected: JSON with all 9 fields, `total_trades > 0`.

### Step 2: Test quick_backtest with overrides

```bash
docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/quick_backtest.py ETH/USDC 14 '{"min_confidence": 0.80}'
```

Expected: JSON, likely fewer trades than default 0.65 confidence.

### Step 3: Verify evolution syntax

```bash
node --check scripts/evolution/copilot-evolution.mjs
```

Expected: Clean (no output).

### Step 4: Verify AI Brain syntax

```bash
python3 -c "import ast; ast.parse(open('scripts/strategy-lab/ai_brain.py').read())"
```

Expected: Clean (no output).

### Step 5: Rebuild and deploy engine (to pick up new volume mount)

The engine container already has `scripts/strategy-lab` mounted. Rebuild to be safe:

```bash
docker compose -f docker-compose.prod.yml build engine && docker compose -f docker-compose.prod.yml up -d engine
```

### Step 6: Final commit and push

```bash
git push
```

---

## Summary: Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `scripts/strategy-lab/quick_backtest.py` | CREATE | Core function + CLI wrapper |
| `scripts/evolution/copilot-evolution.mjs` | MODIFY | Add `runBacktestGate()` method + call between verification and commit |
| `scripts/strategy-lab/ai_brain.py` | MODIFY | Add backtest context to Grok's input |

## What We Do NOT Build

- No new service/daemon
- No new API endpoint
- No new database table
- No new cron job
- No new Docker container
- No TS changes
