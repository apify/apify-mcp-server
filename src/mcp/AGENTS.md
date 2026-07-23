<!-- agents-scope: src/mcp -->
# src/mcp — MCP protocol core (the npm-published surface)

↑ [src/](../AGENTS.md) · sideways: [`../payments/AGENTS.md`](../payments/AGENTS.md)

The cross-file invariant: this directory is the published `@apify/actors-mcp-server`
surface — **generic types only**. No Apify-internal infrastructure (Redis, Mongo,
IAM) may leak in; the internal repo customizes behavior by swapping the SDK store
implementations, not by importing from here.

## Files

- `server.ts` — `ActorsMcpServer`: tool/prompt/resource/task registration, the
  `initialize` handshake, MCP Apps capability detection, `CallToolRequest` handling.
  The `CallToolRequest` handler prepares calls with `tool_call_engine.ts`, runs the
  sync tail, and records telemetry. `InvalidToolCall` is mapped to the v1
  softFail → logging notification → `McpError` sequence; `McpError` is re-thrown,
  while task-creation failures are classified as tool results. The task path reuses
  the same `PreparedCall`; both use the shared `dispatchToolCall` switch.
  Uses the SDK `InMemoryTaskStore` only for stdio; non-stdio transports must be given
  a task store (the internal repo injects a Redis one) or the constructor throws.
- `tool_call_engine.ts` — shared `tools/call` orchestration. `prepareToolCall()` handles
  token gate, tool resolution, payment context, AJV validation, task support, and standby/402
  pre-flight. `executeSyncToolCall()` runs the dispatch tail; `classifyToolCallError()` maps
  non-protocol errors to tool results. Protocol errors are not constructed here, and escaped
  `McpError`s remain JSON-RPC errors.
- `client.ts` — `connectMCPClient(url, token)`: transport negotiation.
- `proxy.ts` — MCP-in-MCP: `getMCPServerID(url)`.
- `actors.ts` — `getActorMCPServerPath()`: parses an Actor's `webServerMcpPath`.
- `utils.ts` — `processParamsGetTools()`: turns `?actors=` URL params into tools.
- `tool_call_error_mapper.ts` — `buildToolCallErrorResult()`: pure classifier both
  `server.ts` tool-call catches share. Maps an error to a `kind: 'payment' | 'approval'
  | 'execution'` result (status, diagnostics, response/userText). Never throws, logs,
  or writes the store — the catch blocks own logging and store writes. For payment/approval
  the mapper returns the ready-to-send `response`; the catch builds the wire result only for
  the execution `userText`.
- `stateless_server.ts` — `createStatelessServer(apifyMcpServer)`: the MCP 2026-07-28
  registration shell on `@modelcontextprotocol/server`. Additive stateless surface for
  `tools/list`, `tools/call`, `resources/*`, `prompts/*`. A thin shell over `tool_call_engine.ts`
  (`prepareToolCall` → `executeSyncToolCall`), not a re-implementation of the spine. Per-request
  client identity/mode/token (envelope `_meta` + `authInfo`, never `_meta.apifyToken`); server mode
  and `report-problem` visibility re-resolved per request. Four differences from the v1 shell:
  `InvalidToolCall` throws `ProtocolError(InvalidParams)` with no logging notification (SEP-2577);
  results are projected via `server.projectCallToolResult`; `tasks/*` is unregistered (the SDK
  rejects it `-32601`), so `isTaskRequest` is always false; identity/mode/token are per-request.
  Apps tools are composed for each request's resolved mode. Legacy `server.ts` stays on the v1 SDK.
- `tool_dispatch.ts` — `dispatchToolCall()`: the single exhaustive `switch (tool.type)`
  (INTERNAL / ACTOR_MCP / ACTOR) both the sync handler and the task path run. Plain
  function taking the `ActorsMcpServer` instance; touches no class state beyond `.server`.
  An ACTOR_MCP connect failure is logged server-side (`log.softFail`) and returned as a soft-fail
  `isError` result — it no longer emits a client-facing logging notification (removed in the
  2026-07-28 migration; SEP-2577).
- `tool_call_telemetry.ts` — `prepareTelemetryData()` / `logToolCallAndTelemetry()`: shared by
  the sync `CallToolRequestSchema` handler and the task path. Plain functions taking the
  `ActorsMcpServer` instance (as `apifyMcpServer`), reading `telemetryEnabled`/`telemetryEnv`
  and `options.*` off it — both are `public readonly` on `ActorsMcpServer`.
- `task_execution.ts` — `executeToolAndUpdateTask()` / `emitTaskStatusNotification()`: the
  long-running-task path. `executeToolAndUpdateTask()` takes the `ActorsMcpServer` instance
  (as `apifyMcpServer`); `emitTaskStatusNotification()` takes `taskStore`/`server` directly
  and also keeps two call sites in `server.ts` (the `tasks/cancel` handler and the pre-flight
  `setImmediate` failure path).
- `const.ts` — the invariant constants below (the single source for these values).

## Gotchas & invariants

- **Tool names: capped + hash-deduped.** Names are capped at `MAX_TOOL_NAME_LENGTH`;
  over-length or colliding names get a `TOOL_NAME_HASH_LENGTH` hash suffix so the
  exposed set stays unique within the limit (the hashing is in `../tools/actor_tool_naming.ts`).
  Never widen the cap — downstream clients depend on it.
- **Proxy server IDs are keyed by URL, not Actor ID.** `getMCPServerID(url)` is
  `sha256(url)` sliced to `SERVER_ID_LENGTH`. One Actor can expose both an SSE and a
  streamable endpoint; keying by URL keeps those distinct. Keying by Actor ID would
  collapse them and cross transports.
- **Transport negotiation is streamable-first, SSE-fallback** (`client.ts`): try
  streamable HTTP, fall back to SSE on a protocol failure — but a connection
  **timeout** returns `null` with no SSE fallback (a timeout means unreachable, not
  the wrong transport). `getActorMCPServerPath()` prioritizes the `/mcp` streamable
  endpoint when an Actor lists several.
- **Two-phase tool loading** (mode-agnostic `getActors()` vs mode-dependent
  `getToolsForServerMode()`) is documented once in
  [`../../DEVELOPMENT.md`](../../DEVELOPMENT.md) — read it before changing
  registration in `server.ts`; not restated here.
- **Stateless per-request compose.** `composeStatelessClientGatedTools()` resolves queued sources
  for the request's mode without mutating the legacy tool map. `stateless_server.ts` uses that map
  for both listing and calling tools, and removes `report-problem` when the request client cannot
  use it.

## Local commands

```bash
pnpm run type-check
pnpm run test:unit
```

Dev server and manual MCP-client (mcpc) testing: see
[`../../DEVELOPMENT.md`](../../DEVELOPMENT.md). After any change here run the root
[Verification](../../AGENTS.md) steps.

## See also

- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) — naming / coding standards (do not duplicate).
- [`../payments/AGENTS.md`](../payments/AGENTS.md) — `CallToolRequest` resolves payment context.
