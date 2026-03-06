# OpenAI ChatGPT Apps: CSP & Widget Metadata Migration

## Context

OpenAI has moved from proprietary `openai/*` metadata keys to the **MCP Apps open standard** (`_meta.ui.*`).
Our codebase still uses the old keys. Migration is needed for broad distribution and future compatibility.

**Source:** [Build your MCP server - CSP section](https://developers.openai.com/apps-sdk/build/mcp-server/#content-security-policy-csp)
**Migration guide:** [ext-apps migrate_from_openai_apps.md](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate_from_openai_apps.md)

> "Existing Apps SDK APIs remain supported" — old `openai/*` keys still work, but the new standard is required for broad distribution.

---

## Implementation Plan: 2 Sequential PRs

### PR 1: CSP Format + MIME Type Fix (unblocks app submission)

Small, targeted fix. Old `openai/*` metadata keys remain (still supported by ChatGPT). Only the CSP field naming and MIME type change — these are what the sandbox actually enforces at runtime.

#### Changes

**`src/resources/widgets.ts`**
- CSP field names: `connect_domains` → `connectDomains`, `resource_domains` → `resourceDomains`
- Update `WidgetMeta` type to match new CSP field names
- Add exported constant: `RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'`

**`src/resources/resource_service.ts`**
- Import `RESOURCE_MIME_TYPE` from `./widgets.js`
- Replace `'text/html+skybridge'` (lines 55, 108) with `RESOURCE_MIME_TYPE`

**`tests/unit/mcp.utils.test.ts`**
- Line 156: Update MIME type assertion to `'text/html;profile=mcp-app'`

---

### PR 2: Full Metadata Restructure (openai/* → ui.*)

Completes the migration to MCP Apps standard. Replaces flat `openai/*` keys with nested `_meta.ui.*` structure.

#### Key Mapping

| Old Key | New Key | Notes |
|---|---|---|
| `openai/widgetCSP` | `ui.csp` | CSP config object |
| `openai/widgetDomain` | `ui.domain` | Required for submission, unique per app |
| `openai/widgetPrefersBorder` | `ui.prefersBorder` | Visual boundary |
| `openai/outputTemplate` | `ui.resourceUri` | Points to widget template URI |
| `openai/widgetAccessible: true` | `ui.visibility: ['model', 'app']` | Array of scopes |
| `openai/resultCanProduceWidget` | _(removed)_ | No equivalent in new standard |
| `openai/widgetDescription` | `openai/widgetDescription` | ChatGPT extension, stays as-is |
| `openai/toolInvocation/invoking` | `openai/toolInvocation/invoking` | ChatGPT extension, stays as-is |
| `openai/toolInvocation/invoked` | `openai/toolInvocation/invoked` | ChatGPT extension, stays as-is |

#### CSP Field Mapping

| Old | New | Purpose |
|---|---|---|
| `connect_domains` | `connectDomains` | Origins for fetch/XHR/WebSocket |
| `resource_domains` | `resourceDomains` | Origins for images, fonts, scripts |
| `frame_domains` | `frameDomains` | Origins for nested iframes (optional, discouraged) |

#### Changes

**`src/resources/widgets.ts`** — Core restructure:
- `OPENAI_WIDGET_BASE_META` → `WIDGET_BASE_META` with nested `ui: { prefersBorder, domain, csp, visibility }`
- `OPENAI_WIDGET_CSP` → `WIDGET_CSP` (rename only, fields already camelCase from PR 1)
- Rewrite `WidgetMeta` type for nested `ui` structure
- Update `WIDGET_REGISTRY`: `openai/outputTemplate` → `ui.resourceUri` inside `ui` object
- Remove `openai/widgetAccessible` and `openai/resultCanProduceWidget`

**`src/utils/tools.ts`** — Strip function:
- `stripOpenAiMeta` → `stripWidgetMeta` (also strips `ui` key, not just `openai/*`)
- `filterOpenAiMeta` → `filterWidgetMeta` in options type
- Update `getToolPublicFieldOnly`

**`src/mcp/server.ts`** — Line 584:
- `filterOpenAiMeta: true` → `filterWidgetMeta: true`

**Comment updates** — Update `stripOpenAiMeta` → `stripWidgetMeta` references:
- `src/tools/core/search_actors_common.ts:96`
- `src/tools/core/fetch_actor_details_common.ts:49`
- `src/tools/core/get_actor_run_common.ts:49`
- `src/tools/core/actor_tools_factory.ts:126`
- `src/tools/default/call_actor.ts:60`
- `src/tools/openai/call_actor.ts:56`

No structural code changes in tool handlers — the `...widgetConfig?.meta` spread pattern works with the new shape.

**Tests:**

`tests/unit/tools.mode_contract.test.ts`:
- `filterOpenAiMeta` → `filterWidgetMeta` in all test options
- Update fixture to include `ui: {...}` key
- Stripping should remove both `openai/*` and `ui` keys

`tests/integration/suite.ts`:
- `expectOpenAiToolMeta` → `expectWidgetToolMeta`
- Check `_meta.ui.resourceUri` and `_meta.ui.visibility` instead of old keys

---

## Files NOT Modified (confirmed)

- `src/tools/openai/search_actors.ts` — `...widgetConfig?.meta` spread works as-is
- `src/tools/openai/fetch_actor_details.ts` — same
- `src/tools/openai/get_actor_run.ts` — same
- `src/tools/openai/actor_executor.ts` — same
- `src/tools/openai/*_internal.ts` — no widget metadata
- `src/utils/mcp.ts` — uses `Record<string, unknown>`, no change needed
- `src/types.ts` — uses `Record<string, unknown>`, no change needed
- `src/web/**` — client-side out of scope (separate future migration)

---

## New Standard Reference

### Widget Resource (from OpenAI docs)
```ts
registerAppResource(server, "widget-name", "ui://widget/my-widget.html", {},
    async () => ({
        contents: [{
            uri: "ui://widget/my-widget.html",
            mimeType: "text/html;profile=mcp-app",
            text: widgetHtml,
            _meta: {
                ui: {
                    prefersBorder: true,
                    domain: "https://myapp.example.com",
                    csp: {
                        connectDomains: ["https://api.example.com"],
                        resourceDomains: ["https://cdn.example.com"],
                    },
                },
            },
        }],
    })
);
```

### Tool Descriptor
```ts
registerAppTool(server, "my-tool", {
    title: "My Tool",
    inputSchema: { query: z.string() },
    _meta: {
        ui: { resourceUri: "ui://widget/my-widget.html" },
        "openai/toolInvocation/invoking": "Loading...",  // ChatGPT extension
        "openai/toolInvocation/invoked": "Done.",         // ChatGPT extension
    },
}, handler);
```

### Tool Visibility (new capability)
```json
{ "_meta": { "ui": { "resourceUri": "...", "visibility": ["model", "app"] } } }
```
- `["model", "app"]` — callable by both (default)
- `["app"]` — UI-only, hidden from model
- `["model"]` — model-only

---

## Notes

- **Downstream**: `apify-mcp-server-internal` may need updates — check before merging PR 2.
- **Client-side**: `window.openai` → `App` from `@modelcontextprotocol/ext-apps` is a separate future migration.
- **No new dependency**: We define `RESOURCE_MIME_TYPE` locally instead of importing from `@modelcontextprotocol/ext-apps`.
