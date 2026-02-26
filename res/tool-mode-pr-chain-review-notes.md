# Tool Mode Chain: Pre-Merge Corrections

Strategy:
- Squash the PR chain into a single branch (reuse PR #465 targeting `master`)
- Apply corrections listed here before merging to master
- Close all other PRs in the chain after squash-merge

Actionable items with exact files/symbols.

---

## Chain Covered

`#465 -> #466 -> #468 -> #469 -> #471 -> #472 -> #473 -> #474 -> #476 -> #477 -> #478 -> #479 -> #480 -> #481 -> #482 -> #489 -> #491 -> #494`

| # | PR | Branch | Summary |
|---|---|---|---|
| 1 | #465 | `feat/tool-mode-separation-plan` | Plan document |
| 2 | #466 | `feat/tool-mode-core-extraction` | Extract shared core logic into `src/tools/core/` |
| 3 | #468 | `feat/tool-mode-executor` | ActorExecutor pattern for mode-aware direct actor tools |
| 4 | #469 | `feat/tool-mode-tool-split` | Extract fetch-actor-details core module |
| 5 | #471 | `feat/split-fetch-actor-details` | Split fetch-actor-details into default/openai |
| 6 | #472 | `feat/split-search-actors` | Split search-actors into default/openai |
| 7 | #473 | `feat/split-get-actor-run` | Split get-actor-run into default/openai |
| 8 | #474 | `feat/split-call-actor` | Split call-actor into default/openai |
| 9 | #476 | `feat/tool-mode-move-freeze` | Move tools to common/openai dirs, freeze definitions |
| 10 | #477 | `feat/tool-mode-build-categories` | Add `buildCategories(uiMode)` and `CATEGORY_NAMES` |
| 11 | #478 | `feat/tool-mode-loader-refactor` | Switch tools-loader to buildCategories, remove deep-clone hack |
| 12 | #479 | `feat/tool-mode-remove-adapters` | Remove adapter files, wire direct tool variants |
| 13 | #480 | `feat/tool-mode-split-instructions` | Split server-instructions into common/default/openai |
| 14 | #481 | `feat/tool-mode-contract-tests` | Add mode-contract tests |
| 15 | #482 | `feat/tool-mode-skyfire-tests` | Extract Skyfire augmentation, add unit tests |
| 16 | #489 | `refactor/kebab-to-snake-case` | Rename all files from kebab-case to snake_case (105 files) |
| 17 | #491 | `refactor/one-file-per-tool` | Split multi-tool files in common/ into one-file-per-tool |
| 18 | #494 | `refactor/remove-tool-categories` | Introduce `ServerMode`, declarative `getCategoryTools(mode)` |

Chain tip: `origin/refactor/remove-tool-categories`

---

## Must-Fix Items

### ~~`ARCH-01` Unify category resolution path end-to-end~~ — FIXED by #494
- `loadToolsByName()` now uses `getCategoryTools(this.serverMode)`
- Deprecated `toolCategories` constant replaced with unified mode-aware resolver
- `CATEGORY_NAMES` is an explicit constant

---

### ~~`CONSISTENCY-01` Remove default-mode references to openai/internal helper tools~~ — FIXED
- Default `search-actors` no longer references `ACTOR_GET_DETAILS_INTERNAL`.
- OpenAI `search-actors` now includes disambiguation guidance with examples for when to use `ACTOR_GET_DETAILS` (browse/explore) vs `ACTOR_GET_DETAILS_INTERNAL` (execute a task).

---

### ~~`CONSISTENCY-02` Fix call-actor description semantics in both variants~~ — FIXED
- OpenAI variant: removed `async` toggle documentation; states execution is always async with widget tracking; instructs agent to wait for user input after calling.
- Default variant: removed "When UI mode is enabled" sentence.

---

### `NEW-01` Verify cross-repo compatibility with `ServerMode` signatures
- **Problem:** PR #494 changed all public functions from optional `uiMode?: UiMode` to required `mode: ServerMode`. This is a breaking change for `apify-mcp-server-internal`.
- **Affected functions:** `loadToolsFromInput()`, `getServerInstructions()`, `getDefaultTools()`, `getCategoryTools()`, `createResourceService()`, `processParamsGetTools()`
- **Action:** publish preview package via `pkg.pr.new`, install in internal repo, run `npm run type-check && npm run lint`.

---

## Should-Fix Items

### ~~`ARCH-02` Remove transitional adapter lifecycle artifacts~~ — FIXED by #494
- Old adapter files deleted, deprecated `toolCategories` constant replaced with declarative mode maps.

---

### ~~`ARCH-03` Remove dead `openaiOnly` property~~ — FIXED
- `openaiOnly` field deleted from `ToolBase` type in `src/types.ts`.
- Integration test comment updated to remove `openaiOnly` reference.

---

### `ARCH-06` `fetch-actor-details` split — keep, document decision
- **Decision:** keep the split. The variants have genuinely different behavior:
  - Default: fetches output schema from ActorStore, returns full text response
  - OpenAI: returns simplified structured content with widget metadata
- **Change required:** state in the PR description that the split is intentional and accepted scope.

---

### `CONSISTENCY-03` Centralize duplicated long instruction strings
- **Problem:** `CALL_ACTOR_DEFAULT_DESCRIPTION` and `CALL_ACTOR_OPENAI_DESCRIPTION` are ~95% identical. Same pattern in search-actors response text.
- **Change required:** extract shared description parts into `core/` constants; keep only mode-specific deltas in variants.
- **Files:** `src/tools/default/call_actor.ts`, `src/tools/openai/call_actor.ts`, `src/tools/core/`

---

### `CONSISTENCY-04` Add debug log for cross-mode selector skipping
- **Problem:** tools-loader silently skips selectors that match tool names from another mode.
- **Evidence:** `src/utils/tools_loader.ts`, `getAllInternalToolNames()` check + silent `continue`
- **Change required:** add `log.debug` when skipping a selector due to mode mismatch to aid debugging.

---

### `NEW-02` Document `ServerMode` vs `UiMode` distinction
- **Problem:** PR #494 introduced `ServerMode = 'default' | 'openai'` (internal) and redefined `UiMode = Exclude<ServerMode, 'default'>` (external API surface). The conversion happens in `ActorsMcpServer` constructor (`options.uiMode ?? 'default'`), but this is undocumented.
- **Change required:** add JSDoc on `ServerMode` and `UiMode` types in `src/types.ts` explaining the relationship and where conversion happens.

---

## Nice-to-Have Items

### ~~`NICE-01` Rename `actor-tools-factory` to domain-focused name~~ — RESOLVED by #489
- All files renamed to snake_case; check if current name is acceptable.

### `NICE-02` Re-evaluate server-instructions split after stabilization
- **Files:** `src/utils/server-instructions/{common,default,openai,index}.ts`
- **Status:** clean and well-organized. Keep it.

### ~~`NICE-03` Trim transitional/deprecation comments after final architecture lands~~ — Subsumed by ARCH-03
- The main remaining deprecation comment is `openaiOnly` — removing it (ARCH-03) resolves this.

---

## Tests to Update/Add

- Keep `tests/unit/tools.mode_contract.test.ts` — ensure assertions reflect final wiring.
- Add targeted tests for:
  - default-mode `search-actors` output text excludes internal tool references (CONSISTENCY-01)
  - openai `call-actor` always runs async regardless of `async` param (CONSISTENCY-02)

---

## Pre-Merge Checklist

- [x] `ARCH-01` unified category path — fixed by #494
- [x] `CONSISTENCY-01` default search-actors: no internal tool references
- [x] `CONSISTENCY-02` call-actor descriptions match actual behavior
- [x] `ARCH-02` deprecated `toolCategories` removed — fixed by #494
- [x] `ARCH-03` `openaiOnly` deleted from `ToolBase` (not just deprecated)
- [x] `ARCH-06` fetch-actor-details split decision documented
- [ ] `CONSISTENCY-03` shared description strings extracted
- [ ] `CONSISTENCY-04` debug log for cross-mode selector skip
- [ ] `NEW-01` cross-repo compatibility verified via `pkg.pr.new`
- [ ] `NEW-02` `ServerMode` vs `UiMode` distinction documented
- [ ] relevant tests added/updated
- [ ] `npm run type-check` passes
- [ ] `npm run lint` passes
- [ ] `npm run test:unit` passes
