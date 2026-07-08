# Refactoring sweep — July 2026

Full-codebase sweep (src, tests, tooling, configs) for defects and refactoring
opportunities. Line numbers are as of 2026-07-08 — verify before use.

Filed as issues (do not duplicate here):

- **#1064** — defects: helper-tool `inputSchema` required/default bug, `smithery.yaml`
  broken entry path, Node-floor drift, payment-client bypass, hardcoded store URL.
- **#1065** — `defineHelperTool` factory + `mockApifyClient()` + context-stub merge.
- **#1066** — quick wins: `getTaskOrThrow`, loader mode-gate dedup, `resolveWidgets`
  memoization, `catchNotFound`, search-actors strings, `injectMcpSessionId`, widget
  boolean split, dead Python tooling, vitest timeout split.
- **#658** (umbrella) — sync/task tool-call dispatch dedup; sub-issues #1061, #684,
  #1062, #1063, #974.

## Backlog — not filed, pull when there's appetite

### `types.ts` split (M)

746 lines mixing six concerns. Move types next to their owners (pattern already used by
`WidgetActor` in `actor_card.ts`, `PricingTier` in `pricing_info.ts`): telemetry types
(`ToolCallTelemetryProperties`, `CallDiagnostics`, `AjvErrorDetails`) → beside
`tool_status.ts`/`telemetry.ts`; `StructuredActorCard`/`ActorCardOptions`/
`ConsoleLinkContext` → `actor_card.ts`/`console_link.ts`; `ServerCard` →
`server_card.ts`. Keep the tool model (`ToolBase`, `ToolEntry`, `TOOL_TYPE`) + `Input` as
the lean core. Do as pure moves + re-exports first. Also: `types.ts` holds runtime values
(`TOOL_TYPE`, `SERVER_MODE`) despite the name.

### Payment seam closure (M) — sequence after #1062

`PAYMENT_REQUIRED_HEADER` + its base64→JSON decode exist twice (`payments/x402.ts` and
`utils/payment_errors.ts`); `server.ts` branches on `isX402PaymentRequiredError` directly
in both catch blocks instead of the provider owning its error path; `prepareToolCallContext`
(`payments/helpers.ts`) carries a split-me TODO and registers the x402 axios interceptor
for every client regardless of provider. Fix: unify header consts/decode in
`payments/const.ts`; add a `buildPaymentRequiredResult(error)` hook to `PaymentProvider`
so a third provider needs no `server.ts` edits. The catch blocks are exactly what #1062's
`mapToolCallError` extracts — do this as its follow-up, not in parallel.

### `RunResponse` assembly dedup (S/M)

The canonical structuredContent + `respondOk` mirror is hand-assembled in
`buildStartRunResponse`, `fetchActorRunData`, and re-implemented (~20 lines) in
`abort_actor_run.ts`. Extract `buildRunResponseContent(run, storages)` +
`respondRunResponse(...)` so abort stops drifting from get-actor-run.

### `call_actor.ts` core extraction (M)

Lines 47–543 are helpers exported mainly for `widgets/call_actor_widget.ts`
(`callActorPreExecute`, `resolveAndValidateActor`, `buildCallActorErrorResponse`,
`callOptionsSchema`); the tool entry itself is ~30 lines at the tail. Move the shared
engine to `actors/call_actor_core.ts`; the widget then depends on an explicit core module
instead of reaching into a sibling tool file.

### `actor_run_response.ts` split (M/L)

875 lines, four banner-separated jobs: field normalization + response types;
status→summary/nextStep templates (~210 lines, the most-edited part); storage
fetch/enrichment; wait/orchestration (`raceAbort`, `waitForRunWithProgress`). Mechanical
4-file split; watch storage tools importing `normalizeDatasetFields`.

### `internals.js` export narrowing (M/L, cross-repo)

`index_internals.ts` exports raw tool-catalog functions the hosted repo consumes directly
(`getDefaultTools`, `getCategoryTools`, `getActorsAsTools`, `processParamsGetTools`,
`getToolPublicFieldOnly`, …) against the stated "expose methods on `ActorsMcpServer`"
policy, plus deprecated aliases awaiting internal migration (`addActor as addTool`,
`redactSkyfirePayId` — see #604, `HelperTools`). Convert one export at a time to a server
method; needs internal-repo coordination per export.

### Server-mode lifecycle encapsulation (M)

One lifecycle ("auto → resolved on initialize, buffer tool loads until then") tracked by
five mutable fields (`serverModeOption`, `serverMode`, `serverModeResolved`,
`pendingToolsAfterModeResolved`, `clientSupportsUi`) mutated from four places; invariants
comment-enforced. Extract a `ServerModeResolver` owning option/resolved/buffer. Land the
#1066 loader-dedup first — it shrinks this.

### `pricing_info.ts` formatter consolidation (M, deliberately deprioritized)

Five pricing models × (complete|simplified) × (text|structured) run in near-parallel
function pairs; tier logic re-walked four ways. Fix: one resolved intermediate per model,
thin renderers on top. Well-tested and correctness-sensitive (see
`pricing_output_contract.md`) — risk offsets payoff; only touch with the E1–E8 oracle
green.

### Test import time (M, measure first)

`test:unit`: 7s running tests, ~30s importing modules (vitest transform+import stats).
Likely heavy barrel imports (`tools/index.js`, server construction) pulled by most of the
72 files. Measure the dep graph before changing anything; do NOT blindly flip
`isolate: false` — the suite leans on `vi.mock`.

### Smaller items

- **Evals type-check policy**: CI type-checks only `src`+`tests`; standalone eval scripts
  (`run_evaluation.ts`, `create_dataset.ts`, `eval_single.ts`) are never compiled, and
  oxlint ignores `evals/*.ts` but lints `evals/*/**.ts`. Pick one policy for the tree.
- **Log field vocabulary**: `statusCode` vs `failureHttpStatus` vs `failure_http_status`
  for the same concept; mixed `[HandlerName]` tag conventions. Standardize when it next
  bites an alert query.
- **Web mock typing**: `MOCK_ACTOR_DETAILS_RESPONSE` (`web/src/utils/mock-actor-details.ts`)
  is an untyped literal with fields absent from the `Actor` type it mocks; annotate it so
  drift becomes a type error. Longer term, generate `web/src/types.ts` from server schemas.
- **`TTLLRUCache.set()`** does a redundant get-then-remove before add; module-global cache
  singletons in `state.ts` have no reset hook (stale ~30 min across hot-reloads).
- **`structured_output_schemas.ts`**: `apifyConsoleUrl` property object hand-written 4×,
  `userTier` enum 3× — extract consts (or fold into the #1065 factory work).

## Checked and healthy — no action

- Zod+AJV double validation is consistent by design (every tool compiles the same schema).
- `legacyToolNameToNew` shim is small, documented, load-bearing.
- content/structuredContent mirroring is intentional for mixed MCP clients.
- Lint suppressions are not piling up (16 across 9 files, scattered).
- `scripts/` (check-agents-links, check_widgets, dev_standby) are solid.
- `evals/workflows` TS code is live and unit-tested (unlike the Python side — #1066).
