<!-- agents-scope: src/mcp -->
# src/mcp — MCP protocol core (the npm-published surface)

↑ [src/](../AGENTS.md) · sideways: [`../payments/AGENTS.md`](../payments/AGENTS.md)

The cross-file invariant: this directory is the published `@apify/actors-mcp-server`
surface — **generic types only**. No Apify-internal infrastructure (Redis, Mongo,
IAM) may leak in; the internal repo customizes behavior by swapping the SDK store
implementations, not by importing from here.

Two MCP protocol revisions are served, each by its own adapter:

- **2025-era stateful protocol** ([spec](https://modelcontextprotocol.io/specification/2025-11-25)),
  via the v1 SDK `@modelcontextprotocol/sdk` — `legacy_server.ts`.
- **2026-07-28 stateless revision** ([spec](https://modelcontextprotocol.io/specification/2026-07-28)),
  via the v2 SDK `@modelcontextprotocol/server` — `stateless_server.ts`. No `initialize`
  handshake; every request carries a `_meta` envelope with protocol version, client info,
  and capabilities.

## Files

- `server.ts` — `ActorsMcpServer`, the shared facade for tools, server mode, services,
  widgets, payments, and telemetry. It constructs and delegates v1 work to `LegacyMcpServer`,
  and hands the stateless adapter a per-request snapshot via `createRequestSnapshot`.
- `legacy_server.ts` — package-private v1 SDK adapter for handlers, Tasks, errors,
  notifications, logging, and transport lifecycle. It reads shared state through
  `LegacyMcpServerHost`.
- `stateless_server.ts` — `createStatelessServer(host)`: the 2026-07-28 (v2 SDK) adapter,
  one `Server` per request, reading shared state through `StatelessMcpServerHost`. Serves
  `tools/*`, `resources/*` and `prompts/*`; registers no Tasks (the SDK answers
  method-not-found) and declares no `logging`.
- `client_context.ts` — protocol-neutral client identity and capabilities.
- `errors.ts` — protocol-neutral domain errors mapped by each protocol adapter.
- `tool_call_engine.ts` — shared `tools/call` orchestration. `prepareToolCall()` handles
  preparation; `executeSyncToolCall()` runs synchronous calls.
- `client.ts` — `connectMCPClient(url, token)`: transport negotiation.
- `remote_tool_call.ts` — `withRemoteMcpClient()`: connect-call-close round trip, shared by
  `tool_dispatch.ts`'s `ACTOR_MCP` case and `call_actor.ts`'s MCP passthrough; each caller's own
  callback does the actual `callTool`. Kept out of `client.ts`: a `vi.spyOn` on `connectMCPClient`
  only intercepts a cross-module import, not a same-module call from inside `client.ts` itself.
- `proxy.ts` — MCP-in-MCP: `getMCPServerID(url)`, `getProxyMCPServerToolName(actorFullName, toolName)`.
- `actors.ts` — `getActorMCPServerPath()`: parses an Actor's `webServerMcpPath`.
- `utils.ts` — `processParamsGetTools()`: turns `?actors=` URL params into tools.
- `tool_call_error_mapper.ts` — shared tool-call error classification.
- `tool_dispatch.ts` — neutral dispatch for internal, Actor MCP, and Actor tools.
- `tool_call_telemetry.ts` — shared tool-call telemetry preparation and logging.
- `task_execution.ts` — legacy long-running task execution and status notifications. `tasks/cancel`
  reaches the Actor run through `createTaskCancellationWatcher` (`utils.ts`), which polls the
  TaskStore rather than chaining the request's `extra.signal` — see its docstring for why.
- `const.ts` — the invariant constants below (the single source for these values).

## Gotchas & invariants

- **Facade → adapter, one direction only.** `ActorsMcpServer` (facade) constructs and delegates
  to `LegacyMcpServer`; `createStatelessServer` builds the stateless adapter per request from the
  same facade, which never constructs it. Each adapter reads shared state only through its own
  narrow host interface (`LegacyMcpServerHost`, `StatelessMcpServerHost`) and never imports the
  concrete facade class; the shared synchronous execution modules (`tool_call_engine.ts`,
  `tool_dispatch.ts`) take plain values and import no `ActorsMcpServer`, v1 `RequestHandlerExtra`,
  or v1 `McpError`, and **nothing shared imports either adapter**. Keep it that way: the two
  adapters are siblings over one Apify core, not layers.
- **Per-request state lives in a snapshot, never on the facade.** The stateless adapter resolves
  `'auto'` mode and report-problem visibility from *that request's* `_meta` envelope through
  `createRequestSnapshot`, which writes no request-specific state back to the facade (the one
  instance field it touches is the identity-independent widget-resolution memo). Never resolve a
  stateless request by writing to the shared facade — concurrent requests would contaminate
  each other.
- **Tool names are capped at `MAX_TOOL_NAME_LENGTH`.** Every name the cap truncates — username,
  tail, or both — carries a `TOOL_NAME_HASH_LENGTH` suffix hashed from the uncapped name;
  truncation alone collides. If any proxied name exceeds the cap, all sibling tools cap their
  username to `MAX_TOOL_NAME_USERNAME_LENGTH`; direct Actor tools do not. Collisions remain
  first-wins in `getToolsForServerMode`. Never widen the cap — clients depend on it
  (Actor tools: `../tools/actor_tool_naming.ts`; proxied Actor-MCP tools: `proxy.ts`
  `getProxyMCPServerToolName`).
- **Proxy server IDs are keyed by URL, not Actor ID.** `getMCPServerID(url)` is
  `sha256(url)` sliced to `SERVER_ID_LENGTH`; its one consumer is the MCP SDK client
  name (`client.ts`). One Actor can expose both an SSE and a streamable endpoint; keying
  by URL keeps those distinct. Keying by Actor ID would collapse them and cross transports.
  Exposed tool names do not use it — they are `{username}--{actor-name}--{originToolName}`,
  with the username cap above.
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
