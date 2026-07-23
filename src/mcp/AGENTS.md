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
  The `CallToolRequest` handler is a thin shell over `tool_call_engine.ts`: it builds
  inputs, calls `prepareToolCall` (mapping an `InvalidToolCall` back to the v1
  softFail-log → side-channel → `McpError` throw, and interpreting a `PreparedCallError` —
  a prep-spine post-resolution throw the engine already classified — like any other outcome)
  and `executeSyncToolCall`, then runs its telemetry `finally`. Its outer `catch` re-throws
  `McpError` unchanged and routes a task-branch `createTask` throw through the shared
  `classifyToolCallError` so it becomes a classified `isError` result, not a raw reject —
  byte-identical to v1's old inline catch. The task path (`executeToolAndUpdateTask`, in
  `task_execution.ts`) reuses the same `PreparedCall`. Both run the shared
  `dispatchToolCall` switch in `tool_dispatch.ts`.
  Uses the SDK `InMemoryTaskStore` only for stdio; non-stdio transports must be given
  a task store (the internal repo injects a Redis one) or the constructor throws.
- `tool_call_engine.ts` — the shared `tools/call` orchestration spine both eras call.
  `prepareToolCall()` runs the prep spine (token gate → resolution → payment context → AJV
  validation → task-support check → standby/402 pre-flight) and returns a neutral
  `PreparedCall`, `InvalidToolCall`, or `PreparedCallError` (a post-resolution non-`McpError`
  throw it classifies itself, keeping the actor context v1 had) — never throws a protocol
  error. `executeSyncToolCall()`
  runs the dispatch tail (pre-flight short-circuit → dispatch → error classification →
  report-problem nudge) and returns a `ToolCallOutcome`. `classifyToolCallError()` is the
  shared error→`ToolCallOutcome` classifier (reuses `buildToolCallErrorResult`, applies the
  nudge, owns the APPROVAL/EXECUTION `logHttpError` side-effects); both `executeSyncToolCall`'s
  catch and the shell's outer catch route through it. `buildPreflightFailureOutcome()`
  lives here (single-source precedence: standby wins over 402). Does not construct SDK protocol
  errors — shells do; escaped `McpError`s are re-thrown so they stay JSON-RPC errors.
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
  The optional `emitLog` param (default: `apifyMcpServer.server.sendLoggingMessage`) is the
  client-facing side-channel for the ACTOR_MCP connect-failure soft-fail; a shell with no
  session transport can pass a no-op, keeping the hard `.server` coupling off the leaf.
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
