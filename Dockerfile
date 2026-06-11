# Stage 1: Build the project
FROM node:24-alpine AS builder

# corepack uses package.json#packageManager to pin the exact pnpm version,
# so the image always matches what we install locally / in CI.
RUN corepack enable

WORKDIR /app

# Copy manifests + lockfile first so the install layer caches independently of source.
# pnpm-workspace.yaml is required because src/web is a workspace package.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY src/web/package.json ./src/web/
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

RUN pnpm run build

# Stage 2: Runtime image
FROM node:24-alpine

RUN corepack enable

WORKDIR /app

# `pnpm deploy --legacy --filter` produces a self-contained node_modules for the
# named package with production dependencies only — the pnpm equivalent of
# `npm ci --omit=dev`, with no extra registry resolution at runtime.
# - `--filter` is required from the workspace root so pnpm knows which package to
#   deploy (workspace contains both the server and the `src/web` widget package).
# - `--legacy` opts out of pnpm v10+'s `inject-workspace-packages` requirement; the
#   server doesn't depend on any workspace package at runtime, so the legacy path is
#   the correct one (see ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE).
COPY --from=builder /app /build
RUN cd /build && pnpm deploy --legacy --filter "@apify/actors-mcp-server" --prod /app && rm -rf /build
COPY --from=builder /app/dist ./dist
# server_card.ts reads server.json at load (resolved as dist/../server.json).
COPY server.json ./

ENTRYPOINT ["node", "dist/stdio.js"]
