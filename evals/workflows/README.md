# Workflow Evaluation System

Tests AI agents performing multi-turn conversations with Apify MCP tools, evaluated by an LLM judge. Runs on the [Opik](https://github.com/comet-ml/opik) TS SDK (self-hosted): test cases become an Opik dataset, each run is an Opik experiment, and every conversation is a trace with `llm` and `tool` spans.

---

## Quick Start

**Prerequisites:**
- Node.js installed
- Apify account with API token
- OpenRouter API key
- Docker (for the local Opik server)
- A running local Opik server

**Start Opik locally (once):**
```bash
git clone https://github.com/comet-ml/opik.git
cd opik
./opik.sh
```
Opik then serves its UI at `http://localhost:5173` and its API at `http://localhost:5173/api`. The runner talks to the API URL.

**Run evaluations:**
```bash
# 1. Set environment variables
export APIFY_TOKEN="your_apify_token"
export OPENROUTER_API_KEY="your_openrouter_key"

# 2. Build the MCP server
pnpm run build

# 3. Run tests (fails fast if Opik is unreachable)
pnpm run evals:workflow
```

**Common options:**
```bash
# Filter by category
pnpm run evals:workflow -- --category search

# Run specific test
pnpm run evals:workflow -- --id search-google-maps

# Increase timeout for long-running Actors (default: 60s)
pnpm run evals:workflow -- --tool-timeout 300

# Run tests in parallel (default: 4)
pnpm run evals:workflow -- --concurrency 8

# Save results to JSON file
pnpm run evals:workflow -- --output
```

**Exit codes:**
- `0` = All tests passed ✅
- `1` = Any test failed, an error occurred, or Opik was unreachable ❌

---

## Viewing results in Opik

Open `http://localhost:5173` after a run.

- **Project `workflow-evals`** holds one trace per test. Open a trace to see the tree: per-turn `llm` spans (messages, model, token usage) and per-call `tool` spans (arguments + the full raw tool result, plus `resultBytes`/duration in span metadata). Trace metadata carries `agentModel`, `turns`, total tokens, and total tool bytes. The `workflow_judge` score (1 = PASS, 0 = FAIL) and the judge's reason are attached to the trace.
- **Dataset `workflow-evals`** mirrors `test_cases.json`. Every run upserts it; identical items are deduped by content.
- **Experiments** are named `<git-branch>/<agent-model-short>` (e.g. `feat-opik-evals/claude-haiku-4.5`) with metadata for the agent/judge models, tool timeout, git branch + commit, and the active filters. To compare a change, run the eval on two branches and compare the two experiments side by side in the Opik UI.

The judge's own LLM call runs inside the scoring metric with an untracked client, so it stays out of the traces (only the agent's calls appear as `llm` spans).

---

## Technical Overview

Tests AI agents executing tasks using Apify MCP server tools through multi-turn conversations evaluated by an LLM judge.

**Core features:**
- Multi-turn conversations with tool calling
- Dynamic tool discovery during execution
- MCP server instructions automatically added to agent system prompt
- LLM-based evaluation against requirements (an Opik scoring metric)
- Isolated MCP server per test
- Configurable tool call timeout (default: 60 seconds)
- Strict pass/fail (all tests must pass)
- Opik tracing: each test is a trace with per-turn `llm` spans (messages, model, token usage) and per-call `tool` spans (arguments + full raw result)

## Critical Design Decisions

### 1. MCP Server Isolation Per Test

**Decision:** Each test gets a fresh MCP server instance.

**Why:**
- Tools like `call-actor` create persistent state (datasets, runs) on Apify platform
- State from one test can contaminate subsequent tests
- Each test must start with clean state

**Implementation:**
```typescript
for (const test of tests) {
    const mcpClient = new McpClient();
    try {
        await mcpClient.start(apifyToken);
        // Run test
    } finally {
        await mcpClient.cleanup();  // Always cleanup
    }
}
```

**Trade-off:** ~20-30% slower (1-2s spawn overhead per test) but guarantees isolation.

**Location:** `run-workflow-evals.ts`

### 2. Dynamic Tool Fetching Per Turn

**Decision:** Refresh tools from MCP server after each conversation turn.

**Why:**
- MCP server supports dynamic tool registration at runtime
- `add-actor` tool can register new Actor tools mid-conversation
- LLM must see updated tool list to use new tools

**Implementation:**
```typescript
while (turnNumber < maxTurns) {
    // Call LLM with current tools
    const llmResponse = await llmClient.callLlm(messages, model, tools);

    // Execute tool calls
    for (const toolCall of llmResponse.toolCalls) {
        await mcpClient.callTool(toolCall);
    }

    // Refresh tools for next turn
    tools = mcpToolsToOpenAiTools(mcpClient.getTools());
}
```

**Trade-off:** ~10-15% slower (100-200ms per turn) but supports dynamic workflows.

**Location:** `conversation-executor.ts`

### 3. Strict Pass/Fail (No Threshold)

**Decision:** ALL tests must pass for exit code 0. Any failure = exit code 1.

**Why:**
- Clear CI/CD signal
- No ambiguity about which tests are critical
- Quality bar: all functionality must work

**Exit codes:**
- `0`: ALL tests passed
- `1`: ANY test failed or error occurred

**Location:** `run-workflow-evals.ts`

### 4. Judge Sees Tool Calls, Not Results

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

**Location:** `workflow-judge.ts`

### 5. LLM Client Shared, MCP Client Isolated

**Decision:** One LLM client shared across tests, MCP client isolated per test.

**Why:**
- LLM client is stateless (OpenRouter/OpenAI SDK)
- No cross-test contamination risk
- Saves initialization overhead

**Location:** `run-workflow-evals.ts`

### 6. Agent vs Judge Models

**Agent:** `anthropic/claude-haiku-4.5` (fast, good at tools)<br>
**Judge:** `deepseek/deepseek-v4-flash` (strong reasoning)

Separation allows independent optimization for speed vs evaluation quality.

**Location:** `config.ts`

### 7. MCP Server Instructions in System Prompt

**Decision:** Automatically append MCP server instructions to agent system prompt.

**Why:**
- MCP servers can provide usage guidelines via the `instructions` field in the initialize response
- Instructions contain important context about tool dependencies and disambiguation
- Agents perform better when they understand tool relationships (e.g., `call-actor` requires two steps)
- Avoids duplicating server instructions in our agent prompt

**Implementation:**
```typescript
// Retrieve instructions after connecting to MCP server
await mcpClient.start(apifyToken);
const serverInstructions = mcpClient.getInstructions();

// Append to agent system prompt
const conversation = await executeConversation({
    userPrompt: testCase.query,
    mcpClient,
    llmClient,
    serverInstructions, // Automatically appended to system prompt
});
```

**Instructions content:**
- Actor concepts and execution workflow
- Tool dependencies (e.g., `call-actor` two-step process)
- Tool disambiguation (e.g., `search-actors` vs `apify/rag-web-browser`)
- Storage types (datasets vs key-value stores)

**Location:** `mcp-client.ts`, `conversation-executor.ts`

## System Components

### Core Files

- `types.ts` - Type definitions
- `config.ts` - Models, prompts, constants, Opik connection config
- `mcp_client.ts` - MCP server wrapper (spawn, connect, call, retrieve instructions)
- `llm_client.ts` - OpenRouter wrapper (accepts an injected, optionally traced, OpenAI client)
- `conversation_executor.ts` - Multi-turn loop with dynamic tools and server instructions
- `workflow_judge.ts` - Judge evaluation logic (prompt, structured output)
- `workflow_judge_metric.ts` - Opik scoring metric wrapping `workflow_judge.ts`
- `opik_client.ts` - Opik client factory, server preflight, git metadata, experiment/dataset naming
- `test_cases_loader.ts` - Load/filter test cases
- `output_formatter.ts` - Results formatting
- `results_writer.ts` - Persist results to `results.json`
- `run_workflow_evals.ts` - Main CLI entry (Opik `evaluate()` runner)

## Configuration

### Environment Variables

Required:
```bash
export APIFY_TOKEN="your_apify_token"           # Get from https://console.apify.com/account/integrations
export OPENROUTER_API_KEY="your_openrouter_key" # Get from https://openrouter.ai/keys
```

Optional (Opik connection):
```bash
export OPIK_URL_OVERRIDE="http://localhost:5173/api"  # Opik API URL (default). Never the Comet cloud URL.
export OPIK_API_KEY="..."                             # Only needed for a remote/Comet Opik; not for local
```

The runner defaults to the local server (`http://localhost:5173/api`), workspace `default`, project `workflow-evals`. It never falls through to Opik's Comet-cloud default.

### CLI Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--category <name>` | | Filter tests by category | All categories |
| `--id <id>` | | Run specific test by ID | All tests |
| `--test-cases-path <path>` | | Custom test cases file path | `test_cases.json` |
| `--agent-model <model>` | | Override agent model | `anthropic/claude-haiku-4.5` |
| `--judge-model <model>` | | Override judge model | `deepseek/deepseek-v4-flash` |
| `--tool-timeout <seconds>` | | Tool call timeout | `60` |
| `--concurrency <number>` | `-c` | Number of tests to run in parallel (Opik `taskThreads`) | `4` |
| `--output` | `-o` | Save results to JSON file | `false` |
| `--baseline <path>` | | Results JSON to compare against (prints byte/token deltas) | `results.json` |
| `--help` | | Show help message | - |

Filters (`--category`, `--id`) still sync the full test set into the Opik dataset; only the matching items are run and recorded as experiment items.

### Concurrency

The `--concurrency` (or `-c`) option controls how many tests run in parallel; it maps to Opik's `taskThreads`.

**Concurrency recommendations:**
- **Default (4)**: Balanced performance for most systems
- **8-12**: High-performance systems with good network bandwidth
- **1**: Debug mode, run tests sequentially
- **Higher values**: May hit API rate limits or resource constraints

**Example:**
```bash
# Run 8 tests in parallel
pnpm run evals:workflow -- --concurrency 8
pnpm run evals:workflow -- -c 8
```

**Note:** Each test spawns its own MCP server instance, so higher concurrency uses more system resources.

### Tool Timeout

The `--tool-timeout` option sets the maximum time (in seconds) to wait for a single tool call to complete.

**When a tool times out:**
- Error returned: `"MCP error -32001: Request timed out"`
- The LLM receives this error and can decide how to proceed

**Timeout recommendations:**
- **Default (60s)**: Suitable for most tools (search, fetch details)
- **300s (5 min)**: For Actor calls that scrape moderate amounts of data
- **600s (10 min)**: For large-scale scraping operations
- **1s (testing)**: Use for testing timeout behavior

**Example:**
```bash
# Long-running Actor calls
pnpm run evals:workflow -- --tool-timeout 300
```

### Saving Results to File

The `--output` (or `-o`) option saves test results to `evals/workflows/results.json` for tracking over time.

**How it works:**
- Results are stored per combination of: `agentModel:judgeModel:testId`
- Running the same test with the same models **overwrites** the previous result
- Running with different model combinations **adds** new entries
- Results are **versioned in git** for historical tracking

**Data structure:**
```json
{
  "version": "1.0",
  "results": {
    "anthropic/claude-haiku-4.5:x-ai/grok-4.1-fast:search-google-maps": {
      "timestamp": "2026-01-07T10:45:23.123Z",
      "agentModel": "anthropic/claude-haiku-4.5",
      "judgeModel": "x-ai/grok-4.1-fast",
      "testId": "search-google-maps",
      "verdict": "PASS",
      "reason": "Agent successfully searched for Google Maps actors",
      "durationMs": 5234,
      "turns": 3,
      "resultBytes": 18452,
      "promptTokens": 6231,
      "completionTokens": 412,
      "totalTokens": 6643,
      "error": null
    }
  }
}
```

**Each result contains:**
- `timestamp` - ISO timestamp when test was run
- `agentModel` - LLM model used for the agent
- `judgeModel` - LLM model used for judging
- `testId` - Test case identifier
- `verdict` - `PASS` or `FAIL`
- `reason` - Judge reasoning or error message
- `durationMs` - Test duration in milliseconds
- `turns` - Number of conversation turns
- `resultBytes` - Total UTF-8 bytes of tool results returned to the agent across the conversation (measured at the point each result is fed to the LLM, so it reflects what the agent actually receives). Compare across branches to quantify byte savings.
- `promptTokens` / `completionTokens` / `totalTokens` - Tokens billed across all agent LLM calls (summed over turns; judge calls excluded). Tokens — not bytes — are what fill the context window, so this is the primary cost signal. Bytes are a deterministic, tokenizer-free proxy.
- `error` - Error message if execution failed, `null` otherwise

**Examples:**
```bash
# Basic usage - save all test results
pnpm run evals:workflow -- --output
pnpm run evals:workflow -- -o

# Save results for specific category
pnpm run evals:workflow -- --category search --output

# Compare different agent models
pnpm run evals:workflow -- --agent-model anthropic/claude-haiku-4.5 --output
pnpm run evals:workflow -- --agent-model openai/gpt-4o --output
# Results file now contains entries for both models

# Compare different judge models
pnpm run evals:workflow -- --judge-model x-ai/grok-4.1-fast --output
pnpm run evals:workflow -- --judge-model openai/gpt-4o --output
```

**Partial runs:**
When using filters (`--category`, `--id`), only the filtered tests are updated in the results file. Other entries remain unchanged.

**Version control:**
The `results.json` file is tracked in git, allowing you to:
- See result changes over time in commits
- Compare results across branches
- Track performance regressions in PRs

### Comparing against a baseline (byte/token deltas)

Every run automatically compares against a baseline and prints per-test and aggregate **deltas** for tool bytes and tokens — no manual file diffing. This is how you answer "did this change grow the response size?".

- **Default baseline** is the committed `evals/workflows/results.json`. Each test is matched by its `agentModel:judgeModel:testId` key.
- **Custom baseline:** `--baseline <path>` compares against any saved results file.
- Deltas read as `▼ -2.1 KB / -10.2%` (reduction) or `▲ +900 / +3.4%` (increase). Lower is better for both metrics.
- This is **reporting only** — a regression never fails the run. Task success (all tests PASS) is the hard gate.

```bash
# Compare the current code against the committed baseline (default)
pnpm run evals:workflow

# Compare against a saved baseline file
cp evals/workflows/results.json /tmp/baseline.json
pnpm run evals:workflow -- --baseline /tmp/baseline.json   # prints byte/token deltas vs the baseline
```

> **Bootstrap note:** records written before these metrics existed have no `resultBytes`/`*Tokens` fields, so the first run after this change shows `(no baseline)` for them and writes fresh values with `--output`. Subsequent runs show real deltas.

### Test Case Format

File: `test-cases.json`

```json
[
  {
    "id": "test-001",
    "category": "basic",
    "prompt": "User prompt for agent",
    "requirements": "What agent must do to pass",
    "maxTurns": 10,
    "tools": ["actors", "docs"]
  }
]
```

**Required fields:**
- `id` - Unique identifier
- `category` - For filtering
- `prompt` - User request
- `requirements` - Success criteria for judge

**Optional:**
- `maxTurns` - Override default (10)
- `tools` - List of tools to enable for this test (e.g., `["actors", "docs", "apify/rag-web-browser"]`). If omitted, all default tools are enabled. Passed to MCP server as `--tools` argument.
- `failTools` - Tool names the harness force-fails with a synthetic `INTERNAL_ERROR` result carrying the real `report-problem` nudge, instead of calling the server (e.g. `["call-actor"]`). Use it to deterministically throw a nudge-eligible error that the live server + API cannot reproduce on demand, e.g. to test that the agent proactively calls `report-problem` after a failure. See `mcp_client.ts`.

## Performance

**Per test overhead:**
- MCP spawn: ~1-2s
- Tool refresh/turn: ~100-200ms
- LLM call/turn: ~1-5s
- Judge evaluation: ~2-4s

**5 tests (2-3 turns each):** ~45s total

**vs shared MCP (previous):** ~37s (18% faster but unsafe)

Trade-off: Slower execution for correctness and isolation is acceptable.

## Key Insights

### MCP Tools Are Stateful

Unlike typical function calling:
- Create persistent state (datasets, runs) on Apify platform
- Can modify tool registry dynamically
- Have side effects affecting subsequent calls

**Implication:** Test isolation critical.

### Dynamic Tool Registration

- `add-actor` dynamically registers new Actor tools
- Tool list NOT static
- Must refresh after tool execution

**Implication:** Cannot cache tools at conversation start.

### Error Propagation

Tool errors passed to LLM in tool result message:
- LLM can retry, use different tool, or explain to user
- No automatic retry by system

**Rationale:** LLM should handle errors intelligently.

### Conversation State

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

## Common Issues

### Tests interfere with each other
**Symptom:** Test 2 fails after Test 1, passes alone.<br>
**Solution:** ✅ Isolated MCP instances per test.

### LLM can't use newly added tool
**Symptom:** Agent uses `add-actor` but can't call new tool.<br>
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

## Future Enhancements

### Possible bug with MCP server Actors

**Issue:** The workflow test run sometimes hangs and I just discovered there were two running MCP server Actors and once I killed them the test run finished instantly. So maybe the client is waiting for the Actors to finish?

### Three-LLM Conversational Approach

**Concept:** More realistic simulation of MCP usage through chat interface.

**Architecture:**
1. **User LLM** - Given a goal, prompts the MCP Server LLM to accomplish tasks
2. **MCP Server LLM** - Receives prompts from User LLM, uses MCP tools to fulfill requests
3. **Judge LLM** - Evaluates the entire conversation for correctness

**Benefits:**
- Simulates real-world chat interface usage pattern
- Tests natural language interaction between user and MCP-enabled assistant
- More realistic conversation flow with back-and-forth dialogue
- Better evaluation of how users would actually interact with MCP tools

**Current approach vs Future:**
- **Current:** Single LLM directly given task → uses tools → judge evaluates
- **Future:** User LLM with goal → prompts Server LLM → Server LLM uses tools → judge evaluates

**Status:** Current two-LLM approach (agent + judge) is sufficient for validating tool functionality and basic workflows. The three-LLM approach would be valuable for testing conversational UX and more complex multi-turn interactions.

## References

- [MCP Protocol Spec](https://modelcontextprotocol.io/)
- [OpenAI Tool Calling](https://platform.openai.com/docs/guides/function-calling)
- [Apify API](https://docs.apify.com/api/v2)
- [OpenRouter](https://openrouter.ai/)
