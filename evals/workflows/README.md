# Workflow evaluation system

Tests Claude Code performing multi-turn conversations with Apify MCP tools, evaluated by an LLM judge. The agent under test is the real Claude Code harness, driven headlessly through the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), so a run exercises the server the way a Claude Code user does. Results (traces, scores, dataset, experiment runs) are recorded in **Langfuse**: the self-hosted instance at [langfuse.apify.dev](https://langfuse.apify.dev), project `MCP Workflow`.

## The flow

```
dataset (Langfuse) -> experiment run -> per item: agent conversation -> judge -> scores
```

1. **Dataset.** Test cases live in the Langfuse dataset `workflow-evals` and are edited in its UI. A run reads them and never writes back.
2. **Experiment.** The run executes the active items matching `--id`/`--category` as one Langfuse experiment, `--concurrency` items at a time.
3. **Conversation.** Each item runs a Claude Code agent (Claude Agent SDK) that spawns its own fresh Apify MCP server and drives it to answer the query.
4. **Judge.** An LLM judge scores the finished conversation against the item's `expectedOutput`.
5. **Scores.** The verdict lands as `workflow_judge` (the pass/fail gate) and the conversation's tokens as `total_tokens`, plus `pass_rate` on the run. The console prints failures and the run URL; per-item detail is in Langfuse.

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
pnpm run evals:workflow
```

Run `pnpm run evals:workflow --help` for the full option list. `--category` and `--id` narrow the run, `--dataset` picks another Langfuse dataset, `--concurrency` defaults to 8 (each item spawns its own agent and MCP server, so higher values use more resources), `--tool-timeout` defaults to 60s (raise it for Actor calls that scrape a lot of data), `--mcp-tools-only` drops Claude Code's built-in tools so only the server's tools remain, `--subscription` runs the agent on the local Claude Code login instead of `ANTHROPIC_API_KEY` (the key is removed from the process environment so the run cannot bill the API), and `--claude-judge` runs the judge on the Claude Agent SDK too, so no `OPENROUTER_API_KEY` is needed (`--judge-model` then takes an Anthropic model ID, default `claude-sonnet-5`; note a Claude judge scoring a Claude agent can be self-lenient, so prefer the OpenRouter judge for comparable numbers). With `--subscription --claude-judge` a run needs only `APIFY_TOKEN` and the Langfuse keys.

### Proper suites vs error-handling suites

By default the gate requires zero failed tool calls: an item whose agent hit any tool error fails even
on a judge PASS, and every item carries a `tool_errors` score (count, with the failing calls in the
comment). Cases that provoke errors on purpose (error recovery, not-found lookups, name collisions)
live in a separate `*-errors` dataset and run with `--allow-tool-errors`, which drops only the
zero-error condition. Never mix the two: an error-provoking case inside a proper suite either fails the
run or forces error tolerance onto cases that must stay clean. Only the server's own tools count:
failures of Claude Code's built-ins (`Bash`, `WebFetch`) and of tools `failTools` injected are exempt.

Read-only probes count too, which is the point: the gate is what keeps the tool descriptions strong
enough that an agent resolves a loose Actor reference with `search-actors` instead of guessing a slug.

One caveat when reading a failure: a transient agent failure is retried once, and the retry replays the
whole prompt, so a fixed-name create case can hit a name collision the second time round and fail the
gate on it. The console prints a `retrying once` line for those items.

The task-tool suites are `tasks-evals` (proper) and `tasks-evals-errors` (error handling). They use
fixed `eval-*` task names, which are unique per account, and the create cases never clean up — so every
run leaves debris that collides on the next one. Run `pnpm run evals:workflow:tasks-fixtures` before
every run: it deletes leftover `eval-*` tasks and seeds the permanent fixture task. Both suites publish
task examples on `jiri.spilka/actor-troubleshooter`, and publishing needs write access to the Actor, so
those cases only pass on an account that has it.

**Exit codes:**
- `0` = every requested test ran and passed ✅
- `1` = any test failed, any test never ran, or setup failed ❌

**Editing test cases:** edit the items in the Langfuse UI, then commit the change here:
```bash
pnpm run evals:workflow:export-dataset   # rewrites dataset_snapshot_workflow-evals.json (no build, no Apify/OpenRouter keys)
```
Each dataset gets its own `dataset_snapshot_<dataset>.json`; `--dataset <name>` exports another one (e.g. `tasks-evals`).

---

## Technical overview

**Core features:**
- Multi-turn conversations run by the real Claude Code harness (system prompt, built-in tools, MCP handling)
- LLM-based evaluation against requirements
- Isolated agent + MCP server per test
- Configurable tool call timeout (default: 60 seconds)
- Deterministic tool-failure injection (`failTools`)
- Strict pass/fail (all tests must pass)

## Critical design decisions

### 1. The Langfuse dataset is the source of truth

**Decision:** A run reads its test cases from the Langfuse dataset and never writes to it. `evals:workflow:export-dataset` writes the active items back to `dataset_snapshot_<dataset>.json`; there is no importer and nothing reads the snapshot at runtime.

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

**Location:** `langfuse_experiment.ts` (`buildRunSummary`)

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

**Location:** `workflow_judge.ts`

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
- `claude_agent.ts` - The agent under test: Claude Agent SDK options, MCP server registration, failure injection
- `sdk_conversation_adapter.ts` - Folds the SDK message stream into `ConversationHistory`, tool spans, and metrics
- `llm_client.ts` - OpenRouter wrapper (judge), traced as a Langfuse generation
- `langfuse_observations.ts` - Builds and emits the item's span tree (agent, usage, tool calls)
- `workflow_judge.ts` - Judge evaluation
- `langfuse_tracing.ts` - OpenTelemetry span processor init/shutdown
- `langfuse_dataset.ts` - Test case schema, dataset item mapping and validation, dataset fetch
- `langfuse_experiment.ts` - Experiment task, evaluators, run summary and exit gate
- `run_workflow_evals.ts` - Main CLI entry
- `export_dataset.ts` - Snapshot CLI entry (`pnpm run evals:workflow:export-dataset`)
- `tasks_fixtures.ts` - Task-suite fixture CLI entry (`pnpm run evals:workflow:tasks-fixtures`)
- `dataset_snapshot_<dataset>.json` - Exported copy of each dataset, not read at runtime

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
- **Runs an experiment** named `<git-branch>-<agent-model>-<timestamp>`, with metadata `{ agentModel, judgeModel, toolTimeout, mcpToolsOnly, agentSdkVersion, agentAuth, allowToolErrors }`. Running on dataset items is what makes it a Langfuse **dataset run**, whose URL the console prints.
- **Traces** every item as one trace. Its root output is the judge verdict plus the agent's narration, thinking, and tool names; nested under it are an `agent` span (prompt in, final answer out), a generation carrying the run's tokens and cost, one span per tool call (arguments in, result out, `ERROR` when the call failed), and a generation for the judge call. See design decision 9.
- **Scores** each item: `workflow_judge` (`1` on a PASS verdict, comment = judge reason) and `tool_errors` (failed tool calls, comment lists them, `0` on a clean item) together form the gate, and `total_tokens` is the agent tokens billed (omitted when the provider reported no usage so an unmeasured run cannot look like a free one; an item whose agent run was retried reports only the second attempt).
- **Scores the run** with `pass_rate`: passing items over items requested, so runs stay comparable even when items were dropped.

### Concurrency

`--concurrency` maps to the SDK's `maxConcurrency`, which runs **sequential batches** of that size rather than a rolling window: one slow test stalls the rest of its batch.

### Test case format

A test case is a dataset item: `input.query`, `expectedOutput`, and the rest in `metadata`. The snapshot holds the same fields flattened, one object per case:

```json
[
  {
    "id": "test-001",
    "category": "basic",
    "query": "User prompt for agent",
    "reference": "What agent must do to pass",
    "maxTurns": 10,
    "tools": ["actors", "docs"]
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
