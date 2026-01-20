# MCP Resources Refactor Analysis (Implementation-Focused, Minimal, Extensible)

## Goals

- Keep the low-level `Server` API (no `McpServer` registry).
- Preserve current resource behavior (Skyfire readme + OpenAI widgets).
- Make the implementation easy to extend without extra abstractions.
- Keep changes minimal and localized.
- Do not add new resources or templates in this phase.

## Current State (Summary)

- Resource handlers are thin and delegate to `createResourceService`.
- Resource service lives in `src/resources/resource_service.ts`.
- Widget registry lives in `src/resources/widgets.ts`.
- Supported resources:
  - `file://readme.md` (Skyfire usage guide, gated by `skyfireMode`)
  - `ui://widget/*` (OpenAI UI widgets, gated by `uiMode === "openai"`)
- Templates are not exposed (`ListResourceTemplatesRequestSchema` returns empty list).

## Implementation (Current, Behavior-Preserving)

### 1. Minimal Resource Service
Create a single service module that owns list/read/templates logic and keeps handlers thin.

Location:
- `src/resources/resource_service.ts`

API:
- `listResources(): Promise<ListResourcesResult>`
- `readResource(uri: string): Promise<ReadResourceResult>` (extended to include `html` for widgets)
- `listResourceTemplates(): Promise<ListResourceTemplatesResult>` (empty for now)

### 2. Thin MCP Handlers
`ActorsMcpServer.setupResourceHandlers` delegates directly:
- `ListResourcesRequestSchema` → `resourceService.listResources()`
- `ReadResourceRequestSchema` → `resourceService.readResource(uri)`
- `ListResourceTemplatesRequestSchema` → `resourceService.listResourceTemplates()`

### 3. Behavior Preservation
- Skyfire readme only when `skyfireMode` is true.
- Widgets only when `uiMode === "openai"` and the widget file exists.
- Read failures return plain-text content (no throw).

## Extension Points (Future-Friendly, Not Implemented Now)

- Add new resource types by extending `resource_service.ts`.
- Add resource templates by returning non-empty `resourceTemplates`.
- Add subscriptions/notifications by layering a small subscription manager in the service.

## Non-Goals

- No new resource types or templates.
- No change to low-level `Server` usage.
- No behavior changes for current clients.

## Implementation Notes (Simplicity + Extensibility)

- Use MCP SDK types (`Resource`, `ListResourcesResult`, `ReadResourceResult`) for clarity.
- Keep widget metadata in `_meta` with OpenAI keys as-is.
- Keep service synchronous where possible and avoid extra indirection.

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
