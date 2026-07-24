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
- `client_context.ts` — protocol-neutral client identity and capabilities. The server
  snapshots it from constructor recovery data and refreshes it during `initialize`.
  Internal helpers receive this context instead of an SDK initialize type; the raw
  `options.initializeRequestData` remains the hosted session-recovery boundary.
- `errors.ts` — protocol-neutral domain errors `InvalidParamsError`/`InternalError`
  (plain `Error` subclasses with `data?: unknown`, zero SDK imports). The prompt and
  resource services throw these; `server.ts`'s `toMcpError` maps each 1:1 to
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
- `tool_call_error_mapper.ts` — `buildToolCallErrorResult()`: pure classifier both
  `server.ts` tool-call catches share. Maps an error to a `kind: 'payment' | 'approval'
  | 'execution'` result (status, diagnostics, response/userText). Never throws, logs,
  or writes the store — the catch blocks own logging and store writes. For payment/approval
  the mapper returns the ready-to-send `response`; the catch builds the wire result only for
  the execution `userText`.
- `tool_dispatch.ts` — `dispatchToolCall()`: the single exhaustive `switch (tool.type)`
  (INTERNAL / ACTOR_MCP / ACTOR) both the sync handler and the task path run. Plain
  function taking the `ActorsMcpServer` instance; touches no class state beyond `.server`.
  The optional `emitLog` parameter sends ACTOR_MCP connect-failure notifications.
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
