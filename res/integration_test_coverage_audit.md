# Integration test coverage audit

Audit of `tests/integration/suite.ts` against the MCP 2025-11-25 spec and the request handlers actually wired in `src/mcp/server.ts` and `src/dev_server.ts`. Goal: identify protocol-level gaps that block confident deploys, without duplicating SDK or unit tests.

## Scope rule

- Skip anything the official `@modelcontextprotocol/sdk` already covers (transport framing, JSON-RPC envelope parsing, schema parsing).
- Skip anything covered by `tests/unit/*` (resource service internals, tool input shapes, ajv, etc).
- Cover only what depends on **our wiring**: `dev_server.ts` Express routes, `ActorsMcpServer` handler registration, the request → handler → tool path, and the public capabilities we advertise.

## What we declare in `initialize`

`src/mcp/server.ts:146` advertises:

```
tools: { listChanged: true }
tasks: { list, cancel, requests.tools.call }
resources: {}
prompts: {}
logging: {}
```

Every advertised capability MUST have a working integration path.

## Coverage matrix

| Capability / surface | Handler | Integration test |
|---|---|---|
| `initialize` → `serverInfo`, `instructions`, `capabilities`, `protocolVersion` | SDK + `setupCapabilityNegotiation` `server.ts:208` | **Missing** |
| `tools/list` | `server.ts:619` | Covered (~30 cases) |
| `tools/list` `_meta` (MCP Apps `ui.*`) | `server.ts:619` + `expectWidgetToolMeta` | Covered (uiMode openai) |
| `tools/call` happy path | `server.ts:633` | Covered |
| `tools/call` AJV validation error | `server.ts:633` | One case (`'must have required property input'`) |
| `tools/call` unknown tool name → JSON-RPC error | `server.ts:633` | **Missing** |
| `tools/call` returning `isError: true` content | several | One case (`fetch-apify-docs` forbidden URL) |
| `notifications/tools/list_changed` | `server.ts` upsert path | Covered (`add-actor`) |
| `notifications/cancelled` for `tools/call` | SDK abort wiring | Covered (streamable-http only) |
| `notifications/progress` (`progressToken` on call) | `server.ts:637` + `createProgressTracker` | **Missing** — server emits, no test asserts client receives them |
| `tasks/list` / `tasks/get` / `tasks/cancel` / `tasks/result` | `server.ts:524` | Covered (sync stream, list+get+result, cancel, statusMessage) |
| `resources/list` | `server.ts:464` | **Missing in integration** (only unit) |
| `resources/read` | `server.ts:468` | **Missing in integration** |
| `resources/templates/list` | `server.ts:472` | **Missing in integration** |
| `prompts/list` | `server.ts:484` | One case (count > 0) |
| `prompts/get` happy path | `server.ts:491` | One case (`GetLatestNewsOnTopic`) |
| `prompts/get` invalid name → InvalidParams | `server.ts:495` | **Missing** |
| `prompts/get` invalid args (AJV) → InvalidParams | `server.ts:500` | **Missing** |
| `logging/setLevel` | `server.ts:447` | **Missing** (no integration test sets a level) |
| `notifications/message` filtered by level | `setupLoggingProxy` `server.ts:~430` | **Missing** — no test asserts filtering behaves |
| `ping` | SDK default | **Missing** (cheap; one-liner per transport) |
| Streamable HTTP `Mcp-Session-Id` round trip | `dev_server.ts:184` | Implicit (client SDK uses it) |
| Streamable HTTP `DELETE /` terminate | `dev_server.ts:277` | Covered (`terminateSession`) |
| Streamable HTTP `GET /` returns 405 | `dev_server.ts:271` | **Missing** — pure HTTP assertion, no MCP client |
| Reusing transport across requests in one session | `dev_server.ts:187` | Implicit |
| Two concurrent sessions are isolated (tools, tasks, log level) | per-session `mcpServers[]` map | **Missing** — no parallel client test |
| 401/403 when `APIFY_TOKEN` missing | implicit (Apify API) | **Missing** at transport layer |
| Bad request: POST without session, not initialize → 404 | `dev_server.ts:244` | **Missing** |
| SSE legacy: GET /sse → POST /message round trip | `dev_server.ts:64`, `:137` | Implicit (suite runs over SSE) |
| Server `instructions` text returned in `initialize` | `server.ts:168` (`getServerInstructions`) | **Missing** |
| `ActorRun` widget structuredContent | get-actor-run | Covered |
| `_meta.usageTotalUsd / usageUsd` | call-actor | Covered |
| Actorized MCP proxy (server-as-tool) | `mcp/proxy.ts` | Covered (add + call) |
| call-actor `actor:tool` syntax routing | `mcp/proxy.ts` | Covered |
| `apifyToken` propagation via `_meta.apifyToken` | `server.ts:638` | **Missing** (only `Authorization` header path is tested) |
| Payment x402 / skyfire flag injection | covered | Covered (streamable-http only) |
| OpenAI / `ui=true` / `ui=openai` mode wiring | covered | Covered |
| Telemetry env-var precedence | covered | Covered |

## Critical gaps that block confident deploys

Ranked by blast radius if broken:

1. **`resources/list` + `resources/read`** — we advertise `resources` and clients (Claude Desktop) probe it on connect. A regression silently breaks those clients. Today only unit tests touch the service; no test verifies the request handler is even wired.
2. **`logging/setLevel` + filtered `notifications/message`** — we advertise `logging`. The proxy in `setupLoggingProxy` is non-trivial and easy to break. No integration test sends `setLevel` and asserts that a subsequent log notification respects the threshold.
3. **`notifications/progress`** — long-running calls publish progress via `createProgressTracker`. No test subscribes to `ProgressNotificationSchema` and asserts at least one `progress`/`total` arrives during a real Actor call. This is what powers the in-flight UX in clients.
4. **`tools/call` unknown name** — should return JSON-RPC `MethodNotFound`/`InvalidParams`, not 500. Currently untested; an exception path change would slip through.
5. **Initialize round-trip** — no test asserts `serverInfo.name`, `serverInfo.version`, `instructions`, and the declared `capabilities` block. A bad bump of capability shape breaks every client without any test catching it.
6. **Session isolation (streamable-http)** — `mcpServers[sessionId]` is a Map; `taskStore` is shared. If two clients open sessions in parallel, A's `loadToolsFromUrl(actors=X)` must not affect B (`actors=Y`), and A's `tasks/list` must not see B's tasks. Today nothing exercises this and a regression here corrupts hosted multi-tenant traffic.
7. **`prompts/get` error paths** — invalid name and invalid args branches in `server.ts:495`/`:500` are dead code as far as tests are concerned.
8. **Streamable-HTTP HTTP-level assertions** — `GET /` → 405 and `POST /` without `Mcp-Session-Id` and not init → 404. These are explicit branches in `dev_server.ts:244,271`. Cheap to assert, currently absent.

## Out of scope (deliberately not adding)

- JSON-RPC framing, message correlation, batch handling — SDK responsibility.
- Resource subscribe/updated, completions/complete, elicitation/sampling, roots — **not advertised** in our `capabilities`. Don't add tests; if we ever turn these on, add coverage then.
- Authorization spec (OAuth flows) — we use a bearer query/header. SDK handles framing; we already tunnel the token.
- Cursor-based pagination — our tool list is small and we don't return `nextCursor`. Skip until we do.
- Pure transport reconnect / `Last-Event-ID` resumability — not advertised, not implemented in `dev_server.ts`. Out of scope.

## Proposed additions

Add to `tests/integration/suite.ts` (single test file by convention; cases run across all three transports unless gated by `it.runIf`).

### Block A — base protocol surface

```ts
it('should expose serverInfo, instructions and capabilities on initialize', ...)
//   client = await createClientFn();
//   const info = client.getServerVersion();        // serverInfo
//   const caps = client.getServerCapabilities();
//   const instr = client.getInstructions();
//   assert: name=SERVER_NAME, version matches package.json, instructions length>0,
//           caps has tools.listChanged, tasks.{list,cancel,requests.tools.call},
//           resources, prompts, logging declared.

it('should respond to ping', ...)
//   await client.ping();  // does not throw
```

### Block B — resources (3 short tests)

```ts
it('should list resources via resources/list', ...)
//   const { resources } = await client.listResources();
//   expect(Array.isArray(resources)).toBe(true);
//   // sanity: at least one widget resource in openai mode
//   client = createClientFn({ uiMode: 'openai' });
//   expect(resources.some(r => r.uri.startsWith('ui://'))).toBe(true);

it('should list resource templates via resources/templates/list', ...)

it('should read a known widget resource and return mime+content', ...)
//   pick a uri from listResources, call client.readResource({uri});
//   expect contents[0].mimeType === RESOURCE_MIME_TYPE.
```

### Block C — logging

```ts
it('should accept logging/setLevel and apply it to outgoing log notifications', ...)
//   - subscribe to LoggingMessageNotificationSchema, accumulate into array.
//   - await client.setLoggingLevel('error')
//   - call any tool that emits info logs (e.g. search-apify-docs).
//   - poll: assert no notification with level !== 'error' after the call.
//   - then setLoggingLevel('debug') and assert at least one debug/info arrives.
//   - retry: 1, gated by runIf(streamable-http) since SSE may not deliver server→client logs reliably.
```

### Block D — progress notifications

```ts
it('should emit notifications/progress when progressToken is supplied', { retry: 1 }, ...)
//   - client.setNotificationHandler(ProgressNotificationSchema, ...)
//   - client.callTool({ name: 'apify/python-example', arguments: {...},
//                       _meta: { progressToken: 'pt-1' } })
//   - assert at least one notification with progressToken: 'pt-1' was received.
//   gated to runIf(streamable-http) for stability (see #558 comment in suite.ts:2402).
```

### Block E — error paths

```ts
it('should return JSON-RPC error for tools/call with unknown tool name', ...)
//   await expect(client.callTool({ name: 'does-not-exist', arguments: {} }))
//     .rejects.toThrow(/Tool .* not found|MethodNotFound|Method not found/);

it('should return InvalidParams for prompts/get with unknown name', ...)
it('should return InvalidParams for prompts/get with invalid args', ...)
//   verify error.code === ErrorCode.InvalidParams from McpError.
```

### Block F — streamable-HTTP HTTP-level wiring

These bypass the MCP client and hit the Express app directly via `fetch` — the test setup already exposes `httpServerHost`. Keep them in the streamable suite file (not the shared suite), since they are HTTP-not-MCP.

```ts
it('should return 405 on GET /', ...)
//   const r = await fetch(httpServerHost + '/');
//   expect(r.status).toBe(405); expect(r.headers.get('allow')).toBe('POST');

it('should return 404 on POST / without session and non-initialize body', ...)
//   POST { jsonrpc:'2.0', method:'tools/list', id:1 }, no Mcp-Session-Id
//   expect status 404, JSON body with jsonrpc error code -32000.
```

### Block G — session isolation (streamable-http)

```ts
it('should isolate tools and tasks across two concurrent sessions', ...)
//   const a = await createClientFn({ actors: ['apify/python-example'] });
//   const b = await createClientFn({ actors: ['apify/rag-web-browser'] });
//   - assert listTools(a) contains python-example and NOT rag-web-browser.
//   - assert listTools(b) contains rag-web-browser and NOT python-example.
//   - kick off a long task on a, then await b.experimental.tasks.listTasks()
//     and assert b sees zero tasks while a sees one.
//   - close in opposite order.
```

### Block H — `_meta.apifyToken` propagation (stdio + streamable-http)

```ts
it('should accept apifyToken via tools/call _meta and use it for the run', ...)
//   - start the server WITHOUT APIFY_TOKEN env var (special createClientFn variant).
//   - call apify/python-example with _meta.apifyToken = process.env.APIFY_TOKEN.
//   - assert success and that the run shows up under the right user via apifyClient.
//   only runIf token-injection is supported on that transport.
```

## Effort

Roughly:

- A: 30 min (4 asserts, no fixtures).
- B: 45 min (3 cases).
- C: 1 h (notification polling helper; reuse existing patterns).
- D: 1 h (gated, retry: 1).
- E: 30 min.
- F: 15 min (raw fetch).
- G: 1 h (concurrency, careful teardown).
- H: 1 h (needs createClientFn variant that omits APIFY_TOKEN env).

Total: ~6 h. ~12 new `it()` cases. No new test files — extend `suite.ts` for shared cases and `actor.server_streamable.test.ts` for HTTP-level cases. Keep names sentence-style per `tests/README.md`.

## Don't add

- A test per individual log level (5 asserts == bloat). One round-trip test is sufficient.
- A test per resource URI. One representative `read` is enough; URI catalog is unit-tested.
- Re-running every `tools/call` happy path with a `progressToken`. One test per progress emission path is enough.
- Synthetic JSON-RPC malformed-frame tests — SDK responsibility.
