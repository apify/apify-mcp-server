# Rebuilt eval datasets: full-tool-set coverage (2026-09-20)

Working record for the two rebuilt Langfuse datasets. Delete once they replace
`mcp-server-evals-pr` / `mcp-server-evals-merge` in `_evaluations.yaml`.

## What was built and why

Goal: run the server with **every tool enabled at once** and have an agent still pick the right
one. The existing datasets can't measure that — most of their cases load one category
(`tools: ["storage"]`, `["tasks"]`, …), so tool-vs-tool ambiguity is configured away before the
agent sees it.

Two new datasets, built from user intent rather than from tool descriptions. The live datasets are
untouched and still gate CI.

| | `mcp-server-evals-pr-v2` | `mcp-server-evals-merge-v2` |
|---|---|---|
| kind | `tool-call` (first call asserted, nothing executes) | `agent` (runs to completion, LLM judge) |
| items | 72 | 29 |
| replaces | `mcp-server-evals-pr` (125) | `mcp-server-evals-merge` (70) |

Every item in both carries the same two settings:

- `tools: ["actors","docs","runs","storage","tasks","schedules","dev","apify/rag-web-browser","apify/web-fetch"]`
  — all 29 in-scope tools loaded, so every case is an ambiguity test.
- `mcpToolsOnly: true` — client built-ins dropped. The question is which *MCP* tool wins, and
  built-ins otherwise inject `ToolSearch` as a false first capture (see Findings).

## Coverage

All 29 non-widget tools have at least one dedicated `pr` case; the 4 widget tools stay out of
scope. Counts are `pr` cases naming the tool in `expectedTools`.

| Tool | pr | Tool | pr |
|---|---|---|---|
| `search-actors` | 4 | `get-dataset-items` | 4 |
| `fetch-actor-details` | 3 | `get-dataset` | 2 |
| `call-actor` | 4 | `get-dataset-schema` | 2 |
| `apify--rag-web-browser` | 3 | `get-dataset-list` | 2 |
| `apify--web-fetch` | 3 | `get-key-value-store` | 2 |
| `search-apify-docs` | 3 | `get-key-value-store-keys` | 2 |
| `fetch-apify-docs` | 2 | `get-key-value-store-record` | 2 |
| `get-actor-run` | 2 | `get-key-value-store-list` | 2 |
| `get-actor-run-list` | 2 | `create-actor-task` | 3 |
| `get-actor-run-log` | 3 | `get-actor-task` | 2 |
| `abort-actor-run` | 2 | `update-actor-task` | 3 |
| `create-schedule` | 3 | `publish-actor-task` | 2 |
| `get-schedule` | 2 | `unpublish-actor-task` | 2 |
| `update-schedule` | 3 | `report-problem` | 1 |
| `delete-schedule` | 2 | | |

`merge` families: actors 4, runs 4, storage 5, tasks 4, schedules 5, docs 2, web 4, dev 1.

Argument coverage: 36 of 72 `pr` cases pin `expectedArgs`, targeting the groups a lazy phrasing
should trigger — `limit`, `offset`, `desc`, `fields`, `unnamed`, `status`, `lines`, `waitSecs`,
`gracefully`, `recordKey`, `isEnabled`, `timezone`, `build`, `callOptions.memory`,
`callOptions.maxTotalChargeUsd`. Not all 95 groups: pinning every one costs a case each and most
are not reachable from natural user language.

## Findings from building it

1. **Two cases in the live `pr` dataset are dead.** `pr/get-actor-log/debug-failed-run` and
   `pr/get-actor-log/missing-line-count` assert `get-actor-log`, renamed to `get-actor-run-log`
   and now in `RETIRED_SELECTOR_NAMES`. They cannot pass, so `get-actor-run-log` has no real
   coverage today. Fixed here by three new cases under the current name.
2. **The live `pr` set is lopsided.** `search-actors` 34, `fetch-actor-details` 18,
   `rag-web-browser` 13, `get-actor-task` 12, `search-apify-docs` 10 — 87 of 125 items on five
   tools, many near-duplicates (five "recent AI articles" variants, three weather variants).
   24 tools share the other 38.
3. **The live `merge` set is over-spent and under-gating.** Seven of 70 cases are the same
   "run a scraper for platform X, then read its dataset" shape at 16–20 turns, each launching a
   real scraper. Meanwhile there is no `runs` family and no `docs` family, and the gate sits at
   `--pass-threshold 0.6` with nine items failing every run.
4. **The item-count lag is real.** A fresh `apify/hello-world` run returns one dataset item while
   the count still reads `0`. `merge/storage/count-lag-honesty` has an explicit judge-blindness
   clause so an agent narrating the lag is not scored as failing.

## Calibration

Run the ladder with `--subscription --claude-judge` (no API keys needed) — and read the two
environment traps below before trusting any number.

```bash
pnpm run evals:mcp-agent -- --dataset mcp-server-evals-pr-v2 \
    --agent-model claude-opus-5 --subscription --claude-judge --concurrency 2
```

### Environment traps (both cost hours here)

- **Concurrency corrupts the result.** At `--concurrency 4+`, items fail with
  `first_tool_match 0 — no tool call attempted`: each item spawns its own MCP server, and with all
  29 tools selected each server fetches two live Actor input schemas at startup. Under load the
  agent starts before its tools are ready. Measured: 5 of 6 such failures pass at
  `--concurrency 1`. Calibrate at 1–2; a higher number measures the race, not the descriptions.
- **Client built-ins inject `ToolSearch`.** With built-ins on, Opus spends turn 1 of the fixed
  2-turn tool-call budget on `ToolSearch`, which the scorer skips — 50 of 66 failures in the first
  run. `mcpToolsOnly: true` on every item removes it.
- Killing a run orphans its agent and MCP children, which keep respawning and starve the box. Let
  runs finish; if one must die, kill the reparented `tsx` worker, then its children.
- The egress CA rotates mid-session. When Node reports `self-signed certificate in certificate
  chain` while `curl --cacert /root/.ccr/ca-bundle.crt` returns 200, prefix runs with
  `SSL_CERT_FILE=/root/.ccr/ca-bundle.crt NODE_OPTIONS=--use-openssl-ca`.

### Fixtures

`merge` needs `eval-sum-nightly` (task) plus `eval-nightly-sum` and `eval-sched-target`
(schedules, both disabled). `pnpm run evals:mcp-agent:schedules-fixtures` seeds them but first
calls `users/me`, so it exits 403 on a token without that scope even when every write it performs
would succeed.

## Open

- Cases are deliberately not all passing. Tuning descriptions so they do is the follow-up, and is
  the reason these datasets exist.
- Numbers per model, and the `--pass-threshold` each tier should carry, go here once the ladder
  finishes.
