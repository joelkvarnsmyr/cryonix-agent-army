# Quick Start

## Local Development

```bash
pnpm install
docker compose up -d          # Redis, Postgres, Python engine
pnpm dev                      # http://localhost:3000
```

Required env vars in `apps/web/.env.local`:

```
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
XAI_API_KEY=xai-...
POSTGRES_URL=postgres://postgres:password@localhost:5432/cryonix
KV_URL=redis://localhost:6379
```

Push database schema (first time only):

```bash
cd packages/database && pnpm db:push
```

## Production Deployment

See [OPS.md](./OPS.md) for full Azure VM deployment guide.
