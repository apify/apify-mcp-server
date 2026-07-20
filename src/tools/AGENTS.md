<!-- agents-scope: src/tools -->
# src/tools — MCP tool implementations

↑ [src/](../AGENTS.md) · sideways: [`../mcp/AGENTS.md`](../mcp/AGENTS.md)

The cross-file invariant: a tool is defined here as a Zod-validated entry, and the
**same implementation serves both server modes** — only `*-widget` tools differ
between default and apps mode. Every non-widget tool (`call-actor`, `get-actor-run`,
direct actor tools, `search-actors`, `fetch-actor-details`) is mode-agnostic.

## Files

- `registry.ts` — tool categories and the tools in each (`index.ts` re-exports them).
- `structured_output_schemas.ts` — shared JSON-schema definitions for structured
  output across tools.
- `utils.ts` — shared tool helpers (schema property shaping, AJV compile).
- Tool implementations are grouped by domain, each registered through `registry.ts`:
  - `actors/` — search, details, call, add, the actor-tools factory, the direct
    actor-tool executor (`actor_executor.ts`), `actor_definition.ts` (fetches and
    prunes an Actor's definition, `getActorDefinition`), and `actor_run_response.ts`.
  - `runs/` — get/abort runs, run logs, run list.
  - `storage/` — dataset and key-value-store tools plus `storage_helpers.ts`.
  - `docs/` — search and fetch Apify docs.
  - `dev/` — the `report-problem` tool for reporting a problem with a tool or Actor.
  - `widgets/` — the `*-widget` tool variants (apps mode only).

## Rules when editing here

- **Validate inputs with Zod**; no ad-hoc shape checks. AJV + Zod already validate
  before a tool runs — don't re-check the same constraint inside the tool body.
- **Reference tool names via the `HELPER_TOOLS` `as const` object**, never hardcoded strings
  (exception: integration tests).
- Keep a new tool mode-agnostic unless it is genuinely a widget variant.

**Storage tool description skeleton** (`storage/`, all 8 tools): lead sentence stating what the tool
returns, then a disambiguation line naming the sibling tool(s) it's confused with via
`${HELPER_TOOLS.X}` (never a hardcoded name), proportional caveats, then `USAGE:` (one or more
bullets) and `USAGE EXAMPLES:` (one or more `user_input:` bullets). Match this shape when touching
these files.

## Related, owned elsewhere (don't restate)

- Tool-name cap + hash dedupe, transport: [`../mcp/AGENTS.md`](../mcp/AGENTS.md).
- Two-phase tool loading: [`../../DEVELOPMENT.md`](../../DEVELOPMENT.md).
- Naming / coding standards: [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).

After any change here run the root [Verification](../../AGENTS.md) steps.
