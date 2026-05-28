# Tool response shapes & telemetry coupling

Inventory of the response patterns across all `src/tools` handlers, where they drift, and where the telemetry contract leaks into call sites. Plus five design options with a recommendation.

## 1. TL;DR

Tool handlers return MCP results in **six different shapes** with no clear taxonomy. The JSON-fence wrapper drifts (some sites use `wrapJsonText`, others inline the same string literally). `isError` + `toolTelemetry` are **structurally independent** but **semantically coupled**: every error site has to remember to attach the right telemetry, or it silently lands in `SOFT_FAIL + INTERNAL_ERROR` by default — a category that's almost never what the caller meant.

The win is small and concrete in the pragmatic version. The structural fix in Option E is bigger but eliminates an entire class of drift permanently.

## 2. Patterns observed

| Pattern | Sites | Example call site |
| --- | --- | --- |
| **A** Happy-path raw shape: `{ content: [{type:'text', text}] }` | ~8 handlers | `get_dataset.ts:59`, `get_key_value_store.ts:48`, `dataset_collection.ts:69`, `key_value_store_collection.ts:71`, `get_key_value_store_keys.ts:65` |
| **B** Happy path + `structuredContent` | 2 handlers | `get_dataset_items.ts:135`, `get_actor_output.ts:120` |
| **C** Informational (non-error, no data), e.g. `"Dataset 'X' is empty."` | 2 sites | `get_dataset_schema.ts:78`, `buildSearchActorsEmptyResponse` |
| **D** Soft-fail user error via wrapper (`buildStorageNotFound`, `buildActorNotFoundResponse`) | 2 helpers, ~6 sites | `get_dataset.ts:49`, `fetch_actor_details_common.ts:142` |
| **E** Inline `buildMCPResponse({ isError: true, telemetry: {...} })` | ~12 sites | `get_dataset_schema.ts:89`, `get_actor_output.ts:85`, `call_actor_common.ts:143`, `fetch_apify_docs.ts:94` |
| **F** Inline `buildMCPResponse({ isError: true })` **without** telemetry | ~4 sites | `buildPermissionApprovalResponse` (call_actor_common.ts:124), `server.ts:1150, 1221, 1333` |

### Plus: fence-wrapper drift

Despite `wrapJsonText()` existing in `storage_helpers.ts`, two sites **inline the same fence string literally**:

```ts
// abort_actor_run.ts:46
return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }] };

// get_actor_output.ts:99
let outputText = `\`\`\`json\n${JSON.stringify(cleanedItems)}\n\`\`\``;
```

Same drift the prior PR caught for storage tools, still present in two non-storage handlers.

## 3. Concrete problems

### P1 — Telemetry is opt-in, default is wrong

`extractToolTelemetry()` (`utils/tool_status.ts:118-126`) defaults `isError: true` *without* telemetry to:

```
toolStatus: SOFT_FAIL
callDiagnostics: { failure_category: INTERNAL_ERROR }
```

That combination is semantically odd — `SOFT_FAIL` says "user error" but `INTERNAL_ERROR` says "server's fault". A real user error should be `INVALID_INPUT`; a real server error should be `FAILED`. This default is almost never the right answer — and it's what `buildPermissionApprovalResponse` and several `server.ts` error paths fall into today.

### P2 — Schema-gen failure has no `failureCategory`

```ts
// get_dataset_schema.ts:89-93
return buildMCPResponse({
    texts: [`Failed to generate schema for dataset '${datasetId}'.`],
    isError: true,
    telemetry: { toolStatus: TOOL_STATUS.FAILED },  // ← no failureCategory
});
```

Telemetry shows up in Segment as `FAILED` with no category, while every other server-side failure carries `INTERNAL_ERROR`. Segmentation in dashboards splits this one off into a "category unknown" bucket.

### P3 — Every soft-fail site re-types the same telemetry literal

Five places spell out:

```ts
telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT }
```

Storage tools centralized it as `buildStorageNotFound`; `fetch_actor_details_common.ts:142` as `buildActorNotFoundResponse`; `fetch_apify_docs.ts` inlines it three times; `call_actor_common.ts:143` inlines it. There's no shared "this is a user error" constructor.

### P4 — `isError: true` without telemetry is structurally legal but semantically broken

`buildPermissionApprovalResponse` returns `isError: true` alone; the caller (`buildPermissionApprovalErrorResponse`) **spreads** it and bolts telemetry on top. The function is also exported from `internals.ts`.

### P5 — No "informational, non-error" status

`"Dataset 'X' is empty."` and `buildSearchActorsEmptyResponse` both return `isError: false`, no telemetry — they map to `SUCCEEDED`. Fine in aggregate, but lossy for product analytics: we can't distinguish "tool returned data" from "tool returned an empty informational message" without parsing text. An HTTP analog would be `200 OK` vs `204 No Content` — same family, different signal.

## 4. Telemetry coupling — what's actually wrong

The MCP response shape carries **two orthogonal channels** that the codebase treats as one:

**Channel 1: client-visible**
- `content[]` — text shown to the LLM
- `structuredContent` — typed payload
- `isError` — boolean visible per MCP spec
- `_meta` — namespaced metadata

**Channel 2: server-internal**
- `toolTelemetry.toolStatus` — SUCCEEDED / SOFT_FAIL / FAILED / ABORTED
- `toolTelemetry.failureCategory` — INVALID_INPUT / AUTH / INTERNAL_ERROR / PERMISSION_APPROVAL_REQUIRED
- `toolTelemetry.failureHttpStatus` / `failureDetail` / `actorId` / `ajvErrorDetails`
- Stripped before reaching the client by `extractToolTelemetry()`

They *should* map deterministically: if you say `isError: true` with no further info, the server should know whether that's a user error or a server error. Today it has to *guess*, and guesses `SOFT_FAIL + INTERNAL_ERROR`.

The right invariant: **`toolStatus` determines the default `failureCategory`**. Any tool that knows it's a server-side failure should be able to say so without typing the category every time:

```
FAILED      → INTERNAL_ERROR
SOFT_FAIL   → INVALID_INPUT
ABORTED     → (no category)
SUCCEEDED   → (no category)
```

Tools needing a non-default category (e.g. `SOFT_FAIL` + `AUTH` for a 401) override explicitly. That collapses today's 5+ repeated literals into "say what happened, the helper picks the category."

Bonus: `classifyFailureCategory(error)` and `getToolStatusFromError(error, isAborted)` already exist in `utils/tool_status.ts` — they're **only** used by `mcp/server.ts` for uncaught exceptions. Tools that catch internally re-classify by hand instead of reusing these.

## 5. Design options

### Option A — Domain result constructors over `buildMCPResponse`

Keep `buildMCPResponse` as the low-level shape. Add a small set of intent-named wrappers that bake in telemetry defaults.

```ts
// utils/mcp.ts
export function ok(text: string | string[], opts?: { structuredContent?, _meta? }) { ... }
export function okJson(value: unknown, opts?: { structuredContent?, _meta? }) { ... }
export function empty(text: string)                       { ... }  // SUCCEEDED + no structuredContent
export function userError(text: string, opts?: {
    failureCategory?: FailureCategory,                   // defaults to INVALID_INPUT
    failureHttpStatus?, failureDetail?, structuredContent?,
}) { ... }
export function serverError(text: string, opts?: {
    error?: unknown,                                     // auto-derives failureCategory + httpStatus
    failureCategory?, structuredContent?,
}) { ... }
```

**Pros**
- Single migration target: every `buildMCPResponse({...})` call site collapses to one of five names.
- Telemetry becomes a property of *intent*, not boilerplate.
- Killing the default-`INTERNAL_ERROR` trap (P1) costs one line in `extractToolTelemetry`.
- Compatible with `buildStorageNotFound`, `buildActorNotFoundResponse` — they become 1-line aliases.
- `okJson` absorbs `wrapJsonText` at the boundary — fence drift dies.

**Cons**
- Still two layers of helper. Discoverability depends on naming and JSDoc.
- Doesn't fix the "`isError: true` + no telemetry is legal" structural problem — only the call-site ergonomics.

### Option B — Result-type discriminated union

Tools return a typed sum, a central encoder maps to MCP shape.

```ts
type ToolResult =
    | { status: 'ok',          text: string, structured?: unknown, meta?: ... }
    | { status: 'empty',       text: string }
    | { status: 'userError',   text: string, category?: ..., httpStatus?: number, ... }
    | { status: 'serverError', text: string, error?: unknown, ... }
    | { status: 'aborted' };

// Tool body
return { status: 'userError', text: `Dataset '${id}' not found.` };

// Server boundary
function encode(r: ToolResult): MCPResponse { ... }
```

**Pros**
- Eliminates the structural "`isError` + telemetry independent" problem entirely.
- Exhaustive switch at the encoder — adding a new status forces every dashboard update.
- Tests can assert on `status` directly, no `isError` / `telemetry` tuple matching.

**Cons**
- Touches the return type of every tool — high blast radius, 30+ files.
- The `internals.ts` contract changes — coordinates with `apify-mcp-server-internal`.
- Bigger change than the call-site ergonomics warrant on its own.

### Option C — HTTP-status analog

Tool returns `{ status: 200 | 204 | 400 | 404 | 500, body, telemetry? }`. Middleware maps status → `isError` + telemetry.

**Pros**
- Familiar mental model.
- Numeric status as source of truth; `isError` derived.

**Cons**
- HTTP semantics don't quite fit — we only have ~4 distinct outcomes, not 60.
- Mapping 404 → `SOFT_FAIL + INVALID_INPUT` is identical to having a named `userError` helper.
- Forces tool authors to remember status codes instead of intents.

### Option D — Drop `buildMCPResponse` entirely

Tools return literal shapes; a separate decorator/util attaches telemetry where needed.

**Pros**
- One fewer abstraction layer.

**Cons**
- Moves the boilerplate *back* into every call site.
- Telemetry attachment becomes ad hoc again — exactly what the helper exists to prevent.
- Reverses the direction of every recent storage-tools cleanup.

### Option E — Go all the way

Premise: we don't care about refactor size or blast radius. We want the contract to be **structurally** right, not just ergonomically nicer. So we replace the response contract, we don't patch it.

A tool handler returns a discriminated union describing *what happened*. A single boundary function (the **encoder**) converts that union to the MCP wire shape and attaches telemetry. `buildMCPResponse`, every domain error builder, and the post-hoc `toolTelemetry`-strip dance all stop existing. `isError` becomes derived, not stored. A tool that fails without classifying the failure becomes a **compile error**, not a silent `SOFT_FAIL + INTERNAL_ERROR`.

#### The type

```ts
// src/tools/result.ts (new)

export type ToolResult =
    | ToolOk          // success with data
    | ToolEmpty       // success, intentionally no data (informational)
    | ToolUserError   // user fixable: 4xx-class
    | ToolServerError // our fault: 5xx-class / unexpected
    | ToolAborted;    // client cancelled

export type ToolOk = {
    status: 'ok';
    text: string | string[];                       // shown to LLM
    structured?: unknown;                          // structuredContent
    meta?: Record<string, unknown>;                // _meta (namespaced)
};

export type ToolEmpty = {
    status: 'empty';
    text: string;                                  // "Dataset 'X' is empty."
};

export type ToolUserError = {
    status: 'userError';
    text: string;
    category?: Exclude<FailureCategory, 'INTERNAL_ERROR'>;  // default INVALID_INPUT
    httpStatus?: number;
    detail?: string;
    structured?: unknown;
};

export type ToolServerError = {
    status: 'serverError';
    text: string;
    error?: unknown;                               // optional: encoder derives category/status
    category?: Extract<FailureCategory, 'INTERNAL_ERROR'>;
    httpStatus?: number;
    detail?: string;
};

export type ToolAborted = {
    status: 'aborted';
    text?: string;
};
```

#### The encoder — the only place that knows MCP wire shape

```ts
export function encodeToolResult(r: ToolResult): MCPWireResponse {
    const textArr = (t: string | string[]) =>
        (Array.isArray(t) ? t : [t]).map((s) => ({ type: 'text' as const, text: s }));

    switch (r.status) {
        case 'ok':
            return {
                content: textArr(r.text),
                ...(r.structured !== undefined && { structuredContent: r.structured }),
                ...(r.meta && { _meta: r.meta }),
            };

        case 'empty':
            return { content: textArr(r.text) };

        case 'userError':
            return {
                content: textArr(r.text),
                isError: true,
                toolTelemetry: {
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: r.category ?? FAILURE_CATEGORY.INVALID_INPUT,
                    ...(r.httpStatus !== undefined && { failureHttpStatus: r.httpStatus }),
                    ...(r.detail && { failureDetail: r.detail }),
                },
                ...(r.structured !== undefined && { structuredContent: r.structured }),
            };

        case 'serverError': {
            const fromErr = r.error !== undefined
                ? { category: classifyFailureCategory(r.error), httpStatus: getHttpStatusCode(r.error) }
                : {};
            return {
                content: textArr(r.text),
                isError: true,
                toolTelemetry: {
                    toolStatus: TOOL_STATUS.FAILED,
                    failureCategory: r.category ?? fromErr.category ?? FAILURE_CATEGORY.INTERNAL_ERROR,
                    ...(((r.httpStatus ?? fromErr.httpStatus) !== undefined) && {
                        failureHttpStatus: r.httpStatus ?? fromErr.httpStatus,
                    }),
                    ...(r.detail && { failureDetail: r.detail }),
                },
            };
        }

        case 'aborted':
            return {
                content: r.text ? textArr(r.text) : [],
                toolTelemetry: { toolStatus: TOOL_STATUS.ABORTED },
            };
    }
}
```

#### Tool handler — before vs after

**Before (today)**

```ts
call: async (toolArgs) => {
    const datasetId = normalizeStorageId(parsed.datasetId);
    const v = await client.dataset(datasetId).listItems({...})
        .catch((err) => {
            if (getHttpStatusCode(err) === 404) return null;
            throw err;
        });

    if (!v) {
        return buildStorageNotFound(`Dataset '${datasetId}' not found.`);
    }

    const structuredContent = { datasetId, items: v.items, ... };
    return {
        content: [{ type: 'text', text: wrapJsonText(v) }],
        structuredContent,
    };
}
```

**After (Option E)**

```ts
call: async (toolArgs): Promise<ToolResult> => {
    const datasetId = normalizeStorageId(parsed.datasetId);
    const v = await catchNotFound(client.dataset(datasetId).listItems({...}));

    if (!v) {
        return { status: 'userError', text: `Dataset '${datasetId}' not found.` };
    }

    return {
        status: 'ok',
        text: wrapJsonText(v),
        structured: { datasetId, items: v.items, ... },
    };
}
```

Same line count, stricter contract. The compiler now enforces that *every* non-success branch is one of the named statuses. There's no shape where you can return `isError: true` without classifying.

#### What dies

| Killed | Why |
| --- | --- |
| `buildMCPResponse` (public) | Only the encoder builds the wire shape. |
| `buildStorageNotFound` | `{ status: 'userError', text }` inline. |
| `buildActorNotFoundResponse` | Same. |
| `buildSearchActorsEmptyResponse` | `{ status: 'ok', text, structured: { actors:[], ... } }` inline. |
| `buildPermissionApprovalResponse` | `{ status: 'userError', text, category: 'PERMISSION_APPROVAL_REQUIRED', detail, httpStatus }`. |
| `buildGetActorRunError`, `buildCallActorErrorResponse` | `{ status: 'serverError' \| 'userError', text, error: caughtErr }` — encoder classifies. |
| `extractToolTelemetry` (most of it) | Tools never *set* telemetry. The encoder does. The strip step is gone. |
| Hand-rolled fences in `abort_actor_run.ts`, `get_actor_output.ts` | Encoder owns JSON serialization; fence rule lives in one place. |
| The "`isError: true` + no telemetry → `SOFT_FAIL + INTERNAL_ERROR`" default trap | Structurally impossible — that shape can't be constructed. |

#### What we get

- **Compile-enforced classification.** A new failure mode means a new union variant + encoder branch. TypeScript flags every consumer.
- **One place for telemetry shaping.** The `failureCategory` ↔ `failure_category` rename, the actor-id passthrough, the http-status capture — all live in the encoder.
- **Cleaner tests.** `expect(result.status).toBe('userError')` instead of a (`isError`, `toolTelemetry.toolStatus`, `toolTelemetry.failureCategory`) tuple match.
- **`isError` stops being authored.** Eliminates the silent bug where a happy path accidentally sets it.
- **Aborted is first-class.** Today it's framework-derived; the union makes it explicit.
- **Drift dies at the source.** No `buildMCPResponse` means no inline fences, no inline `{content: [{type:'text', text:...}]}`, no inline telemetry literals.

#### What it costs

| Cost | Detail |
| --- | --- |
| Tool signature change | `ToolEntry.call` return type changes from MCP shape to `Promise<ToolResult>`. Every `call:` definition touched — ~25 files in `src/tools`. |
| Server dispatcher | `mcp/server.ts` wraps every tool invocation in `encodeToolResult(await tool.call(...))`. Removes the inline `buildMCPResponse` error paths in `server.ts` too. |
| Test migration | ~50 unit tests assert on `content` / `isError` / `toolTelemetry`. Migrate assertions to the union shape. Mechanical. |
| Internals contract | `internals.ts` exports change. Encoder lives on the public side; `apify-mcp-server-internal` still receives MCP-shaped responses. Coordinate. |
| Atomic landing | The union change can't ship in waves — the tool signature is uniform. Either every tool returns `ToolResult` or none does. |

#### Migration order (atomic, but staged within the PR)

1. Land the types + encoder + encoder unit tests. Parallel to the existing world.
2. Add a transitional `callAndEncode` helper in the dispatcher that accepts either shape during the migration.
3. Migrate every tool in `src/tools/common` (15 files, mostly mechanical).
4. Migrate `src/tools/core` (`call_actor_common`, `get_actor_run_common`, `fetch_actor_details_common`, `search_actors_common`, `actor_run_response`).
5. Migrate `src/tools/apps` (widget variants).
6. Migrate inline `buildMCPResponse` calls in `src/mcp/server.ts`.
7. Tighten the dispatcher — remove the transitional helper, narrow `ToolEntry.call` return type to `Promise<ToolResult>`. Compiler-driven sweep.
8. Delete `buildMCPResponse`, all domain builders, the bulk of `extractToolTelemetry`. Coordinate with `apify-mcp-server-internal`.
9. Audit tests; migrate assertions to the union shape.

#### Estimated scope

| Surface | Files | Notes |
| --- | --- | --- |
| New: types + encoder | 2 | `src/tools/result.ts`, `tests/unit/tools.result.test.ts` |
| Tool handlers | ~25 | Storage (7), core (5), apps (3), other common (~10). Mostly 1-3 line edits per file. |
| Server dispatcher | 1 | `src/mcp/server.ts` — wrap dispatch + remove inline error builders. |
| Tests | ~25 unit + integration | Migrate assertions. Mechanical. |
| Domain builders deleted | 6+ files lose builders | `buildStorageNotFound`, `buildActorNotFoundResponse`, `buildSearchActorsEmptyResponse`, `buildPermissionApprovalResponse`, `buildGetActorRunError`, `buildCallActorErrorResponse`. |
| `extractToolTelemetry` | 1 | Shrinks dramatically. |
| `internals.ts` | 1 | Re-export `encodeToolResult` and `ToolResult`. Drop `buildMCPResponse` from public surface. |

Rough order-of-magnitude: ~50 files touched, net code reduction (probably 200–400 lines once builders are deleted). One sustained branch, one coordinated merge with internal.

#### Risks

- `structuredContent` shape divergence per status — audit needed (today `buildPermissionApprovalResponse` uses `structuredContent` on a soft-fail).
- Widget tools emit `_meta` with `openai/outputTemplate` for ChatGPT rendering — `meta?` must be plumbed on `ToolOk`.
- The `aborted` path — keep framework ownership rather than handler-emitted.
- Long-lived branch with internal repo — land internal's adapter PR first or in lockstep.
- Segment-side audit before/after — the SOFT_FAIL + INTERNAL_ERROR combo we're eliminating today shows up in dashboards.

#### Why this is "right" rather than just "different"

- The two channels (client-visible / server-internal) become one channel at the source. The split happens at the boundary, not at the call site.
- The type system gains the ability to talk about tool outcomes. Everything in this analysis (P1–P5) becomes a type-checker concern, not a code-review concern.
- Future additions — `elicitation-required`, `partial-data`, `retry-after` — slot into the union without a new builder or new telemetry literal.
- The "describe the result, the framework handles the protocol" pattern is what the MCP SDK itself converges to. Aligning with it costs nothing once we've paid the migration.

## 6. Recommendation

**Go with Option E.** A ~50-file PR that nets a smaller codebase, a compile-checked contract, and the disappearance of every drift class P1–P5 simultaneously. The migration is mechanical, the wins are structural, and the only real friction is one-PR coordination with `apify-mcp-server-internal`.

Option A is the consolation prize if E is blocked for scheduling reasons — it solves the ergonomics but leaves the structural trap (`isError: true` without telemetry is still constructible) in place.
