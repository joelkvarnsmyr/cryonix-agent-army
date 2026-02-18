# App Router Pages

## Structure
- `page.tsx` — Main dashboard (3-column: stats|chart|positions)
- `analytics/page.tsx` — Trade journal, config versions, pattern performance
- `backtest/page.tsx` — Backtesting UI
- `api/` — 20+ API routes (see OPS.md for full list)

## Adding new pages
- Use `'use client'` for interactive pages
- Import layout from `@/components/dashboard/dashboard-layout`
- Add nav link in dashboard-layout.tsx navItems array
- Use shadcn/ui components from `@cryonix/ui`
