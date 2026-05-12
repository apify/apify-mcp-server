# `tasks/cancel` → Actor abort flow

How a client's `tasks/cancel` request gets translated into an actual
`apifyClient.run(runId).abort()` call against the Apify platform, and what
PR #812 (issue #763) changed.

Verify line numbers against current source before trusting them.

## The bug

The MCP SDK's `tasks/cancel` request handler
(`@modelcontextprotocol/sdk/dist/esm/shared/protocol.js`,
`CancelTaskRequestSchema` handler) does this and only this:

1. Reads the task from the `TaskStore`.
2. Verifies it is not in a terminal status.
3. Writes `status='cancelled'` to the `TaskStore`.
4. Clears the task's pending message queue.
5. Returns the cancelled task.

It does **not** abort the in-flight request's `AbortController`.

This differs from the older `notifications/cancelled` notification
(handled by the SDK's `_oncancel`), which **does** call
`controller.abort()` on the request handler's controller.

Net effect before PR #812: a client could call `tasks/cancel`, the task
would flip to `cancelled`, but the tool handler would keep running. The
underlying Apify Actor run would keep consuming compute until natural
completion. The bug shows up as "I cancelled, but my Apify bill kept
ticking."

## Where the actor is actually aborted

A single line in `src/tools/core/actor_execution.ts:64`:

```ts
await apifyClient.run(runId).abort({ gracefully: false });
```

Wrapped in `abortActorRun(runId)` (`src/tools/core/actor_execution.ts:62-68`).
This call existed before PR #812 — it is wired to fire when an `AbortSignal`
passed in via the `abortSignal` parameter aborts. PR #812 did not touch
`actor_execution.ts`; it just made sure the right `AbortSignal` reaches it.

## Before PR #812

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant SDK as MCP SDK<br/>(tasks/cancel handler)
    participant Store as TaskStore
    participant Server as ActorsMcpServer<br/>executeToolAndUpdateTask
    participant Exec as callActorGetDataset
    participant Apify as Apify platform

    Client->>Server: tools/call (task mode)
    Server->>Exec: actor execution<br/>abortSignal = extra.signal
    Exec->>Apify: actorClient.start(input)
    Apify-->>Exec: { runId }
    Exec->>Apify: run(runId).waitForFinish()

    Note over Client,Apify: ... time passes, run is in flight ...

    Client->>SDK: tasks/cancel { taskId }
    SDK->>Store: updateTaskStatus(taskId, 'cancelled')
    SDK-->>Client: { task: { status: 'cancelled' } }

    rect rgba(255, 0, 0, 0.12)
        Note over Server,Apify: Handler never learns about the cancel.<br/>extra.signal does not fire for tasks/cancel.<br/>Run keeps consuming compute until natural finish.
    end

    Apify-->>Exec: run finishes naturally
    Exec-->>Server: result (discarded)
    Server->>Store: post-run isTaskCancelled check<br/>(skip result storage only)
```

The post-run `isTaskCancelled` check at `src/mcp/server.ts:1485` mitigated
the *result-storage* half of the problem (we don't return data for a
cancelled task) but did nothing about the *compute-consumption* half.

## After PR #812

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant SDK as MCP SDK<br/>(tasks/cancel handler)
    participant Store as TaskStore
    participant Watcher as createTaskCancellationWatcher<br/>(polls every 500 ms)
    participant Server as ActorsMcpServer<br/>executeToolAndUpdateTask
    participant Exec as callActorGetDataset
    participant Apify as Apify platform

    Client->>Server: tools/call (task mode)
    Server->>Watcher: create watcher<br/>(taskId, mcpSessionId, taskStore)
    Server->>Exec: actor execution<br/>abortSignal = cancelWatcher.signal
    Exec->>Apify: actorClient.start(input)
    Apify-->>Exec: { runId }
    Exec->>Apify: run(runId).waitForFinish()

    loop every 500 ms
        Watcher->>Store: getTask(taskId)
        Store-->>Watcher: status: 'working'
    end

    Client->>SDK: tasks/cancel { taskId }
    SDK->>Store: updateTaskStatus(taskId, 'cancelled')
    SDK-->>Client: { task: { status: 'cancelled' } }

    Watcher->>Store: getTask(taskId)
    Store-->>Watcher: status: 'cancelled'

    rect rgba(0, 180, 0, 0.15)
        Watcher->>Watcher: controller.abort()<br/>cancelWatcher.signal fires
        Watcher-->>Exec: abortSignal 'abort' event
        Exec->>Apify: run(runId).abort({ gracefully: false })
        Apify-->>Exec: aborted
    end

    Exec-->>Server: returns null (aborted)
    Server->>Watcher: dispose() in finally
    Server->>Store: skip result storage<br/>finishTaskTracking(aborted)
```

`cancelWatcher.signal` replaces `extra.signal` at the two places where
the in-flight execution observes cancellation:

- `src/mcp/server.ts:1349` — internal-tool branch (`tool.call({ extra: taskExtra })`)
- `src/mcp/server.ts:1382` — direct-actor-tool branch (`abortSignal: cancelWatcher.signal`)

Both branches funnel into `callActorGetDataset` (or other code paths that
respect `AbortSignal`). The abort listener inside `callActorGetDataset`
(`src/tools/core/actor_execution.ts:96-101`) reacts and calls
`abortActorRun(runId)` → `apifyClient.run(runId).abort()` at line 64.

## End-to-end signal path

```mermaid
flowchart LR
    A[Client<br/>tasks/cancel] --> B[MCP SDK<br/>writes status='cancelled']
    B --> C[(TaskStore<br/>shared, Redis-backed in prod)]
    C -. polled every 500 ms .-> D[createTaskCancellationWatcher<br/>src/mcp/utils.ts]
    D -- detects cancelled --> E[controller.abort]
    E --> F[cancelWatcher.signal<br/>'abort' event]
    F --> G[abortListener inside<br/>callActorGetDataset:96]
    G --> H["apifyClient.run(runId).abort()<br/>actor_execution.ts:64"]
    H --> I[Apify platform<br/>stops Actor run, releases compute]
```

## Why the request's `extra.signal` is intentionally NOT chained

Per the MCP tasks spec, a task's lifetime is **decoupled** from the
original request. Once the task is created and `{ task }` is returned,
the request is complete and the task continues independently. Client
disconnect, transport close, or `notifications/cancelled` for the
original request ID MUST NOT cancel the task — only `tasks/cancel`
(which writes `cancelled` to the TaskStore) is allowed to.

`createTaskCancellationWatcher` therefore reads only from the TaskStore
and exposes a fresh `AbortController`. It does NOT subscribe to
`extra.signal` from the original request handler. Earlier drafts of this
helper chained the parent signal as a "free" cancel path; that was
spec-incorrect and was removed before merge.

In practice the parent signal cannot fire after the task is created
anyway: the SDK deletes the request's `AbortController` from
`_requestHandlerAbortControllers`
(`@modelcontextprotocol/sdk/dist/esm/shared/protocol.js` lines 419-420)
in the `.finally()` callback that runs after the response is sent, and
`executeToolAndUpdateTask` runs in `setImmediate` after that. But "it
can't fire" is not the same as "it's safe to subscribe to" — a future
SDK change or an aggressive transport could violate that timing, and
the tests would silently lock in the wrong behaviour. Not subscribing
in the first place keeps the contract explicit.

The unit test
`does not abort when an unrelated AbortSignal fires (task survives client disconnect)`
in `tests/unit/mcp.utils.test.ts` is the regression guard.

## Why polling, not a callback

In multi-node deployments (the hosted Apify MCP server runs on multiple
pods sharing one Redis-backed `TaskStore` — `RedisTaskStore` in the
internal repo), `tasks/cancel` may arrive on a **different** node from
the one running the handler. The `AbortController` lives in the executing
node's process memory and cannot be reached from another pod. The shared
`TaskStore` is the only signal the executing pod can observe — so it
must poll.

500 ms is a deliberate compromise between cancel latency and Redis load.
See `src/mcp/utils.ts` `createTaskCancellationWatcher` docstring.

The internal repo's
`test/multinode/slow-multi-node-actor-cancellation.test.ts:169-221`
exercises this cross-node path end-to-end: client 1 starts a task on
node 1, client 2 calls `cancelTask` on node 2, node 1's poll loop reads
the cancelled status from Redis and aborts the local watcher.

## Race-condition guards already in `callActorGetDataset`

The abort can arrive before there is a `runId` to abort. Two pre-existing
guards handle this — they were not added by PR #812 but they make the
chain robust:

- **Before `start()`** (`actor_execution.ts:72-75`): if `abortSignal.aborted`
  is already true, return without starting.
- **After `start()`** (`actor_execution.ts:83-88`): `actorClient.start()`
  is not tied to the `AbortSignal`, so a cancel during the start RPC is
  invisible until `start()` resolves. We immediately re-check and abort
  the freshly-created run ourselves.
- **Steady state** (`actor_execution.ts:110-119`):
  `Promise.race([waitForFinish(), abortPromise])` plus listener cleanup
  on the winner so a stale abort cannot fire on a run that already
  finished naturally.

## Hardening on top of the polling loop

Two extra defenses live inside `createTaskCancellationWatcher`:

- **`tickInProgress` guard.** Skips a tick if the previous one is still
  awaiting `getTask`. Without this, Redis tail-latency spikes (cluster
  reslot, failover) cause ticks to pile up and amplify load right when
  the backend is struggling.
- **Swallowing `try/catch`.** `RedisTaskStore.getTask` is a single Redis
  HGET that can throw on transient cluster errors. Without the catch, a
  single Redis blip becomes an unhandled promise rejection → with Node's
  default `--unhandled-rejections=throw` the worker pod crashes, killing
  every other session it serves. The catch swallows silently and keeps
  polling so the next successful tick still aborts. No logging: the loop
  fires every 500 ms per active task, so logging on each failure would
  flood logs during a Redis outage that's already alerted at a lower layer.

## Files of interest

| Path | Role |
|---|---|
| `src/mcp/utils.ts` — `createTaskCancellationWatcher` | The polling watcher. Bridges TaskStore status → AbortSignal. |
| `src/mcp/server.ts:1290-1299` | Constructs the watcher per task in `executeToolAndUpdateTask`. |
| `src/mcp/server.ts:1382` | Threads the chained signal into the direct-actor-tool branch. |
| `src/mcp/server.ts:1349` | Threads the chained signal into internal-tool calls. |
| `src/mcp/server.ts:1512` | `dispose()` in `finally` to stop polling. |
| `src/tools/core/actor_execution.ts:62-68` | `abortActorRun(runId)` wrapper. |
| `src/tools/core/actor_execution.ts:64` | The actual `apifyClient.run(runId).abort()`. |
| `src/tools/core/actor_execution.ts:72-101` | Race-condition guards around `start()` and the abort listener. |
| `tests/integration/suite.ts` | E2E test: cancel mid-run, assert Apify run reaches ABORTED. |
| `tests/unit/mcp.utils.test.ts` | Unit tests for the watcher (happy path, parent abort, dispose, transient errors, no overlap). |
| internal repo `test/multinode/slow-multi-node-actor-cancellation.test.ts:169-221` | Cross-node regression test for the polling path. |
