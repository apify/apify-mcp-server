<!-- agents-scope: src/mcp -->
# src/mcp — MCP protocol core (the npm-published surface)

↑ [src/](../AGENTS.md) · sideways: [`../payments/AGENTS.md`](../payments/AGENTS.md)

The cross-file invariant: this directory is the published `@apify/actors-mcp-server`
surface — **generic types only**. No Apify-internal infrastructure (Redis, Mongo,
IAM) may leak in; the internal repo customizes behavior by swapping the SDK store
implementations, not by importing from here.

## Files

- `server.ts` — `ActorsMcpServer`, the shared facade for tools, server mode, services,
  widgets, payments, and telemetry. It constructs and delegates v1 work to `LegacyMcpServer`.
- `legacy_server.ts` — package-private v1 SDK adapter for handlers, Tasks, errors,
  notifications, logging, and transport lifecycle. It reads shared state through
  `LegacyMcpServerHost`.
- `client_context.ts` — protocol-neutral client identity and capabilities.
- `errors.ts` — protocol-neutral domain errors mapped by each protocol adapter.
- `tool_call_engine.ts` — shared `tools/call` orchestration. `prepareToolCall()` handles
  preparation; `executeSyncToolCall()` runs synchronous calls.
- `client.ts` — `connectMCPClient(url, token)`: transport negotiation.
- `proxy.ts` — MCP-in-MCP: `getMCPServerID(url)`.
- `actors.ts` — `getActorMCPServerPath()`: parses an Actor's `webServerMcpPath`.
- `utils.ts` — `processParamsGetTools()`: turns `?actors=` URL params into tools.
- `tool_call_error_mapper.ts` — shared tool-call error classification.
- `tool_dispatch.ts` — neutral dispatch for internal, Actor MCP, and Actor tools.
- `tool_call_telemetry.ts` — shared tool-call telemetry preparation and logging.
- `task_execution.ts` — legacy long-running task execution and status notifications.
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
