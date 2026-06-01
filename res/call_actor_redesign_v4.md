# `call-actor` V4 response contract (shipped)

The V4 redesign shipped via PRs #823 and #825. **Code is the source of truth** — this file
keeps only the locked decisions and the "why" behind them. For the implementation see
`src/tools/core/actor_run_response.ts` (response shape + status templates),
`src/tools/core/call_actor_common.ts` (`waitSecs`, sync/task modes), and
`src/tools/structured_output_schemas.ts` (the structured schema).

## What it is

`call-actor` and `get-actor-run` return one canonical shape across sync, task, and
wait-timeout modes. The shape mirrors Apify's storage API and adds a `summary` (past) +
`nextStep` (one primary action) pair the LLM acts on directly. The response carries
identifiers and field/key lists only — no inline dataset items or KV bodies; the agent
fetches data via `get-dataset-items` / `get-key-value-store-record`.

## Locked decisions

| ID | Decision |
|---|---|
| **T1** | `storages` mirrors `ActorRunStorageIds`: `{ datasets: { default, [alias] }, keyValueStores: { default, [alias] } }`. Each value is a subset of the Apify storage API (timestamps as ISO 8601), minus security/identity fields. KV value adds `keys` (capped at 50) + `keyCount`; dataset value adds `fields` (dot notation), no item samples. |
| **T2** | `summary` = past, `nextStep` = one primary action. Both camelCase. |
| **R1** | Emit `notifications/tasks/status` on every task state change. No heartbeat (task `tools/call` returns immediately; SDK clients poll `tasks/get`). |
| **R4** | Keep the public name `call-actor`; the `run-actor` rename is a separate, deferred migration. |
| **Q2** | `get-actor-run` returns the same canonical shape. |
| **Q3** | `get-dataset-items`, `get-key-value-store-record`, `abort-actor-run` are auto-injected in actor workflows. `get-actor-output` deprecated, ordered after `get-dataset-items`. |
| **Q4** | Server translates Apify slash-notation to dot-notation; `get-dataset-items` auto-flattens parents referenced in dot-notation `fields`. Explicit `flatten` is a diagnostic override. |
| **Q5** | `isError: false` for any observed terminal run status (`SUCCEEDED`/`FAILED`/`ABORTED`/`TIMED-OUT`); task lands in `completed`. Task `failed` is reserved for tool-side failures (auth, validation, network). |
| **Q6** | Storage tools stay single-purpose: `get-dataset-items` requires `datasetId`, `get-key-value-store-record` requires `keyValueStoreId`. Both IDs are surfaced in `storages.*.default.id` and interpolated into `nextStep`. |
| **Q7** | No inline KV bodies; `keys` lists up to 50 names with `keyCount` for the total. |
| **Q8** | Status enum is the full Apify set: `READY \| RUNNING \| TIMING-OUT \| TIMED-OUT \| ABORTING \| ABORTED \| SUCCEEDED \| FAILED`. Each has its own `summary`/`nextStep` template. |
| **Q9** | `waitSecs` capped 0–45, default 30 on both `call-actor` and `get-actor-run` (#822). 45 s stays under the 60 s tool-call timeout some clients impose; longer waits are agent-driven via repeated `get-actor-run`. In task mode `waitSecs` is ignored. |

## Param rename

`get-key-value-store-record` takes `keyValueStoreId` (renamed from `storeId`) to align with
`datasetId`. `recordKey` unchanged.
