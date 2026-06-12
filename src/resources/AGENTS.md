<!-- agents-scope: src/resources -->
# src/resources — MCP resources + widget registry

↑ [src/](../AGENTS.md) · sideways: [`../web/AGENTS.md`](../web/AGENTS.md)

Two files serving the MCP `resources/*` surface:

- `resource_service.ts` — handles `ListResources` / `ListResourceTemplates` /
  read-resource requests.
- `widgets.ts` — the registry of UI widgets (the metadata that maps a widget name to
  its resource); the widgets themselves are built in [`../web`](../web/AGENTS.md).

## Gotcha

`widgets.ts` is **metadata only** — it registers and locates widgets. The actual
React widget code and design rules live in [`../web/AGENTS.md`](../web/AGENTS.md);
keep the two in sync (a widget registered here must exist there, and vice versa).

After any change here run the root [Verification](../../AGENTS.md) steps.
