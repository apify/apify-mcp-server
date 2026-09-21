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
| items | 74 | 37 |
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

`merge` families: actors 4, runs 4, storage 6, tasks 5, schedules 6, docs 2, web 9, dev 1.

Argument coverage: 41 of 74 `pr` cases pin `expectedArgs`, targeting the groups a lazy phrasing
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

## Baseline (2026-09-21, `--subscription --claude-judge`, **concurrency 1**)

| Tier | Opus | Sonnet | Haiku |
|---|---|---|---|
| `pr-v2` (72 items as measured) | 39/72 (0.54) | 54/72 (0.75) | 56/72 (0.78) |
| `merge-v2` (29 items as measured) | 23/29 (0.79) | not run | 16/29 (0.55) |

Measured before the coverage top-up below took `pr` to 74 and `merge` to 37. The 7 added cases were
validated separately: the 5 changed/added `pr` cases pass on Haiku and Sonnet (5/5) and 4/5 on Opus,
and all 8 added `merge` cases pass on Opus (8/8), so the tier figures move only slightly.

**Run the tier at `--concurrency 1`.** An earlier sweep at concurrency 2 measured 0.51/0.63/0.58 —
each roughly 20 points low, purely from the MCP-startup race. Those numbers are void; do not compare
against them.

**The `pr` ladder runs Haiku > Sonnet > Opus, and that is the finding, not noise.** Opus is 24 points
behind Haiku. The stronger the model, the more it reads before it acts, and the tool-call scorer
asserts the *first* call. The `merge` tier, which scores the whole multi-turn run, orders normally
(Opus 0.79 > Haiku 0.55). So: a weaker model is the more sensitive probe of *descriptions*; a
stronger one is the more sensitive probe of *whether an action tool is worth calling directly*.

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

These 13 fail on **all three** models on the clean sweep, so they are description problems rather
than model quirks. Start the tuning PR here:

```
pr/call-actor/budget-cap-one-dollar             pr/get-key-value-store-keys/lazy-whats-in-there
pr/call-actor/wait-two-minutes                  pr/publish-actor-task/let-people-find-it
pr/create-actor-task/lazy-save-config           pr/search-actors/limit-three-amazon-reviews
pr/create-actor-task/not-a-schedule-trap        pr/update-actor-task/lazy-change-numbers
pr/create-actor-task/with-stored-input          pr/update-actor-task/switch-build
pr/delete-schedule/remove-completely-not-pause  pr/update-schedule/change-frequency
pr/get-actor-run-log/lazy-why-did-it-break
```

An earlier concurrency-2 sweep put this list at 18; five of those were race victims, not findings.

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

## Is v2 at least as good as v1?

Checked mechanically against snapshots of both live datasets, because "cheaper and broader" was
true for `pr` and **false for `merge`** on the first cut.

**`pr`: yes.** No tool covered by v1 is missing. v2 adds `get-actor-run-log` — v1's two cases for it
assert the pre-rename `get-actor-log` and can never pass — and `report-problem`. Argument pinning
goes from 21 to **43** distinct (tool, arg) pairs, with **zero** groups left only-in-v1. Five did
regress on the first cut (`create-schedule.cronExpression`, `get-dataset.datasetId`,
`get-dataset-schema.datasetId`/`limit`, `get-key-value-store.keyValueStoreId`) and are now closed.

**`merge`: not at first.** Collapsing v1's 20 web cases to 4 and dropping its two collision cases
silently lost six axes. Restored by porting v1's own calibrated cases:

| Axis | v1 cases dropped | restored as |
|---|---|---|
| output formats | `formats-easy-1`, `formats-medium-1`, `format-discovery` | `web/markup-not-cleaned-up`, `web/pdf-to-text` |
| links extraction | `links-medium-1` | `web/list-the-links` |
| HTTP status | `status-hard-1` | `web/reports-404-truthfully` |
| unreachable host | `unreachable` | `web/unreachable-host` |
| name collision | `tasks/create-collision`, `schedules/collision-hard-1` | `tasks/name-collision`, `schedules/name-collision` |
| pagination / bulk | `storage-dataset-items-{maps,hotels}-bulk` | `storage/all-rows-one-call` |

`merge-v2` stays at 37 against v1's 70. The difference is v1's seven near-identical
"run a scraper for platform X, then read its dataset" cases at 16-20 turns each, consolidated to two
— deliberate, and the single biggest cost saving in the tier.

`status-hard-1` was retargeted off httpbin.org (503s regularly, per the harness README) to a 404 on
rfc-editor.org, probed at authoring time.

## Tiering: why v2 does not replace v1 yet

Three tiers, one job each:

| Tier | Job | Dataset |
|---|---|---|
| PR | fast regression gate, nothing executes | **v1** — runs 0.93-0.97 against a 0.9 threshold |
| merge | full agent run on master | **v1** |
| nightly | diagnostic bench, non-gating | **does not exist yet** — this is where v2 belongs |

v2 scores ~0.78 on the CI model *by design*: it holds cases that fail so descriptions can be tuned
against them. Gating on that would mean a threshold near 0.55, which is not a gate — 45% of the
suite could break and CI would stay green. So v1 keeps gating until either the tuning work lifts
v2's rate, or a nightly tier gives v2 a home where failures are the point. On the second path v2
never replaces v1 at all; they run side by side.

## Open

- Cases are deliberately not all passing. Tuning descriptions so they do is the follow-up, and is
  the reason these datasets exist. Start with the 13 cross-model failures above.
- Sonnet has not been run on `merge`. Queue it behind #1394: merge cases create `eval-*` resources,
  and running another model now just adds debris the sweep has to clean up first.
- `--pass-threshold` is deliberately unset. Pick it from the post-tuning rate, or not at all if v2
  lands on a nightly tier where nothing is gated.
- #1394 is partly satisfied by v2 already: mutating cases are self-contained (`create-then-remove`
  makes and deletes its own schedule; both collision cases mutate nothing). Its per-trial-naming and
  age-based sweep are not — `eval-sched-weekday` and `eval-sum-eight-nine` collided between two runs
  here. Re-scope it against v2 before implementing as written.
