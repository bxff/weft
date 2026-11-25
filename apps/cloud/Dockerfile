# weft cloud — the self-hostable Bun store (apps/cloud/src/server.ts).
#
# IMPORTANT: build context MUST be the REPO ROOT, not apps/cloud.
# The server imports @weft/sync-engine, rm-ink, and rm-format from packages/*.
# Those packages export raw .ts via "exports", so Bun runs them directly —
# no per-package build step. We therefore copy the whole workspace and let
# `bun install` link the workspace symlinks.
#
# Build from repo root:
#   docker build -f apps/cloud/Dockerfile -t weft-cloud .
# (docker-compose.yml already sets context: . and dockerfile accordingly.)

FROM oven/bun:1-slim

WORKDIR /app

# --- dependency layer (cached unless manifests change) -----------------------
# Copy root manifest + lockfile and every workspace package.json so the
# dependency graph resolves before we copy source.
COPY package.json bun.lock ./
COPY apps/cloud/package.json ./apps/cloud/
COPY packages/rm-format/package.json ./packages/rm-format/
COPY packages/rm-ink/package.json ./packages/rm-ink/
COPY packages/sync-engine/package.json ./packages/sync-engine/

# Install only what cloud needs. --filter keeps the image lean and avoids
# pulling the web app's heavy deps (tldraw/react/pdfjs).
RUN bun install --frozen-lockfile --filter @weft/cloud

# --- source layer ------------------------------------------------------------
COPY apps/cloud/src ./apps/cloud/src
COPY packages/rm-format/src ./packages/rm-format/src
COPY packages/rm-ink/src ./packages/rm-ink/src
COPY packages/sync-engine/src ./packages/sync-engine/src

# --- runtime -----------------------------------------------------------------
# Persist the bun:sqlite DB on a volume. /data is declared as a volume so the
# notebook store survives container restarts/redeploys.
ENV CLOUD_DB=/data/weft.db
ENV PORT=8080
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]

USER bun
EXPOSE 8080

# Bun auto-loads /app/apps/cloud/.env if present, but in prod we pass
# CLERK_SECRET_KEY / SENTRY_DSN via the environment (see docker-compose.yml).
WORKDIR /app/apps/cloud
CMD ["bun", "src/server.ts"]
