# Tool Mode Chain: Pre-Merge Corrections

Strategy:
- Squash the PR chain into a single PR (not into master)
- Apply corrections listed here before merging to master

Actionable items with exact files/symbols.

---

## Chain Covered

`#465 -> #466 -> #468 -> #469 -> #471 -> #472 -> #473 -> #474 -> #476 -> #477 -> #478 -> #479 -> #480 -> #481 -> #482`

Chain tip: `origin/feat/tool-mode-skyfire-tests` (19 commits from master)

---

## Must-Fix Items

### `ARCH-01` Unify category resolution path end-to-end
- **Problem:** `loadToolsByName()` uses deprecated static `toolCategories` — always resolves default-mode variants regardless of server's `uiMode`. This is a bug: openai-mode server loads default tool variants when adding tools by name.
- **Evidence:**
  - `src/mcp/server.ts:273-274`: `...defaultTools, ...Object.values(toolCategories).flat()`
  - `src/tools/index.ts`: `defaultTools` computed from static map; `getUnauthEnabledToolCategories()` uses `toolCategories`
  - `src/tools/categories.ts`: `CATEGORY_NAMES` derived from deprecated `toolCategories`
- **Change required:**
  - In `loadToolsByName()`, use `buildCategories(this.options.uiMode)` instead of `toolCategories`
  - Remove deprecated `toolCategories` constant entirely
  - Make `CATEGORY_NAMES` an explicit constant (not derived from deprecated map)
  - Update `getUnauthEnabledToolCategories()` to use `buildCategories()`
  - Remove `defaultTools` from `index.ts` or recompute from `buildCategories()`
- **Files:**
  - `src/mcp/server.ts`: `loadToolsByName()`
  - `src/tools/index.ts`: `defaultTools`, `getUnauthEnabledToolCategories`, exports
  - `src/tools/categories.ts`: `toolCategories`, `CATEGORY_NAMES`, `buildCategories()`
- **Acceptance criteria:**
  - no runtime import/use of deprecated `toolCategories`
  - `loadToolsByName()` respects server's `uiMode`

---

### `CONSISTENCY-01` Remove default-mode references to openai/internal helper tools
- **Problem:** default `search-actors` text references `ACTOR_GET_DETAILS_INTERNAL` which does not exist in default mode.
- **Evidence:** `src/tools/default/search-actors.ts` line ~68: `”use ${HelperTools.ACTOR_GET_DETAILS_INTERNAL}”`
- **Change required:** remove the internal tool reference from default variant response text.

---

### `CONSISTENCY-02` Fix call-actor description semantics in both variants
- **Problem:** both descriptions are wrong for their mode.
  - **Openai variant** (`src/tools/openai/call-actor.ts`): documents `async: false` and `async: true` behavior, but implementation always runs async — the `async` parameter is ignored.
  - **Default variant** (`src/tools/default/call-actor.ts`): includes “When UI mode is enabled, async is always enforced and the widget automatically tracks progress” — irrelevant for default mode.
- **Change required:**
  - Openai description: state that execution is always asynchronous; remove `async` toggle documentation
  - Default description: remove the UI mode sentence

---

## Should-Fix Items

### `ARCH-02` Remove transitional adapter lifecycle artifacts
- **Status:** mostly done — old files (`actor.ts`, `run.ts`, `store_collection.ts`, `fetch-actor-details.ts`) are deleted, `buildCategories()` wires directly to mode variants.
- **Remaining:** the deprecated `toolCategories` constant and its deprecation comments. Resolved automatically when ARCH-01 is completed.
- **Acceptance criteria:** no deprecated `toolCategories` in codebase

---

### `ARCH-03` Remove dead `openaiOnly` property
- **Status:** no tool definitions set `openaiOnly` anymore; tools-loader no longer filters on it; `buildCategories()` handles mode resolution.
- **Remaining:** the deprecated property declaration in `src/types.ts:99`.
- **Change required:** remove `openaiOnly` from `ToolBase` type and its deprecation comment.

---

### `ARCH-06` `fetch-actor-details` split — keep, document decision
- **Decision:** keep the split. The variants have genuinely different behavior:
  - Default: fetches output schema from ActorStore, returns full text response
  - OpenAI: returns simplified structured content with widget metadata
- **Change required:** state in the PR description that the split is intentional and accepted scope (not a temporary state).

---

### `CONSISTENCY-03` Centralize duplicated long instruction strings
- **Problem:** `CALL_ACTOR_DEFAULT_DESCRIPTION` and `CALL_ACTOR_OPENAI_DESCRIPTION` are ~90% identical. Same pattern in search-actors response text.
- **Change required:** extract shared description parts into `core/*-common.ts` files; keep only mode-specific deltas in variants.
- **Files:** `src/tools/default/*.ts`, `src/tools/openai/*.ts`, `src/tools/core/*-common.ts`

---

### `CONSISTENCY-04` Add debug log for cross-mode selector skipping
- **Problem:** tools-loader silently skips selectors that match tool names from another mode.
- **Evidence:** `src/utils/tools-loader.ts`, `getAllInternalToolNames()` check + silent `continue`
- **Change required:** add `log.debug` when skipping a selector due to mode mismatch to aid debugging.

---

## Nice-to-Have Items

### `NICE-01` Rename `actor-tools-factory` to domain-focused name
- **Current:** `src/tools/core/actor-tools-factory.ts`
- **Suggestion:** `actor-tools.ts` or `actor-tools-builder.ts`

### `NICE-02` Re-evaluate server-instructions split after stabilization
- **Files:** `src/utils/server-instructions/{common,default,openai,index}.ts`
- **Status:** clean and well-organized. Keep it.

### `NICE-03` Trim transitional/deprecation comments after final architecture lands
- Remove “will be removed later” comments that no longer apply.

---

## Tests to Update/Add

- Keep `tests/unit/tools.mode-contract.test.ts` — ensure assertions reflect final wiring.
- Add targeted tests for:
  - `loadToolsByName()` uses mode-resolved categories (ARCH-01)
  - default-mode `search-actors` output text excludes internal tool references (CONSISTENCY-01)
  - openai `call-actor` always runs async regardless of `async` param (CONSISTENCY-02)

---

## Pre-Merge Checklist

- [ ] `ARCH-01` unified category path — `loadToolsByName()` uses `buildCategories(uiMode)`
- [ ] `CONSISTENCY-01` default search-actors: no internal tool references
- [ ] `CONSISTENCY-02` call-actor descriptions match actual behavior
- [ ] `ARCH-02` deprecated `toolCategories` removed (follows from ARCH-01)
- [ ] `ARCH-03` `openaiOnly` removed from `ToolBase`
- [ ] `ARCH-06` fetch-actor-details split decision documented in PR
- [ ] `CONSISTENCY-03` shared description strings extracted
- [ ] `CONSISTENCY-04` debug log for cross-mode selector skip
- [ ] relevant tests added/updated
- [ ] `npm run type-check` passes
- [ ] `npm run lint` passes
- [ ] `npm run test:unit` passes
