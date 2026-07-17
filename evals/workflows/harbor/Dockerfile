# Prebuilt shared image for the Apify MCP workflow evals.
# Contains: node (per .nvmrc), installed node_modules (correct Linux binaries), the built
# dist/, and the eval runner + verifier code. Every generated Harbor task references this
# image by tag (apify-mcp-evals:local) via [environment].docker_image, so no per-task build.
#
# Build context is the repo root; ignores live in Dockerfile.dockerignore (BuildKit).
FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:/app/node_modules/.bin:$PATH
RUN corepack enable

WORKDIR /app

# Install dependencies first for layer caching. The workspace manifest lists src/web, so its
# package.json must be present for a frozen-lockfile install to resolve.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY src/web/package.json ./src/web/package.json
RUN corepack prepare pnpm@11.1.3 --activate && pnpm install --frozen-lockfile

# Copy the rest of the repo and build the core (dist/stdio.js + compiled modules). The web
# widget bundle is not needed for the non-widget tools these evals exercise.
COPY . .
RUN pnpm run build:core

# The MCP server reads APIFY_TOKEN from the environment; Harbor injects it per trial.
CMD ["node", "dist/stdio.js"]
