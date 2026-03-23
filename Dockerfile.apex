# Dockerfile.apex — APEX Meta-Intelligence Confluence Trader
FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies
RUN npm install --no-save \
    @iarna/toml@2 \
    openai@4 \
    dotenv@16 \
    ioredis@5 \
    pg@8 \
    zod@3 \
    tsx@4 \
    typescript@5 \
    ccxt@4

# Stub for @cryonix/types — all imports are `import type` (erased by tsx at runtime)
RUN mkdir -p node_modules/@cryonix/types && \
    echo '{"name":"@cryonix/types","version":"1.0.0","main":"index.js"}' > node_modules/@cryonix/types/package.json && \
    echo 'module.exports = {};' > node_modules/@cryonix/types/index.js

# Copy agent source (apex + shared modules)
COPY packages/agents/src/ ./packages/agents/src/

# Copy runner script
COPY scripts/services/apex-runner.ts ./scripts/services/

RUN npm install -g @anthropic-ai/claude-code

USER node
CMD ["npx", "tsx", "scripts/services/apex-runner.ts"]
