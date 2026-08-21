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
  - `actors/` — search, details, call, the actor-tools factory, the direct
    actor-tool executor (`actor_executor.ts`), `actor_definition.ts` (fetches and
    prunes an Actor's definition, `getActorDefinition`), and `actor_run_response.ts` —
    the one canonical run shape `call-actor` and `get-actor-run` share across sync, task
    and wait-timeout modes: storage IDs plus a `summary` (past) / `nextStep` (one primary
    action) pair, never inline dataset items or KV bodies.
  - `runs/` — get/abort runs, run logs, run list.
  - `storage/` — dataset and key-value-store tools plus `storage_helpers.ts`.
  - `tasks/` — Actor task create/get/update plus publish/unpublish of the task's public
    landing page (`task_helpers.ts` holds the shared task response shape and the publication call).
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

Exception: the `AUTO_INJECTED_TOOLS` (`../utils/tools_loader.ts`) — `get-actor-run`,
`get-dataset-items`, `get-key-value-store-record`, `abort-actor-run` — land in sessions that never
loaded their own category, so their disambiguation line must describe what they return instead of
naming a sibling — a name the client never received in `tools/list` invites a call to a tool that
does not exist. Any other cross-tool reference must be gated per session: define a
`buildDescription(ctx)` on the entry (see `ToolDescriptionContext` in `../types.ts`), wrap the
reference in `ctx.hasTool(...)`, and set `description` to the `ALL_TOOLS_PRESENT` render. Rendering
happens once, at the tools/list boundary (`getToolPublicFieldOnly` in `../utils/tools.ts`). Enforced
by `tests/unit/tools.mode_contract.test.ts`, which scans `description` only.

Input-schema field text (`.describe()` on a Zod field) reaches `tools/list` verbatim — nothing
renders it per session — so never name a tool there; put the guidance in `buildDescription` behind
`hasTool`. `actors/actor_tools_factory.ts`'s `waitSecs` is the one exception: an Actor tool always
auto-injects the `get-actor-run` it names.

Result text (`summary` / `nextStep` in `content[1]`) has no `hasTool`, but it does have a per-session
gate: `InternalToolArgs.loadedToolNames` (see `suggestTool` in `storage/storage_helpers.ts`). Name a
tool there only through that gate, or when it is the calling tool itself (the "call it again with the
next offset" pagination hint); otherwise leave the cross-tool guidance to the gated description.
An `AUTO_INJECTED_TOOLS` member is no exception — the injection is conditional on `call-actor`, an
Actor tool, or `get-actor-run` being loaded, so a session that loaded only `abort-actor-run` gets
none of them. The task tools name no tool, enforced by `tests/unit/tools.actor_task_crud.test.ts`;
result text elsewhere predates the gate, and `suggestTool` is the pattern to fix it with. Grep
`HELPER_TOOLS` outside `buildDescription` for the current set rather than trusting a list here.

## Related, owned elsewhere (don't restate)

- Tool-name cap + hash dedupe, transport: [`../mcp/AGENTS.md`](../mcp/AGENTS.md).
- Two-phase tool loading: [`../../DEVELOPMENT.md`](../../DEVELOPMENT.md).
- Naming / coding standards: [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).

After any change here run the root [Verification](../../AGENTS.md) steps.
