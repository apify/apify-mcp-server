<!-- agents-scope: src/mcp -->
# src/mcp — MCP protocol core (the npm-published surface)

↑ [src/](../AGENTS.md) · sideways: [`../payments/AGENTS.md`](../payments/AGENTS.md)

The cross-file invariant: this directory is the published `@apify/actors-mcp-server`
surface — **generic types only**. No Apify-internal infrastructure (Redis, Mongo,
IAM) may leak in; the internal repo customizes behavior by swapping the SDK store
implementations, not by importing from here.

## Files

- `server.ts` — `ActorsMcpServer`: the **shared-Apify-behavior facade**. Owns the tool
  registry + loaders, server-mode resolution, MCP Apps capability detection, `actorStore`,
  telemetry config, widgets, the neutral prompt/resource services, and token/client
  resolution. Implements `LegacyMcpServerHost` and constructs exactly one `LegacyMcpServer`
  (the v1 adapter), delegating all v1 protocol work to it. `applyInitialize()` runs the
  shared initialize steps (client-context refresh → `'auto'` mode resolution → pending-tool
  flush → widget resolution) the adapter delegates to before returning `InitializeResult`.
  `connect()` resolves widgets then brings the adapter's transport up; `close()` takes the
  adapter down then clears the tool map (reverse-of-connect order — a deliberate reorder vs
  the pre-refactor tools-then-server order). Raw `.server` / `.taskStore` are NOT on the
  facade — they moved to the adapter.
- `legacy_server.ts` — `LegacyMcpServer` + the `LegacyMcpServerHost` interface: the v1 SDK
  adapter. **Package-private** — not exported from `index.ts` / `index_internals.ts`,
  constructed only by `ActorsMcpServer`. Owns the SDK `Server`, the `taskStore`, every
  request handler (`initialize` handshake, logging proxy + setLevel, error handling + SIGINT,
  tools/list + tools/call, prompts, resources, tasks), notifications, and `toLegacyMcpError`.
  Reads shared state through `LegacyMcpServerHost` (implemented by the facade); never imports
  the concrete facade class. The `CallToolRequest` handler decodes the wire request, pulls
  plain values off the host/`extra`, and drives `tool_call_engine.ts` (prepare → sync tail /
  task path → `dispatchToolCall`), then records telemetry. `InvalidToolCall` is mapped to the
  v1 softFail → logging notification → `McpError` sequence; `McpError` is re-thrown, while
  task-creation failures are classified as tool results. The task path reuses the same
  `PreparedCall`; both use the shared `dispatchToolCall` switch. Uses the SDK `InMemoryTaskStore`
  only for stdio; non-stdio transports must be given a task store (the internal repo injects a
  Redis one) or the constructor throws.
- `client_context.ts` — protocol-neutral client identity and capabilities. The server
  snapshots it from constructor recovery data and refreshes it during `initialize`.
  Internal helpers receive this context instead of an SDK initialize type; the raw
  `options.initializeRequestData` remains the hosted session-recovery boundary.
- `errors.ts` — protocol-neutral domain errors `InvalidParamsError`/`InternalError`
  (plain `Error` subclasses with `data?: unknown`, zero SDK imports). The prompt and
  resource services throw these; `legacy_server.ts`'s `toLegacyMcpError` maps each 1:1 to
  `McpError(ErrorCode.InvalidParams | InternalError, message, data)` in the
  `resources/read` and `prompts/get` handler bodies — the single v1 seam, so wire
  output stays byte-identical. A future v2 adapter supplies its own projection.
- `tool_call_engine.ts` — shared `tools/call` orchestration. `prepareToolCall()` handles
  token gate, tool resolution, payment context, AJV validation, task support, and standby/402
  pre-flight. `executeSyncToolCall()` runs the dispatch tail; `classifyToolCallError()` maps
  non-protocol errors to tool results. Protocol errors are not constructed here, and escaped
  `McpError`s remain JSON-RPC errors.
- `client.ts` — `connectMCPClient(url, token)`: transport negotiation.
- `proxy.ts` — MCP-in-MCP: `getMCPServerID(url)`.
- `actors.ts` — `getActorMCPServerPath()`: parses an Actor's `webServerMcpPath`.
- `utils.ts` — `processParamsGetTools()`: turns `?actors=` URL params into tools.
- `tool_call_error_mapper.ts` — `buildToolCallErrorResult()`: pure classifier shared by the
  engine's `classifyToolCallError()` (`tool_call_engine.ts`, reached from `legacy_server.ts`'s
  tools/call catch and from `executeSyncToolCall`) and the `task_execution.ts` catch. Maps an
  error to a `kind: 'payment' | 'approval'
  | 'execution'` result (status, diagnostics, response/userText). Never throws, logs,
  or writes the store — the catch blocks own logging and store writes. For payment/approval
  the mapper returns the ready-to-send `response`; the catch builds the wire result only for
  the execution `userText`.
- `tool_dispatch.ts` — `dispatchToolCall()`: the single exhaustive `switch (tool.type)`
  (INTERNAL / ACTOR_MCP / ACTOR) both the sync handler and the task path run. Plain function
  taking neutral values (`signal`, `sendNotification`, `emitLog`, `actorStore`,
  `paymentProvider`, `loadedToolNames`, …), not the facade. The required `emitLog` parameter
  sends ACTOR_MCP connect-failure notifications.
- `tool_call_telemetry.ts` — `prepareTelemetryData()` / `logToolCallAndTelemetry()`: shared by
  the sync `CallToolRequestSchema` handler and the task path. Plain functions taking the
  resolved telemetry config (`telemetryEnabled` / `telemetryEnv` / `transportType`) as neutral
  values, not the facade.
- `task_execution.ts` — `executeToolAndUpdateTask()` / `emitTaskStatusNotification()`: the
  long-running-task path (legacy-only). `executeToolAndUpdateTask()` takes the legacy
  `taskStore` / `server` plus neutral values (`tools`, `actorStore`, `paymentProvider`,
  `loadedToolNames`, telemetry config, `sendNotification`), not the facade, and builds its
  abort signal from its own cancel watcher. `emitTaskStatusNotification()` takes
  `taskStore`/`server` directly and also keeps two call sites in `legacy_server.ts` (the
  `tasks/cancel` handler and the pre-flight `setImmediate` failure path).
- `const.ts` — the invariant constants below (the single source for these values).

## Gotchas & invariants

- **Facade → adapter, one direction only.** `ActorsMcpServer` (facade) constructs and delegates
  to `LegacyMcpServer` (adapter). The adapter reads shared state only through the
  `LegacyMcpServerHost` interface and never imports the concrete facade class; the shared
  synchronous execution modules (`tool_call_engine.ts`, `tool_dispatch.ts`) take plain values and
  import no `ActorsMcpServer`, v1 `RequestHandlerExtra`, or v1 `McpError`, and nothing shared
  imports `LegacyMcpServer`. Keep it that way so a second protocol adapter reuses one Apify core.
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
- **Client data has two forms.** Keep `options.initializeRequestData` unchanged for hosted
  session recovery. Use the `McpClientContext` snapshot for client gating, request origin,
  telemetry, resources, and scheduled tasks. Do not export the context from the package root
  or `./internals`.

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
