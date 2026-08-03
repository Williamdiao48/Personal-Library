# Cloud Run extraction container (Phase 4). Build CONTEXT is the REPO ROOT so the
# shared extractor can be bundled from source:
#   docker build -f server/cloud-run/extract/Dockerfile -t extract .
#
# The container holds no long-lived credential — it only ever receives presigned
# R2 URLs per request (Decision 3). This Dockerfile is finalized/validated end-to-
# end in Chunk 5 (first real deploy); the handler + server it wraps are already
# unit- and round-trip-tested locally.

# ── Build stage: bundle src/ + the shared electron/main/capture closure ──────
# The repo layout is preserved verbatim inside the image so the container's
# relative imports (`../../../../electron/main/...`) resolve exactly as they do
# in the repo — no path rewriting, one source of truth.
FROM node:22-slim AS build
WORKDIR /repo/server/cloud-run/extract

# Install the container's own deps (adm-zip / jsdom / sanitize-html + esbuild).
COPY server/cloud-run/extract/package*.json ./
RUN npm install --no-audit --no-fund

# Container source + the Electron-free extraction closure it imports.
COPY server/cloud-run/extract/ ./
COPY electron/main/capture /repo/electron/main/capture
COPY electron/main/security /repo/electron/main/security
COPY electron/main/workers/parse-protocol.ts /repo/electron/main/workers/parse-protocol.ts

RUN npm run build && npm prune --omit=dev

# ── Runtime stage: minimal, non-root ─────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Drop privileges; the base image ships an unprivileged `node` user.
USER node

COPY --chown=node:node --from=build /repo/server/cloud-run/extract/dist ./dist
COPY --chown=node:node --from=build /repo/server/cloud-run/extract/node_modules ./node_modules

# Cloud Run injects $PORT (default 8080). The service is deployed
# --no-allow-unauthenticated --ingress=all (the Edge Function calls in from
# Supabase, outside GCP, so internal-only ingress would block it; the ID-token
# IAM check is the auth boundary, not the network). Deploy-time flags (Chunk 5),
# not bakeable here.
EXPOSE 8080
CMD ["node", "dist/server.js"]
