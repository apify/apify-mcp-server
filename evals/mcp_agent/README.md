# MCP agent evaluation system

Tests Claude Code driving Apify MCP tools, through two tiers: a fast, deterministic tool-pick check (`kind: "selection"`) and a full multi-turn conversation evaluated by an LLM judge (`kind: "agent"`). The agent under test is the real Claude Code harness, driven headlessly through the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), so a run exercises the server the way a Claude Code user does. Results (traces, scores, dataset, experiment runs) are recorded in **Langfuse**: the self-hosted instance at [langfuse.apify.dev](https://langfuse.apify.dev), project `MCP Workflow`.

## The flow

```
dataset (Langfuse) -> experiment run -> per item: agent conversation -> judge (agent items only) -> scores
```

1. **Dataset.** Test cases live in the Langfuse dataset `mcp-server-evals` and are edited in its UI. A run reads them and never writes back.
2. **Experiment.** The run executes the active items matching `--id`/`--category`/`--tier` as one Langfuse experiment, `--concurrency` items at a time; `--iterations N` repeats each selected item N times within that one experiment.
3. **Conversation.** Each item runs a Claude Code agent (Claude Agent SDK) that spawns its own fresh Apify MCP server. A `kind: "agent"` item drives it to a final answer; a `kind: "selection"` item denies every tool call before it executes and records only the first attempted one.
4. **Judge.** `kind: "agent"` only: an LLM judge scores the finished conversation against the item's `expectedOutput`. `kind: "selection"` items are scored deterministically instead - see below.
5. **Scores.** Agent items: `mcp_agent_judge` (the judge verdict) and `tool_errors` (unexpected failed server calls) form the gate, plus `total_tokens`. Selection items: `first_tool_match` alone is the gate. The run also gets `pass_rate` (passed trials / requested trials). The console prints failures, `pass@k`/`pass^k` with `--iterations`, and the run URL; per-item detail is in Langfuse.

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

Run `pnpm run evals:mcp-agent --help` for the full option list. `--category` and `--id` narrow the run, `--tier pr|full` keeps only items whose `tier` array contains that value (absent = all tiers), `--dataset` picks another Langfuse dataset, `--concurrency` defaults to 8 (each item spawns its own agent and MCP server, so higher values use more resources), `--iterations N` (default 1) repeats each selected item N times within the same run and prints `pass@k`/`pass^k`, `--pass-threshold` (default `1.0`) gates the exit code on the aggregate pass rate instead of requiring every trial to pass, `--tool-timeout` defaults to 60s (raise it for Actor calls that scrape a lot of data), `--mcp-tools-only` drops Claude Code's built-in tools so only the server's tools remain, `--subscription` runs the agent on the local Claude Code login instead of `ANTHROPIC_API_KEY` (the key is removed from the process environment so the run cannot bill the API), and `--claude-judge` runs the judge on the Claude Agent SDK too, so no `OPENROUTER_API_KEY` is needed (`--judge-model` then takes an Anthropic model ID, default `claude-sonnet-5`; note a Claude judge scoring a Claude agent can be self-lenient, so prefer the OpenRouter judge for comparable numbers). With `--subscription --claude-judge` a run needs only `APIFY_TOKEN` and the Langfuse keys.

### One dataset: kind, tier, id scheme, and expectedErrors

Every item is `mcp-server-evals`, no per-family or per-suite dataset split. Each item's
`metadata` says what it is and when it runs:

- `kind`: `"agent"` (a multi-turn conversation, judged) or `"selection"` (a single-turn tool
  pick, no judge, nothing executes - see "Selection mode" below).
- `tier`: `["pr"]`, `["full"]`, or both — which run(s) include the item (`--tier` filters on
  this). Everything migrated from the old per-family datasets is `tier: ["full"]`; new
  `pr`-tier items are `kind: "selection"`, so a PR gate can run in seconds, not minutes.
- `expectedErrors` (optional, `kind: "agent"` only): tool names allowed to fail on this item
  without failing the zero-tool-error gate below. The gate exempts only the named tools; any
  other tool's failure still fails the item.

Item ids are `<category>/<slug>` (e.g. `tasks/create-explicit-1`, `web-fetch/unreachable`),
where `<category>` is a coarse family name — `mcp-agent`, `tasks`, `web-fetch`, or
`web-selection` — and `<slug>` is the rest of the id. This `<category>` is not the same as
`metadata.category` (the fine-grained value `--category` filters on, e.g. `create`, `get`,
`search-actors`); the id's category only tells you which family a case belongs to. Run one
family with `--id`, which already matches by regex: `pnpm run evals:mcp-agent -- --id '^tasks/'`
runs the 10 tasks-family items (7 proper + 3 error) in one call.

By default the agent-item gate requires zero *unexpected* failed tool calls: an item whose agent hit
any tool error not named in its `expectedErrors` fails even on a judge PASS, and every agent item
carries a `tool_errors` score (the count of unexpected failures, with every failing call in the
comment - expected ones marked `(expected)`). Only the server's own tools count: failures of Claude
Code's built-ins (`Bash`, `WebFetch`) and of tools `failTools` injected are exempt. Traces still show
an expected failure as an ERROR span - the comment marks it expected, the span level does not lie.

Read-only probes count too, which is the point: the gate is what keeps the tool descriptions strong
enough that an agent resolves a loose Actor reference with `search-actors` instead of guessing a slug.

One caveat when reading a failure: a transient agent failure is retried once, and the retry replays the
whole prompt, so a fixed-name create case can hit a name collision the second time round and fail the
gate on it. The console prints a `retrying once` line for those items.

The tasks family (`tasks/*`, 10 items: 7 proper + 3 with `expectedErrors`) uses fixed `eval-*`
task names, which are unique per account, and the create cases never clean up — so every run
leaves debris that collides on the next one. Run `pnpm run evals:mcp-agent:tasks-fixtures`
before every run: it deletes leftover `eval-*` tasks and seeds the permanent fixture task. It
deletes on whatever account `APIFY_TOKEN` points at and prints that account first; pass
`--dry-run` to see what it would delete before it does. The family publishes task examples on
`jiri.spilka/actor-troubleshooter`, and publishing needs write access to the Actor, so those cases only
pass on an account that has it.

Publishing requires all three of `publicConfig.inputSchemaFields`, `datasetView` and `seoDescription`
(probed against the API), and the API reports the missing ones **non-exhaustively** — which is why
`tasks/publish-discovery` budgets turns for several fix-and-retry rounds rather than one.

`tasks/chain-hard-1` is the calibration edge, and it is calibrated: `claude-sonnet-4-5` passes it 3/3,
`claude-haiku-4-5` about 5 runs in 8. Every Haiku failure is the same one — it constructs
`jiri.spilka/troubleshooter` from the loose reference in the query instead of resolving the real
`actor-troubleshooter` with `search-actors`, eats the not-found, then recovers. The judge passes those
runs; only the zero-error gate catches them, which is exactly what that gate is for.

Do not try to close that gap by rewording descriptions. Both `create-actor-task` and
`fetch-actor-details` already say, explicitly, to resolve a loose name with `search-actors` rather than
guess, and `fetch-actor-details`' not-found response repeats it. Adding the `fetch-actor-details`
wording was measured at 5/8 against ~7/10 without it — no change. Treat a shift in the ratio as the
signal, not a single red run, and read a persistent drop as a description problem only after checking
it still passes on Sonnet.

The web-fetch family (`web-fetch/*`, 11 items: 8 proper + 3 with `expectedErrors`) covers the
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

The web-selection family (`web-selection/*`, 9 items: 7 proper + 2 with `expectedErrors`) covers
the clash between the default web tools: web search by query (`apify/rag-web-browser`) vs
single-URL verbatim fetch (`apify/web-fetch`) vs Actor discovery (`search-actors`) vs a
specialized Actor for structured platform data, plus rag→web-fetch escalation when a page
blocks rag's crawler (reddit) and coexistence with a client's built-in, summarizing fetch. Also
stateless — no fixtures script. Known residual (2026-08-21): on `web-fetch/unsupported-protocol`,
claude-haiku-4-5 reproducibly rewrites the ftp:// URL to https:// without telling the user,
despite the scheme note in both the tool description and the `url` parameter — a model-level
limit the case documents on purpose; stronger models pass.

### Selection mode

A `kind: "selection"` item measures only which tool the agent would have called, and with what
arguments — no judge, nothing executes, no account state. The agent runs exactly as an agent item
does (same MCP server, same prompt), but a per-item `PreToolUse` hook denies every tool call with:

> Tool calls are disabled in this evaluation. Do not retry with a different tool or arguments —
> report to the user, in your final answer, which tool you would have called and with what
> arguments, then stop.

This exact wording matters: it was calibrated against a spike that also tried reusing the
`failTools`/`report-problem` nudge text, which reads as "work around this" and measurably caused
the model to retry (and once exhausted `maxTurns`) instead of stopping cleanly after one denied
call. `maxTurns` is fixed at 2 for selection items for the same reason - the validator rejects a
`maxTurns` on a selection item rather than silently ignoring it.

The hook records every attempted call. The measurement is the first attempt that is not
`ToolSearch` (Claude Code's own tool-search meta-tool, which can be the true first call once
built-in tools sit behind it - see the `ToolSearch` skip note in `selection_mode.ts`). Set
`mcpToolsOnly: true` on an item (or run with `--mcp-tools-only`) to remove the built-ins, and
`ToolSearch` with them, for a case that must isolate MCP-vs-MCP tool choice.

Scoring (`first_tool_match`, 1 or 0):
- **Name membership.** The captured tool name (`mcp__apify__` prefix stripped for MCP tools;
  built-in names such as `WebFetch` compared verbatim) must be a member of `expectedTools`.
- **`expectedArgs`** (optional, a flat object): once the name matches, every key in it must
  deep-equal the same key of the captured call's arguments; keys not listed are ignored. This is
  what catches "guessed a slug instead of resolving the full id" - a name-only check would pass
  `fetch-actor-details({"actor":"rag-web-browser"})` against an item expecting the resolved
  `apify/rag-web-browser`; `expectedArgs: { actor: "apify/rag-web-browser" }` catches it.

A denied selection call still shows as a failed (ERROR) MCP tool span in its trace - harmless
(`tool_errors` never runs for selection items), but expected; don't "fix" it.

### Permission path, and running under root

Every item runs with `canUseTool` granting every tool call, not `bypassPermissions` +
`allowDangerouslySkipPermissions` - the Claude Code CLI refuses that combination outright under
root/sudo ("cannot be used with root/sudo privileges for security reasons"), which is how this
harness runs in some sandboxes. A selection item's deny-all `PreToolUse` hook still fires first
regardless, so its denial is unaffected either way. If a run does die with an opaque "Claude Code
process exited with code 1," check the console for `[claude-stderr] ...` lines - `claude_agent.ts`
forwards the subprocess's stderr and appends the last few lines to the thrown error.

### `--iterations` on stateful agent items

`--iterations N` repeats each selected item N times within the same run (one Langfuse experiment,
not N separate runs) and reports `pass@k` (at least one trial passed) and `pass^k` (every trial
passed) per item, plus in the `📈` summary line. This is safe and useful for `kind: "selection"`
items (nothing executes, so trials are fully independent) and for stateless agent items. For a
stateful family with fixed resource names (e.g. `tasks/*`'s `eval-*` task names), a second trial
can collide with the first trial's leftovers within the same run - the same collision the
fixtures script exists to clean up *between* runs, just now possible *within* one. Documented here
rather than blocked in code: measuring an agent item's flakiness (e.g. `tasks/chain-hard-1`'s
5-in-8 note above) is a legitimate use of `--iterations` on an agent item.

**Exit codes:**
- `0` = the aggregate pass rate (passed trials / requested trials) meets `--pass-threshold`
  (default `1.0`, i.e. every requested trial passed) ✅
- `1` = the pass rate falls short of the threshold, or setup failed ❌

**Editing test cases:** edit the items in the Langfuse UI. The next run picks them up; there is nothing to commit
in the dataset itself — but re-run the export below so the committed snapshot reflects the edit.
```bash
pnpm run evals:mcp-agent:export-dataset   # writes dataset_snapshot_mcp-server-evals.json (no build, no Apify/OpenRouter keys)
```
`dataset_snapshot_mcp-server-evals.json` is committed, so a UI edit shows as a diff on the next export; `--dataset <name>`
exports any other dataset to its own `dataset_snapshot_<dataset>.json`, which stays gitignored.

---

## Technical overview

**Core features:**
- Multi-turn conversations run by the real Claude Code harness (system prompt, built-in tools, MCP handling)
- Two scoring tiers: deterministic tool-pick (`kind: "selection"`) and LLM-based evaluation against requirements (`kind: "agent"`)
- Isolated agent + MCP server per test
- Configurable tool call timeout (default: 60 seconds)
- Deterministic tool-failure injection (`failTools`), and per-item error exemption (`expectedErrors`)
- Threshold-gated pass rate, with `pass@k`/`pass^k` from `--iterations`

## Critical design decisions

### 1. The Langfuse dataset is the source of truth

**Decision:** A run reads its test cases from the Langfuse dataset and never writes to it. Langfuse is the only copy: `evals:mcp-agent:export-dataset` dumps the active items to `dataset_snapshot_<dataset>.json` for reading them outside the UI, but there is no importer and nothing reads the snapshot at runtime.

**Why:**
- A UI edit takes effect on the next run. An earlier version synced a local file into the dataset first, which silently overwrote UI edits
- `experiment.run` only records a comparable **dataset run** (with a shareable run URL) when given real dataset items
- A snapshot is a second copy that no code reads and nothing keeps in sync automatically, so most are gitignored. `dataset_snapshot_mcp-server-evals.json` is the one exception, committed so a git reviewer sees dataset edits as a diff. Its output is byte-stable, so two exports diff cleanly when you want to see what changed in the UI

Every active item is validated when the dataset is fetched, so a bad UI edit fails the run before any LLM spend. Archived items are skipped, which is how a case is retired.

**Trade-off:** the dataset is mutable, so a run is only reproducible against the dataset as it was. Langfuse keeps item versions.

**Location:** `langfuse_dataset.ts`, `run_mcp_agent_evals.ts`, `export_dataset.ts`

### 2. MCP server isolation per test

**Decision:** Each test gets a fresh MCP server instance, spawned by that test's agent.

**Why:**
- Tools like `call-actor` create persistent state (datasets, runs) on Apify platform
- State from one test can contaminate subsequent tests
- Each test must start with clean state

**Trade-off:** ~20-30% slower (1-2s spawn overhead per test) but guarantees isolation.

**Location:** `claude_agent.ts`

### 3. The agent is Claude Code, not a hand-rolled loop

**Decision:** Run each case through the Claude Agent SDK's `query()` with the `claude_code` system-prompt and tool presets, and register the Apify MCP server alongside them.

**Why:**
- The eval measures what a real client does with our tool descriptions, including Claude Code's own prompting, tool-result handling, and multi-turn behavior
- The SDK owns the MCP lifecycle (spawn, handshake, server instructions, dynamic tool updates), so none of it is reimplemented here
- `--mcp-tools-only` drops the built-ins when a case should be forced onto the server's tools

Run settings: `canUseTool` granting every call (headless, never prompts - see "Permission path" above for why this replaced `bypassPermissions`), `settingSources: []` and `strictMcpConfig` (this repo's settings and `.mcp.json` are ignored, so a run is not shaped by the developer's machine), and `cwd: tmpdir()` (built-in file tools cannot touch the checkout).

The server is registered with `alwaysLoad: true`. Left at the default, its tools sit behind tool search once built-in tools are on, and the agent answers from memory or `Bash` instead - the eval would measure tool search, not our tool descriptions.

**Trade-off:** the harness is a moving target - a Claude Code release can shift results, so `agentSdkVersion` is recorded in the run metadata.

**Location:** `claude_agent.ts`, `sdk_conversation_adapter.ts`

### 4. Pass rate gated on the requested trial count, threshold-configurable

**Decision:** Exit code 0 while `passedTrials / requestedTrials >= --pass-threshold` (default `1.0`,
reproducing strict all-pass). `requestedTrials = requestedIds.length * iterations`.

**Why:**
- Clear CI/CD signal by default (every trial must pass), while still letting a calibrated suite gate on an aggregate rate instead of one flaky item blocking every PR
- The trial count matters as much as the scores: the Langfuse SDK drops an item whose task throws, so gating on the results it returns would report `7/7 passed` on a run where three trials never executed

Harness failures (MCP spawn, OpenRouter, judge) are therefore left to throw rather than being converted into a `FAIL` verdict. A broken harness shows up as a shortfall, not as a failing eval.

**Location:** `langfuse_experiment.ts` (`buildRunSummary`, `resolveExitCode`)

### 5. Judge sees tool calls, not results

**Decision:** Judge sees tool calls with arguments and agent responses, but NOT raw tool results.

**Why:**
- Evaluates agent behavior (tool selection, arguments)
- Tool results are often very long and noisy
- Agent should summarize results, judge evaluates the summary

**Judge input format:**
```
USER: Find actors for Google Maps
AGENT: [Called tool: search-actors with args: {"keywords":"google maps","limit":5}]
AGENT: I found 5 actors: 1. Google Maps Scraper... 2. ...
```

**Location:** `mcp_agent_judge.ts`

### 6. Judge client shared, agent isolated

**Decision:** One judge LLM client shared across tests; the agent and its MCP server are per test.

**Why:**
- The judge client is stateless (OpenRouter/OpenAI SDK), so sharing it saves initialization overhead with no contamination risk
- The agent holds conversation and Apify state, so it cannot be shared

**Location:** `run_mcp_agent_evals.ts`

### 7. Agent vs judge models

**Agent:** `claude-haiku-4-5` on the Anthropic API (fast; a weaker model is a more sensitive probe of tool descriptions)<br>
**Judge:** `deepseek/deepseek-v4-flash` on OpenRouter (strong reasoning)

Separation allows independent optimization for speed vs evaluation quality.

**Location:** `config.ts`

### 8. The SDK message stream is folded back into the old conversation shape

**Decision:** `sdk_conversation_adapter.ts` rebuilds `ConversationHistory` from the SDK's message stream instead of the judge reading SDK messages.

**Why:**
- The judge, its input format, and the scores stay unchanged, so verdicts remain comparable with earlier experiments
- `ConversationHistory` carries only what the judge and the scores read; tool results and metrics live on `ToolInvocation` and `ConversationMetrics`
- MCP tool names are stripped of their `mcp__apify__` prefix, so the judge sees `search-actors` as before
- Subagent messages (via the `Task` tool) are excluded, so the transcript reflects the main agent
- Cached prompt tokens are counted into `total_tokens`; the API reports them separately and a cached run would otherwise look nearly free. The trace's generation splits them out (`input`, `cache_read_input_tokens`, `cache_creation_input_tokens`): the SDK reports usage for the whole run, so a multi-turn run re-reads the cached system prompt and tool definitions every turn and the total is mostly cache traffic

**Location:** `sdk_conversation_adapter.ts`

### 9. The agent's conversation is traced by hand

**Decision:** After each agent run, `langfuse_observations.ts` emits the item's span tree from the adapted SDK stream; `llm_client.ts` traces the judge call itself.

```
experiment-item-run     Langfuse SDK, holds the scores
|- agent                the prompt in, the final answer out
|  |- <agent model>     generation: the run's aggregate tokens and cost, windowed to the last turn
|  |- <tool name>       one span per tool call: arguments in, result out
|- <judge model>        generation, emitted by llm_client.ts
```

**Why:**
- The agent runs in the Claude Code subprocess, so nothing it does is instrumented for us. Left alone, an item's trace holds a single span and the conversation is invisible in the UI
- Tokens and cost only roll up to the trace from a **generation**. The SDK reports usage once for the whole run, not per turn, so the run's aggregate sits on a single generation
- That generation is windowed to the final model turn, not the whole run. The UI orders siblings by start time, so a generation spanning the tool calls sorts ahead of them and reads as though the model answered before calling anything. Its `usageScope: run` metadata marks that the numbers still cover the whole run
- Tool spans are timed from when the SDK delivered the call and its result (`claude_agent.ts` stamps every message as it arrives). Without those stamps every span would collapse to the moment the tree is emitted, after the run

**Trade-off:** the tree is emitted after the fact, so a crashed run leaves no spans, and the agent's individual model turns are not separate generations.

**Location:** `langfuse_observations.ts`, `claude_agent.ts`, `llm_client.ts`

## System components

### Core files

- `types.ts` - Type definitions
- `config.ts` - Models, prompts, constants
- `claude_agent.ts` - The agent under test: Claude Agent SDK options, MCP server registration, failure injection, the selection-mode deny-all hook, `canUseTool`, stderr forwarding
- `selection_mode.ts` - Selection-mode scoring: the deny wording, `ToolSearch` skip, `first_tool_match` name/args matching
- `sdk_conversation_adapter.ts` - Folds the SDK message stream into `ConversationHistory`, tool spans, and metrics
- `llm_client.ts` - OpenRouter wrapper (judge), traced as a Langfuse generation
- `langfuse_observations.ts` - Builds and emits the item's span tree (agent, usage, tool calls)
- `mcp_agent_judge.ts` - Judge evaluation
- `langfuse_tracing.ts` - OpenTelemetry span processor init/shutdown
- `langfuse_dataset.ts` - Test case schema, dataset item mapping and validation, dataset fetch, `filterByTier`
- `langfuse_experiment.ts` - Experiment task (agent + selection dispatch), evaluators, run summary, exit gate
- `run_mcp_agent_evals.ts` - Main CLI entry
- `export_dataset.ts` - Snapshot CLI entry (`pnpm run evals:mcp-agent:export-dataset`)
- `tasks_fixtures.ts` - Task-suite fixture CLI entry (`pnpm run evals:mcp-agent:tasks-fixtures`)
- `migrate_unified_dataset.ts` - One-off migration into `mcp-server-evals` from the old per-family datasets (#259); not part of the regular workflow
- `dataset_snapshot_<dataset>.json` - Local export of a dataset, not read at runtime. Gitignored except `dataset_snapshot_mcp-server-evals.json`, which is committed

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

- **Reads the dataset** `mcp-server-evals` (override with `--dataset`) and matches its active items against `--id`/`--category`/`--tier`. For a variant set of cases, clone the dataset in the UI and pass `--dataset`; a run stays recorded against the dataset it used.
- **Runs an experiment** named `<git-branch>-<agent-model>-<timestamp>`, with metadata `{ agentModel, judgeModel, toolTimeout, mcpToolsOnly, agentSdkVersion, agentAuth, tier, iterations, passThreshold }`. With `--iterations N > 1`, each selected item appears N times in the same experiment, tagged `metadata.iteration` (1-based) - still one Langfuse **dataset run**, whose URL the console prints.
- **Traces** every item as one trace. Its root output is the judge verdict (agent items) or the first-attempted-call comment (selection items) plus the agent's narration, thinking, and tool names; nested under it are an `agent` span (prompt in, final answer out), a generation carrying the run's tokens and cost, one span per tool call (arguments in, result out, `ERROR` when the call failed or was denied), and - agent items only - a generation for the judge call. See design decision 9.
- **Scores** each agent item: `mcp_agent_judge` (`1` on a PASS verdict, comment = judge reason) and `tool_errors` (count of unexpected failed tool calls, comment lists every failure with expected ones marked, `0` on a clean item) together form the gate, and `total_tokens` is the agent tokens billed (omitted when the provider reported no usage so an unmeasured run cannot look like a free one; an item whose agent run was retried reports only the second attempt). Each selection item scores `first_tool_match` alone (`1`/`0`, comment names the captured call and the verdict).
- **Scores the run** with `pass_rate`: passed trials over requested trials (`requestedIds.length * iterations`), so runs stay comparable even when trials were dropped.

### Concurrency

`--concurrency` maps to the SDK's `maxConcurrency`, which runs **sequential batches** of that size rather than a rolling window: one slow test stalls the rest of its batch.

### Test case format

A test case is a dataset item: `input.query`, `expectedOutput`, and the rest in `metadata`. The id is
`<category>/<slug>` (see "One dataset: kind, tier, id scheme, and expectedErrors" above). The snapshot
holds the same fields flattened, one object per case, in this fixed key order:

```json
[
  {
    "id": "tasks/create-explicit-1",
    "category": "create",
    "kind": "agent",
    "tier": ["full"],
    "query": "User prompt for agent",
    "reference": "What agent must do to pass",
    "maxTurns": 10,
    "tools": ["actors", "docs"]
  },
  {
    "id": "tasks/get-not-found",
    "category": "get",
    "kind": "agent",
    "tier": ["full"],
    "query": "What Actor does my task eval-video-digest run?",
    "reference": "PASS if get-actor-task reports the task does not exist and the agent says so.",
    "expectedErrors": ["get-actor-task"]
  },
  {
    "id": "fetch-actor-details/input-schema",
    "category": "fetch-actor-details",
    "kind": "selection",
    "tier": ["pr"],
    "query": "Show me the input schema for apify/rag-web-browser",
    "expectedTools": ["fetch-actor-details"],
    "expectedArgs": { "actor": "apify/rag-web-browser" }
  }
]
```

**Required fields:**
- `id` - Unique identifier, `<category>/<slug>`
- `category` - For `--category` filtering (fine-grained, e.g. `create`, `get`, `search-actors` — not the same as the id's coarse `<category>` prefix)
- `kind` - `"agent"` (multi-turn, judged) or `"selection"` (single-turn tool pick, no judge, nothing executes)
- `tier` - Array of `"pr"` and/or `"full"`: which run(s) include the item (`--tier` filters on it)
- `query` - User request
- `reference` (`expectedOutput` in the dataset) - Success criteria for the judge. Required for `kind: "agent"`; not accepted for `kind: "selection"` (nothing executes, so there's nothing to judge)

**Optional:**
- `expectedTools` - `kind: "selection"` only, required for that kind: tool names the first attempted (non-`ToolSearch`) call must match
- `expectedArgs` - `kind: "selection"` only: a flat object; every key in it must deep-equal the same key of the captured call's arguments, keys not listed are ignored. Omit for a name-only check
- `expectedErrors` - `kind: "agent"` only: tool names allowed to fail on this item without failing the zero-tool-error gate (see "Selection mode" above and the "One dataset" section)
- `maxTurns` - `kind: "agent"` only: override the default (10). Not accepted on `kind: "selection"`, which is fixed at 2
- `tools` - List of tools to enable for this test (e.g., `["actors", "docs", "apify/rag-web-browser"]`). If omitted, all default tools are enabled. Passed to MCP server as `--tools` argument.
- `mcpToolsOnly` - Force MCP-tools-only for this item, dropping Claude Code's built-ins (OR-ed with the run-wide `--mcp-tools-only`). Useful on a selection item that must isolate MCP-vs-MCP tool choice
- `failTools` - `kind: "agent"` only: tool names the harness force-fails before they reach the server (e.g. `["call-actor"]`), with a message carrying the real `report-problem` nudge. Use it to deterministically produce a nudge-eligible failure that the live server + API cannot reproduce on demand, e.g. to test that the agent proactively calls `report-problem` after one. Injected as a `PreToolUse` deny (the same hook mechanism the selection-mode deny-all uses, with different wording), so the agent sees a refused call rather than an `INTERNAL_ERROR` tool result. See `claude_agent.ts`.

## Key insights

### MCP tools are stateful

Unlike typical function calling:
- Create persistent state (datasets, runs) on Apify platform
- Can modify tool registry dynamically
- Have side effects affecting subsequent calls

**Implication:** Test isolation critical.

### Dynamic tool registration

- a restored pre-cutover session's `add-actor` could dynamically register new Actor tools (no longer selectable for new sessions)
- Tool list NOT static

**Implication:** the agent must re-read the tool list mid-conversation. The Agent SDK handles `tools/list_changed` itself.

### Error propagation

Tool errors passed to LLM in tool result message:
- LLM can retry, use different tool, or explain to user
- No automatic retry by system

**Rationale:** LLM should handle errors intelligently.

### Conversation state

Claude Code owns the message history. The harness only sees the SDK's message stream and folds it back into `ConversationHistory` for the judge.

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
**Solution:** Tune `JUDGE_PROMPT_TEMPLATE` in `config.ts`.

### Tests timeout (hit maxTurns)
**Symptom:** Conversations don't complete.
**Solutions:**
- Check tool results are helpful
- Reduce `maxTurns` to fail faster
- Try a different agent model

## References

- [MCP Protocol Spec](https://modelcontextprotocol.io/)
- [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)
- [Apify API](https://docs.apify.com/api/v2)
- [OpenRouter](https://openrouter.ai/)
