<!-- agents-scope: src -->
# src — source map

↑ [Root](../AGENTS.md)

The package has **several entry points** over one core; the top-level files wire
those entries, and the subdirectories hold the logic. Start at the child doc for the
directory you're editing.

## Entry points (top-level files)

- `index.ts` — the library export (`ActorsMcpServer` plus `createStatelessServer`, the
  per-request registration for 2026-07-28 traffic); `index_internals.ts` — the
  `./internals.js` surface the internal repo consumes (keep it minimal).
- `stdio.ts` — CLI entry (used for Docker). **Sentry must be imported first** — keep
  that import order.
- `dev_server.ts` — Express server for local dev / standby Actor mode. Its POST route
  serves both protocol eras: `isStatelessRequest` sends 2026-07-28 (per-request
  envelope) traffic to the stateless adapter, everything else to the stateful flow.
- `input.ts` — input processing (`processInput`, used by `stdio.ts` and the HTTP URL-param parser in `mcp/utils.ts`).
- `apify_client.ts` — the Apify API client wrapper; use it rather than calling the
  API directly. `state.ts` — TTL caches. `const.ts`, `errors.ts`,
  `types.ts`, `telemetry.ts`, `instrument.ts`, `server_card.ts` — shared spine.

## Subdirectories

- [`mcp/AGENTS.md`](mcp/AGENTS.md) — MCP protocol core (the published surface).
- [`tools/AGENTS.md`](tools/AGENTS.md) — MCP tool implementations.
- [`payments/AGENTS.md`](payments/AGENTS.md) — Skyfire / x402 payment providers.
- [`resources/AGENTS.md`](resources/AGENTS.md) — MCP resources + widget registry.
- [`web/AGENTS.md`](web/AGENTS.md) — widget UI (separate build) + design system.
- `utils/` — broad helper grab-bag, no single concept (no child doc; grep it).
- `prompts/` — the prompt registry (`index.ts`) plus `prompt_service.ts`
  (`createPromptService`, throws protocol-neutral domain errors); no child doc.

**Two-phase tool loading** (mode-agnostic `getActorsFromInput()` vs mode-dependent
`getToolsForServerMode()`) is documented once in
[`../DEVELOPMENT.md`](../DEVELOPMENT.md) — read it before touching tool loading.

After any change run the root [Verification](../AGENTS.md) steps.
