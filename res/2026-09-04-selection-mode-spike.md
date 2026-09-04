# Selection-mode spike: deny-all capture + `--iterations` (apify/ai-team#260)

Throwaway technical spike. No code from this spike is committed; the working tree has
untracked files under `evals/mcp_agent/spike/` only (see `git diff --stat` at the end).

## Verdicts

| Question | Verdict |
|---|---|
| Q1 — deny-all capture | **WORKS WITH CAVEATS** |
| Q2 — iterations x Langfuse experiments | **WORKS** |
| Q3 — mixed deny-all + normal run | **WORKS** |

---

## Q1 — deny-ALL capture

**Setup:** `evals/mcp_agent/spike/spike_q1_deny_all.ts`, a standalone copy of
`runAgentConversation`'s SDK options with a `PreToolUse` hook that denies **every** tool
call (not just a `failTools` allowlist) and records `{tool_name, tool_input}` on every
invocation. Agent model `claude-haiku-4-5`, `maxTurns: 3`, 3 queries x 2 denial wordings = 6 runs.

### (a) Is the first tool call's name + arguments capturable? Yes, two independent ways agree

The `PreToolUse` hook input (`input.tool_name`, `input.tool_input`) and the SDK message
stream's `assistant` `tool_use` block (`block.name`, `block.input`) report the identical
call. Example (query: "Show me the input schema for apify/rag-web-browser"):

```json
{
  "toolName": "mcp__apify__fetch-actor-details",
  "toolInput": { "actor": "apify/rag-web-browser", "output": { "inputSchema": true } }
}
```

The hook fires **before** any permission check (see caveat below), so this is a clean,
side-effect-free capture point: nothing executes, exactly as #260 wants.

**Caveat — "first tool call" is not always the tool you think you're measuring.** For the
web-fetch query ("Fetch https://example.com and tell me what it says"), the first
captured call was not `WebFetch` — it was Claude Code's own **`ToolSearch`** meta-tool:

```json
{ "toolName": "ToolSearch", "toolInput": { "query": "select:WebFetch", "max_results": 5 } }
```

This is expected, documented Claude Code behavior (README design decision #3: built-ins sit
behind tool search once enabled) — not a sandbox artifact. It means a deny-all harness that
naively reports "the first denied tool name" will sometimes report `ToolSearch`, not the
tool the eval actually cares about. In this run the agent recovered gracefully: after
`ToolSearch` was denied, it inferred and stated the call it *would* have made
(`WebFetch(url: "https://example.com")`) in its final answer — so the intended call is
still recoverable, just not from the hook capture alone. **Recommendation for #260:** either
(1) run `mcp-tools-only` for selection cases that must isolate MCP-vs-MCP tool choice, or
(2) when the first denied call is `ToolSearch`, don't count it as "the measurement" — deny it
too (so the agent proceeds) and take the *next* denied call as the real first attempt, or (3)
parse the agent's own restated call out of its final answer as a fallback signal. Don't score
on "first PreToolUse capture" blindly.

### (b) What does the agent do after denial: give up vs. retry?

This is wording-dependent — the second finding worth the whole spike:

| Wording | Behavior | turns used (of 3) |
|---|---|---|
| **Clean-stop** (see below) | Stops after exactly 1 denied call, states what it would have called, ends | 2/3, all 3 queries |
| **Nudge-style** (mirrors current `failTools`' `REPORT_PROBLEM_NUDGE`) | Retries the same tool with different args once, sometimes twice | 3-4/3 — **B3 hit `error_max_turns`** |

Nudge-style wording is the exact text `denyToolsHook()` already uses today
(`"...report it to the Apify team by calling report-problem..."`). It is right for
`failTools` (a targeted, single-tool failure the agent should escalate) but **wrong for
deny-all**: it reads to the model as "try to work around this," so it retries instead of
stopping, and on the WebFetch query it burned all 3 turns re-issuing `ToolSearch` and never
produced a final answer (`resultSubtype: "error_max_turns"`). A deny-all harness needs its
own denial message, not a reuse of the nudge.

**Denial wording that stopped the agent cleanly on all 3 queries** (drop-in for #260):

```
Tool calls are disabled in this evaluation. Do not retry with a different tool or
arguments — report to the user, in your final answer, which tool you would have called and
with what arguments, then stop.
```

### (c) Per-item turns / tokens / duration (maxTurns=3, claude-haiku-4-5)

| run | query | turns | result | duration | cost | prompt/cache/out tokens | # denied calls |
|---|---|---|---|---|---|---|---|
| A1 clean-stop | best TikTok scraper | 2 | success | 5.4s | $0.0089 | in=17 cacheRead=64827 out=457 | 1 |
| A2 clean-stop | rag-web-browser input schema | 2 | success | 6.0s | $0.0084 | in=17 cacheRead=64901 out=375 | 1 |
| A3 clean-stop | fetch example.com | 2 | success | 4.2s | $0.0208 | in=17 cacheRead=57950 out=219 | 1 |
| B1 nudge-style | best TikTok scraper | 3 | success | 7.7s | $0.0193 | in=24 cacheRead=93893 out=525 | 2 |
| B2 nudge-style | rag-web-browser input schema | 3 | success | 7.9s | $0.0127 | in=24 cacheRead=97285 out=502 | 2 |
| B3 nudge-style | fetch example.com | **4** | **error_max_turns** | 3.2s | $0.0152 | in=24 cacheRead=70770 out=292 | 2 |

Clean-stop wording is both cheaper (no retry turn) and deterministic-safe (never hits
`maxTurns` in this sample). At `maxTurns: 3` this leaves 1 full spare turn per item for
clean-stop, so #260 can likely run deny-all at `maxTurns: 2` to fail fast on the (rare) case
where the agent still doesn't stop.

### Sandbox blocker hit and worked around (relevant to CI, not just this spike)

`claude_agent.ts` uses `permissionMode: 'bypassPermissions'` +
`allowDangerouslySkipPermissions: true`. In this sandbox (root user, `IS_SANDBOX=yes`), the
underlying Claude Code CLI **hard-refuses** that combination:

```
[claude-stderr] --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

`IS_SANDBOX=yes` does not override this check. Confirmed by running `claude -p "hi"`
directly (works fine without the flag) vs. via the SDK with `bypassPermissions` (fails
immediately, `SDKMessage` stream never starts, `Error: Claude Code process exited with
code 1`). **Workaround used for this spike:** drop `bypassPermissions` /
`allowDangerouslySkipPermissions` entirely and rely on the `PreToolUse` deny-all hook, which
fires before the permission layer regardless of `permissionMode` — so no prompt is ever
reached for a denied call. Confirmed working for all 6 Q1 runs and both Q3 runs (the
"normal" non-denied item in Q3 needed a `canUseTool: async () => ({behavior: 'allow', ...})`
callback instead, since it has nothing to deny).
**This is a sandbox-specific issue** (root execution), not a change needed in
`claude_agent.ts` for real CI runners that aren't root — but #260 (and anyone else touching
`claude_agent.ts`) should know the failure mode exists, and that a root-run harness
(e.g. some container-based CI, or a Cowork-style environment) needs the hook-only path with
no `bypassPermissions`, or the whole harness dies with an opaque "process exited with code
1" and no application-level context lost. Consider making `assertStdioBinExists()`-style
preflight also probe `--dangerously-skip-permissions` support and fail with a clear message.

---

## Q2 — `--iterations` x Langfuse experiments

**Environment note confirmed:** this Langfuse instance is v4 events_only. The v3
`dataset-run-items` and `datasets/<name>/runs/<runName>` REST endpoints return HTTP 404 with
an explicit deprecation notice pointing at the v4 replacements:

```
GET /api/public/dataset-run-items -> 404
"replacement": "GET /api/public/experiment-items?fromStartTime=<from>&toStartTime=<to>"
GET /api/public/datasets/<name>/runs/<runName> -> 404
"replacement": "GET /api/public/experiments"
GET /api/public/scores -> 404, replacement "GET /api/public/v3/scores"
```

**How `@langfuse/client@5.9.1`'s `experiment.run()` actually behaves:** `ExperimentParams`
has **no `iterations` field** — `data` is a flat array and `task` runs exactly once per
array entry (`ExperimentManager.run()`, batched by `maxConcurrency`). Score attachment is
**per-trace** (`evaluator` results are posted via `score.create({ traceId, observationId,
...ev })`), not per-dataset-run-item — so per-trial scoring does not depend on any
dataset-run linkage succeeding or being unique.

**Probe: repeat each dataset item N times in the `data` array, one `experiment.run()` call.**
Dataset `zz-spike-selection-poc` (2 items, ids `spike/item-1`, `spike/item-2`), fake
no-LLM task returning a distinguishable canned value, `ITERATIONS = 3` -> `data.length = 6`,
single `runName`.

Result: **one experiment, N distinct item-results per dataset item — this is answer "one
experiment with each item executed N times."** No collision, no overwrite, no dedup:

- `result.itemResults.length === 6`, each with its own `traceId` and distinct output
  (`callIndex` 0-5, all six executed).
- `GET /api/public/experiments?fromStartTime=...&toStartTime=...` (after allowing ~5-10s for
  indexing) returns the run with `"itemCount": 6`.
- `GET /api/public/experiment-items?fromStartTime=...&toStartTime=...` returns 6 rows, 3 with
  `experimentItemId: "spike/item-1"` and 3 with `experimentItemId: "spike/item-2"`, each with
  a unique `id` and `traceId` — this is the field to `GROUP BY` for pass@k/pass^k.
- `GET /api/public/v3/scores?name=spike_call_index` returns 6 distinct score rows (values
  0-5), confirming per-trial scores are independently recorded and retrievable.

**Confirmed once with a real agent, 2 items x 2 iterations = 4 real Claude Code calls**
(`spike_q2_iterations_real.ts`, no judge, `maxTurns: 1`, prompt includes "append a random
6-digit number" to make independence checkable): 4 distinct `traceId`s, 4 different random
numbers in the answers (proof these are 4 real, separate model calls, not a cached/deduped
single call), `GET /api/public/experiments` shows `"itemCount": 4` for that run.

### Recommendation for #260's `--iterations N`

1. **Implement it as "repeat each requested item N times in the `data` array passed to one
   `experiment.run()` call,"** not N separate `experiment.run()` calls and not N separate
   CLI invocations. One call keeps everything (agent runs, judge, deny-all captures) under
   one `runName`/experiment, which is what the run-summary gate and the printed run URL
   already assume.
2. **Tag each repeated entry with its iteration index in `metadata`** before flattening
   (e.g. `{ ...item, metadata: { ...item.metadata, iteration: k } }`) so it survives into
   the trace/experiment-item metadata and the judge/evaluator output — `experimentItemId`
   alone (= dataset item id) does not distinguish iteration k from k+1 in the API response;
   only `id`/`traceId` do, and those are opaque. Without an explicit iteration tag,
   `buildRunSummary`-style pass@k math has to infer iteration order from array position or
   timestamp, which is fragile once `maxConcurrency > 1` interleaves start times.
3. **`countPassed`/`pass_rate`-equivalent for pass@k/pass^k:** group `itemResults` by
   `output.id` (already carried per `McpAgentTaskOutput`), then compute per-group
   pass@k = any trial passed, pass^k = all trials passed, over the N-sized group — this can
   be done entirely from the in-process `result.itemResults` the SDK already returns; no
   need to round-trip through the REST API at run time. Use `GET /api/public/experiments` /
   `experiment-items` only for later, out-of-band analysis (e.g. a dashboard), not for the
   exit-code gate.
4. **Do not rely on `GET /api/public/dataset-run-items`, `.../datasets/.../runs/...`, or the
   old `GET /api/public/scores`** — all three are gone on this instance. Use
   `GET /api/public/experiments`, `GET /api/public/experiment-items`, and
   `GET /api/public/v3/scores` if #260 or a future dashboard needs to read results back via
   REST instead of from the SDK's return value.
5. Requested-count accounting (`buildRunSummary`'s `droppedIds`) needs an iteration-aware
   denominator: `requestedIds.length * iterations`, not `requestedIds.length`, or a dropped
   trial silently inflates the apparent pass rate the same way a dropped item does today.

---

## Q3 — mixed deny-all + normal item in one run

**Setup:** `evals/mcp_agent/spike/spike_q3_mixed.ts`, two items run concurrently
(`Promise.all`, mirroring `maxConcurrency > 1`): one with the deny-all `PreToolUse` hook,
one with no hook (real execution, using `canUseTool: async () => ({behavior:'allow', ...})`
in place of the root-blocked `bypassPermissions` — see Q1 sandbox note).

Result: **works exactly as expected, no cross-talk.**

- Deny-all item: `search-actors({keywords:"TikTok"})` captured and denied; agent gave a
  clean "I would have called..." final answer, 2 turns.
- Normal item, same tool, same MCP server, running **concurrently** in the same process:
  `search-actors` executed for real and returned real Store data
  (`clockworks/tiktok-scraper`, 4.8 stars, 369 reviews, 249k users), agent summarized it
  correctly, 2 turns.

Confirms the premise behind #260: hooks are configured per-`query()`-call (i.e. per item's
agent instance, exactly as `claude_agent.ts` already does via
`...(failTools ? { hooks: {...} } : {})`), so a single run/dataset can freely mix
`selectionMode: true` items (deny-all) and ordinary executing items — no global state, no
extra wiring needed beyond conditioning the existing per-item hook construction on a new
item-level flag (e.g. `metadata.selectionMode`), the same way `failTools` already is today.

---

## Recommendations summary for apify/ai-team#260

- Deny-all hook: reuse the `PreToolUse` deny mechanism (`denyToolsHook`-shaped, but denying
  unconditionally rather than checking a `Set`), with **new wording**, not the `failTools`
  `REPORT_PROBLEM_NUDGE` text — see the exact string in Q1. Reusing the nudge text measurably
  causes retries and can exhaust `maxTurns` (one of three sample queries in this spike did).
- Treat `ToolSearch` as a possible false "first call" when Claude Code's built-ins are
  enabled and gated behind tool search; either force `mcp-tools-only` for cases that need a
  clean single measured call, or special-case `ToolSearch` in the capture logic.
- `maxTurns: 2` is probably enough for a well-worded deny-all item (all 3 clean-stop runs in
  this spike finished in exactly 2 turns); keep it low so a mis-behaving item fails fast
  rather than burning budget on retries.
- `--iterations N`: implement as one `experiment.run()` per invocation with the requested
  items repeated N times in `data`, iteration index carried in item metadata, pass@k/pass^k
  computed in-process from `result.itemResults` grouped by item id — see the 5-point list
  above. Update `buildRunSummary`'s denominator to `requestedIds.length * iterations`.
- Root-sandbox note for whoever runs this in a container-based CI/Cowork environment:
  `bypassPermissions` + `allowDangerouslySkipPermissions` is refused by the Claude Code CLI
  when the process runs as root/sudo, `IS_SANDBOX=yes` does not exempt it, and the SDK
  surfaces this as an opaque `Error: Claude Code process exited with code 1` with no message
  unless a `stderr` callback is wired up. `claude_agent.ts` does not currently pass one. Not
  a blocker for real (non-root) CI runners, but worth either (a) adding a `stderr` handler so
  a future root-run failure is diagnosable instead of a bare exit code, or (b) noting in
  `assertStdioBinExists()`'s neighborhood that root execution is unsupported for the
  `bypassPermissions` path.

## Notes for #259 (item schema) and #240

- #259 (item schema): whatever field selection-mode uses to flag an item
  (e.g. `metadata.selectionMode: true`) should be validated the same way `failTools` is
  today — `McpAgentMetadataValidator` is a `z.strictObject`, so a new optional boolean field
  needs to be added there or a bad/misspelled flag will be silently stripped and the item
  will just run normally instead of failing loudly.
- #240: not directly probed in this spike (out of scope), but the iteration-index tagging
  recommended for #260 (item 2 above) is the same kind of per-trial metadata #240 would
  presumably also want if it does anything with individual trial results rather than
  aggregate pass_rate — worth checking its data needs against `experimentItemId` /
  `traceId` granularity before it's implemented, since those are the only stable per-trial
  keys the Langfuse v4 API exposes.

---

## Langfuse hygiene

Created dataset `zz-spike-selection-poc` (2 items, ids `spike/item-1`, `spike/item-2`) and
two experiment runs against it (`spike-iter-probe-*`, `spike-iter-probe-real-*`). No
existing dataset was touched. **This dataset and its runs can be archived/deleted** — it
exists only for this spike.

---

## Environment / commands used

- `pnpm run build` (once, to produce `dist/stdio.js`).
- All spike scripts run via `node_modules/.bin/tsx evals/mcp_agent/spike/<script>.ts`
  (`npx tsx` is blocked by this repo's `devEngines.packageManager` pin for non-pnpm
  invocations, so the local binary was called directly).
- Agent auth: `--subscription`-equivalent (`delete process.env.ANTHROPIC_API_KEY` before
  calling `query()`) — `ANTHROPIC_API_KEY` was not present in this environment; the local
  Claude Code login was used for every agent call in this spike.
- No unit tests, no lint/type-check run against the spike scripts (per task instructions —
  this is throwaway code, not part of the codebase).

## Files from this spike (uncommitted, untracked)

```
evals/mcp_agent/spike/spike_q1_deny_all.ts
evals/mcp_agent/spike/spike_q2_iterations.ts
evals/mcp_agent/spike/spike_q2_iterations_real.ts
evals/mcp_agent/spike/spike_q3_mixed.ts
```

`git diff --stat` (staged with `git add -N` only to produce this, then unstaged again —
nothing is committed or staged in the actual working tree):

```
 evals/mcp_agent/spike/spike_q1_deny_all.ts        | 197 ++++++++++++++++++++++
 evals/mcp_agent/spike/spike_q2_iterations.ts      | 120 +++++++++++++
 evals/mcp_agent/spike/spike_q2_iterations_real.ts | 100 +++++++++++
 evals/mcp_agent/spike/spike_q3_mixed.ts           | 104 ++++++++++++
 4 files changed, 521 insertions(+)
```

`git status --porcelain` at the end of this spike: `?? evals/mcp_agent/spike/` (untracked
directory only — nothing staged, nothing committed).
