# Next.js Dashboard (apps/web)

## Key Files
- `src/app/page.tsx` — Main 3-column dashboard
- `src/app/analytics/page.tsx` — Trade journal + config comparison
- `src/app/api/auto-trade/route.ts` — Core trading logic (2000+ lines)
- `src/lib/config.ts` — TOML config loader (@iarna/toml)
- `src/lib/config-version.ts` — Config hash utility (SHA256 → 8 chars)
- `src/lib/redis.ts` — Redis client

## Conventions
- API routes: `export const dynamic = 'force-dynamic'`, use NextResponse.json()
- Database: import from `@cryonix/database` (Drizzle ORM)
- Redis: import from `@/lib/redis`
- UI components: import from `@cryonix/ui` (shadcn/ui)
- Config: CONFIG object in auto-trade/route.ts is single source of truth for risk parameters
- All trades tagged with config_version via getConfigVersion()

## Important
- auto-trade/route.ts is the most critical file — changes affect live trading
- Instance lock prevents concurrent execution (60s TTL)
- SPOT_ONLY mode — only BUY orders, no short selling
