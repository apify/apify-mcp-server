# Code Mode for the Apify MCP Server

**Status:** Draft — pending approval before implementation.
**Owner:** TBD

## Summary

A new `code` tool category in mcp.apify.com lets the caller LLM submit a TypeScript program that orchestrates Apify resources through typed bindings. The program runs in a `workerd` V8 isolate hosted in a new Apify Actor (`apify/code-runtime`) running in Standby mode with the Worker Loader API. Two new MCP tools: `execute-code` and `get-code-mode-recipe`. Existing tools unchanged. Discovery (`search-actors`, `fetch-actor-details`, `search-apify-docs`) stays on existing MCP tools.

## Problem

Some Actors return more data than fits in caller LLM context. Some tasks need programmatic processing (filter, project, chain) the caller cannot do locally. The current MCP tool set forces the caller to round-trip every intermediate result through the model.

## Architecture

```
External MCP client
  | tools/call execute-code({ code })
  v
mcp.apify.com (apify-mcp-server, code category opt-in)
  | client.actor('apify/code-runtime').call({ code })  (existing call-actor plumbing)
  v
apify/code-runtime (Apify Standby Actor)
  +-------------------------------------------------+
  | workerd serve --experimental                    |
  | +---------------------------------------------+ |
  | | parent worker                               | |
  | |  - parses { code } from request body        | |
  | |  - substitutes into inner.js template       | |
  | |  - LOADER.get(uuid, () => ({ modules,env }))| |
  | |  - awaits entrypoint.fetch                  | |
  | +---------------------------------------------+ |
  | +---------------------------------------------+ |
  | | inner V8 isolate (one per request)          | |
  | |  - apify global = fetch-based REST shim     | |
  | |  - runs runUserCode(apify, console)         | |
  | |  - APIFY_TOKEN visible only here            | |
  | |  - discarded after response                 | |
  | +---------------------------------------------+ |
  +-------------------------------------------------+
```

## MCP server changes

A new `code` tool category, opt-in only — not in `toolCategoriesEnabledByDefault`.

### Tool: `execute-code`

| Field | Value |
|---|---|
| Input | `{ code: string }` |
| Output | `content[0].text` = stdout + stderr (capped at `TOOL_MAX_OUTPUT_CHARS = 50 000`); `structuredContent: { runId, exitCode, durationMs, stdoutBytes, stderrBytes }` |
| Error | `isError: true`; diagnostic in text; `structuredContent: { status, failureCategory, runId?, exitCode? }` |
| paymentRequired | `true` |
| readOnlyHint | `false` |
| taskSupport | `optional` |

### Tool: `get-code-mode-recipe`

| Field | Value |
|---|---|
| Input | `{ topic: enum }` (5 values) |
| Output | Markdown recipe (~300–500 tokens), TypeScript fenced |
| paymentRequired | `false` |
| readOnlyHint | `true` |

Topics: `running-actors`, `datasets`, `key-value-stores`.

## Runtime Actor (`apify/code-runtime`, new repo)

### Container

- Two-stage Docker build:
  - Stage 1 (`node:24-bookworm-slim`): install `workerd@1.20260402.x` via npm to extract the binary.
  - Stage 2 (`debian:bookworm-slim`): minimal runtime; only the workerd binary + `ca-certificates`.
- workerd is statically linked except for libc + libm (verified via `ldd`); no Node.js, no Apify SDK, no apify-client.
- ENTRYPOINT: `workerd serve --experimental /app/worker/config.capnp`.
- Image: 208 MB (validated; 410 MB with the Node base — the Node runtime is ~150 MB and unnecessary).

### Standby configuration

| Setting | Value |
|---|---|
| usesStandbyMode | `true` |
| desiredRequestsPerActorRun | `1000` (single instance handles all concurrent traffic) |
| maxRequestsPerActorRun | `10000` (hard cap; platform should not spawn a second container) |
| idleTimeoutSecs | `300` (initial) |
| memoryMbytes | `1024` (initial) |

Standby + hot workerd + Worker Loader gives ~700 ms warm latency vs. ~6–10 s for normal-mode-per-request (PoC-validated).

### Per-request lifecycle

1. Parent worker receives `POST /exec` with `{ code }` JSON body.
2. Parent reads `inner.js` template via a `text` capnp binding.
3. Parent replaces the marker with the user's code.
4. Parent calls `env.LOADER.get(uuid, () => ({ mainModule: 'main.js', modules: { 'main.js': moduleCode }, env: { APIFY_TOKEN } }))`.
5. Parent awaits `entrypoint.fetch('http://inner/exec')`.
6. Inner isolate runs `runUserCode(apify, console)`; captures stdout/stderr.
7. Inner returns `{ exitCode, stdout, stderr, durationMs }`.
8. Parent forwards response.
9. Inner isolate is discarded; container handles next request.

### Sandbox properties

- Network: outbound restricted to `*.apify.com` via `globalOutbound`.
- Filesystem: none (workerd has no FS APIs).
- Imports: none — only `apify` global + standard JS built-ins.
- State across requests: none (fresh isolate each).

## Bindings exposed to the script

The `apify` global is a simplified subset of `apify-client` that calls the Apify REST API directly via `fetch()`. This avoids bundling the apify-client npm dependency (which adds image weight and a transitive tree) and presents an LLM-ergonomic surface.

```ts
apify.actor.search({ query, limit?, category? })
apify.actor.getDetails({ actorId })
apify.actor.run({ actorId, input?, memoryMbytes?, timeoutSecs?, waitForFinishSecs?, maxTotalChargeUsd?, maxItems? })
apify.actor.start({ actorId, input?, ...same opts })
apify.actor.runAndGetItems({ actorId, input?, fields?, limit?, ...opts })

apify.run.get({ runId })
apify.run.wait({ runId, waitForFinishSecs? })
apify.run.abort({ runId })
apify.run.getLog({ runId, limit? })

apify.dataset.listItems({ datasetId, fields?, omit?, limit?, offset?, clean?, desc? })
apify.dataset.iterate({ datasetId, fields?, ... })
apify.dataset.getSchema({ datasetId, sample? })
apify.dataset.create({ name? })
apify.dataset.pushItems({ datasetId, items })

apify.kvs.get({ storeId, key })
apify.kvs.set({ storeId, key, value, contentType? })
apify.kvs.list({ storeId, limit?, exclusiveStartKey? })
apify.kvs.create({ name? })
```

23 methods. Each is a `fetch()` wrapper to `api.apify.com`. Implementation lives in `apify/code-runtime`.

Possible v2 additions: bindings for schedules, tasks, webhooks, request queues, builds. Discovery (`search-actors`, `fetch-actor-details`, `search-apify-docs`) intentionally stays on the existing MCP tools.

## Binding design principles

1. Object arguments only — no positional parameters.
2. Direct returns — return what the caller wants; no wrapper objects.
3. Units in names — `memoryMbytes`, `timeoutSecs`, `waitForFinishSecs`.
4. One method per common task — convenience aggregations (`runAndGetItems`) over composing two calls.
5. Consistent shapes — same patterns across all namespaces.

## Security

- Sandbox has no filesystem, no module resolution, and outbound network restricted to `*.apify.com` via `globalOutbound`.
- The bindings hit `api.apify.com` only and cannot reach `mcp.apify.com`, so a sub-agent cannot recursively invoke `execute-code`.
- The caller's `APIFY_TOKEN` lives in container env and is passed only to the inner isolate; it is never exposed back to the caller.
- workerd alone is not a hardened sandbox; the Apify container is the outer boundary. Multiple concurrent requests share one container but each request runs in its own discarded V8 isolate.
