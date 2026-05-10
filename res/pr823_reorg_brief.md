# PR #823 reorg brief — split `get_actor_run_common.ts`

Handoff for a local agent picking this up.

## Context

- PR #823 (draft, in review): `feat: Modify get-actor-run - add waitSec and progress`. Closes #822 (Wave 2 of `res/call_actor_redesign_v4.md`).
- Branch: `feat/get-actor-run-wait-sec`. Local working branch: `claude/refactor-for-reusability-PC18Q`.
- Follow-up wave (no issue yet): **F = `call-actor` canonical shape**. Same canonical `RunResponse`, same status templates, same wait-with-progress logic.
- Issue #822 explicitly states: *"`src/tools/core/get_actor_run_common.ts` — shape construction shared with F."* So sharing is by design, not speculative.

## Decision

**Split `src/tools/core/get_actor_run_common.ts` into two files.** Do this inside PR #823 — it is *not* a separate refactor PR. The code is brand-new in #823; naming new code correctly the first time is part of the PR, not a follow-up.

### New file: `src/tools/core/actor_run_response.ts` (shared bucket)

Move out of `get_actor_run_common.ts`:

- **Types**: `RunResponse`, `RunDataset`, `RunKeyValueStore`, `FetchActorRunResult`
- **Constants**: `WAIT_SECS_MAX`, `WAIT_SECS_DEFAULT`, `KV_KEYS_LIMIT`, `POLL_HINT_WAIT_SECS`
- **Status templates**: `buildStatusSummaryNextStep` (exported) + private helpers `buildSucceededSummaryNextStep`, `buildTimedOutSummaryNextStep`, `summarizeKv`, `buildKvOnlyNextStep`, `pollHint`, `elapsedSecs`
- **Run-data builders**: `buildRunDataset`, `buildRunKeyValueStore`, `buildStats`, `resolveItemCountWithLagFallback`, `actorNameForActorId`
- **Utilities**: `slashToDot`, `omitNullish`, `toIsoString`, `errMessage`
- **Wait/progress**: `waitForRunWithProgress` — **must become `export`** (currently private, line 428 of pre-split file)
- **Pipeline**: `fetchActorRunData` (already exported)

### Trimmed file: `src/tools/core/get_actor_run_common.ts` (tool-specific only)

Stays put, imports from `actor_run_response.ts`:

- `getActorRunArgs` (Zod schema)
- `GET_ACTOR_RUN_DESCRIPTION`
- `getActorRunMetadata`
- `buildGetActorRunError` (wording is tool-specific)
- `buildGetActorRunSuccessResponse` (knows the ActorRun widget URI)

## Parameterize the abort hook in `waitForRunWithProgress`

Inside the wait function, the existing comment spells out the only behavioral fork between get-actor-run and call-actor:

> *"Race waitForFinish against the client's abort signal... Unlike call-actor we do not abort the underlying run — get-actor-run is read-only."*

Add an optional parameter so call-actor can plug in its abort behavior without re-implementing the loop:

```ts
onAbort?: (runId: string, client: ApifyClient) => Promise<void>;
```

Invoke it inside the `if (raced === CLIENT_ABORT)` branch before returning `{ kind: 'aborted' }`. Default = no-op → get-actor-run behavior unchanged.

## Reasons

1. **Naming is wrong once shared.** `get_actor_run_common.ts` was named for "common to get-actor-run default + widget variants." Once `call-actor` imports `waitForRunWithProgress` and `fetchActorRunData`, a file named after one tool exporting helpers to a *different* tool is a dependency red flag.
2. **Avoids a future `call_actor_common.ts` → `get_actor_run_common.ts` import**, which would be confusing in the dep graph.
3. **Shrinks the call-actor PR diff.** With the split + `onAbort`, the call-actor PR adds zero lines of wait-loop or canonical-shape code — it imports and wires.
4. **Not a CLAUDE.md scope violation.** The "refactoring is a separate PR" rule is about pre-existing code. This file is brand-new in PR #823.
5. **Reviewer signal.** Exporting `waitForRunWithProgress` from a file called `get_actor_run_common.ts` would prompt "why is this exported?" The split makes the export site obviously correct.

## Out of scope (do NOT do)

- Don't rename `buildGetActorRunSuccessResponse` / `buildGetActorRunError` — they're tool-specific by intent.
- Don't pre-create a `buildCallActorSuccessResponse` stub — that belongs in the call-actor PR.
- Don't extract types into yet another module — keep them with the shared bucket.
- Don't `git mv` — most of the file content is moving out, but the file itself stays (trimmed). Do a fresh `Write` for the new file and `Edit` the old one down.

## Concrete steps

1. `Write` `src/tools/core/actor_run_response.ts` with the shared bucket. Make `waitForRunWithProgress` exported. Add the optional `onAbort` parameter and invoke it in the abort branch.
2. `Edit` `src/tools/core/get_actor_run_common.ts` down to the tool-specific remnant. Add an `import` from `./actor_run_response.js` for whatever it still uses (`fetchActorRunData`, `RunResponse`, `WAIT_SECS_*`, `buildUsageMeta` consumers).
3. Update import paths in:
   - `src/tools/default/get_actor_run.ts`
   - `src/tools/apps/get_actor_run_widget.ts`
   - `tests/unit/tools.get_actor_run.response.test.ts`
   - `tests/unit/tools.get_actor_run.widget.response.test.ts`
4. Run `npm run type-check`, `npm run lint`, `npm run test:unit`. Zero tolerance for errors.
5. Commit on `claude/refactor-for-reusability-PC18Q` with a Conventional Commits message, e.g. `refactor: Split actor_run_response from get_actor_run_common`. (Note: this commit when merged into PR #823's branch is part of the feature, not a standalone "refactor" PR — the message describes what the diff does.)
6. Update PR #823's description with one sentence: *"Canonical-shape building blocks live in `actor_run_response.ts` for reuse by the upcoming call-actor PR (per issue #822 scope: 'shape construction shared with F')."*

## Verification

- `npm run type-check` clean.
- `npm run lint` clean.
- `npm run test:unit` clean — existing tests should pass with only import-path updates; no behavioral change.
- No mcpc or integration runs needed (pure file reorganization, no runtime change).
