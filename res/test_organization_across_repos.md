# Test organization across public and internal repos

How tests are split between `apify-mcp-server` (public) and `apify-mcp-server-internal`.

## Goal

Eliminate test-code duplication between the two repos while still covering every behavior that can break in the hosted environment.

## Principle

**Consumer-driven contracts.** Each repo writes its own tests; no test code is imported or copied across the boundary.

- Public verifies what its package **produces**.
- Internal verifies what it **consumes** from the package and what its own hosting layer adds.
- Coupling is limited to the package's runtime API (`ActorsMcpServer`, `internals.js` exports, fixture actor names) — already unavoidable.

A package regression that internal depends on surfaces at the version bump — the right moment, with clear blame.

## Layers

The system has four layers. Each layer has one owner; tests for a layer live with its owner.

### Layer 1 — MCP protocol (wire) — public

- `initialize` handshake (`serverInfo`, `instructions`, advertised `capabilities`).
- Request/response shapes for `tools/*`, `prompts/*`, `resources/*`, `tasks/*`, `logging/setLevel`.
- Notification delivery (`tools/list_changed`, `progress`, `cancelled`, `message` with level filtering).
- JSON-RPC error codes for unknown tool, invalid params, invalid prompt args.

### Layer 2 — Package implementation — public

- Tool loader: selectors, categories, slash-syntax actor names, `tools` + `actors` merge.
- Widget metadata shape (`_meta.ui`, openai vs apps mode), widget pairing.
- Structured output schemas; output-schema enrichment for direct actor tools.
- Prompt registry contents.
- Built-in tool internals: docs search/fetch, store search, fetch-actor-details, get-actor-run / get-dataset-items / get-kv-record.
- `call-actor` canonical `RunResponse` shape.
- `SkyfirePaymentProvider` (input injection, session isolation, `?payment=skyfire` URL parsing).
- Client-name capability detection (`doesMcpClientSupportDynamicTools()`).
- URL → server-mode mapping for `?ui=apps`/`?ui=openai`/`?ui=true` via `parseServerMode()`.

### Layer 3 — Hosting middleware — internal

- **IAM auth gate**: 401 on missing token, unauth-user toolset filtering, 403 paths. `src/server/shared.ts` via `@apify-packages/iam-server`.
- **IAM bypass on `?payment=skyfire`**: IAM treats the URL parameter as a signal to skip token validation. The payment provider itself is layer 2.
- **Rate limiter**: 429 thresholds, non-MCP path bypass (homepage `/`), per-IP/per-token scoping. `src/server/rate-limiter.ts`.
- **Event resumability**: `RedisEventStore` replay via `Last-Event-ID`. `src/stores/redis-event-store.ts`.
- **User-aware rental Actor filter**: shows the caller's rented Actors among non-rentals. Requires user identity from IAM; distinct from public's drop-all-rentals filter.
- **Non-MCP HTTP routes**: the `/` homepage and other paths outside the MCP protocol surface.

### Layer 4 — Multi-node coordination — internal multinode

- Re-runs layers 3 and the consumer contract through Caddy LB across two nodes.
- Cross-node session continuity (LB pins session-id back to origin node via Redis routing).
- Cross-node cancellation (`tasks/cancel` to node B for a task created on node A).
- Failover (node B handles traffic when node A is down).
- Legacy SSE behavior across nodes.

### Cross-cutting — consumer-driven contract — internal

A small set of internal-owned smoke tests asserting that layer-1 and layer-2 behaviors **survive layer 3** intact. The contract test is not a duplicate of the public test — it verifies preservation through middleware, not implementation correctness.

Typical candidates:
- `notifications/tools/list_changed` reaches the client (Caddy buffer config could delay/drop it).
- `_meta` keys survive middleware (auth filter could strip them).
- `structuredContent` not rewritten by response transformers.
- Skyfire `skyfire-pay-id` injection survives the request/response cycle.
- `?ui=apps` / `?ui=true` parsing reaches the package (internal's HTTP server forwards the query string).
- Client-name in the `initialize` request reaches the package (middleware could rewrite `clientInfo.name`).
- Long-running task lifecycle through Redis-backed `TaskStore`.

One test per consumed behavior, with a one-line comment naming both the behavior and the middleware risk it guards against.

## How to decide where a new test belongs

1. Does the code under test require IAM, Redis, the rate-limiter, multi-node coordination, or a non-MCP hosted route to make sense? → internal (layer 3 or 4). Stop.
2. Otherwise the implementation is in the package → public (layer 1 or 2).
3. **Additionally**, if internal's middleware sits between the wire and this behavior in a way that could plausibly break or strip it → internal also writes a contract smoke test. Default to "no contract test" unless there's a concrete risk story.

## Target structure

**Public** — no changes. `tests/integration/suite.ts` covers layers 1 and 2 across stdio, sse, streamable-http transports against `dev_server.ts`. Gaps tracked in [`integration_test_coverage_plan.md`](./integration_test_coverage_plan.md).

**Internal** — `test/integration/src/server-suite.ts` splits into two factories:

- `createContractSuite()` — consumer-driven contract.
- `createHostedSuite()` — layer-3 behaviors.

`server-suite.ts` becomes a thin wrapper calling both. Transport entry points at `test/integration/tests/` are unchanged.

**Multinode** — `multinode-streamable.test.ts` keeps importing the integration suite. Multinode-specific files (`multi-node-state-balancer-round-robin.test.ts`, `slow-multi-node-actor-cancellation.test.ts`, `multi-node-legacy-sse.test.ts`) unchanged.

## Acceptance

- No test in internal exercises pure package logic. Layer-2 behaviors appear only as contract tests with a middleware-risk justification in the test comment.
- Every contract test has a one-line comment naming the consumed behavior and (if layer-2) the middleware risk.
- Every hosted test references a layer-3 behavior in its name or comment.
- `pnpm run test:integration` and `pnpm run test:multinode` both pass.

## Out of scope

- Filling public-side coverage gaps (tracked in [`integration_test_coverage_plan.md`](./integration_test_coverage_plan.md)).
- Renaming fixture actors (handled in PR #895; legacy actors stay published).
- Bumping `@apify/actors-mcp-server` version in internal.

## References

- [`integration_test_coverage_audit.md`](./integration_test_coverage_audit.md), [`integration_test_coverage_plan.md`](./integration_test_coverage_plan.md), [`mcp_task_reference.md`](./mcp_task_reference.md)
- `test/multinode/README.md` in `apify-mcp-server-internal` — documents the "no duplicated test bodies" pattern at the internal→multinode boundary.
