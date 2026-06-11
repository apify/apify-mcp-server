<!-- agents-scope: src/tools -->
# src/tools — MCP tool implementations

↑ [src/](../AGENTS.md) · sideways: [`../mcp/AGENTS.md`](../mcp/AGENTS.md)

The cross-file invariant: a tool is defined here as a Zod-validated entry, and the
**same implementation serves both server modes** — only `*-widget` tools differ
between default and apps mode. Every non-widget tool (`call-actor`, `get-actor-run`,
direct actor tools, `search-actors`, `fetch-actor-details`) is mode-agnostic.

## Files

- `actor_executor.ts` — direct actor-tool executor; mode-agnostic.
- `categories.ts` — tool categories and the tools in each (`index.ts` re-exports them).
- `build.ts` — fetches and prunes an Actor's definition (`getActorDefinition`).
- `structured_output_schemas.ts` — shared JSON-schema definitions for structured
  output across tools.
- `utils.ts` — shared tool helpers (schema property shaping, AJV compile).
- The bulk of tool implementations live in `apps/`, `common/`, `core/`, `default/`,
  registered through `categories.ts`.

## Rules when editing here

- **Validate inputs with Zod**; no ad-hoc shape checks. AJV + Zod already validate
  before a tool runs — don't re-check the same constraint inside the tool body.
- **Reference tool names via the `HelperTools` enum**, never hardcoded strings
  (exception: integration tests).
- Keep a new tool mode-agnostic unless it is genuinely a widget variant.

## Related, owned elsewhere (don't restate)

- Tool-name cap + hash dedupe, transport: [`../mcp/AGENTS.md`](../mcp/AGENTS.md).
- Two-phase tool loading: [`../../DEVELOPMENT.md`](../../DEVELOPMENT.md).
- Naming / coding standards: [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).

After any change here run the root [Verification](../../AGENTS.md) steps.
