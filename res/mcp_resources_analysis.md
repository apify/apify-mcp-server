# MCP Resources Implementation Analysis for Apify MCP Server

## Executive Summary

The current MCP resources implementation is intentionally minimal and uses the low-level MCP `Server` API. Resources are exposed only to prevent client failures and to support existing UI widgets and the Skyfire usage guide. There is no use of `registerResource` or `ResourceTemplate` because the codebase does not use the high-level `McpServer` API. Resource listing and reading are handled directly via request handlers.

## Current Architecture Overview

### MCP Server Structure
- **ActorsMcpServer** (`src/mcp/server.ts`) wraps the low-level MCP `Server`.
- Resources are declared in capabilities (empty object) to prevent failures in clients that expect resource support.
- Resource handling is implemented via `setRequestHandler` for:
  - `ListResourcesRequestSchema`
  - `ReadResourceRequestSchema`
  - `ListResourceTemplatesRequestSchema` (returns empty list)

### Existing Resource Types
1. **Skyfire usage guide**
   - Enabled only when `skyfireMode` is true.
   - URI: `file://readme.md`
   - Contents come from `SKYFIRE_README_CONTENT`.

2. **OpenAI UI widgets**
   - Enabled only when `uiMode === "openai"`.
   - URI prefix: `ui://widget/`
   - Resource list and reads are driven by `availableWidgets`.
   - Read handler loads widget JS from disk and wraps it in an HTML page.

### Resource Templates
No templates are currently provided. `ListResourceTemplatesRequestSchema` always returns an empty list.

## Constraints and Non-Negotiables

- **Do not use `registerResource`**: This repository uses the low-level `Server` API, not the high-level `McpServer` API.
- **Keep resource handling explicit**: Resource listing and reading must be handled via request handlers.
- **No new resources in this phase**: Only existing resources are in scope (Skyfire usage guide and UI widgets).

## Gaps and Risks

- **Monolithic handler**: Resource logic is embedded in `ActorsMcpServer.setupResourceHandlers`, which makes extension harder.
- **No resource registry**: There is no common interface for listing and reading resources; each resource type is handled inline.
- **No subscriptions or notifications**: The server does not provide `subscribe`, `unsubscribe`, or `notifications/resources/*` handling.
- **No templates**: Dynamic resources via URI templates are not supported.

## References

- Official MCP TypeScript SDK: `/home/jirka/github/typescript-sdk`
- Example server implementing full MCP specs: `/home/jirka/github/servers/src/everything`

