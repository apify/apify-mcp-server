<!-- agents-scope: src/web -->
# src/web — MCP Apps widget UI (separate build)

↑ [src/](../AGENTS.md) · sideways: [`../resources/AGENTS.md`](../resources/AGENTS.md)

The cross-file invariant: this is a **self-contained React project with its own
`package.json`, Tailwind/PostCSS config, and build** — the root `tsconfig.json`
excludes `src/web`, and `pnpm run build` builds it separately and copies the output
into `dist/web/`. Treat it as its own package: it does not import server code, and
server code does not import widgets.

## How widgets work

- A widget renders from a **tool's output** — to put data on a widget, change the
  corresponding tool's return value, not the widget's props by hand.
- Rendering requires **UI mode**: `?ui=true` on the endpoint or `UI_MODE=true`.
- Editing `src/web/src/widgets/*.tsx` hot-reloads; adding a new widget filename
  requires reconnecting the MCP client to pick it up.

## Design system

Widget styling and component rules live in
[`./DESIGN_SYSTEM_AGENT_INSTRUCTIONS.md`](./DESIGN_SYSTEM_AGENT_INSTRUCTIONS.md) —
read it before any UI/widget work. It is the single source of truth for the design
system; don't restate its rules elsewhere.

## Local commands

```bash
pnpm run build      # builds the core + this widget bundle into dist/web/
pnpm run dev        # hot-reload widget dev (see DEVELOPMENT.md)
```

Build, hot-reload, and ChatGPT/MCPJam preview workflows are documented in
[`../../DEVELOPMENT.md`](../../DEVELOPMENT.md). After any change here run the root
[Verification](../../AGENTS.md) steps.
