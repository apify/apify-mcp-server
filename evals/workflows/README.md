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

**Location:** `claude_agent.ts`, `sdk_run.ts`

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

### 8. The judge reads the SDK message stream directly

**Decision:** `formatSdkStreamForJudge()` formats the SDK's messages for the judge. There is no intermediate conversation object.

**Why:**
- The judge's input format is unchanged, so verdicts remain comparable with earlier experiments
- MCP tool names are stripped of their `mcp__apify__` prefix, so the judge sees `search-actors` as before
- Subagent messages (via the `Task` tool) are excluded, so the judge reads the main agent
- Cached prompt tokens are counted into `total_tokens`; the API reports them separately and a cached run would otherwise look nearly free

**Location:** `workflow_judge.ts`, `sdk_messages.ts`

## System components

### Core files

- `config.ts` - Models, prompts, constants
- `claude_agent.ts` - The agent under test: Claude Agent SDK options, MCP server registration, failure injection
- `sdk_messages.ts` - SDK content-block shapes shared by the judge and the run summary
- `sdk_run.ts` - Summarizes one SDK run: token usage, paired tool invocations, debug transcript
- `llm_client.ts` - OpenRouter wrapper (judge)
- `workflow_judge.ts` - Judge evaluation
- `langfuse_tracing.ts` - OpenTelemetry span processor init/shutdown
- `langfuse_dataset.ts` - Test case schema, dataset item mapping and validation, dataset fetch
- `langfuse_experiment.ts` - Experiment task, evaluators, run summary and exit gate
- `run_workflow_evals.ts` - Main CLI entry
- `export_dataset.ts` - Snapshot CLI entry (`pnpm run evals:workflow:export-dataset`)
- `dataset_snapshot.json` - Exported copy of the dataset, not read at runtime

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
- **Traces** every item as one trace whose root output is the judge verdict plus the agent's narration, thinking, and tool names - not the tool payloads. Individual LLM and MCP tool calls are not instrumented: they happen inside the Claude Code subprocess.
- **Scores** each item: `workflow_judge` (`1` on a PASS verdict, comment = judge reason) is the strict gate, and `total_tokens` is the agent tokens billed, omitted when the provider reported no usage so an unmeasured run cannot look like a free one.
- **Scores the run** with `pass_rate`: passing items over items requested, so runs stay comparable even when items were dropped.

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
- `failTools` - Tool names the harness force-fails with a synthetic `INTERNAL_ERROR` result carrying the real `report-problem` nudge, instead of calling the server (e.g. `["call-actor"]`). Use it to deterministically throw a nudge-eligible error that the live server + API cannot reproduce on demand, e.g. to test that the agent proactively calls `report-problem` after a failure. Injected as a `PreToolUse` deny, the one hook that survives `bypassPermissions`. See `claude_agent.ts`.

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

Claude Code owns the message history. The harness only sees the SDK's message stream, which it formats for the judge and summarizes for the scores.

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
