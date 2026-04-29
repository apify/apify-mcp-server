# Redesign: `call-actor`, `get-actor-run`, `get-dataset-items`

Supersedes the design in #582 after re-evaluation against the duration distribution and tool-call-count criterion.

## Problem

Today's `call-actor` (default mode) blocks until the actor terminates by calling `apifyClient.actor(id).call(...)` under the hood. For long actors this hangs indefinitely, exceeds HTTP transport timeouts (~30–60s), and creates brittle agent loops. Sync vs async response shapes diverge. `get-actor-output` is a thin wrapper around `get-dataset-items` and adds no real value.

## Goals

1. Long actors must not block indefinitely.
2. Response shape consistent across terminal / still-running / failure.
3. Optimal agent UX across the realistic mix of clients (Tier A: no MCP-task support, majority; Tier B: native task support, growing minority).
4. Widget/apps mode must work — widget polls client-side and needs the runId fast.
5. Consume the MCP 2025-11-25 task spec where it pays off (cancellation, true non-blocking).

## Duration distribution (assumed)

- 70% terminal in <30s
- 20% in 30s–5min
- 10% 5min+

This shape — heavy left tail — is the single most important fact for the design. It tells us the common case is short, and a design that pays a tool call to handle the long tail at the expense of the common case is the wrong trade.

## Tool surface — final

Three tools (down from four). Drop `get-actor-output`.

| Tool | Role |
|------|------|
| `call-actor` | Start an actor; wait up to `waitSecs` for terminal; return current state. |
| `get-actor-run` | Resume waiting on a runId; wait up to `waitSecs` for terminal; return current state. |
| `get-dataset-items` | Fetch dataset rows. The single canonical full-data fetcher. |

`call-actor` and `get-actor-run` share an identical structuredContent shape. The agent learns one shape, not two.

## Shared response shape

```ts
structuredContent: {
    runId: string;
    actorName: string;
    status: "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED-OUT";
    startedAt: string;       // ISO 8601
    finishedAt?: string;     // present when terminal
    stats?: {                // present when terminal; widget reads these
        computeUnits?: number;
        memoryAvgBytes?: number;
        memoryMaxBytes?: number;
        runtimeSecs?: number;
    };
    storages: {
        defaultDatasetId: string;
        defaultKeyValueStoreId: string;
    };
    hint: string;            // next step the agent should take, or "" if none
}
```

`isError`:
- `false` when the tool itself succeeded — even if the actor terminated as FAILED/ABORTED/TIMED-OUT. The agent reads `status` and `hint` to react.
- `true` only for tool-level errors (auth, network, invalid actor id, validation).

Rationale: the tool successfully observed the run; it's the run that failed. Mixing the two confuses tool-level error handling. (We revisit this for task mode below.)

`hint` values, by status:
- `RUNNING` / `READY` → `"Call get-actor-run with runId to wait for the run to finish."`
- `SUCCEEDED` → `"Call get-dataset-items with datasetId from storages to retrieve results."`
- `FAILED` / `ABORTED` / `TIMED-OUT` → `"Run did not complete. Call get-actor-run-log with runId to see what went wrong."` (assuming `ACTOR_RUNS_LOG` exists — it does, see HelperTools.)

## Tool I/O specifications

### `call-actor`

```ts
input: {
    actor: string;                 // "username/name" or "username/name:toolName" for MCP servers
    input: object;                 // actor input (passthrough)
    waitSecs?: number;             // 0–60, default 30
    callOptions?: {
        memory?: number;           // 128–32768, power of 2
        timeout?: number;          // actor-side run timeout, 0 = unlimited
    };
}
output: <shared shape above>
```

Behavior:
1. Resolve actor, validate input via the actor's input schema (Ajv).
2. `apifyClient.actor(id).start(input, callOptions)` → returns `runId` immediately.
3. If `waitSecs > 0`: `apifyClient.run(runId).waitForFinish({ waitSecs })`. The Apify SDK polls and returns early on terminal — `waitSecs` is a ceiling.
4. Build response from current run state. Status will be terminal if it finished within `waitSecs`, else `RUNNING`.

Defaults:
- Default mode: `waitSecs = 30`. Captures ~70% of runs in a single tool call.
- Apps mode: `waitSecs = 0`. Widget renders immediately and polls itself.

Removed parameters vs today: `async`, `previewOutput`. The `waitSecs` parameter subsumes both — `waitSecs: 0` is the old `async: true`; preview items move out (the dataset is fetched separately via `get-dataset-items`, which is what callers actually want when they need data).

### `get-actor-run`

```ts
input: {
    runId: string;
    waitSecs?: number;             // 0–60, default 30
}
output: <shared shape above>
```

Behavior: identical to `call-actor` step 3–4, but on an existing runId. `waitSecs: 0` returns the current state synchronously without waiting.

### `get-dataset-items`

Unchanged. Existing input/output retained. This is now the only tool for fetching rows.

### `get-actor-output` — removed

Replaced 1:1 by `get-dataset-items`. The "cleaning" behavior in `get-actor-output` (strip empty fields) is not worth a separate tool. If desired, add a `clean: true` flag to `get-dataset-items` (it already exists).

## Task mode (Tier B clients)

`call-actor` declares `execution.taskSupport: "optional"`. Server declares `tasks.requests.tools.call` capability.

When the client sends `tools/call` with `params.task`:

1. Server returns `CreateTaskResult` immediately with `taskId`, `status: "working"`, `pollInterval: 5000`.
2. Server sets `_meta["io.modelcontextprotocol/model-immediate-response"]` to `"Started actor X (Run ID: Y). The result will arrive automatically."` so the host can return control to the model right away.
3. In the background, server runs the full `call-actor` body with `waitSecs = ttl/1000` (clamped to actor timeout). No 30s ceiling — the task IS the long wait.
4. `ProgressTracker` sends `notifications/progress` and `notifications/tasks/status` with messages like `"Actor running (45s)..."`.
5. On terminal: server stores the result. Status transitions to `completed` if SUCCEEDED, `failed` otherwise (per spec: tool result with `isError: true` ⇒ task `failed`). For a FAILED actor run under task mode, we DO set `isError: true` so the task transitions correctly. (This is the one place where the run-status / tool-error distinction is bridged — required by spec.)
6. `tasks/cancel` → `abortController.abort()` → `apifyClient.run(runId).abort()` → task `cancelled`.

Tier B agents make exactly **1 logical tool call** for any duration. The MCP task layer does the polling on the agent's behalf.

`get-actor-run` does NOT declare task support — it's already cheap.

## Widget / apps mode

`call-actor` (apps variant) defaults `waitSecs: 0`. Returns runId + storages + widget `_meta`. Widget polls `get-actor-run` with `waitSecs: 0` from the iframe. No change to the widget polling architecture; it already drives its own refresh cycle from React state.

The shared response shape means the widget reads `structuredContent.status` once, regardless of whether the value came from `call-actor` or `get-actor-run`.

## Candidate designs considered

### Design A — chosen — bounded-wait `call-actor` + `waitSecs` on `get-actor-run`

Spec'd above. Common case: 1 tool call. Long case: 1 + N polls. Failure visible in 1 call when ≤30s, in 1 + 1 when longer.

### Design B — issue #582's plan — always-start `call-actor` + `waitSecs` on `get-actor-run`

`call-actor` always returns `RUNNING` with runId. Agent always then calls `get-actor-run` with `waitSecs` to wait.

- **Pro:** `call-actor` has one job (start), one shape, one branch.
- **Pro:** Strict separation of "trigger" from "observe" maps cleanly onto MCP tasks.
- **Con (decisive):** Common case (70% of runs) costs 2 tool calls instead of 1. The agent pays a round-trip + a tool-call slot + tokens for the runId-only response, every time, even for a 3-second search.
- **Con:** Failure visibility is also 2 calls minimum, even for runs that fail in the first second.
- **Con:** The "uniform shape" argument is illusory — Design A's shape is also uniform; only the populated optional fields differ by status, exactly as in B.

The duration distribution makes this the wrong trade.

### Design C — bounded-wait `call-actor` only (no `waitSecs` on `get-actor-run`)

`call-actor` waits up to 30s. `get-actor-run` returns instantly only. Long actors require many `get-actor-run` polls.

- **Con (decisive):** A 5-minute run with 10s poll-side intervals = 30 tool calls. Token cost and reliability both poor.

### Design D — overload `call-actor` with `runId` for resumption

`call-actor` accepts either `actor + input` (start) or `runId` (resume waiting). Eliminates `get-actor-run` for waiting.

- **Pro:** One tool covers start + wait.
- **Con:** Verb collision ("call" implies start, not "wait"). Mutually-exclusive params confuse LLMs and validators. Two distinct semantics under one name.

### Design E — single `actor-run` tool (start XOR wait)

Same as D with renamed surface.

- **Con:** Same as D. Overloaded verb. The clean naming of three tools beats the abstract elegance of one.

## Decision criteria scorecard

| Criterion | A (chosen) | B (#582) | C | D/E |
|---|---|---|---|---|
| 1. Tool-call count, common case | **1** | 2 | 1 | 1 |
| 2. Long-actor non-blocking | yes (capped wait) | yes | yes | yes |
| 3. Failure visibility | 1 call (≤30s), 2 (longer) | 2 always | 1 (≤30s), N (longer) | 1 (≤30s), 2 (longer) |
| 4. Response-shape consistency | identical across `call-actor` / `get-actor-run` | identical | identical | identical |
| 5. Task-mode value | full non-block + cancel | full non-block + cancel | full non-block + cancel | same |
| 6. Widget compatibility | `waitSecs:0` default in apps mode | works | works | works |
| 7. Implementation complexity | one extra branch (if waitSecs>0 wait) over B | simplest | simplest | medium |
| 8. CLAUDE.md scope discipline | minimal, no speculative | minimal | minimal | overloads |
| 9. MCP spec adherence | full (taskSupport: optional) | full | full | full |
| 10. Next-step clarity | `hint` field on every response | same | same | same |

A wins on #1 and #3, ties on the rest, loses to B on #7 by a single conditional branch — a fair price for halving the common-case tool-call count.

## Decision (one paragraph)

**Design A: `call-actor` waits up to 30s by default, `get-actor-run` accepts `waitSecs` for resumption, both return an identical shape, `get-actor-output` is removed in favor of `get-dataset-items`, and `call-actor` declares `taskSupport: "optional"` so Tier B clients get true non-blocking + cancellation while Tier A gets a fast common-case path.** The trade-off accepted: `call-actor` carries two response sub-modes (terminal vs RUNNING) within one shape, which adds a single conditional branch to the implementation and asks the LLM to read `status` before acting — a one-time learning cost, paid back on every short run by saving an entire tool call. Design B's stricter separation of "start" from "wait" is intellectually cleaner but pays its premium on every invocation, including the 70% that don't need it; given the duration distribution and criterion #1, that is the wrong direction.

## Migration / breaking changes

- `call-actor` parameters: drop `async`, drop `previewOutput`. Add `waitSecs`.
- `call-actor` response: drop `previewItems`, drop `schema`, drop `totalItemCount`, drop `previewItemCount`. Add `storages`, add `hint`.
- `get-actor-run` parameters: add `waitSecs`.
- `get-actor-run` response: drop `dataset.previewItems`, drop `dataset.schema`. Keep `finishedAt`, `stats`. Add `storages`, add `hint`.
- `get-actor-output` removed. Migrate callers to `get-dataset-items`.
- Widget (`src/web/src/widgets/actor-run-widget.tsx`): pass `waitSecs: 0` in the polling `get-actor-run` calls. Drop reads of `structuredContent.dataset.previewItems`.
- Internal repo (`apify-mcp-server-internal`): does not import any of the changed internals (verified per #582). Verify integration tests after merge.

## Open follow-ups (out of scope here)

- Direct actor tools (RAG Web Browser etc.) currently sync-with-preview — keep as-is; convert in a separate PR.
- `get-dataset-items` accepting `runId` as alternative to `datasetId`.
- `taskSupport` on `get-actor-run` — deferred until task adoption is measurable.
