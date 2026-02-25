# ADR-016: Aktienix -- US Stock Trading via Alpaca Markets
**Date:** 2026-02-17 | **Status:** Deferred

**Origin:** `docs/plans/2026-02-17-aktienix-stock-trading-design.md`

### Context (Why)

Cryonix is crypto-only. BTC and S&P 500 show ~0.4-0.7 correlation during macro events (e.g., Feb 5 2026: BTC -15%, S&P -2% synchronized selloff). The system had zero awareness of stock market movements and would buy crypto during correlated selloffs.

Adding US stock trading enables two things: (1) portfolio diversification across asset classes, and (2) a macro risk filter where SPY/VIX data prevents buying into correlated market crashes. The cross-market intelligence is the primary value-add beyond simple code reuse.

### Decision (What)

Design an expansion to US stock trading via Alpaca Markets with three isolated Docker containers sharing Redis/Postgres infrastructure:

- **`stocks-engine`**: StockScoutTank scanning 15 US large-caps every 60s during NYSE hours only. Reuses QuantGuild pattern detection with tuned thresholds. Outputs to `trades:stocks:pending` Redis queue.
- **`macro-engine`**: MacroCorrelationTank polling SPY/VIX every 15 minutes. Writes to `macro:spy:*` and `macro:vix:*` Redis keys. Enables cross-market risk filtering for both crypto and stock trades.
- **Auto-trade route extension**: Reads both crypto and stock queues. SPY dip >1% raises crypto confidence threshold +20%. VIX >30 pauses all new buys.

Broker choice: Alpaca Markets -- no minimum capital, commission-free, paper trading available, Swedish access via CurrencyCloud (1.5% fee capped at $40). Free IEX data feed sufficient for swing trading. Bracket orders (atomic entry + SL + TP) are superior to Binance's approach.

Database changes: single `asset_class` column added to 4 tables (signals, positions, trades, position_history) with `DEFAULT 'crypto'` for backward compatibility.

Migration path to IBKR ISK planned when capital exceeds ~20-30k SEK for tax optimization (schablonbeskattning vs K4 filing).

### Consequences (How)

- **Deferred**: This remains a design document. Implementation is parked until crypto trading is consistently profitable and capital has grown sufficiently. At ~$40 capital, stock trading yield would be negligible.
- **Trade-off**: Three new Docker containers add ~230MB RAM to a 4GB VM (currently ~2.5GB used). Feasible but tight -- may require VM upgrade.
- **Trade-off**: PDT rules limit accounts under $25k to 3 day-trades per 5 business days, forcing a swing-oriented strategy with overnight gap risk.
- **Trade-off**: K4 tax reporting burden for Swedish users -- Alpaca does not report to Skatteverket, requiring manual filing with SEK conversion at transaction-day exchange rates.
- **Risk mitigation**: Capital isolation is absolute (crypto and stock pools never cross-fund). Process isolation via Docker means a stocks-engine crash cannot affect crypto. Paper trading mandatory for 30+ days before live.
