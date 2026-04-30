# V3.1 — Final design (delta on v3)

Supersedes v3 after settling open questions. Read v3 first for the candidate analysis, real I/O baseline, and decision matrix. This file locks the contract.

## Locked decisions

| ID | Decision |
|---|---|
| **T1** | Use `storages` object (with `dataset` + `keyValueStore` substructures) whose shape **mirrors the Apify storage API verbatim** — same field names, same types as the `Dataset` and `KeyValueStore` interfaces in `apify-client`. We only omit security/auth fields and add `sampleItem`. |
| **T2** | Field naming: **`summary`** describes the past, **`next_step`** prescribes one action. No `context`, no `hint`, no `instructions`. |
| **R1** | Push notifications are **required** server work, not optional polish. `notifications/tasks/status` and `notifications/progress` must fire on actor run-status changes. |
| **R4** | Rename `call-actor` → **`run-actor`**. Backward-compatible alias retained for one minor cycle. |
| Q1 | `sampleItem` is the entire data preview — minimal, deeply truncated, one item only. |
| Q2 | `get-actor-run` mirrors `run-actor`'s terminal shape, including `storages.dataset.{fields,sampleItem}`. |
| Q3 | Promote `abort-actor-run` and `get-dataset-items` into the default toolset. |
| **TEST** | Every implementation change validated against `dist/stdio.js` via mcpc before merge — start, terminal, RUNNING-on-timeout, task-mode push notifications, cancellation, and the `call-actor` alias all probed end-to-end. |

## Final response shape (canonical, shared by `run-actor` + `get-actor-run`)

`storages.dataset` and `storages.keyValueStore` mirror the `apify-client` `Dataset` and `KeyValueStore` interfaces verbatim — same field names, same nesting. We omit security/identity/access-control fields the LLM has no use for (`userId`, `username`, `urlSigningSecretKey`, `generalAccess`, `accessedAt`, `actId`, `actRunId`, `*PublicUrl`). We add one field: `sampleItem`.

```ts
{
  runId: string,
  actorName: string,
  status: "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED-OUT",
  startedAt: string,
  finishedAt?: string,                              // when terminal
  stats?: {                                         // when terminal — actor run stats, not storage
    runTimeSecs: number,
    computeUnits: number,
    memMaxBytes: number,
  },

  storages: {
    // Subset of apify-client.Dataset, verbatim names:
    dataset: {
      id: string,                                   // always present
      name?: string,                                // when set
      title?: string,                               // when set
      createdAt?: string,                           // ISO 8601
      modifiedAt?: string,                          // ISO 8601
      itemCount?: number,                           // when terminal
      cleanItemCount?: number,                      // when terminal
      fields?: string[],                            // when terminal — Apify slash notation, e.g. ["crawl/httpStatusCode", "searchResult/title"]
      stats?: {                                     // when terminal — Apify DatasetStats verbatim
        readCount?: number,
        writeCount?: number,
        deleteCount?: number,
        storageBytes?: number,
      },
      // Our addition (not in Apify shape):
      sampleItem?: object,                          // when terminal AND itemCount > 0 — 1 item, deeply truncated, ≤ 2 KB
    },
    // Subset of apify-client.KeyValueStore, verbatim names:
    keyValueStore: {
      id: string,                                   // always present
      name?: string,
      title?: string,
      createdAt?: string,
      modifiedAt?: string,
      stats?: {                                     // Apify KeyValueStoreStats verbatim
        readCount?: number,
        writeCount?: number,
        deleteCount?: number,
        listCount?: number,
        storageBytes?: number,
      },
      // Future expansion (kept compatible with Apify shape): keys?: string[]
    },
  },

  summary: string,                                  // "SUCCEEDED in 22s. 47 items, 8 fields."
  next_step: string,                                // "Use get-dataset-items with datasetId=xyz to fetch items. Apify returns field paths in slash notation (e.g. crawl/httpStatusCode); convert to dot notation and pass flatten=crawl when querying nested fields."
}
```

**Note on `fields` slash-notation:** Apify's storage API returns field paths with `/` (e.g. `"crawl/httpStatusCode"`). `get-dataset-items` `fields` parameter expects `.` (e.g. `"crawl.httpStatusCode"`) AND requires `flatten=crawl` for any nested access. The `next_step` text must call this out explicitly so the LLM constructs the correct `get-dataset-items` call. Server does NOT translate — preserves Apify shape fidelity.

`isError`:
- `false` for any observed terminal status, including FAILED/ABORTED/TIMED-OUT — the tool succeeded in observing the run; LLM reads `status` + `summary` to react.
- Exception: under task mode, when actor terminates non-SUCCEEDED, set `isError: true` so the MCP task transitions to `failed` per spec.

## `sampleItem` truncation rule

Long strings → first ~80 chars + `[truncated, N chars]`.
Arrays → first element + `[N more]`.
Nested objects → recurse with same rule.
Hard cap: serialized `sampleItem` ≤ 2 KB.

Goal: every leaf field name visible to the LLM, no value field carries enough content to be useful as data. The LLM uses it to construct a precise `get-dataset-items` call (which fields to request, what types to expect).

## Tool surface (final)

| Tool | Status | Notes |
|---|---|---|
| `run-actor` | New name (canonical) | Takes `actor`, `input`, `waitSecs?` (0–60, default 30), `callOptions?`. `taskSupport: "optional"`. |
| `call-actor` | Deprecated alias of `run-actor` | One minor cycle; description prefixed with deprecation notice. Identical handler. |
| `get-actor-run` | Modified | Adds `waitSecs` (0–60, default 30). Returns the canonical shape above. |
| `get-dataset-items` | **Promoted to default toolset** | Already exists in storage tool group; move to defaults. |
| `abort-actor-run` | **Promoted to default toolset** | Already exists in runs tool group; move to defaults. |
| `get-actor-output` | Deprecated, retained one minor cycle | Kept as a separate deprecated tool, NOT an alias (input semantics differ — see below). Description prefixed with deprecation notice. Removal in v0.11. |

## Backward-compatibility plan for `call-actor` → `run-actor`

The codebase already has a legacy-name resolution path (`legacyToolNameToNew` in `src/tools/utils.ts`). Use it.

1. Register the tool under the canonical name `run-actor`. Implementation in `src/tools/default/run_actor.ts` (move from `call_actor.ts`).
2. Add `call-actor` as a **registered alias** in the tool list:
   - Same handler, same Zod schema.
   - Description prefixed: `"DEPRECATED: use run-actor. This name will be removed in v0.11. " + <new description>`.
   - Listed in `tools/list` so older agents discover it.
3. `legacyToolNameToNew["call-actor"] = "run-actor"` so any internal routing uses the canonical handler.
4. Telemetry: when invoked via `call-actor`, log a deprecation event so we can measure adoption before removal.
5. Remove the alias in v0.11 (one minor version after release of v3.1).

Same pattern is **not** applied as a one-shot alias to `get-actor-output`: its `fields` parameter auto-flattens dot-notation (`fields:"searchResult.title"` works), whereas `get-dataset-items` requires explicit `flatten=searchResult` first. Aliasing the name would silently change `fields` semantics. Instead:

- Keep the `get-actor-output` handler intact for one minor cycle.
- Add to its description: `"DEPRECATED: use get-dataset-items. This tool will be removed in v0.11. Note: get-dataset-items requires flatten=<parent> for dot-notation fields."`
- Telemetry: log every `get-actor-output` invocation as a deprecation event.
- Remove in v0.11.

This gives existing callers a working tool until they migrate, without silent behavior changes.

## R1 — push-notification implementation scope

Today's `ProgressTracker` (`src/utils/progress.ts`) calls `taskStore.updateTaskStatus()` on each Apify run-status poll, but no push notification is emitted. Probe confirmed zero `notifications/progress` and zero `notifications/tasks/status` during a 10 s task-mode run.

Required changes:

1. **`src/utils/progress.ts`** — `ProgressTracker.updateProgress(message)`:
   - When the request carries `_meta.progressToken`, send `notifications/progress` with `{ progressToken, progress: <derived %|null>, total: <null|known>, message }`.
   - When the request is task-augmented, also send `notifications/tasks/status` with the full Task object (after `taskStore.updateTaskStatus` returns).
   - Throttle: emit only on state change (status enum or `statusMessage` text changes). Don't fire every 5 s tick if nothing changed.

2. **Server capability declaration** unchanged — `tasks: { list, cancel, requests: { tools: { call } } }` already declared (probe confirmed).

3. **Status messages** — leverage Apify run's `statusMessage` field (already populated by Apify for many actors, e.g. `"Crawled 17/50 pages"`). Pass through verbatim, prefixed with actor name.

4. **Tests**: integration test that asserts at least one `notifications/tasks/status` arrives between `taskCreated` and `completed`.

## Promoted tools — implementation note

In `src/utils/tools_loader.ts`, the default tool set is selected from groups. Move `abort-actor-run` from the `runs` group and `get-dataset-items` from the `storage` group into whatever set is loaded for the default mode. Verify the apps mode tool set independently — it currently excludes some actor-runs tools and may need separate treatment.

## Updated mermaid — canonical fast-actor flow (Tier A)

```mermaid
sequenceDiagram
  participant LLM
  participant Server
  participant Apify
  LLM->>Server: run-actor(actor, input, waitSecs:30)
  Server->>Apify: start + waitForFinish(30s)
  Apify-->>Server: SUCCEEDED at 10s
  Server->>Apify: dataset.listItems(limit:1) + dataset.get + schema
  Server-->>LLM: status:SUCCEEDED,<br/>storages.dataset:{id,itemCount,fields,sampleItem,stats},<br/>summary:"SUCCEEDED in 10s. 1 item, 5 fields.",<br/>next_step:"Use get-dataset-items with datasetId=xyz; convert slash-paths to dot notation (e.g. crawl/httpStatusCode → crawl.httpStatusCode) and pass flatten=crawl,searchResult,metadata."
  LLM->>Server: get-dataset-items(datasetId:xyz, flatten:"crawl,searchResult,metadata", fields:"metadata.url,markdown")
  Server-->>LLM: items:[...]
```

## Tier B (task mode) with push notifications — final flow

```mermaid
sequenceDiagram
  participant LLM
  participant Client
  participant Server
  participant Apify
  LLM->>Client: run-actor(...)
  Client->>Server: tools/call + task:{ttl:600000} + _meta:{progressToken:"p1"}
  Server-->>Client: CreateTaskResult{taskId,status:working,pollInterval:5000}
  Server-)Apify: start + waitForFinish (no cap)
  Note over Server: every state change →<br/>push both notifications
  Apify--)Server: status: "Crawling page 5/20"
  Server--)Client: notifications/progress{progressToken:p1,progress:25,total:100,message:"apify/x: page 5/20"}
  Server--)Client: notifications/tasks/status{taskId,status:working,statusMessage:"apify/x: page 5/20"}
  Apify--)Server: SUCCEEDED
  Server--)Client: notifications/tasks/status{taskId,status:completed}
  Client->>Server: tasks/result
  Server-->>Client: status:SUCCEEDED, storages, summary, next_step
  Client-->>LLM: result
```

## Migration / breaking changes

| Change | Impact |
|---|---|
| `call-actor` → `run-actor` | Soft: alias preserves Tier-A behavior for one minor cycle. |
| Response shape: `datasetId` → `storages.dataset.id` | Hard. Clients that read `structuredContent.datasetId` break. |
| Response shape: `items` removed (sync mode) | Hard. Clients that read `structuredContent.items` break. They must call `get-dataset-items`. |
| `previewItems` → `storages.dataset.sampleItem` (single, truncated) | Hard. Different field, different content. |
| `instructions` → `summary` + `next_step` | Hard. Different semantics. |
| Apify shape adoption — no `schema` field, `fields` use Apify slash notation | Hard. Inferred JSON Schema is dropped from the response; agents fetch via `get-dataset-schema` if needed. |
| `async` parameter removed | Hard. Use `waitSecs: 0` instead. |
| `previewOutput` parameter removed | Hard. Replaced by `sampleItem` truncation rule (always present, always tiny). |
| `get-actor-output` deprecated, retained one cycle | Soft. Existing callers keep working until v0.11. |
| `get-dataset-items` in default toolset | Soft. New tool appears, no removals. |
| `abort-actor-run` in default toolset | Soft. New tool appears. |
| `get-actor-run`: `waitSecs` parameter, mirrored shape | Hard. Existing callers without `waitSecs` now wait up to 30 s. Widget passes `waitSecs: 0`. |

Acceptable per CLAUDE.md scope discipline: breaking changes are okay when they produce a simpler, clearer implementation.

## Internal repo impact

`apify-mcp-server-internal` does not import the changed handlers. Verify integration tests after merge. The `call-actor` alias means existing internal references continue to resolve.

## Open follow-ups (out of scope here)

- Direct actor tools (e.g. `apify--rag-web-browser`) keep the old shape for now. Convert in a follow-up PR after `run-actor` ships and stabilizes.
- `get-dataset-items` accepting `runId` as alternative to `datasetId` — convenience improvement.
- Surface `keyValueStore.output` (the conventional `OUTPUT` record) in `storages.keyValueStore` when present — useful for actors that don't write datasets.
- `taskSupport` on `get-actor-run` — deferred until task adoption is measured.

## Testing checklist

Every change validated end-to-end via `mcpc` against the local `dist/stdio.js` build before merge. CLAUDE.md mandates this; this redesign locks it in as a per-change requirement.

mcpc command sequence per change:
```bash
npm run build                    # must succeed first
mcpc connect .mcp.json:stdio @stdio  # one-time
mcpc @stdio restart                  # after each rebuild
mcpc @stdio tools-list               # confirm tool surface
mcpc @stdio tools-call run-actor actor:=apify/rag-web-browser input:='{"query":"mcp","maxResults":1}' waitSecs:=30
mcpc @stdio tools-call run-actor actor:=apify/rag-web-browser input:='{"query":"mcp","maxResults":5}' waitSecs:=5      # forces RUNNING return
mcpc @stdio tools-call get-actor-run runId:=<id> waitSecs:=30
mcpc @stdio tools-call get-dataset-items datasetId:=<id>
mcpc @stdio tools-call abort-actor-run runId:=<id>
mcpc @stdio tools-call call-actor actor:=apify/rag-web-browser input:='{"query":"x","maxResults":1}'                   # alias parity
mcpc @stdio tools-call get-actor-output datasetId:=<id>                                                                # deprecated path still works
```

Plus existing test suite:

- **Unit:** `summary` text per status; `next_step` text per status; `sampleItem` truncation rule (≤2 KB, all leaf field names visible); `legacyToolNameToNew["call-actor"]`; storages shape conforms to Apify SDK types.
- **Integration:** end-to-end `run-actor` against rag-web-browser; verify shape against the `Dataset`/`KeyValueStore` interfaces in `apify-client`; verify `call-actor` alias produces identical output; verify push notifications arrive in task mode (`scripts/probe-tasks.mjs` style).
- **Widget:** `actor-run-widget.tsx` reads `storages.dataset.id` instead of `datasetId`; `get-actor-run` polled with `waitSecs: 0`.
- **Manual:** Claude Desktop (stdio), MCPJam, ChatGPT (apps mode).
