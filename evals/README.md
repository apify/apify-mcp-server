# MCP agent evaluation system

Tests Claude Code against Apify MCP tools. `tool-call` items check the first attempted call without executing it; `agent` items run to completion and use an LLM judge. Runs are stored in [Langfuse](https://langfuse.apify.dev), project `MCP Workflow`.

## The flow

```
dataset -> experiment -> agent run -> scores
```

1. **Dataset.** Cases live in `mcp-server-evals-pr` or `mcp-server-evals-merge`; a run reads the selected dataset and does not write to it.
2. **Experiment.** Active items matching `--id` and `--category` run concurrently. `--iterations N` repeats each item in the same experiment.
3. **Agent.** Each item starts a fresh MCP server. Agent items receive an LLM judgment; tool-call items record the first denied call.
4. **Scores.** Agent items gate on `mcp_agent_judge` and unexpected `tool_errors`; tool-call items gate on `first_tool_match`. The run reports `pass_rate`.

---

## Quick start

**Prerequisites:**
- Node.js installed
- Apify account with API token
- Anthropic API key (agent) — or a local Claude Code login with `--subscription`
- OpenRouter API key (judge) — or a local Claude Code login with `--claude-judge`
- Langfuse project (public + secret key)

**Run evaluations:**
```bash
# 1. Set environment variables (a .env file at the repo root is loaded automatically)
export APIFY_TOKEN="your_apify_token"
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENROUTER_API_KEY="your_openrouter_key"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://langfuse.apify.dev"

# 2. Build the MCP server
pnpm run build

# 3. Run tests
pnpm run evals:mcp-agent
```

Run `pnpm run evals:mcp-agent --help` for all options. `--dataset` selects the dataset, `--id` and `--category` filter it, `--concurrency` controls parallel agents, and `--iterations` repeats cases. `--pass-threshold` gates the aggregate pass rate (default `0.9`); `--tool-timeout` caps each MCP tool call (default 60 s); `--mcp-tools-only` removes Claude Code built-ins. Use `--subscription` for local Claude Code credentials and `--claude-judge` to avoid an OpenRouter key.

### Two datasets: kind, id scheme, and expectedErrors

Each CI tier has a dataset: the default `mcp-server-evals-pr` holds `tool-call` items and `mcp-server-evals-merge` holds `agent` items. Their IDs are `pr/<tool>/<slug>` and `merge/<family>/<slug>`.

- `kind`: what the item asserts.
  - `"tool-call"`: only the first tool call the agent attempts, by name and optionally
    arguments. No judge, nothing executes - see "Tool-call mode" below.
  - `"agent"`: the agent runs to completion and an LLM judge scores the result against the
    item's `reference`/`expectedOutput`.
- `expectedErrors` (optional, `kind: "agent"` only): tool names allowed to fail on this item
  without failing the zero-tool-error gate below. The gate exempts only the named tools; any
  other tool's failure still fails the item.

The ID family is separate from the fine-grained `metadata.category` used by `--category`. Filter a family with `--id`, for example `--id '^merge/tasks/'`.

Agent items fail on any unexpected tool error, even with a passing judgment. `expectedErrors` exempts only its listed server tools; built-ins and injected `failTools` do not count.

Read-only probes count too, which is the point: the gate is what keeps the tool descriptions strong
enough that an agent resolves a loose Actor reference with `search-actors` instead of guessing a slug.

One caveat when reading a failure: a transient agent failure is retried once, and the retry replays the
whole prompt, so a fixed-name create case can hit a name collision the second time round and fail the
gate on it. The console prints a `retrying once` line for those items.

The tasks family (`merge/tasks/*`, 10 items: 7 proper + 3 with `expectedErrors`) uses fixed `eval-*`
task names, which are unique per account, and the create cases never clean up — so every run
leaves debris that collides on the next one. Run `pnpm run evals:mcp-agent:tasks-fixtures`
before every run: it deletes leftover `eval-*` tasks and seeds the permanent fixture task. It
deletes on whatever account `APIFY_TOKEN` points at and prints that account first; pass
`--dry-run` to see what it would delete before it does. Three cases (`publish-discovery`,
`publish-medium-1`, `chain-hard-1`) publish task examples on `apify/normal-mode-test-actor`, and
publishing needs write access to the Actor, so only those three depend on an account that has it.

Publishing requires four things, not the three `publish-actor-task` lists: the task's own `description`,
plus `publicConfig.inputSchemaFields`, `publicConfig.datasetView` and `publicConfig.seoDescription`
(all probed against the API). The API reports the missing ones **non-exhaustively** — which is why
`merge/tasks/publish-discovery` budgets turns for several fix-and-retry rounds rather than one, and why
`merge/tasks/publish-medium-1` currently fails: it spells out every requirement the tool documents, so
the agent has no reason to set a `description` and eats one `cannot-publish-actor-task` error fixing it.

`merge/tasks/chain-hard-1` names no tool or feature: the agent has to map "rerun with one click" to a
saved task, "put it up on the Actor's public page" to publishing, and "take it down" to unpublishing.
The input is fully specified, so the flow should complete without a single failed tool call.

It is **uncalibrated**. It previously referred to its target Actor loosely, and `claude-haiku-4-5` failed
it about 3 runs in 8 by constructing a plausible slug instead of resolving the real one with
`search-actors` — the judge passed those runs and only the zero-error gate caught them. Naming the
Actor exactly retired that failure mode along with the 5/8 ratio, so re-measure before reading a red
run as a regression. The lesson that outlived it: treat a shift in the ratio as the signal rather than a
single red run, and blame a tool description only after checking the case still passes on Sonnet.

The schedules family (`merge/schedules/*`, 10 items: 7 proper + 3 with `expectedErrors`) covers the
schedule tools: create for a task and for an Actor, cron and time-zone translation from user language,
pausing, adding an action (an update replaces the whole list), deleting, a name collision, and a
not-found read. It uses fixed `eval-sched-*` names plus two permanent, disabled fixture schedules that
run the `eval-sum-nightly` task fixture: `eval-nightly-sum`, which the pure read cases assert on and no
case may modify, and `eval-sched-target`, which the add-an-action case edits. They are separate because
items run concurrently against one account — a case that edits the schedule a read case asserts on makes
that read pass or fail depending on which item finished first. For the same reason,
`merge/schedules/add-action-medium-1` is not safe under `--iterations N` above 1 unless you also pass
`--concurrency 1`: its trials all edit `eval-sched-target`, so a trial can read the schedule after
another trial has already added to it and get judged against a starting state that is no longer there.
CI runs each item once, so this affects local repeat runs only. Run
`pnpm run evals:mcp-agent:tasks-fixtures && pnpm run evals:mcp-agent:schedules-fixtures` before every
run: the second script deletes leftover `eval-*` schedules and resets the fixture (disabled, `0 3 * * *`
UTC, one task action), since an eval agent may have enabled it or replaced its actions. The fixture stays
disabled on purpose; an enabled one would start a run on the eval account every night.

Run `evals:mcp-agent:schedules-fixtures` again **after** a run as well. The create cases leave enabled
schedules behind, and an enabled schedule keeps firing on the eval account until something deletes it —
seeding at the start of the next run is too late. CI does this in a `Tear down schedule fixtures` step
guarded by `always()`, so a failed or cancelled run still cleans up.

The web-fetch family (`merge/web-fetch/*`, 11 items: 8 proper + 3 with `expectedErrors`) covers the
`apify/web-fetch` default Actor tool: fetching, output formats, HTTP status reporting, tool
selection among the defaults, and multi-fetch chains. They create no named account state, so
there is no fixtures script. The cases fetch live third-party pages (example.com, rfc-editor.org,
httpbin.org), so a failure can also mean the page changed or the host is down — check the target
before blaming the tool (httpbin outages are common; the status/format references tolerate a
truthfully reported upstream error). Platform behavior the cases are built on (probed 2026-08-20):
an HTTP 4xx/5xx from the target page still ends the run SUCCEEDED with `fetch.httpStatusCode` in
the item; an unreachable domain either fails the run ("Could not connect…") or succeeds with an
empty 502 item, depending on unblocker routing; JSON content fails `text`/`markdown` formats with a
status message telling the agent to add `raw`; `ftp://` fails with "Unsupported URL protocol".

The web-selection family (`merge/web-selection/*`, 9 items: 7 proper + 2 with `expectedErrors`) covers
the clash between the default web tools: web search by query (`apify/rag-web-browser`) vs
single-URL verbatim fetch (`apify/web-fetch`) vs Actor discovery (`search-actors`) vs a
specialized Actor for structured platform data, plus rag→web-fetch escalation when a page
blocks rag's crawler (reddit) and coexistence with a client's built-in, summarizing fetch. Also
stateless — no fixtures script. Known residual (2026-08-21): on `merge/web-fetch/unsupported-protocol`,
claude-haiku-4-5 reproducibly rewrites the ftp:// URL to https:// without telling the user,
despite the scheme note in both the tool description and the `url` parameter — a model-level
limit the case documents on purpose; stronger models pass.

### Tool-call mode

A `kind: "tool-call"` item records the first attempted call and its arguments. A `PreToolUse` hook denies every call with `TOOL_CALL_DENY_REASON` (`runner/tool_call_mode.ts`), so no tool executes and the agent stops after reporting what it would have called. Tool-call items have a fixed `maxTurns` of 2.

The scorer skips Claude Code's `ToolSearch` meta-tool. Set `mcpToolsOnly: true` (or `--mcp-tools-only`) to remove built-ins when a case must compare MCP tools only.

Scoring (`first_tool_match`, 1 or 0):
- The tool name must be in `expectedTools`.
- For optional `expectedArgs`, each listed key must match. Other keys are ignored.

Denied calls remain ERROR spans in Langfuse; they do not affect tool-call scoring.

### Permission path, and running under root

The harness uses `canUseTool` instead of root-incompatible permission bypass flags. The deny-all hook still runs first. On a subprocess failure, inspect `[claude-stderr]` output.

### `--iterations` on stateful agent items

`--iterations N` repeats each item in one experiment and reports `pass@k` and `pass^k`. It is safe for tool-call and stateless agent items. Stateful cases such as `merge/tasks/*` can collide with their own leftovers.

**Exit codes:**
- `0` = the aggregate pass rate (passed trials / requested trials) meets `--pass-threshold`
  (default `0.9`; pass `1.0` to require every trial) ✅
- `1` = the pass rate falls short of the threshold, or setup failed ❌

**Editing test cases:** edit the items in the Langfuse UI. The next run picks them up; there is nothing to commit
in the dataset itself. Use `pnpm run evals:mcp-agent:export-dataset` for an optional local snapshot; exports are gitignored.

---

## Critical design decisions

### 1. The Langfuse datasets are the source of truth

**Decision:** A run reads its test cases from a Langfuse dataset and never writes to it. Langfuse is the only copy: `evals:mcp-agent:export-dataset` dumps the active items to `dataset_snapshot_<dataset>.json` for reading them outside the UI (it defaults to `mcp-server-evals-pr` too, and the file name carries the dataset name), but there is no importer and nothing reads the snapshot at runtime.

**Why:**
- A UI edit takes effect on the next run. An earlier version synced a local file into the dataset first, which silently overwrote UI edits
- `experiment.run` only records a comparable **dataset run** (with a shareable run URL) when given real dataset items
- A snapshot is a second copy that no code reads and nothing keeps in sync automatically, so snapshots are gitignored

Every active item is validated when the dataset is fetched, so a bad UI edit fails the run before any LLM spend. Archived items are skipped, which is how a case is retired.

**Trade-off:** the dataset is mutable, so a run is only reproducible against the dataset as it was. Langfuse keeps item versions.

**Location:** `langfuse/dataset.ts`, `runner/run.ts`, `scripts/export_dataset.ts`

### 2. MCP server process isolation per test

**Decision:** Each test gets a fresh MCP server instance, spawned by that test's agent, so MCP session and in-process state do not carry between tests. Persistent Apify resources remain shared and fixture scripts must clean them up.

**Trade-off:** ~20-30% slower (1-2s spawn overhead per test) for process isolation.

**Location:** `agent/claude_agent.ts`

### 3. The agent is Claude Code, not a hand-rolled loop

**Decision:** Run each case through the Claude Agent SDK's `query()` with the `claude_code` system-prompt and tool presets, and register the Apify MCP server alongside them — so the eval measures what a real client does with our tool descriptions, not a custom harness. See `agent/claude_agent.ts` for the run settings (`canUseTool`, `settingSources`, `strictMcpConfig`, `alwaysLoad`) and why each one is set that way.

**Trade-off:** the harness is a moving target - a Claude Code release can shift results, so `agentSdkVersion` is recorded in the run metadata.

**Location:** `agent/claude_agent.ts`, `agent/conversation_adapter.ts`

### 4. Pass rate gated on the requested trial count, threshold-configurable

**Decision:** Exit code 0 while `passedTrials / requestedTrials >= --pass-threshold` (default `0.9`,
rationale in `runner/run.ts`). `requestedTrials = requestedIds.length * iterations`.

**Why:**
- A calibrated suite gates on an aggregate rate instead of one flaky item blocking every PR; `--pass-threshold 1.0` restores strict all-pass
- The trial count matters as much as the scores: the Langfuse SDK drops an item whose task throws, so gating on the results it returns would report `7/7 passed` on a run where three trials never executed

Harness failures (MCP spawn, OpenRouter, judge) are therefore left to throw rather than being converted into a `FAIL` verdict. A broken harness shows up as a shortfall, not as a failing eval.

**Location:** `runner/experiment.ts` (`buildRunSummary`, `resolveExitCode`)

### 5. Judge sees tool calls, not results

**Decision:** Judge sees tool calls with arguments and agent responses, but NOT raw tool results — see `formatConversationForJudge()` in `judge/judge.ts` for why.

**Judge input format:**
```
USER: Find actors for Google Maps
AGENT: [Called tool: search-actors with args: {"keywords":"google maps","limit":5}]
AGENT: I found 5 actors: 1. Google Maps Scraper... 2. ...
```

**Location:** `judge/judge.ts`

### 6. Judge client shared, agent isolated

**Decision:** One judge LLM client shared across tests; the agent and its MCP server are per test.

**Why:**
- The judge client is stateless (OpenRouter/OpenAI SDK), so sharing it saves initialization overhead with no contamination risk
- The agent holds conversation and Apify state, so it cannot be shared

**Location:** `runner/run.ts`

### 7. Agent vs judge models

**Agent:** `claude-haiku-4-5` on the Anthropic API (fast; a weaker model is a more sensitive probe of tool descriptions)<br>
**Judge:** `deepseek/deepseek-v4-flash` on OpenRouter (strong reasoning)

Separation allows independent optimization for speed vs evaluation quality.

**Location:** `config.ts`

### 8. The SDK message stream is folded back into the old conversation shape

**Decision:** `agent/conversation_adapter.ts` rebuilds `ConversationHistory` from the SDK's message stream instead of the judge reading SDK messages.

**Why:**
- The judge, its input format, and the scores stay unchanged, so verdicts remain comparable with earlier experiments
- `ConversationHistory` carries only what the judge and the scores read; tool results and metrics live on `ToolInvocation` and `ConversationMetrics`
- MCP tool names are stripped of their `mcp__apify__` prefix, so the judge sees `search-actors` as before
- Subagent messages (via the `Task` tool) are excluded, so the transcript reflects the main agent
- Cached prompt tokens are counted into `total_tokens`; the API reports them separately and a cached run would otherwise look nearly free. The trace's generation splits them out (`input`, `cache_read_input_tokens`, `cache_creation_input_tokens`): the SDK reports usage for the whole run, so a multi-turn run re-reads the cached system prompt and tool definitions every turn and the total is mostly cache traffic

**Location:** `agent/conversation_adapter.ts`

### 9. The agent's conversation is traced by hand

**Decision:** After each agent run, `langfuse/observations.ts` emits the item's span tree from the adapted SDK stream; the selected judge client traces the judge call itself. See those files for why each part of the tree (agent span, tool spans, generation windowing) is shaped the way it is.

```
experiment-item-run     Langfuse SDK, holds the scores
|- agent                the prompt in, the final answer out
|  |- <agent model>     generation: the run's aggregate tokens and cost, windowed to the last turn
|  |- <tool name>       one span per tool call: arguments in, result out
|- <judge model>        generation, emitted by the active judge client
```

**Trade-off:** the tree is emitted after the fact, so a crashed run leaves no spans, and the agent's individual model turns are not separate generations.

**Location:** `langfuse/observations.ts`, `agent/claude_agent.ts`, `judge/openrouter_client.ts`, `judge/claude_client.ts`

## System components

### Core files

- `config.ts` - Models and the MCP tool-name prefix, shared across responsibilities
- `environment.ts` - Env var sanitization and missing-var reporting
- `runner/run.ts` - Main CLI entry, runner defaults
- `runner/experiment.ts` - Experiment task (agent + tool-call dispatch), `EVALUATORS`, run summary, exit gate
- `runner/filters.ts` - Test case filtering by category and id
- `runner/tool_call_mode.ts` - Tool-call-mode scoring: the deny wording, `ToolSearch` skip, `first_tool_match` name/args matching
- `agent/claude_agent.ts` - The agent under test: Claude Agent SDK options, MCP server registration, failure injection, the tool-call-mode deny-all hook, `canUseTool`, stderr forwarding
- `agent/conversation_adapter.ts` - Folds the SDK message stream into `ConversationHistory`, tool spans, and metrics
- `judge/judge.ts` - Judge evaluation and `JUDGE_PROMPT_TEMPLATE`
- `judge/client.ts` - The `JudgeClient` contract, response and usage types
- `judge/openrouter_client.ts` - OpenRouter wrapper (judge), traced as a Langfuse generation
- `judge/claude_client.ts` - Judge backed by the Claude Agent SDK (`--claude-judge`), for runs without an OpenRouter key
- `langfuse/dataset.ts` - Test case schema, dataset item mapping and validation, dataset fetch
- `langfuse/observations.ts` - Builds and emits the item's span tree (agent, usage, tool calls)
- `langfuse/tracing.ts` - OpenTelemetry span processor init/shutdown
- `scripts/export_dataset.ts` - Snapshot CLI entry (`pnpm run evals:mcp-agent:export-dataset`)
- `scripts/tasks_fixtures.ts` - Task-suite fixture CLI entry (`pnpm run evals:mcp-agent:tasks-fixtures`)
- `scripts/schedules_fixtures.ts` - Schedule-suite fixture CLI entry (`pnpm run evals:mcp-agent:schedules-fixtures`)
- `dataset_snapshot_<dataset>.json` - Local export of a dataset, not read at runtime and gitignored

## Configuration

### Environment variables (required)

```bash
export APIFY_TOKEN="your_apify_token"           # Get from https://console.apify.com/account/integrations
export ANTHROPIC_API_KEY="sk-ant-..."           # Agent, get from https://console.anthropic.com/settings/keys
export OPENROUTER_API_KEY="your_openrouter_key" # Judge, get from https://openrouter.ai/keys
export LANGFUSE_PUBLIC_KEY="pk-lf-..."          # Langfuse project settings
export LANGFUSE_SECRET_KEY="sk-lf-..."          # Langfuse project settings
export LANGFUSE_BASE_URL="https://langfuse.apify.dev"  # self-hosted instance
```

Both entry points fail fast (before any test runs) listing every missing variable at once, and sanitize these values in place first, because the Langfuse SDK reads `process.env` directly and a secret with a trailing newline dies inside `node:http` instead. They can also be set in a `.env` file at the repo root.

### Results in Langfuse

Results are recorded in Langfuse, not to a local file. Each run:

- **Reads the dataset** `mcp-server-evals-pr` (`--dataset mcp-server-evals-merge` for the merge set, or any other Langfuse dataset) and matches its active items against `--id`/`--category`. For a variant set of cases, clone the dataset in the UI and pass `--dataset`; a run stays recorded against the dataset it used.
- **Runs an experiment** named `<git-branch>-<agent-model>-<timestamp>`, with metadata `{ agentModel, judgeModel, toolTimeout, mcpToolsOnly, agentSdkVersion, agentAuth, iterations, passThreshold }`. With `--iterations N > 1`, each selected item appears N times in the same experiment, tagged `metadata.iteration` (1-based) - still one Langfuse **dataset run**, whose URL the console prints.
- **Traces** every item as one trace. Its root output is the judge verdict (agent items) or the first-attempted-call comment (tool-call items) plus the agent's narration, thinking, and tool names; nested under it are an `agent` span (prompt in, final answer out), a generation carrying the run's tokens and cost, one span per tool call (arguments in, result out, `ERROR` when the call failed or was denied), and - agent items only - a generation for the judge call. See design decision 9.
- **Scores** each agent item: `mcp_agent_judge` (`1` on a PASS verdict, comment = judge reason) and `tool_errors` (count of unexpected failed tool calls, comment lists every failure with expected ones marked, `0` on a clean item) together form the gate, and `total_tokens` is the agent tokens billed (omitted when the provider reported no usage so an unmeasured run cannot look like a free one; an item whose agent run was retried reports only the second attempt). Each tool-call item scores `first_tool_match` alone (`1`/`0`, comment names the captured call and the verdict).
- **Scores the run** with `pass_rate`: passed trials over requested trials (`requestedIds.length * iterations`), so runs stay comparable even when trials were dropped.

### Concurrency

`--concurrency` maps to the SDK's `maxConcurrency`, which runs **sequential batches** of that size rather than a rolling window: one slow test stalls the rest of its batch.

### Test case format

A test case is a dataset item: `input.query`, `expectedOutput`, and the rest in `metadata`. The id is
`pr/<tool>/<slug>` or `merge/<family>/<slug>` (see "Two datasets: kind, id scheme, and expectedErrors"
above). The snapshot holds the same fields flattened, one object per case, in this fixed key order:

```json
[
  {
    "id": "merge/tasks/create-explicit-1",
    "category": "create",
    "kind": "agent",
    "query": "User prompt for agent",
    "reference": "What agent must do to pass",
    "maxTurns": 10,
    "tools": ["actors", "docs"]
  },
  {
    "id": "merge/tasks/get-not-found",
    "category": "get",
    "kind": "agent",
    "query": "What Actor does my task eval-video-digest run?",
    "reference": "PASS if get-actor-task reports the task does not exist and the agent says so.",
    "expectedErrors": ["get-actor-task"]
  },
  {
    "id": "pr/fetch-actor-details/input-schema",
    "category": "fetch-actor-details",
    "kind": "tool-call",
    "query": "Show me the input schema for apify/rag-web-browser",
    "expectedTools": ["fetch-actor-details"],
    "expectedArgs": { "actor": "apify/rag-web-browser" }
  }
]
```

**Required fields:**
- `id` - Unique identifier, `pr/<tool>/<slug>` or `merge/<family>/<slug>`
- `category` - For `--category` filtering (fine-grained, e.g. `create`, `get`, `search-actors` — not the same as the id's coarse family segment)
- `kind` - `"tool-call"` (asserts only the first tool call the agent attempts, by name and optionally arguments; no judge, nothing executes) or `"agent"` (the agent runs to completion and an LLM judge scores the result against `reference`)
- `query` - User request
- `reference` (`expectedOutput` in the dataset) - Success criteria for the judge. Required for `kind: "agent"`; not accepted for `kind: "tool-call"` (nothing executes, so there's nothing to judge)

**Optional:**
- `expectedTools` - `kind: "tool-call"` only, required for that kind: tool names the first attempted (non-`ToolSearch`) call must match
- `expectedArgs` - `kind: "tool-call"` only: a flat object; every key in it must deep-equal the same key of the captured call's arguments, keys not listed are ignored. Omit for a name-only check
- `expectedErrors` - `kind: "agent"` only: tool names allowed to fail on this item without failing the zero-tool-error gate (see "Tool-call mode" above and the "Two datasets" section). Not accepted on `kind: "tool-call"`
- `maxTurns` - `kind: "agent"` only: override the default (10). Not accepted on `kind: "tool-call"`, which is fixed at 2
- `tools` - List of tools to enable for this test (e.g., `["actors", "docs", "apify/rag-web-browser"]`). If omitted, all default tools are enabled. Passed to MCP server as `--tools` argument.
- `mcpToolsOnly` - Force MCP-tools-only for this item, dropping Claude Code's built-ins (OR-ed with the run-wide `--mcp-tools-only`). Useful on a tool-call item that must isolate MCP-vs-MCP tool choice
- `failTools` - `kind: "agent"` only: tool names the harness force-fails before they reach the server (e.g. `["call-actor"]`), with a message carrying the real `report-problem` nudge. Use it to deterministically produce a nudge-eligible failure that the live server + API cannot reproduce on demand, e.g. to test that the agent proactively calls `report-problem` after one. Injected as a `PreToolUse` deny (the same hook mechanism the tool-call-mode deny-all uses, with different wording), so the agent sees a refused call rather than an `INTERNAL_ERROR` tool result. See `agent/claude_agent.ts`. Not accepted on `kind: "tool-call"`.

## Common issues

### Tests interfere with each other
**Symptom:** Test 2 fails after Test 1, passes alone.<br>
**Solution:** ✅ Isolated agent + MCP instance per test.

### Agent claims the Apify MCP server is "still connecting" (remote/sandboxed environments)
**Symptom:** A transcript shows the agent reading a system notice that MCP servers are still
connecting, concluding the Apify tools are unavailable, and falling back to a built-in tool.<br>
**Cause:** In sandboxed remote Claude Code environments the MCP handshake can race the first
turn; a fast model sometimes doesn't wait or retry. On a local machine the CLI completes the
handshake before the first turn, so this doesn't reproduce there.<br>
**Solution:** Retry the item once; a repeat failure on a local machine is real.

### Agent answers from memory or shells out instead of using our tools
**Symptom:** The judge reports the agent used `Bash`, `WebSearch`, or its own knowledge.<br>
**Solutions:**
- Check the server is registered with `alwaysLoad: true`, or its tools sit behind tool search
- Run with `--mcp-tools-only` to confirm the case passes when the built-ins are gone

### Judge too strict/lenient
**Symptom:** Incorrect verdicts.<br>
**Solution:** Tune `JUDGE_PROMPT_TEMPLATE` in `judge/judge.ts`.

### Tests timeout (hit maxTurns)
**Symptom:** Conversations don't complete.
**Solutions:**
- Check tool results are helpful
- Reduce `maxTurns` to fail faster
- Try a different agent model

## CI

CI runs two Langfuse tiers:

- `pr`: `mcp-server-evals-pr` tool-call items. It fails below 0.9, based on a 0.93 local floor.
- `merge`: `mcp-server-evals-merge` agent items. It fails below 0.6, based on a 0.73 local floor; nine of 60 items fail consistently, and three publish cases (`tasks/publish-discovery`, `tasks/publish-medium-1`, `tasks/chain-hard-1`) fail unless `APIFY_TOKEN` can write to their target Actor.

`_evaluations.yaml` runs a tier for three triggers: non-draft, same-repo PRs on relevant paths; the `validated` label; and every push to `master` touching the same paths (both tiers). The PR trigger intentionally excludes `synchronize` to control cost, so it is not a required check. The master workflow is separate because evals must not hold the release lock.

Fork PRs cannot run evals because GitHub withholds repository secrets. Push the branch into this repository to evaluate fork changes.

Both tiers need `ANTHROPIC_API_KEY`, the three `LANGFUSE_*` keys, and `APIFY_TOKEN` (mapped from the `APIFY_TEST_USER_API_TOKEN` repository secret). `OPENROUTER_API_KEY` is required only by the merge judge. The three publish cases also need write access to `apify/normal-mode-test-actor`.

The pr tier has run on a hosted runner in 4m31s, inside its ten-minute target; the merge tier's threshold and 90-minute timeout are still provisional. Transient network and provider failures retry once; the handshake race above does not, because it produces a wrong answer rather than an error.

## Writing tool descriptions

Tool descriptions are the main lever on eval scores, but not the only one — some failures
are model-level limits, not description bugs.

### Tool definitions (Anthropic guidelines)

- **Be extremely detailed.** Explain what the tool does, when it should and should not be
  used, what each parameter means, and any caveats — including what the tool does *not*
  return when its name is misleading. Aim for 3-4 sentences, more for complex tools.
- **Prioritize description over examples.** Add examples only after the description is
  complete.

### Metadata for OpenAI models

- Name — pair the domain with the action (`calendar.create_event`).
- Description — start with "Use this when..." and call out disallowed cases ("Do not use
  for reminders").
- Parameter docs — describe each argument, include examples, use enums for constrained
  values.
- Annotate `readOnlyHint: true` on tools that never mutate state so clients can skip the
  confirmation prompt.

### Tool description vs parameter description

Based on [Cursor Agent Tools v1.0](https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/refs/heads/main/Cursor%20Prompts/Agent%20Tools%20v1.0.json),
[Lovable Agent Tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Lovable/Agent%20Tools.json)
and [Claude Code Tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Claude%20Code/claude-code-tools.json):

**Tool description**: what the tool does, when to use it, key limitations, high-level
behavior.

**Parameter description**: what each parameter does, input constraints, per-parameter
examples and guidance.

Keep both concise but comprehensive, use language that matches user intent, and state
operational limits explicitly.

### Improving a failing tool

1. **Start with the `pr` tier.** Its tool-call items are unjudged — the item records the
   first attempted call and nothing executes — so a failure is a plain wrong-tool or
   wrong-args signal, easier to read than a `merge`-tier judge score.
2. **Read the trace for what that tier records.** On a `pr` item, read the
   first-attempted-call comment: every tool span there is an ERROR by design (the deny-all
   hook), so red spans say nothing about pass or fail. On a `merge` item, read the judge's
   reasoning. A run that crashed before the tree was emitted leaves no spans — only the
   SDK's item-run root.
3. **Confirm it is a regression** before touching a description — see
   [Two datasets](#two-datasets-kind-id-scheme-and-expectederrors) for why a single failing
   run is not the signal.
4. **Change one tool at a time.** Simultaneous edits are untraceable.
5. **Iterate on a subset**, then re-run the full dataset — fixing one case often breaks
   another.
6. **Never let an LLM rewrite tool descriptions automatically.** Make the edit manually
   from your own reading of the failure; automated rewrites usually make it worse.

For runtime symptoms rather than description problems — agent shelling out, judge too
strict, timeouts — see [Common issues](#common-issues).

## References

- [MCP Protocol Spec](https://modelcontextprotocol.io/)
- [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)
- [Apify API](https://docs.apify.com/api/v2)
- [OpenRouter](https://openrouter.ai/)
- [Example of a good tool description](https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use#example-of-a-good-tool-description)
- [OpenAI optimize metadata](https://developers.openai.com/apps-sdk/guides/optimize-metadata)
