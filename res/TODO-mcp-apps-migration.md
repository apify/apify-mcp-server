# TODO: MCP Apps Full Migration

Remaining work to achieve full MCP Apps (`@modelcontextprotocol/ext-apps`) compliance.
Tracks items not covered by the initial metadata migration PR.

## Server-side

### Capability negotiation (high priority)
- [ ] Check `io.modelcontextprotocol/ui` extension in client capabilities during `initialize`
- [ ] Use `getUiCapability()` from `@modelcontextprotocol/ext-apps/server` (requires `moduleResolution: 'node16'` or `'bundler'` in tsconfig, or import from root)
- [ ] Conditionally register UI tools/resources only when client supports `text/html;profile=mcp-app`
- [ ] Provide text-only fallback tools when client doesn't support MCP Apps

### Mode decoupling
- [ ] Decouple `ui` metadata from `mode: 'openai'` — the `_meta.ui.*` keys are the MCP standard and should be available in all modes, not just `openai`
- [ ] Only gate `openai/*` legacy keys behind `mode: 'openai'`
- [ ] Widget resources should be served when widgets are available, regardless of mode

### CSP dual format
- [ ] Remove snake_case CSP fields (`connect_domains`, `resource_domains`) from `WIDGET_CSP` in `src/resources/widgets.ts` once MCP Jam and all hosts support camelCase (`connectDomains`, `resourceDomains`). Currently shipping both for compatibility.

### Cleanup / renames
- [x] Rename `stripOpenAiMeta` → `stripWidgetMeta` in `src/utils/tools.ts`
- [x] Rename `filterOpenAiMeta` → `filterWidgetMeta` in `ToolPublicFieldOptions` and `src/mcp/server.ts`
- [x] Update `stripOpenAiMeta` comment references in 6 tool files
- [ ] Remove `openai/resultCanProduceWidget` (no MCP equivalent) once ChatGPT no longer needs it
- [ ] Remove `openai/widgetAccessible` once ChatGPT fully supports `ui.visibility`

## Client-side (`src/web/`)

### Replace `window.openai` with MCP Apps SDK `App` instance
- [ ] Install `@modelcontextprotocol/ext-apps` in the web package
- [ ] `window.openai.theme` → `app.getHostContext()?.theme` (`src/web/src/utils/init-widget.tsx`, `src/web/src/hooks/use-open-ai-global.ts`)
- [ ] `window.openai.toolOutput = ...` → `app.ontoolresult` callback (`src/web/src/widgets/actor-run-widget.tsx:225`)
- [ ] `window.openai.callTool(...)` → `app.callServerTool(...)` (`src/web/src/pages/ActorRun/ActorRun.tsx:367`)
- [ ] `window.openai.openExternal({href})` → `app.openLink({url})` (`src/web/src/pages/ActorRun/ActorRun.tsx:464,472`)
- [ ] `window.openai.widgetState` / `setWidgetState` → alternative state mechanism (`src/web/src/hooks/use-widget-state.ts`) — no MCP equivalent yet, use `localStorage` or server-side state
- [ ] Replace `src/web/src/hooks/use-open-ai-global.ts` hook with MCP Apps context
- [ ] Update `src/web/src/utils/mock-openai.ts` dev mock for new `App` API
- [ ] Remove/update `window.openai` type declarations

### Theming
- [ ] Adopt MCP Apps CSS variables (`--color-background-primary`, `--color-text-primary`, etc.) from host context
- [ ] Use `applyHostStyleVariables` / `applyDocumentTheme` utilities from ext-apps SDK

## Blocked upstream (not yet available in MCP Apps SDK)

| Feature | OpenAI API | Status |
|---------|-----------|--------|
| Tool invocation progress | `openai/toolInvocation/invoking` / `invoked` | Not yet implemented |
| Widget description | `openai/widgetDescription` | Use `app.updateModelContext()` |
| Widget state persistence | `widgetState` / `setWidgetState` | Use `localStorage` or server-side |
| File operations | `uploadFile` / `getFileDownloadUrl` | Not yet implemented |
| Modal management | `requestModal` / `requestClose` | Not yet implemented |
| Open in app URL | `setOpenInAppUrl` | Not yet implemented |
