# Integration test suite rework

## What

Split `tests/integration/suite.ts` (3292 lines, 115 cases, one file) into per-concern
modules. Share the majority of cases with `apify-mcp-server-internal` instead of
hand-duplicating ~40 of them there.

## Why

One file, 115 cases, unmaintainable by more than one person at a time. Internal
re-implements a third of the same assertions against a live deploy — drifts, doubles
maintenance cost, no shared source of truth.

## Things to decide

Two top-level directories, not one flat pile:

```
tests/integration/
  tools/                          # mirrors src/tools/ — tool-owned behavior
    actors/{call_actor,fetch_actor_details,search_actors,mcp_server_actor}.ts
    docs/docs_tools.ts
    runs/actor_run.ts
    storage/storage_tools.ts
    widgets/widget_contracts.ts
  protocol/                       # mirrors src/mcp/ + src/utils/server_mode.ts
    tool_loading.ts                # selectors/categories/env-vars — registration, not a tool
    tasks.ts
    notifications_cancellation.ts
    server_mode.ts
    payments/{skyfire,x402}.ts
  actor.server_stateless.test.ts   # unchanged: real vitest entry points, compose
  actor.server_streamable.test.ts  # every register*Tests() into one sequential
  stdio.test.ts                    # describe block, same as today
```

`tools/`/`protocol/` files export plain `register*Tests(ctx)` functions — not
`*.test.ts` files. Tests run sequentially (shared Apify test account/Actors, rate
limits) — new concern files stay non-test modules composed by the 3 existing entry
points into one sequential run, same as today.

## How: critical tests, shared with internal

Each scenario carries `critical: boolean`. Public runs all of them. Internal imports
only the `critical: true` ones and runs them against its live deploy — no separate
internal reimplementation for the shared subset.

```ts
// tests/integration/tools/actors/search_actors.ts (public)
export const searchActorsScenarios: Scenario[] = [
    {
        name: 'lists at least one Actor',
        critical: true,                      // internal runs this against staging/prod
        run: async (ctx) => {
            const client = await ctx.createClientFn();
            const result = await client.callTool('search-actors', { search: 'web scraper' });
            expect(result.content.length).toBeGreaterThan(0);
        },
    },
    {
        name: 'excludes rental Actors from results',
        critical: false,                     // public-only, never registered internally
        run: async (ctx) => { /* ... */ },
    },
];
```

```ts
// published behind package.json "./test-kit" export, vitest as optional peerDependency
export function registerScenarios(suiteName: string, scenarios: Scenario[], ctx: ScenarioCtx) {
    describe(suiteName, () => {
        for (const s of scenarios) {
            const runIt = ctx.criticalOnly && !s.critical ? it.skip : it;   // skip, not silent omission
            runIt(s.name, () => s.run(ctx));
        }
    });
}
```

```ts
// apify-mcp-server-internal/test/integration/tests/server-streamable.test.ts
import { registerScenarios, searchActorsScenarios } from '@apify/actors-mcp-server/test-kit';

registerScenarios('search-actors (staging)', searchActorsScenarios, {
    createClientFn: () => createDeployedClient(settings.mcpServerBaseUrl, getTestToken()),
    criticalOnly: true,   // only "lists at least one Actor" runs here
});

// internal keeps its own tests, untouched, same file or a sibling one
describe('Redis event store', () => {
    it('replays missed events after reconnect', async () => { /* ... */ });
});
```

## Known quirk — pnpm peer-dependency hoisting

Optional peerDependency alone is not enough: pnpm nests a private copy of `vitest`
inside the consumed package even at an identical version, giving two vitest module
instances in one process — `describe()` fails at runtime
(`Cannot read properties of undefined (reading 'config')`), not at install time.
Fix: internal's `pnpm-workspace.yaml` needs

```yaml
publicHoistPattern:
  - vitest
```

Verified for real in both repos: built public's `dist/test_kit`, packed it with
`pnpm pack` (real tarball, not a workspace link), installed it in internal, hit the
bug, fixed it with `publicHoistPattern`, reran — critical case passed, non-critical
showed as skipped, internal's own 132 unit tests unaffected.
