# ADR-021: Dashboard v2 -- Single-Page Minimal Layout
**Date:** 2026-02-20 | **Status:** Active

**Origin:** `docs/plans/2026-02-20-dashboard-v2-design.md`, `docs/plans/2026-02-20-dashboard-simplification-design.md`

### Context (Why)

The dashboard was built for a 45-symbol, multi-strategy system with grid DCA, agent orchestration, correlation matrices, and advanced analytics. The system evolved to trade 2 symbols on a $40 spot-only account, executing ~4 trades per month. The user gets all actionable updates via Telegram.

The dashboard had 40 components across 3 pages (Terminal, Analytics, Backtest): candlestick chart (277 lines, heavyweight library), PnL chart, AI impact chart, pattern performance, correlation matrix, grid manager, deep value alerts, agent flow visualization, config cards, cost tracking, risk monitor, portfolio donut, signal validator, tank monitor, and more. ~80% was dead weight -- displaying data for features not in use or at volumes that don't justify dedicated visualizations.

A candlestick chart for a system that trades 4 times per month is a Bloomberg terminal for a savings account.

### Decision (What)

Replace the entire dashboard with a single-page, single-column layout in one file (~200 lines of `page.tsx`). Six inline sections:

1. **Header** (~10 lines): Logo + health status dot + UTC clock
2. **Balance Card** (~30 lines): Big portfolio value number, daily P&L, 7-day P&L, baseline freeze badge
3. **Equity Curve** (~30 lines): 30-day Recharts `LineChart` (already a dependency). Single cyan line, no grid, no legend, 160px height.
4. **Position Cards** (~40 lines): 2-column grid showing each whitelisted symbol. Open position shows entry/current/SL/P&L; empty shows "No position".
5. **Recent Trades** (~30 lines): Last 5 closed trades with symbol, P&L, relative time.
6. **Health Row** (~20 lines): Horizontal row of service dots (Redis, Postgres, Engine, Binance).

Key design choices:
- **Reuse existing hooks** (`usePortfolio`, `useAutoTrade`, `useSystemHealth`) rather than raw fetch -- they already have error handling, caching, and refresh intervals tested in production.
- **No separate component files**: With 5 sections at 20-40 lines each, folder complexity outweighs the benefit. Refactor at 300+ lines.
- **Old dashboard moved to `/legacy/page.tsx`**: Zero-cost fallback. If v2 breaks, `/legacy` works instantly.
- **No candlestick chart**: Removed the heaviest component. The equity curve shows if the system is making money -- that's what matters for a status-glance page.
- **No Framer Motion animations**: Visual polish served no purpose on a status page.
- **5 API endpoints total**: portfolio (15s), auto-trade (10s), health (30s), chart-data (60s), journal (30s). No WebSocket needed.

### Consequences (How)

- **Positive**: Dashboard honestly reflects the system's actual scale. Mobile-first single column works on all devices. Page loads in <1 second without heavyweight chart libraries.
- **Positive**: All 27 API routes preserved (used by auto-trader, Telegram bot, engine). No backend changes.
- **Positive**: Old dashboard accessible at `/legacy` for reference or if v2 has issues.
- **Trade-off**: Lost detailed views (pattern performance, AI impact, config comparison) that were occasionally useful for debugging. These are still accessible via API routes and Telegram commands, just not visualized.
- **Trade-off**: As the system scales (more symbols, more trades), the single-page layout may become insufficient. The design acknowledges this: refactor when it grows beyond 300 lines.
