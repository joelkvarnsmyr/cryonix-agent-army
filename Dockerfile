FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# --- Dependencies stage ---
FROM base AS deps
WORKDIR /app

# Copy workspace configs first (for layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./

# Copy all package.json files for workspace resolution
COPY apps/web/package.json ./apps/web/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/agents/package.json ./packages/agents/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/engine/package.json ./packages/engine/package.json
COPY packages/intelligence/package.json ./packages/intelligence/package.json

RUN pnpm install --frozen-lockfile

# --- Builder stage ---
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/ ./
COPY . .

# Build the Next.js app (standalone output)
RUN pnpm build

# --- Production runner ---
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone Next.js server
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# Copy auto-trader script (plain JS, no TS needed)
COPY --from=builder /app/scripts/auto-trader.mjs ./scripts/auto-trader.mjs

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
