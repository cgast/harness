# =============================================================================
# Harness Server — Multi-stage Docker Build
#
# Builds the @harness/server package (headless HTTP/WebSocket agent runtime)
# into a minimal production image.
#
# Usage:
#   docker build -t harness .
#   docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... harness
#
# With persistent data:
#   docker run -p 3000:3000 \
#     -e ANTHROPIC_API_KEY=sk-ant-... \
#     -v harness-data:/home/harness/.harness \
#     harness
# =============================================================================

# ── Stage 1: Install dependencies and build ──────────────────────────────────

FROM node:22-slim AS builder

# Install build tools needed by better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /build

# Copy workspace config and lockfile first (layer caching)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./

# Copy only the packages needed for the server build
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/server/package.json packages/server/tsconfig.json packages/server/

# Copy package.json for workspace packages not built in Docker (needed so
# pnpm can resolve the full workspace and the lockfile matches)
COPY packages/cli/package.json packages/cli/
COPY packages/desktop/package.json packages/desktop/

# Copy plugin package.json files (workspace references)
COPY plugins/telemetry/package.json plugins/telemetry/
COPY plugins/human-review/package.json plugins/human-review/
COPY plugins/template/package.json plugins/template/
COPY plugins/memory/package.json plugins/memory/
COPY plugins/persistence/package.json plugins/persistence/

# Install dependencies (frozen lockfile for reproducibility)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/core/src packages/core/src
COPY packages/server/src packages/server/src
COPY plugins/ plugins/

# Build TypeScript
RUN pnpm --filter @harness/core build && \
    pnpm --filter @harness/server build

# Prune dev dependencies for a smaller production image
RUN pnpm prune --prod

# ── Stage 2: Production image ────────────────────────────────────────────────

FROM node:22-slim AS production

# Install only the minimal runtime libraries needed by better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd --gid 1001 harness && \
    useradd --uid 1001 --gid harness --shell /bin/bash --create-home harness

WORKDIR /app

# Copy built artifacts from builder
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/core/dist ./packages/core/dist
COPY --from=builder /build/packages/core/package.json ./packages/core/
COPY --from=builder /build/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /build/packages/server/dist ./packages/server/dist
COPY --from=builder /build/packages/server/package.json ./packages/server/
COPY --from=builder /build/packages/server/node_modules ./packages/server/node_modules
COPY --from=builder /build/package.json ./

# Copy plugin dist and configs
COPY --from=builder /build/plugins ./plugins

# Copy default souls and skills into the image
COPY souls/ /app/souls/
COPY skills/ /app/skills/

# Create writable data directory for SQLite and logs
RUN mkdir -p /home/harness/.harness/data /home/harness/.harness/logs && \
    chown -R harness:harness /home/harness/.harness

# Switch to non-root user
USER harness

# Default environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HARNESS_HOME=/home/harness/.harness

EXPOSE 3000

# Health check against the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Use tini as init process (proper signal handling, zombie reaping)
ENTRYPOINT ["tini", "--"]

CMD ["node", "packages/server/dist/server.js"]
