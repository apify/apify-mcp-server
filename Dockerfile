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

# `pnpm deploy --prod` produces a self-contained, hoisted node_modules (no `.pnpm/`
# symlinks) with production dependencies only — the pnpm equivalent of
# `npm ci --omit=dev`, with no extra registry resolution at runtime.
COPY --from=builder /app /build
RUN cd /build && pnpm deploy --prod /app && rm -rf /build
COPY --from=builder /app/dist ./dist

ENTRYPOINT ["node", "dist/stdio.js"]
