# MCP Resources Refactor Analysis (Modular, Extensible, Existing Resources Only)

## Goals

- Make the existing resource handling modular and easy to extend.
- Keep the current low-level `Server` API approach.
- Keep the code minimal.
- Preserve behavior for existing resources (Skyfire usage guide and OpenAI UI widgets).
- Do not add new resources or templates in this phase.

## Current State (Summary)

- Resource handlers live in `ActorsMcpServer.setupResourceHandlers` (`src/mcp/server.ts`).
- Supported resources:
  - `file://readme.md` (Skyfire usage guide, gated by `skyfireMode`)
  - `ui://widget/*` (OpenAI UI widgets, gated by `uiMode === "openai"`)
- Resource templates are not exposed (`ListResourceTemplatesRequestSchema` returns an empty list).
- All resource logic is inline and coupled to server options.

## Proposed Refactor (No Behavior Changes)

### 1. Introduce a Minimal Resource Service Layer
Create a small resource service that owns listing and reading, and is invoked by the low-level request handlers.
Keep it as a single module at first to avoid extra abstractions.

- New module (example):
  - `src/mcp/resource_service.ts`

The service should expose:
- `listResources(): Promise<Resource[]>`
- `readResource(uri: string): Promise<ReadResourceResult>`
- `listResourceTemplates(): Promise<{ resourceTemplates: [] }>` (empty for now)

### 2. Keep Low-Level MCP Request Handlers

`ActorsMcpServer.setupResourceHandlers` should become thin glue:
- `ListResourcesRequestSchema` => `resourceService.listResources()`
- `ReadResourceRequestSchema` => `resourceService.readResource(uri)`
- `ListResourceTemplatesRequestSchema` => `resourceService.listResourceTemplates()`

No use of `registerResource` or `ResourceTemplate`, keeping low-level control intact.

### 3. Preserve Existing Behavior

- The Skyfire readme is still only exposed when `skyfireMode` is true.
- Widgets are still only exposed when `uiMode === "openai"` and the widget exists.
- Read failures continue to return plain-text errors to avoid client crashes.

## Extension Points (Future-Friendly, Not Implemented Now)

- Add a new provider class per new resource type.
- Add optional resource template support by extending the service to return templates.
- Add subscription handling by attaching a subscription manager to the resource service.

## Non-Goals

- No new resources or templates.
- No changes to the underlying low-level MCP `Server` usage.
- No runtime behavior changes for current clients.

## Reference Implementations and Patterns

### Official MCP TypeScript SDK (High-Level `McpServer`)
The official SDK’s conformance server (`/home/jirka/github/typescript-sdk/src/conformance/everything-server.ts`) uses `McpServer.registerResource` and `ResourceTemplate`. The SDK’s high-level server owns:
- Resource registry (static and template resources)
- `resources/list`, `resources/read`, and `resources/templates/list` handlers
- Template matching and completion

This is a different abstraction layer than the low-level `Server` we use here, so the registry and handlers are not available to reuse.

### FastMCP
FastMCP is also built on the low-level `Server` but provides its own registry layer:

- Maintains internal maps: `#resources` and `#resourceTemplates`
- Registers low-level handlers:
  - `ListResourcesRequestSchema` returns the cached list from the map
  - `ReadResourceRequestSchema` loads a direct resource or resolves a template
  - `ListResourceTemplatesRequestSchema` returns templates (if present)
- Exposes convenience methods: `addResource`, `addResources`, `addResourceTemplate`, `removeResource`, etc.
- Handles template matching via `parseURITemplate`

There is no `ResourceProvider` abstraction. FastMCP centralizes list/read logic in one place and uses an internal registry to keep handlers simple.

## Is a ResourceProvider Interface Required?

No. A provider interface is optional and not part of MCP or the official SDK. Given the current scope, a single minimal resource service (like a small registry) keeps the code shortest and easiest to follow. Add a provider interface only if the number of resource types grows enough to justify the extra indirection.

## MCP Resources Spec Highlights (2025-11-25)

### Capabilities
- Servers that support resources must declare `capabilities.resources`.
- Optional flags:
  - `subscribe`: server supports `resources/subscribe` and update notifications.
  - `listChanged`: server emits `notifications/resources/list_changed`.

### Core Methods
- `resources/list` supports pagination and returns `resources` plus optional `nextCursor`.
- `resources/read` returns `contents` containing text or binary resource blocks.
- `resources/templates/list` returns URI templates for parameterized resources.

### Notifications
- `notifications/resources/list_changed` when the list changes.
- `notifications/resources/updated` for subscribed resources.

### Resource Shapes
- `Resource` fields: `uri`, `name`, optional `title`, `description`, `icons`, `mimeType`, `size`.
- `ResourceContent` contains either `text` or `blob` (base64), plus `uri` and `mimeType`.
- Optional `annotations`: `audience`, `priority`, `lastModified`.

### URI Schemes
- `https://`: only when client can fetch directly.
- `file://`: filesystem-like resources (virtual or real).
- `git://`: version control resources.
- Custom schemes must follow RFC 3986.

### Errors
- Resource not found: `-32002`
- Internal error: `-32603`


## References

- Official MCP TypeScript SDK: `/home/jirka/github/typescript-sdk`
- Example server implementing full MCP specs: `/home/jirka/github/servers/src/everything`
- FastMCP: `/home/jirka/github/fastmcp`
