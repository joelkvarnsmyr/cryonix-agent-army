# Stage 1: Install dependencies and build the application
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy dependency definition files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./

# Install dependencies for the entire monorepo
# This leverages Docker layer caching
RUN pnpm install --frozen-lockfile

# Copy the rest of the source code
COPY . .

# Build the web application
# This will create the standalone output in apps/web/.next/standalone
RUN pnpm turbo run build --filter=@cryonix/web


# Stage 2: Create the production image
FROM node:20-alpine AS runner

WORKDIR /app

# Set environment variables for production
ENV NODE_ENV=production
# Disable telemetry
ENV NEXT_TELEMETRY_DISABLED 1

# Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy the standalone application build from the builder stage
COPY --from=builder /app/apps/web/.next/standalone .
# Copy public assets and static build files
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# Change ownership to the non-root user
RUN chown -R nextjs:nodejs /app

# Switch to the non-root user
USER nextjs

EXPOSE 3000

ENV PORT 3000

# Start the Next.js server
CMD ["node", "server.js"]
