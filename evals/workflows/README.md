# Workflow evaluation system

Tests Claude Code performing multi-turn conversations with Apify MCP tools, evaluated by an LLM judge. The agent under test is the real Claude Code harness, driven headlessly through the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), so a run exercises the server the way a Claude Code user does. Results (traces, scores, dataset, experiment runs) are recorded in **Langfuse**: the self-hosted instance at [langfuse.apify.dev](https://langfuse.apify.dev), project `MCP Workflow`.

## The flow

```
dataset (Langfuse) -> experiment run -> per item: agent conversation -> judge -> scores
```

1. **Dataset.** Test cases live in the Langfuse dataset `workflow-evals` and are edited in its UI. A run reads them and never writes back.
2. **Experiment.** The run executes the active items matching `--id`/`--category` as one Langfuse experiment, `--concurrency` items at a time.
3. **Conversation.** Each item runs a Claude Code agent (Claude Agent SDK) that spawns its own fresh Apify MCP server and drives it to answer the query.
4. **Judge.** An LLM judge scores the finished conversation against the item's `expectedOutput` on six fixed dimensions. `toolSelection` is decided in code instead when the item sets `expectedTools`.
5. **Scores.** `workflow_judge` (the pass/fail gate) plus one `rubric_*` score per dimension and the conversation's tokens as `total_tokens`; `pass_rate` and a per-dimension `pass_rate_*` on the run. The console prints one line per item with the six verdicts, then the run URL; the reasons are in Langfuse.

---

## Quick start

**Prerequisites:**
- Node.js installed
- Apify account with API token
- Anthropic API key (agent)
- OpenRouter API key (judge)
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
pnpm run evals:workflow
```

Run `pnpm run evals:workflow --help` for the full option list. `--category` and `--id` narrow the run, `--dataset` picks another Langfuse dataset, `--concurrency` defaults to 4 (each item spawns its own agent and MCP server, so higher values use more resources), `--tool-timeout` defaults to 60s (raise it for Actor calls that scrape a lot of data), and `--mcp-tools-only` drops Claude Code's built-in tools so only the server's tools remain.

**Exit codes:**
- `0` = every requested test ran and passed ✅
- `1` = any test failed, any test never ran, or setup failed ❌

**Editing test cases:** edit the items in the Langfuse UI, then commit the change here:
```bash
pnpm run evals:workflow:export-dataset   # rewrites dataset_snapshot.json (no build, no Apify/OpenRouter keys)
```

**The rubric dataset:** `expectedTools` (design decision 5) lives on `workflow-evals-rubric`, a copy of `workflow-evals` seeded by `pnpm run evals:workflow:clone-dataset` (`--dry-run` prints the plan), and committed as `dataset_snapshot.workflow-evals-rubric.json`:
```bash
pnpm run evals:workflow -- --dataset workflow-evals-rubric
```
Its item ids carry a `-rubric` suffix, because Langfuse item ids are unique per project across datasets and a copy cannot reuse them - so `--id` patterns match either dataset. `workflow-evals` is untouched and still runs, with every `toolSelection` verdict coming from the judge.

---

## Technical overview

**Core features:**
- Multi-turn conversations run by the real Claude Code harness (system prompt, built-in tools, MCP handling)
- Six-dimension LLM rubric, with tool selection checked in code where the case can express it
- Isolated agent + MCP server per test
- Configurable tool call timeout (default: 60 seconds)
- Deterministic tool-failure injection (`failTools`)
- Strict pass/fail (all tests must pass)

## Critical design decisions

### 1. The Langfuse dataset is the source of truth

**Decision:** A run reads its test cases from the Langfuse dataset and never writes to it. `evals:workflow:export-dataset` writes the active items back to `dataset_snapshot.json`; there is no importer and nothing reads the snapshot at runtime.

**Why:**
- A UI edit takes effect on the next run. An earlier version synced a local file into the dataset first, which silently overwrote UI edits
- `experiment.run` only records a comparable **dataset run** (with a shareable run URL) when given real dataset items
- The snapshot puts UI edits into git history and keeps a copy of the cases outside the Langfuse database. Its output is byte-stable, so an unexpected diff means the dataset changed without being committed

Every active item is validated when the dataset is fetched, so a bad UI edit fails the run before any LLM spend. Archived items are skipped, which is how a case is retired.

**Trade-off:** the dataset is mutable, so a run is only reproducible against the dataset as it was. Langfuse keeps item versions.

**Location:** `langfuse_dataset.ts`, `run_workflow_evals.ts`, `export_dataset.ts`

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

Run settings: `permissionMode: 'bypassPermissions'` (headless, never prompts), `settingSources: []` and `strictMcpConfig` (this repo's settings and `.mcp.json` are ignored, so a run is not shaped by the developer's machine), and `cwd: tmpdir()` (built-in file tools cannot touch the checkout).

The server is registered with `alwaysLoad: true`. Left at the default, its tools sit behind tool search once built-in tools are on, and the agent answers from memory or `Bash` instead - the eval would measure tool search, not our tool descriptions.

**Trade-off:** the harness is a moving target - a Claude Code release can shift results, so `agentSdkVersion` is recorded in the run metadata.

**Location:** `claude_agent.ts`, `sdk_conversation_adapter.ts`

### 4. Strict pass/fail gated on the requested count

**Decision:** Exit code 0 only when every requested item ran and scored `workflow_judge === 1`.

**Why:**
- Clear CI/CD signal, no ambiguity about which tests are critical
- The item count matters as much as the scores: the Langfuse SDK drops an item whose task throws, so gating on the results it returns would report `7/7 passed` on a run where three tests never executed

Harness failures (MCP spawn, OpenRouter, judge) are therefore left to throw rather than being converted into a `FAIL` verdict. A broken harness shows up as a shortfall, not as a failing eval.

The gate reads `taskCompletion` alone. The other five rubric dimensions never affect the exit code: these evals are run by hand on a PR and read by a human, and nothing in CI runs them.

**Location:** `langfuse_experiment.ts` (`buildRunSummary`)

### 5. Six dimensions, and code wins where it can

**Decision:** The judge scores six fixed dimensions instead of one verdict - `toolSelection`, `argumentCorrectness`, `resultUtilization`, `taskCompletion`, `errorRecovery`, `planEfficiency` - and sees each tool call's result, truncated to 2000 chars. `toolSelection` is replaced by a deterministic set comparison against the item's `expectedTools` whenever that field is set; the judge's own answer for it is then dropped.

**Why:**
- One verdict says a test regressed, not which capability regressed. A run where the agent still answers correctly but now takes four detours to get there should show up as a `planEfficiency` failure, not as a pass
- `resultUtilization` and `errorRecovery` cannot be scored from tool calls alone: whether the agent ignored an error or misreported a payload is only visible next to what the tool returned. Truncation keeps one large `get-dataset-items` result from drowning the conversation it is meant to explain
- Where correct tool selection is a fixed set, a code comparison is a fact and the judge's answer is a probability. Same dedupe-sort-compare semantics as `toolsExactMatch` in `evals/run_evaluation.ts`, so order and repeat calls are ignored while a missing or extra tool fails
- Claude Code's built-in tools are excluded from that comparison: the agent reaches for `TodoWrite` or `Read` on its own initiative, which says nothing about how it picked ours. The judge still sees those calls and scores them under `planEfficiency`

`overallVerdict` is the `taskCompletion` verdict, not an aggregate of the six, so the gate keeps meaning what it always meant and `workflow_judge` stays comparable with runs from before the rubric. The other five dimensions are diagnostic: nothing gates on them, and nothing in CI reads them.

**Judge input format:**
```
USER: Find actors for Google Maps
AGENT: [Called tool: search-actors with args: {"search":"google maps","limit":5}]
TOOL RESULT (search-actors): [{"name":"compass/crawler-google-places",...}] [truncated at 2000 chars, 8431 total]
AGENT: I found 5 actors: 1. Google Maps Scraper... 2. ...
```
A failed call shows as `TOOL ERROR (<tool>): <message>` - the message the agent was given, which is what `errorRecovery` is scored on.

**Trade-off:** six verdicts per item is six chances for the judge to be noisy, and the prompt is much larger (the judge's 1M context absorbs it). Only the cases whose requirements pin one path set `expectedTools`; the rest leave `toolSelection` judged, so that dimension is the least trustworthy of the six.

**Location:** `workflow_judge.ts`, `deterministic_checks.ts`, `config.ts` (`JUDGE_PROMPT_TEMPLATE`)

### 6. Judge client shared, agent isolated

**Decision:** One judge LLM client shared across tests; the agent and its MCP server are per test.

**Why:**
- The judge client is stateless (OpenRouter/OpenAI SDK), so sharing it saves initialization overhead with no contamination risk
- The agent holds conversation and Apify state, so it cannot be shared

**Location:** `run_workflow_evals.ts`

### 7. Agent vs judge models

**Agent:** `claude-haiku-4-5` on the Anthropic API (fast; a weaker model is a more sensitive probe of tool descriptions)<br>
**Judge:** `deepseek/deepseek-v4-flash` on OpenRouter (strong reasoning)

Separation allows independent optimization for speed vs evaluation quality.

**Location:** `config.ts`

### 8. The SDK message stream is folded back into the old conversation shape

**Decision:** `sdk_conversation_adapter.ts` rebuilds `ConversationHistory` from the SDK's message stream instead of the judge reading SDK messages.

**Why:**
- The judge, its input format, and the scores stay unchanged, so verdicts remain comparable with earlier experiments
- `ConversationHistory` carries what the judge and the scores read: each tool call now carries its paired result and whether it went to our server, which the rubric needs. Metrics stay on `ConversationMetrics`, and `ToolInvocation` still carries the untruncated payloads for the trace
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
- `claude_agent.ts` - The agent under test: Claude Agent SDK options, MCP server registration, failure injection
- `sdk_conversation_adapter.ts` - Folds the SDK message stream into `ConversationHistory`, tool spans, and metrics
- `llm_client.ts` - OpenRouter wrapper (judge), traced as a Langfuse generation
- `langfuse_observations.ts` - Builds and emits the item's span tree (agent, usage, tool calls)
- `workflow_judge.ts` - Judge evaluation: the rubric prompt, its schema, and the merge with the deterministic check
- `deterministic_checks.ts` - Code-based rubric checks (`expectedTools` vs. the tools actually called)
- `langfuse_tracing.ts` - OpenTelemetry span processor init/shutdown
- `langfuse_dataset.ts` - Test case schema, dataset item mapping and validation, dataset fetch
- `langfuse_experiment.ts` - Experiment task, evaluators, run summary and exit gate
- `run_workflow_evals.ts` - Main CLI entry
- `export_dataset.ts` - Snapshot CLI entry (`pnpm run evals:workflow:export-dataset`)
- `clone_dataset.ts` - One-off: copy a dataset into a new one, adding `expectedTools` (`pnpm run evals:workflow:clone-dataset`)
- `dataset_snapshot.json` - Exported copy of `workflow-evals`, not read at runtime. Any other dataset exports to `dataset_snapshot.<name>.json`

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

- **Reads the dataset** `workflow-evals` (override with `--dataset`) and matches its active items against `--id`/`--category`. For a variant set of cases, clone the dataset in the UI and pass `--dataset`; a run stays recorded against the dataset it used.
- **Runs an experiment** named `<git-branch>-<agent-model>-<timestamp>`, with metadata `{ agentModel, judgeModel, toolTimeout, mcpToolsOnly, agentSdkVersion }`. Running on dataset items is what makes it a Langfuse **dataset run**, whose URL the console prints.
- **Traces** every item as one trace. Its root output is the judge verdict plus the agent's narration, thinking, and tool names; nested under it are an `agent` span (prompt in, final answer out), a generation carrying the run's tokens and cost, one span per tool call (arguments in, result out, `ERROR` when the call failed), and a generation for the judge call. See design decision 9.
- **Scores** each item: `workflow_judge` (`1` when `taskCompletion` passed, comment = its reason) is the strict gate; `rubric_tool_selection`, `rubric_argument_correctness`, `rubric_result_utilization`, `rubric_task_completion`, `rubric_error_recovery` and `rubric_plan_efficiency` carry the six dimensions with their reasons as comments; and `total_tokens` is the agent tokens billed, omitted when the provider reported no usage so an unmeasured run cannot look like a free one. `rubric_task_completion` repeats `workflow_judge` on purpose - the gate keeps its own name and history.
- **Scores the run** with `pass_rate` and one `pass_rate_<dimension>` per dimension: passing items over items requested, so runs stay comparable even when items were dropped. Comparing two runs dimension by dimension is what the Langfuse run-comparison view is for; the console prints the current run's numbers only.

### Concurrency

`--concurrency` maps to the SDK's `maxConcurrency`, which runs **sequential batches** of that size rather than a rolling window: one slow test stalls the rest of its batch.

### Test case format

A test case is a dataset item: `input.query`, `expectedOutput`, and the rest in `metadata`. `dataset_snapshot.json` holds the same fields flattened, one object per case:

```json
[
  {
    "id": "test-001",
    "category": "basic",
    "query": "User prompt for agent",
    "reference": "What agent must do to pass",
    "maxTurns": 10,
    "tools": ["actors", "docs"],
    "expectedTools": ["search-actors", "call-actor"]
  }
]
```

**Required fields:**
- `id` - Unique identifier
- `category` - For filtering
- `query` - User request
- `reference` - Success criteria for judge

**Optional:**
- `maxTurns` - Override default (10)
- `tools` - List of tools to enable for this test (e.g., `["actors", "docs", "apify/rag-web-browser"]`). If omitted, all default tools are enabled. Passed to MCP server as `--tools` argument.
- `expectedTools` - The MCP tools that constitute correct tool selection, e.g. `["call-actor", "get-dataset-items"]`. Compared as a set (order and repeat calls ignored, a missing or extra tool fails), and Claude Code's built-in tools are left out of the comparison. When set, the rubric's `toolSelection` dimension is decided in code rather than by the judge - so set it only on a case whose requirements pin one path, and leave it off a case that has to discover an Actor first. See design decision 5.
- `failTools` - Tool names the harness force-fails before they reach the server (e.g. `["call-actor"]`), with a message carrying the real `report-problem` nudge. Use it to deterministically produce a nudge-eligible failure that the live server + API cannot reproduce on demand, e.g. to test that the agent proactively calls `report-problem` after one. Injected as a `PreToolUse` deny, the one hook that survives `bypassPermissions`, so the agent sees a refused call rather than an `INTERNAL_ERROR` tool result. See `claude_agent.ts`.

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
