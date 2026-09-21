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

## Baseline (2026-09-21, `--subscription --claude-judge`, concurrency 2)

| Tier | Opus | Sonnet | Haiku |
|---|---|---|---|
| `pr-v2` (72 tool-call) | 37/72 (0.51) | 45/72 (0.63) | 42/72 (0.58) |
| `merge-v2` (29 agent) | 23/29 (0.79) | not run | 16/29 (0.55) |

Every `pr` figure is depressed by the concurrency race: 10, 10 and 16 items respectively failed with
`no tool call attempted`, and 5 of Opus's 10 pass when re-run at `--concurrency 1` (so Opus is really
~42/72). Treat these as a floor, not a measurement, until someone runs the tier at concurrency 1.

**The `pr` ladder does not go the way the skill assumes: Sonnet > Haiku > Opus.** That is the finding,
not noise. Opus's failures are a near-superset of Haiku's because the stronger model reads before it
acts, and the tool-call scorer asserts the *first* call. The `merge` tier, which scores the whole
multi-turn run, orders normally (Opus 0.79 > Haiku 0.55). A weaker model is the more sensitive probe
of *descriptions*; a stronger one is the more sensitive probe of *whether an action tool is worth
calling directly*.

### The one systemic finding

With every tool loaded, agents reach for the *inspect* sibling before the *action* tool. It accounts
for nearly every failure in both models:

| Wanted | Agent called instead |
|---|---|
| `update-actor-task`, `publish-actor-task`, `unpublish-actor-task` | `get-actor-task` |
| `update-schedule`, `delete-schedule` | `get-schedule` |
| `get-actor-run-log` | `get-actor-run` |
| `get-dataset-items`, `get-dataset-schema` | `get-dataset` |
| `get-key-value-store-keys` | `get-key-value-store` |
| `call-actor`, `create-actor-task` | `fetch-actor-details` |
| `abort-actor-run` | `get-actor-run` |

These 18 fail on **all three** models, so they are description problems rather than model quirks.
Start the tuning PR here:

```
pr/call-actor/budget-cap-one-dollar             pr/get-key-value-store-keys/lazy-whats-in-there
pr/create-actor-task/lazy-save-config           pr/publish-actor-task/lazy-make-public
pr/create-actor-task/not-a-schedule-trap        pr/publish-actor-task/let-people-find-it
pr/create-actor-task/with-stored-input          pr/search-actors/limit-three-amazon-reviews
pr/create-schedule/timezone-prague              pr/update-actor-task/landing-page-title
pr/delete-schedule/remove-completely-not-pause  pr/update-actor-task/lazy-change-numbers
pr/fetch-apify-docs/missing-page                pr/update-actor-task/switch-build
pr/get-actor-run-log/error-message-not-status   pr/update-schedule/change-frequency
pr/get-actor-run-log/lazy-why-did-it-break      pr/update-schedule/turn-back-on
```

A handful of these lost one model to the concurrency race rather than to a wrong pick, so confirm a
case at `--concurrency 1` before treating it as evidence about a description.

Two argument findings, both cross-model: `search-actors` ignores an explicit count ("just 3 options"
→ `limit` 5 or 6, though the schema allows 1), and `get-actor-run` shortens a stated wait ("up to 60
seconds" → `waitSecs` 45).

`report-problem` **passes** as a first call on Opus. PR #1338 recorded it as structurally uncoverable;
with the full tool set and no client built-ins competing, it is covered.

### merge-v2

Opus 23/29, Haiku 16/29. Five case defects surfaced and are fixed:

- the pause case targeted a fixture seeded disabled, so "pause it" found it already paused;
- the lifecycle case used an Actor this account cannot create tasks for (`apify/hello-world` →
  `insufficient-permissions`), now `apify/normal-mode-test-actor`;
- the verbatim-fetch case hit an Actor requiring account-permission approval, now in `expectedErrors`;
- `merge/actors/vague-need-shortlist` demanded the judge verify slugs against search results it
  cannot see, and it duly failed real results as "implausibly precise" — the judge-blindness trap;
- `merge/tasks/publish-requirement-discovery` required discovery-by-error and so failed an agent that
  set the requirements up front and published in one pass, which is the better outcome. Now scored on
  the outcome.

Real findings left standing: the agent asks for confirmation instead of completing an update, answers
"what data do I have" without listing any storage, skips the FAILED status filter, silently rewrites
`ftp://` to `https://` without telling the user, answers a web question from memory with no search,
and — the sharpest one — on an injected `call-actor` failure it silently switches to another tool and
presents the result rather than reporting the failure.

**Create cases leave debris.** `eval-sched-weekday` and `eval-sum-eight-nine` collided on the second
run and failed the zero-tool-error gate. Delete every `eval-*` task and schedule except the three
fixtures before each run; `evals:mcp-agent:schedules-fixtures` does this but exits 403 on a token
without `users/me`.

## Open

- Cases are deliberately not all passing. Tuning descriptions so they do is the follow-up, and is
  the reason these datasets exist. Start with the 11 cross-model failures above.
- Sonnet has not been run. The Opus/Haiku gap is about deliberation, not capability, so the middle
  rung is worth having before any description is changed.
- `--pass-threshold` for CI is deliberately not set yet: it should be chosen after the tuning PR,
  from the post-fix rate, not from this baseline.
- Switching CI over is a two-line change in `_evaluations.yaml` (`--dataset ...-v2`); the live
  datasets stay until then.
