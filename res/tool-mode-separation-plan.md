# Tool Mode Separation Plan (Simplified)

## Executive Summary

**What**: Separate UI-mode (OpenAI) and normal-mode tool behavior into independent, self-contained modules with a shared core logic layer and a mode-aware Actor Executor pattern.

**Why**:
- `if (uiMode === 'openai')` is scattered across 8+ files with substantial behavioral differences (sync vs async execution, different schemas, different response formats, widget metadata)
- Direct actor tools (`type: 'actor'`) are completely UI-mode-unaware - they always run synchronously without widgets, even in OpenAI mode
- The tools-loader uses a fragile deep-clone hack (JSON.parse/stringify with function reattachment) to customize tool descriptions per mode
- Two tools (`search-actors-internal`, `fetch-actor-details-internal`) already use separate definitions, but three others (`call-actor`, `search-actors`, `get-actor-run`) use inline branching - inconsistent patterns

**Approach**: Keep the refactor minimal and focused. Fix only the mode-separation problems above, avoid broad folder reorgs, and preserve external API compatibility.

**Estimated effort**: 3-5 developer days

**Risk**: Medium (runtime behavior changes in OpenAI mode, but no public tool name/category changes)

---

## Scope and Constraints

### In scope

1. Introduce a mode-aware Actor Executor used by both server dispatch paths.
2. Split mode-divergent tools into separate default/openai modules:
   - `call-actor`
   - `search-actors`
   - `get-actor-run`
3. Extract only the shared core logic needed by both variants.
4. Remove the tools-loader deep-clone + runtime description-mutation hack.

### Out of scope

- Renaming tool names, tool categories, or `tools` input selectors
- Changing `actor-mcp` passthrough behavior
- Changing `add-actor` behavior
- Large file/folder reorganization not required for the above goals
- Designing for hypothetical future modes beyond `openai` vs default

### Non-negotiables

- External API remains stable (`call-actor`, `search-actors`, `fetch-actor-details`, `get-actor-run`, category names unchanged)
- Refactor should be additive and easy to review
- No speculative abstractions

---

## Current Problems (Concrete)

1. `server.ts` contains duplicated `type: 'actor'` execution logic in:
   - Main call handler
   - Task execution handler
2. Direct actor tools always run sync (`callActorGetDataset`) even in OpenAI mode.
3. Mode-specific tool behavior is implemented with inline `if (uiMode === 'openai')` in multiple tool files.
4. `tools-loader` deep-clones tool entries and mutates `call-actor` description at runtime.
5. Mode separation pattern is inconsistent:
   - Already separated: `search-actors-internal`, `fetch-actor-details-internal`
   - Still inline-branching: `call-actor`, `search-actors`, `get-actor-run`

---

## Target Architecture (Minimal)

Keep the architecture intentionally small:

1. **Shared core logic layer** for business logic only (no UI formatting decisions).
2. **Mode-specific tool modules** only for tools that actually diverge.
3. **Mode-aware Actor Executor** selected once at server construction and reused in both dispatch paths.

### Minimal module layout

```text
src/
  mcp/
    actor-executor.ts                  # interface + default/openai implementations
    server.ts                          # uses actorExecutor in both actor dispatch paths

  tools/
    core/
      actor-execution.ts               # shared actor execution helpers

    call-actor.ts                      # default behavior (existing location)
    store_collection.ts                # default behavior for search-actors
    run.ts                             # default behavior for get-actor-run

    openai/
      call-actor.ts                    # openai behavior
      search-actors.ts                 # openai behavior
      get-actor-run.ts                 # openai behavior
      index.ts                         # openai mode exports

    mode-tools.ts                      # picks mode-correct implementations
    categories.ts                      # unchanged category names, mode-aware entries
```

Notes:
- Existing files can stay as wrappers/re-exports where that reduces churn.
- Keep `openai/` as the primary separation boundary for UI-mode code.
- No mandatory move of every tool into `default/`, `openai/`, `common/`.

---

## Actor Executor Pattern

### Interface

```ts
type ActorExecutor = {
    executeActorTool(params: ActorExecutionParams): Promise<ToolResponse>;
};
```

### Default mode behavior

- Uses sync execution path (`callActorGetDataset`)
- Returns current plain response format

### OpenAI mode behavior

- Uses async start path (`actorClient.start`)
- Returns run metadata + widget `_meta` + compact text guidance

### Server wiring

- `ActorsMcpServer` creates one executor in constructor based on `uiMode`
- Both current actor dispatch locations call the same executor
- Removes duplicated actor-dispatch logic and makes direct actor tools mode-aware

---

## Tool Separation Strategy

Split only the three tools with meaningful mode divergence:

1. `call-actor`
   - default: sync-by-default behavior, full result path (stays in default module)
   - openai: forced async behavior, widget-oriented response (`tools/openai/call-actor.ts`)
2. `search-actors`
   - default: text-first card output (stays in default module)
   - openai: widget-friendly output and metadata (`tools/openai/search-actors.ts`)
3. `get-actor-run`
   - default: full run info text/structured response (stays in default module)
   - openai: compact status + widget metadata (`tools/openai/get-actor-run.ts`)

Keep separate modules self-contained:
- Each mode module owns its own description, output schema, and response formatting.
- Shared fetching/validation logic stays in `tools/core`.

---

## Loader Simplification

`loadToolsFromInput()` should:

1. Resolve mode-aware tools from `mode-tools.ts` / `categories.ts`
2. Apply selector resolution (`tools`, category names, tool names)
3. Load actor tools by name
4. Auto-inject companion tools (`get-actor-run`, `get-actor-output`) as today
5. Deduplicate by tool name

It should no longer:

- Deep-clone tool entries with JSON serialization
- Reattach function references (`ajvValidate`, `call`)
- Mutate `call-actor` description dynamically

The mode-specific descriptions come directly from mode-specific modules.

---

## Implementation Plan (Short PR chain)

### PR 1: Actor Executor + direct actor mode-awareness

**Goal**: Fix the biggest functional gap first.

Changes:
- Add `ActorExecutor` in `src/mcp/actor-executor.ts`
- Implement default/openai execution paths
- Replace both actor dispatch blocks in `src/mcp/server.ts` with executor calls

Expected result:
- Direct actor tools become mode-aware
- Dispatch duplication removed

---

### PR 2: Split the 3 mode-divergent tools

**Goal**: Remove inline mode branching from tool handlers.

Changes:
- Add `src/tools/openai/` modules for:
  - `call-actor.ts`
  - `search-actors.ts`
  - `get-actor-run.ts`
- Keep default implementations in their existing modules (or use thin wrappers if cleaner)
- Add `mode-tools.ts` for mode selection
- Update `categories.ts` to use mode-correct tool entries (same category names)

Expected result:
- Tool behavior per mode is explicit and self-contained
- Consistent pattern with already-separated internal tools

---

### PR 3: tools-loader cleanup + contract tests

**Goal**: Remove the hack and lock behavior.

Changes:
- Simplify `src/utils/tools-loader.ts` per section above
- Remove runtime description mutation path for `call-actor`
- Add mode-parameterized tests (default/openai) for:
  - tool selection/list shape
  - `call-actor` behavior difference (sync vs async)
  - `search-actors` and `get-actor-run` mode-specific outputs

Expected result:
- No deep-clone hack
- Behavior is explicit and regression-protected

---

## Current PR Stack Triage and Restack Plan

The current tool-mode branch chain is too long for efficient review and maintenance:

`#465 -> #466 -> #468 -> #469 -> #471 -> #472 -> #473 -> #474 -> #476 -> #477 -> #478 -> #479 -> #480 -> #481 -> #482`

To align with this simplified plan, keep only PRs that directly serve the required outcomes and collapse them into a shorter review chain.

### Keep vs discard

#### Keep (content to preserve)

- `#465` - plan document
- `#466` - shared core extraction (useful baseline)
- `#468` - Actor Executor pattern and server dispatch deduplication
- `#472` - split `search-actors`
- `#473` - split `get-actor-run`
- `#474` - split `call-actor`
- `#478` - tools-loader cleanup (deep-clone removal direction)
- `#481` - mode contract tests

#### Discard (close or supersede)

- `#469` - split-plan churn and non-essential changes
- `#471` - split `fetch-actor-details` (out of current scope)
- `#476` - broad move/freeze reorg (`common/openai` migration)
- `#477` - separate category abstraction phase (can be folded)
- `#479` - adapter-removal phase (not required)
- `#480` - server-instructions split (not required)
- `#482` - Skyfire freeze follow-up tied to discarded reorg

### Restacked target chain (final)

Replace the long stack with this compact chain:

1. **Docs** - plan (`#465`, updated)
2. **Core runtime** - combine core extraction + Actor Executor (`#466 + #468`)
3. **Tool split** - combine the 3 required tool splits (`#472 + #473 + #474`)
4. **Loader and tests** - combine loader cleanup + mode contracts (`#478 + #481`)

### Execution steps

1. Keep `#465` as architecture reference PR.
2. Build a new restack branch from `master` (or from merged `#465` if preferred).
3. Cherry-pick only the commits from keep PRs into the 3 implementation PRs above.
4. Validate each restacked PR with:
   - `npm run type-check`
   - `npm run lint`
   - `npm run test:unit`
5. Open the new compact PR chain and mark old long-stack PRs as superseded.
6. Close discarded PRs with a pointer to the replacement PR URL.

### Decision rules during restack

- Do not rename tool names or categories.
- Do not include broad file moves/freeze-only refactors unless they are directly required by loader cleanup.
- Keep `actor-mcp` and `add-actor` behavior unchanged.
- Prefer the smallest diff that achieves mode separation and direct-actor mode-awareness.

---

## Validation Checklist

After each implementation PR:

1. `npm run type-check`
2. `npm run lint`
3. `npm run test:unit`

Manual smoke checks:

- Default mode:
  - `call-actor` waits and returns results
  - `search-actors` returns non-widget response
  - `get-actor-run` returns full details
- OpenAI mode:
  - `call-actor` starts run async and returns widget metadata
  - direct actor tools use openai executor path
  - `search-actors` and `get-actor-run` return openai-specific response shapes

---

## Success Criteria

- [ ] Direct actor tools (`type: 'actor'`) are mode-aware via executor
- [ ] `server.ts` actor dispatch duplication removed
- [ ] `call-actor`, `search-actors`, `get-actor-run` no longer use inline `uiMode` branching
- [ ] tools-loader deep-clone hack removed
- [ ] runtime call-actor description mutation removed
- [ ] tool names and category names unchanged
- [ ] `actor-mcp` passthrough behavior unchanged
- [ ] `add-actor` behavior unchanged
- [ ] all verification commands pass (`type-check`, `lint`, `test:unit`)

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Behavior drift between default/openai variants | Medium | Keep shared logic in `tools/core`; add mode contract tests |
| Cross-repo compatibility (`apify-mcp-server-internal`) | High | Test preview package in internal repo before merge |
| Accidental public API changes | High | Keep tool names/categories/selectors unchanged; add tests |
| Scope creep into broad reorg | Medium | Keep work limited to 3 PRs and listed files only |

