# Tool response shapes & telemetry coupling

Inventory of the response patterns across all `src/tools` handlers, where they drift, and where the telemetry contract leaks into call sites. Plus six design options with a recommendation.

## 1. TL;DR

Tool handlers return MCP results in **six different shapes** with no clear taxonomy. There's no shared JSON-fence helper, so ~8 sites inline the same fence string by hand. `isError` + `toolTelemetry` are **structurally independent** but **semantically coupled**: every error site has to remember to attach the right telemetry, or it silently lands in `SOFT_FAIL + INTERNAL_ERROR` by default — a category that's almost never what the caller meant.

**Recommendation: Option F** — make a small `respond*` constructor family the only public way to build a response, un-export `buildMCPResponse`, and brand the output so an unclassified error won't compile. It delivers Option E's structural guarantee (the bad shape becomes unconstructable) as a handful of small, reversible PRs with no cross-repo coordination — because `buildMCPResponse` was never on the public `internals` surface. Option E (full discriminated-union rewrite) is reserved for when a concrete new outcome variant actually lands.

## 2. Patterns observed

| Pattern | Sites | Example call site |
| --- | --- | --- |
| **A** Happy-path raw shape: `{ content: [{type:'text', text}] }` | ~8 handlers | `get_dataset.ts:59`, `get_key_value_store.ts:48`, `dataset_collection.ts:69`, `key_value_store_collection.ts:71`, `get_key_value_store_keys.ts:65` |
| **B** Happy path + `structuredContent` | 2 handlers | `get_dataset_items.ts:135`, `get_actor_output.ts:120` |
| **C** Informational (non-error, no data), e.g. `"Dataset 'X' is empty."` | 2 sites | `get_dataset_schema.ts:78`, `buildSearchActorsEmptyResponse` |
| **D** Soft-fail user error — one wrapper (`buildActorNotFoundResponse`), rest inline the literal | 1 helper, ~6 sites | `fetch_actor_details_common.ts:142` (helper); `get_dataset.ts:49` (inline) |
| **E** Inline `buildMCPResponse({ isError: true, telemetry: {...} })` | ~12 sites | `get_dataset_schema.ts:89`, `get_actor_output.ts:85`, `call_actor_common.ts:143`, `fetch_apify_docs.ts:94` |
| **F** Inline `buildMCPResponse({ isError: true })` **without** telemetry | ~4 sites | `buildPermissionApprovalResponse` (call_actor_common.ts:124), `server.ts:1150, 1221, 1333` |

### Plus: fence-wrapper drift

There is **no shared JSON-fence helper** — every site that wants a fenced JSON block inlines the same `` ```json\n…\n``` `` string by hand. ~8 sites do this:

```ts
// abort_actor_run.ts:46
return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }] };

// get_actor_output.ts:101
let outputText = `\`\`\`json\n${JSON.stringify(cleanedItems)}\n\`\`\``;
```

Also at `get_dataset.ts:60`, `get_dataset_schema.ts:89`, `get_key_value_store.ts:49`, `dataset_collection.ts:68`, `key_value_store_collection.ts:68`, `get_key_value_store_keys.ts:50`, `get_key_value_store_record.ts:56`. The fence rule lives in eight places at once.

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

**Ten** places spell out:

```ts
telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT }
```

`get_dataset_items.ts:113`, `get_actor_output.ts:88`, `fetch_apify_docs.ts:103`, `get_dataset.ts:49`, `get_key_value_store_record.ts:53`, `get_dataset_schema.ts:64`, `get_key_value_store.ts:46`, `call_actor_common.ts:312`, `fetch_actor_details_common.ts:152`, `actor_run_response.ts:694`. `fetch_actor_details_common.ts` wraps it as `buildActorNotFoundResponse`; the rest inline it. There's no shared "this is a user error" constructor.

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

Tools needing a non-default category (e.g. `SOFT_FAIL` + `AUTH` for a 401) override explicitly. That collapses today's ten repeated literals into "say what happened, the helper picks the category."

Bonus: `classifyFailureCategory(error)` and `getToolStatusFromError(error, isAborted)` already exist in `utils/tool_status.ts`. `mcp/server.ts` uses them for uncaught exceptions, but `fetch_apify_docs.ts` and `call_actor_common.ts` also call them — and most other tools that catch internally re-classify by hand instead of reusing these.

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
- `buildActorNotFoundResponse` becomes a 1-line alias; the inline storage-tool literals collapse to `userError`.
- `okJson` becomes the single JSON-fence home — fence drift dies.

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
        return buildMCPResponse({
            texts: [`Dataset '${datasetId}' not found.`],
            isError: true,
            telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
        });
    }

    const structuredContent = { datasetId, items: v.items, ... };
    return {
        content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }],
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
        text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``,  // or the encoder fences it
        structured: { datasetId, items: v.items, ... },
    };
}
```

(`catchNotFound` here is a helper Option E would introduce, not one that exists today.)

Same line count, stricter contract. The compiler now enforces that *every* non-success branch is one of the named statuses. There's no shape where you can return `isError: true` without classifying.

#### What dies

| Killed | Why |
| --- | --- |
| `buildMCPResponse` (public) | Only the encoder builds the wire shape. |
| inline storage not-found literals (`get_dataset.ts:49`, …) | `{ status: 'userError', text }` inline. |
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
| Tool signature change | `ToolEntry.call` return type changes from `Promise<object>` to `Promise<ToolResult>`. Every `call:` definition touched — 24 files in `src/tools`. |
| Server dispatcher | `mcp/server.ts` wraps every tool invocation in `encodeToolResult(await tool.call(...))`. Removes the inline `buildMCPResponse` error paths in `server.ts` too. |
| Test migration | ~50 unit tests assert on `content` / `isError` / `toolTelemetry`. Migrate assertions to the union shape. Mechanical. |
| Internals contract | None at the import level — `buildMCPResponse`/`extractToolTelemetry`/`ToolEntry` aren't exported from `index_internals.ts`. As long as the encoder emits the same wire shape, `apify-mcp-server-internal` needs no change. The only obligation is the existing rule: flag any change to the observable `_meta` / `structuredContent` shape. |
| Atomic landing | The transitional `callAndEncode` (step 2 below) accepts either shape, so the migration is *not* a flag day — it lands tool-by-tool with the wire output held constant. (Earlier framing called this "atomic / can't ship in waves," which contradicts the transitional helper.) |

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
| Domain builders deleted | 6 builders | `buildActorNotFoundResponse`, `buildSearchActorsEmptyResponse`, `buildPermissionApprovalResponse`, `buildPermissionApprovalErrorResponse`, `buildGetActorRunError`, `buildCallActorErrorResponse` (plus inline storage not-found literals). |
| `extractToolTelemetry` | 1 | Shrinks dramatically. |
| `index_internals.ts` | 1 | `buildMCPResponse` is not exported here, so nothing changes on the public surface. (Earlier drafts overstated this as a coordinated contract change.) |

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

> **Correction (review):** an earlier draft claimed the discriminated-union encoder "is what the MCP SDK itself converges to." That is false. This codebase uses the low-level `Server`/`setRequestHandler`, and the SDK expects a handler to return a raw `CallToolResult` (`{ content, isError?, structuredContent?, _meta? }`) — exactly the shape `buildMCPResponse` already builds. The SDK has no describe-the-result union at the handler boundary. Option E's encoder is an app-level layer **on top of** the SDK, not alignment **with** it. The "costs nothing" argument stands on its own; the SDK-convergence justification does not.

### Option F — intent constructors as the only door (recommended)

Premise: get Option E's structural guarantee — "you cannot construct an unclassified error" — without E's blast radius, atomic landing, or cross-repo coordination. The trick: the bad shape can't drift if **no one can author it directly**.

`buildMCPResponse` is **not on the `internals` surface** (`src/index_internals.ts` doesn't export it; neither does `extractToolTelemetry`, `ToolEntry`, or the telemetry types). The hosted server consumes only the *stripped wire shape* (`content` / `isError` / `structuredContent` / `_meta`); `toolTelemetry` is stripped inside this package before the boundary. So *how* we build that wire shape is a private implementation detail — changing it needs **zero** coordination with `apify-mcp-server-internal` as long as the serialized output is unchanged.

That lets us do three things:

1. **Un-export `buildMCPResponse`** — it becomes private to `utils/mcp.ts`.
2. Expose a small `respond*` family as the *only* public way a handler builds a response. Each constructor bakes in correct telemetry by construction.
3. The bad shape (`isError: true` + no/garbage telemetry) becomes **unconstructable** — there's no public function that emits it. Same structural guarantee as E, via encapsulation instead of a uniform return-type change across ~50 files.

#### The constructor family

`respond*` prefix — verb-first per CONTRIBUTING naming rules, groups in autocomplete.

```ts
// utils/mcp.ts — buildMCPResponse is now private to this module

/** Success with text. */
export function respondOk(
    text: string | string[],
    opts?: { structuredContent?: unknown; meta?: Record<string, unknown> },
): ToolResponse;

/** Success carrying a JSON payload. Owns the ```json fence — the single place it lives. */
export function respondJson(
    value: unknown,
    opts?: { structuredContent?: unknown; meta?: Record<string, unknown> },
): ToolResponse;

/** Success, intentionally no data — "Dataset 'X' is empty." (P5). */
export function respondEmpty(text: string): ToolResponse;

/** User-fixable error → SOFT_FAIL. Category defaults to INVALID_INPUT. */
export function respondUserError(
    text: string | string[],
    opts?: {
        category?: Exclude<FailureCategory, 'INTERNAL_ERROR'>;  // INVALID_INPUT | AUTH | PERMISSION_APPROVAL_REQUIRED
        httpStatus?: number;
        detail?: string;
        structuredContent?: unknown;
    },
): ToolResponse;

/** Our fault → FAILED. Pass the caught error; category + httpStatus are derived. */
export function respondServerError(
    text: string | string[],
    opts?: { error?: unknown; detail?: string },
): ToolResponse;
```

Three moves do the work:

- **Status determines category (kills P3).** `respondUserError` defaults to `SOFT_FAIL + INVALID_INPUT`, `respondServerError` to `FAILED + INTERNAL_ERROR`. The ten duplicated literals collapse to `respondUserError(text)`. This is the invariant from §4, enforced in the constructor instead of repeated by hand.
- **`respondServerError` reuses the existing classifiers.** It calls `classifyFailureCategory(error)` + `getHttpStatusCode(error)` — the functions tools currently re-implement. P2 (`FAILED` with no category) disappears: the default fills it.
- **Narrowed category args.** `Exclude<…, 'INTERNAL_ERROR'>` on user errors, `error`-derived on server errors — same `Exclude`/`Extract` safety E proposed, applied to the constructor argument rather than a union variant.

#### The compile-time lock — what makes F beat A

Plain structural typing wouldn't stop a handler from hand-rolling `{ content: [...] }` and bypassing the constructors. Brand the output so it can't:

```ts
declare const wireBrand: unique symbol;
export type ToolResponse = MCPWireShape & { readonly [wireBrand]?: never };
```

Constructors return `ToolResponse`; raw object literals don't carry the brand. As the **final** migration step, narrow the handler signature (`src/types.ts:187`):

```ts
// was: call: (args: InternalToolArgs) => Promise<object>;
call: (args: InternalToolArgs) => Promise<ToolResponse>;
```

Now a handler that hand-rolls a shape, or sets `isError` by hand, **won't compile**. That is the exact "unclassified error is a compile error" guarantee E advertises — delivered by a 3-line brand + a one-line signature change. No discriminated union rippling through every file, no encoder, no transitional `callAndEncode`, and no leaky all-optional `serverError` (here the *function* requires `error` or accepts the documented default — there is no silent half-spec).

`ToolEntry.call` is `Promise<object>` today — completely untyped — so this narrowing is pure gain, not a downgrade of an existing contract.

#### What every existing builder collapses to

| Today | After |
| --- | --- |
| `buildMCPResponse({ texts:[t], isError:true, telemetry:{SOFT_FAIL, INVALID_INPUT} })` ×10 | `respondUserError(t)` |
| `buildActorNotFoundResponse` (`fetch_actor_details_common.ts:142`) | `respondUserError(t)` — delete the builder |
| `buildSearchActorsEmptyResponse` (`search_actors_common.ts:126`) | `respondOk(t, { structuredContent: { actors: [], query, count: 0 } })` |
| `buildPermissionApprovalResponse` + `buildPermissionApprovalErrorResponse` (`call_actor_common.ts`) | `respondUserError(texts, { category: 'PERMISSION_APPROVAL_REQUIRED', httpStatus, detail })` |
| `buildCallActorErrorResponse`, `buildGetActorRunError` | `respondServerError(msg, { error })` — classifier fills category/status |
| ~8 hand-rolled `` ```json `` fences | `respondJson(v)` — fence in one place |
| `get_dataset_schema.ts` `FAILED` with no category (P2) | `respondServerError(msg)` → default fills it |

#### P1 ships first, on its own

`extractToolTelemetry`'s `isError && !telemetry` default (`SOFT_FAIL + INTERNAL_ERROR`) is incoherent. Land a **1-line fix to `FAILED + INTERNAL_ERROR`** (coherent "unknown → assume our fault, keep it visible in dashboards") with a failing test first. Once constructors are the only door this branch is dead for tools, but it stays as a backstop for `server.ts` inline paths until those migrate.

#### Migration — incremental, reversible, no coordination

1. P1 1-line default fix + regression test. Ships alone.
2. Add the `respond*` family (`buildMCPResponse` still exported temporarily). Unit-test the constructors.
3. Migrate handlers tool-by-tool. **Each tool is an independent PR** — wire output is byte-identical, so `internals` and the hosted server see no change.
4. Migrate `server.ts` inline error paths.
5. Delete the six domain builders, un-export `buildMCPResponse`, shrink `extractToolTelemetry`.
6. **Last:** add the brand + narrow `call` to `Promise<ToolResponse>`. The compiler points at every remaining hand-rolled shape; fix and done.

Steps 1–4 each merge to `master` independently. Nothing is atomic, nothing coordinates with `apify-mcp-server-internal`, every step is reversible.

**Pros**
- Structural guarantee (unclassified error won't compile) — E's headline win — at ~1/25th the cost, and the guarantee holds *during* the migration because each step lands independently.
- One layer, not two: the constructors *are* the API; `buildMCPResponse` disappears from view. Kills Option A's "still two layers / discoverability depends on JSDoc" con.
- Reuses what exists (`classifyFailureCategory`, `getHttpStatusCode`, one JSON fence) instead of re-typing it.
- Honors the repo's scope rules: minimal, one-thing-per-change, reversible — no "we don't care about blast radius."
- Zero cross-repo coordination (the wire shape and `./internals` surface never change).

**Cons**
- The brand is a mild TS idiom that a reader must understand (≈3 lines + a comment).
- `respondEmpty` is a thin alias of `respondOk` until product wants a distinct `NO_DATA` telemetry signal — wiring that into Segment is a separate, optional follow-up (touches the `TOOL_STATUS` enum), so P5's analytics gap is only *half* closed now.
- Doesn't make `aborted` first-class (E does). Abort stays framework-derived in `server.ts`, which is fine — it isn't a problem any of P1–P5 raised.

## 6. Recommendation

**Go with Option F.** It closes P1–P4 and the fence drift, delivers the compile-enforced classification that was Option E's whole point, and does it as a handful of small, reversible, one-thing-per-change PRs with no cross-repo coordination — because `buildMCPResponse` was never on the public surface to begin with.

Option E remains the right move **only** if a concrete future requirement lands that needs genuinely new outcome variants with distinct wire behavior (real `elicitation-required` / `partial-data`). At that point the union solves a current problem instead of an imagined one — and, thanks to F's brand, it can be adopted incrementally rather than as an atomic flag day.

Option A is strictly dominated by F: F is A's constructors plus the encapsulation that closes the structural trap A leaves open (`isError: true` without telemetry still constructible). There's no reason to pick A over F.
