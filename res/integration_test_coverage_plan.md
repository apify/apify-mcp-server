# Integration test coverage — implementation plan (PR / issue breakdown)

Source: [`integration_test_coverage_audit.md`](./integration_test_coverage_audit.md).
This document slices the audit into mid-size, **independent** PRs. Any order works; no PR depends on another. No upfront scaffolding PR is required (helpers each PR needs are small enough to land with the tests).

PR title format follows Conventional Commits (≤70 chars). Branch `test/<slug>`. Each PR adds tests only — no production code changes — so risk is low and review is fast.

---

## PR 1 — `test: Add base protocol and prompt error path tests`

**Branch**: `test/base-protocol-and-error-paths`
**Scope**: Block A + Block E from the audit. Lock down what the server returns at `initialize` time and what the unhappy paths of `tools/call` and `prompts/get` look like.

**Test cases (all in `tests/integration/suite.ts`):**
1. `should expose serverInfo, instructions and declared capabilities on initialize` — assert `client.getServerVersion().name === SERVER_NAME`, version matches `package.json`, `getInstructions()` non-empty, `getServerCapabilities()` contains `tools.listChanged`, `tasks.{list,cancel,requests.tools.call}`, `resources`, `prompts`, `logging`.
2. `should respond to ping` — `await client.ping()` does not throw.
3. `should return JSON-RPC error for tools/call with unknown tool name` — expect rejection with code/message indicating not found.
4. `should return InvalidParams for prompts/get with unknown name` — assert `error.code === ErrorCode.InvalidParams`.
5. `should return InvalidParams for prompts/get with invalid args` — pass args that fail the prompt's AJV validator; assert `InvalidParams`.

**Files touched**: `tests/integration/suite.ts` only.
**Why mid-size**: 5 tests, single file, no helpers, no transport-specific gating.
**Acceptance**: all 5 cases pass against stdio, sse, streamable-http; existing suite unchanged.
**Estimate**: ~45 min.

---

## PR 2 — `test: Add resources/list, templates, and read end-to-end tests`

**Branch**: `test/resources-end-to-end`
**Scope**: Block B. Today only unit tests touch `resource_service`; nothing verifies the request handlers in `server.ts:464,468,472` are wired.

**Test cases (all in `tests/integration/suite.ts`):**
1. `should list resources via resources/list` — `await client.listResources()`; assert `Array.isArray(resources)`. Run a second client with `uiMode: 'openai'`; assert at least one resource URI starts with `ui://` (widget).
2. `should list resource templates via resources/templates/list` — `await client.listResourceTemplates()`; assert array shape.
3. `should read a known widget resource and return mime+content` — pick a `ui://` URI from (1), `await client.readResource({ uri })`, assert `contents[0].mimeType === RESOURCE_MIME_TYPE` and non-empty body.

**Files touched**: `tests/integration/suite.ts` only.
**Acceptance**: all 3 pass across all 3 transports.
**Estimate**: ~45 min.

---

## PR 3 — `test: Add progress notification and logging level tests`

**Branch**: `test/notifications-progress-logging`
**Scope**: Block C + Block D. Both need a notification accumulator helper, so they share one PR.

**New helper** — `tests/integration/utils/notifications.ts`:
- `collectNotifications<T>(client, schema)` returns a function pair: `{ get(): T[], unsubscribe() }`. Internally calls `client.setNotificationHandler(schema, ...)` and pushes each notification to an array.
- Trivial (~20 lines), follows the existing pattern of the `task_waits.ts` helper.

**Test cases (all in `tests/integration/suite.ts`):**
1. `should emit notifications/progress when progressToken is supplied` (`{ retry: 1 }`, gated `runIf(streamable-http || sse)`) — start `apify/python-example` with `_meta.progressToken: 'pt-1'` via `client.request({ method: 'tools/call', ..., _meta: { progressToken: 'pt-1' } }, CallToolResultSchema)`. After completion, assert at least one collected `ProgressNotificationSchema` notification has `params.progressToken === 'pt-1'`.
2. `should filter notifications/message by setLevel`(`{ retry: 1 }`, gated `runIf(streamable-http)`) — collect `LoggingMessageNotificationSchema`. `await client.setLoggingLevel('error')`. Trigger a tool call that emits info logs (e.g. `search-apify-docs`). Assert no collected notification has `level !== 'error'` after the call. Then `setLoggingLevel('debug')`, repeat the call, assert at least one info-or-lower notification arrives.

**Files touched**: `tests/integration/suite.ts`, new `tests/integration/utils/notifications.ts`.
**Acceptance**: 2 tests pass on streamable-http; helper is exported and unused elsewhere is fine.
**Estimate**: ~1.5 h (notifications are slightly flaky; budget for `retry: 1`).

---

## PR 4 — `test: Add streamable-HTTP wire-level and session isolation tests`

**Branch**: `test/streamable-http-isolation`
**Scope**: Block F + Block G. Both target the streamable HTTP transport. Highest-stakes PR — covers multi-tenant correctness.

**Test cases:**

In `tests/integration/actor.server_streamable.test.ts` (append a `describe('streamable HTTP wire level', ...)` block — these are raw `fetch` calls, not MCP client traffic, so they don't fit the shared suite):
1. `should return 405 on GET /` — `fetch(httpServerHost + '/')` → status 405, `Allow: POST`.
2. `should return 404 on POST / without session and non-initialize body` — POST `{ jsonrpc:'2.0', method:'tools/list', id:1 }` with no `Mcp-Session-Id`; assert status 404 and JSON body has `error.code === -32000`.

In `tests/integration/suite.ts` (gated `runIf(streamable-http)`):
3. `should isolate tools and tasks across two concurrent sessions` — open client `a` with `actors: ['apify/python-example']` and client `b` with `actors: ['apify/rag-web-browser']`. Assert `listTools(a)` contains python-example and not rag-web-browser; vice versa for `b`. Start a long-running task on `a`, assert `b.experimental.tasks.listTasks()` returns zero tasks while `a` sees one. Close in opposite order.

**Files touched**: `tests/integration/actor.server_streamable.test.ts`, `tests/integration/suite.ts`.
**Acceptance**: 3 tests pass on streamable-http; SSE/stdio unaffected.
**Estimate**: ~1.5 h (concurrency teardown care).

---

## PR 5 — `test: Add _meta.apifyToken propagation tests` (optional / lower priority)

**Branch**: `test/meta-apify-token-propagation`
**Scope**: Block H. The hosted server relies on `_meta.apifyToken` arriving in `tools/call` params (`server.ts:638`). Currently no test exercises this path; only the bearer header / env-var paths are covered.

**Helper change** — `tests/helpers.ts`:
- Add an `omitToken?: boolean` flag to `McpClientOptions`. When set: `createMcpStdioClient` does not put `APIFY_TOKEN` in the spawned env, and the streamable-http variant does not send the `Authorization` header. ~10 lines.

**Test cases (in `tests/integration/suite.ts`, gated `runIf(stdio || streamable-http)`):**
1. `should accept apifyToken via tools/call _meta and run successfully` — create client with `omitToken: true`. Send `tools/call` for `apify/python-example` with `_meta.apifyToken = process.env.APIFY_TOKEN`. Assert run completes successfully.

**Files touched**: `tests/helpers.ts`, `tests/integration/suite.ts`.
**Acceptance**: 1 test passes on each gated transport.
**Estimate**: ~1 h.

**Why optional**: arguably already exercised end-to-end by the hosted-server tests in `apify-mcp-server-internal`. Land if we want the public repo to own this guarantee.

---

## Suggested merge order

Independent in code, but in business value:

1. **PR 4** first — multi-tenant safety net.
2. **PR 1** — base protocol lock-in is the cheapest broad coverage win.
3. **PR 2** — closes the resources gap.
4. **PR 3** — notifications/progress/logging.
5. **PR 5** — last; optional.

## Sizing summary

| PR | Tests | Files | Helpers | Est. effort |
|---|---|---|---|---|
| 1 | 5 | 1 | 0 | 45 min |
| 2 | 3 | 1 | 0 | 45 min |
| 3 | 2 | 2 | 1 new util | 1.5 h |
| 4 | 3 | 2 | 0 | 1.5 h |
| 5 | 1 | 2 | 1 flag | 1 h |
| **Total** | **14** | — | — | **~5.5 h** |

## Out of scope (deliberately)

The following are **not** in any PR:
- Resource subscribe/updated, completions/complete, elicitation, sampling, roots — not declared in `capabilities`.
- JSON-RPC framing, batch handling — SDK responsibility.
- Pure transport reconnect / `Last-Event-ID` resumability — not implemented in `dev_server.ts`.
- Cursor pagination on `tools/list` — we do not return `nextCursor`.

Re-evaluate when the corresponding feature is turned on in the server, not before.
