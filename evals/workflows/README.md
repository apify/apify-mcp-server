# Workflow evaluation system

Tests AI agents performing multi-turn conversations with Apify MCP tools, evaluated by an LLM judge. Results (traces, scores, dataset, experiment runs) are recorded in **Langfuse**: the self-hosted instance at [langfuse.apify.dev](https://langfuse.apify.dev), project `MCP Workflow`.

## The flow

```
dataset (Langfuse) -> experiment run -> per item: agent conversation -> judge -> scores
```

1. **Dataset.** Test cases live in the Langfuse dataset `workflow-evals` and are edited in its UI. A run reads them and never writes back.
2. **Experiment.** The run executes the active items matching `--id`/`--category` as one Langfuse experiment, `--concurrency` items at a time.
3. **Conversation.** Each item gets a fresh MCP server and runs a multi-turn agent conversation against it.
4. **Judge.** An LLM judge scores the finished conversation against the item's `expectedOutput`.
5. **Scores.** The verdict lands as `workflow_judge` (the pass/fail gate) and the conversation's tokens as `total_tokens`, plus `pass_rate` on the run. The console prints failures and the run URL; per-item detail is in Langfuse.

---

## Quick start

**Prerequisites:**
- Node.js installed
- Apify account with API token
- OpenRouter API key
- Langfuse project (public + secret key)

**Run evaluations:**
```bash
# 1. Set environment variables (a .env file at the repo root is loaded automatically)
export APIFY_TOKEN="your_apify_token"
export OPENROUTER_API_KEY="your_openrouter_key"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://langfuse.apify.dev"

# 2. Build the MCP server
pnpm run build

# 3. Run tests
pnpm run evals:workflow
```

Run `pnpm run evals:workflow -- --help` for the full option list. `--category` and `--id` narrow the run, `--dataset` picks another Langfuse dataset, `--concurrency` defaults to 4 (each item spawns its own MCP server, so higher values use more resources), and `--tool-timeout` defaults to 60s; raise it for Actor calls that scrape a lot of data.

**Exit codes:**
- `0` = every requested test ran and passed ✅
- `1` = any test failed, any test never ran, or setup failed ❌

**Editing test cases:** edit the items in the Langfuse UI, then commit the change here:
```bash
pnpm run evals:workflow:export-dataset   # rewrites dataset_snapshot.json (no build, no Apify/OpenRouter keys)
```

---

## Technical overview

Tests AI agents executing tasks using Apify MCP server tools through multi-turn conversations evaluated by an LLM judge.

**Core features:**
- Multi-turn conversations with tool calling
- Dynamic tool discovery during execution
- MCP server instructions automatically added to agent system prompt
- LLM-based evaluation against requirements
- Isolated MCP server per test
- Configurable tool call timeout (default: 60 seconds)
- Strict pass/fail (all tests must pass)

## Critical design decisions

### 1. The Langfuse dataset is the source of truth

**Decision:** A run reads its test cases from the Langfuse dataset and never writes to it. Test cases are edited in the Langfuse UI; `dataset_snapshot.json` is an exported copy that nothing reads at runtime.

**Why:**
- Editing an item in the Langfuse UI changes the next run. An earlier version synced a local file into the dataset before every run, which silently overwrote UI edits and made the file the real source of truth
- `experiment.run` only records a comparable **dataset run** (with a shareable run URL) when it is given real dataset items
- One source of truth means no id-matching contract to maintain between a local file and a remote dataset

An item's `input.query` is the agent prompt, `expectedOutput` is what the judge scores against, and `metadata` carries the harness knobs (`category`, `maxTurns`, `tools`, `failTools`). Every active item is validated when the dataset is fetched, so a bad UI edit fails the run before any LLM spend. Archived items are skipped, which is how a case is retired.

**Trade-off:** the dataset is mutable, so a run is only reproducible against the dataset as it was. Export makes changes reviewable in git, and Langfuse itself keeps item versions.

**Location:** `langfuse_dataset.ts`, `run_workflow_evals.ts`

### 1b. The snapshot is a copy, not an input

**Decision:** `evals:workflow:export-dataset` writes the active items to `dataset_snapshot.json`, sorted by id with a fixed key order. There is no importer.

**Why:**
- Puts UI edits through code review and into git history, which the Langfuse UI alone does not give
- Keeps a copy of the cases outside Langfuse, otherwise the only copy is its database
- Byte-stable output, so an unexpected diff means someone changed the dataset without committing it

**Location:** `export_dataset.ts`

### 2. MCP server isolation per test

**Decision:** Each test gets a fresh MCP server instance.

**Why:**
- Tools like `call-actor` create persistent state (datasets, runs) on Apify platform
- State from one test can contaminate subsequent tests
- Each test must start with clean state

**Trade-off:** ~20-30% slower (1-2s spawn overhead per test) but guarantees isolation.

**Location:** `langfuse_experiment.ts`

### 3. Dynamic tool fetching per turn

**Decision:** Refresh tools from MCP server after each conversation turn.

**Why:**
- MCP server supports dynamic tool registration at runtime
- a restored pre-cutover session may still have `add-actor` loaded and register new Actor tools mid-conversation (`add-actor` itself is no longer selectable for new sessions)
- LLM must see updated tool list to use new tools

**Trade-off:** ~10-15% slower (100-200ms per turn) but supports dynamic workflows.

**Location:** `conversation_executor.ts`

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

### 6. LLM client shared, MCP client isolated

**Decision:** One LLM client shared across tests, MCP client isolated per test.

**Why:**
- LLM client is stateless (OpenRouter/OpenAI SDK)
- No cross-test contamination risk
- Saves initialization overhead

**Location:** `run_workflow_evals.ts`

### 7. Agent vs judge models

**Agent:** `anthropic/claude-haiku-4.5` (fast, good at tools)<br>
**Judge:** `deepseek/deepseek-v4-flash` (strong reasoning)

Separation allows independent optimization for speed vs evaluation quality.

**Location:** `config.ts`

### 8. MCP server instructions in system prompt

**Decision:** Automatically append MCP server instructions to agent system prompt.

**Why:**
- MCP servers can provide usage guidelines via the `instructions` field in the initialize response
- Instructions contain important context about tool dependencies and disambiguation
- Agents perform better when they understand tool relationships (e.g., `call-actor` requires two steps)
- Avoids duplicating server instructions in our agent prompt

**Instructions content:**
- Actor concepts and execution workflow
- Tool dependencies (e.g., `call-actor` two-step process)
- Tool disambiguation (e.g., `search-actors` vs `apify/rag-web-browser`)
- Storage types (datasets vs key-value stores)

**Location:** `mcp_client.ts`, `conversation_executor.ts`

## System components

### Core files

- `types.ts` - Type definitions
- `config.ts` - Models, prompts, constants
- `mcp_client.ts` - MCP server wrapper (spawn, connect, call, retrieve instructions)
- `llm_client.ts` - OpenRouter wrapper
- `conversation_executor.ts` - Multi-turn loop with dynamic tools and server instructions
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
export OPENROUTER_API_KEY="your_openrouter_key" # Get from https://openrouter.ai/keys
export LANGFUSE_PUBLIC_KEY="pk-lf-..."          # Langfuse project settings
export LANGFUSE_SECRET_KEY="sk-lf-..."          # Langfuse project settings
export LANGFUSE_BASE_URL="https://langfuse.apify.dev"  # self-hosted instance
```

Both entry points fail fast (before any test runs) listing every missing variable at once, and sanitize these values in place first, because the Langfuse SDK reads `process.env` directly and a secret with a trailing newline dies inside `node:http` instead. They can also be set in a `.env` file at the repo root.

### Results in Langfuse

Results are recorded in Langfuse, not to a local file. Each run:

- **Reads the dataset** `workflow-evals` (override with `--dataset`), takes its active items and matches them against `--id`/`--category`. To try a variant set of cases, clone the dataset in the Langfuse UI and pass `--dataset`; runs stay recorded against the dataset they used.
- **Runs an experiment** over the matching dataset items, run name `<git-branch>-<agent-model>-<timestamp>`, with run metadata `{ agentModel, judgeModel, toolTimeout }`. Because it runs on dataset items, it is recorded as a Langfuse **dataset run** and the console prints its direct URL.
- **Traces** every item as one trace, whose root output is a compact summary (judge verdict, tokens) rather than the transcript. The agent's individual LLM calls and MCP tool calls are not instrumented: the hand-rolled harness is being replaced by the Claude Agent SDK, which reports its own turns.
- **Scores** each item with two evaluators:
  - `workflow_judge`: `1` if the judge verdict is PASS, else `0` (comment = judge reason). This is the strict gate.
  - `total_tokens`: agent LLM tokens billed across the conversation. Omitted entirely when the provider reported no usage, so an unmeasured run cannot look like a free one.
- **Scores the run** with `pass_rate`: passing items over the number of items requested, so runs are comparable across branches and models even when items were dropped.

The console prints only failures, the `passed/requested` count, and the run link; per-item detail is in Langfuse.

Compare tokens across runs (branches, models) directly in the Langfuse experiment view.

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
- `failTools` - Tool names the harness force-fails with a synthetic `INTERNAL_ERROR` result carrying the real `report-problem` nudge, instead of calling the server (e.g. `["call-actor"]`). Use it to deterministically throw a nudge-eligible error that the live server + API cannot reproduce on demand, e.g. to test that the agent proactively calls `report-problem` after a failure. See `mcp_client.ts`.

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
- Must refresh after tool execution

**Implication:** Cannot cache tools at conversation start.

### Error propagation

Tool errors passed to LLM in tool result message:
- LLM can retry, use different tool, or explain to user
- No automatic retry by system

**Rationale:** LLM should handle errors intelligently.

### Conversation state

OpenAI-compatible message history maintained:
```typescript
[
  { role: 'system', content: '...' },
  { role: 'user', content: '...' },
  { role: 'assistant', tool_calls: [...] },
  { role: 'tool', tool_call_id: '...', content: '...' },
  { role: 'assistant', content: '...' }
]
```

Format must be exact for LLM context understanding.

## Common issues

### Tests interfere with each other
**Symptom:** Test 2 fails after Test 1, passes alone.<br>
**Solution:** ✅ Isolated MCP instances per test.

### LLM can't use newly added tool
**Symptom:** Agent uses a dynamically-registered tool (e.g. a restored session's `add-actor`) but can't call new tool.<br>
**Solution:** ✅ Dynamic tool fetching per turn.

### Judge too strict/lenient
**Symptom:** Incorrect verdicts.<br>
**Solution:** Tune `JUDGE_PROMPT_TEMPLATE` in `config.ts`.

### Tests timeout (hit maxTurns)
**Symptom:** Conversations don't complete.
**Solutions:**
- Review agent system prompt
- Check tool results are helpful
- Reduce `maxTurns` to fail faster
- Try different LLM model

## References

- [MCP Protocol Spec](https://modelcontextprotocol.io/)
- [OpenAI Tool Calling](https://platform.openai.com/docs/guides/function-calling)
- [Apify API](https://docs.apify.com/api/v2)
- [OpenRouter](https://openrouter.ai/)
