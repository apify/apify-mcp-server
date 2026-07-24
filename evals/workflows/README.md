# Workflow Evaluation System

Tests AI agents performing multi-turn conversations with Apify MCP tools, evaluated by an LLM judge. Results (traces, scores, dataset, experiment runs) are recorded in **Langfuse Cloud**.

---

## Quick Start

**Prerequisites:**
- Node.js installed
- Apify account with API token
- OpenRouter API key
- Langfuse Cloud project (public + secret key)

**Run evaluations:**
```bash
# 1. Set environment variables
export APIFY_TOKEN="your_apify_token"
export OPENROUTER_API_KEY="your_openrouter_key"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://us.cloud.langfuse.com"  # US, or https://cloud.langfuse.com for EU

# 2. Build the MCP server
pnpm run build

# 3. Run tests
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
```

**Exit codes:**
- `0` = All tests passed ✅
- `1` = Any test failed or error occurred ❌

Every run upserts all test cases from `test_cases.json` into the Langfuse dataset `workflow-evals` (by `id`, so it stays complete regardless of filters), then runs the filtered subset as an experiment named `workflow-evals`. The run name is `<git-branch>-<agent-model>-<timestamp>`.

---

## Technical Overview

Tests AI agents executing tasks using Apify MCP server tools through multi-turn conversations evaluated by an LLM judge.

**Core features:**
- Multi-turn conversations with tool calling
- Dynamic tool discovery during execution
- MCP server instructions automatically added to agent system prompt
- LLM-based evaluation against requirements
- Isolated MCP server per test
- Configurable tool call timeout (default: 60 seconds)
- Strict pass/fail (all tests must pass)

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
- `config.ts` - Models, prompts, constants
- `mcp_client.ts` - MCP server wrapper (spawn, connect, call, retrieve instructions)
- `llm_client.ts` - OpenRouter wrapper (optionally wrapped with `observeOpenAI` for tracing)
- `conversation_executor.ts` - Multi-turn loop with dynamic tools and server instructions
- `workflow_judge.ts` - Judge evaluation
- `test_cases_loader.ts` - Load/filter test cases
- `output_formatter.ts` - `sumResultBytes` helper (tool-result byte total)
- `langfuse_tracing.ts` - OpenTelemetry + Langfuse span processor init/shutdown, env validation
- `langfuse_dataset.ts` - Get-or-create dataset and upsert test cases
- `langfuse_experiment.ts` - Experiment task, evaluators, run-name/item helpers
- `run_workflow_evals.ts` - Main CLI entry

## Configuration

### Environment Variables (Required)

```bash
export APIFY_TOKEN="your_apify_token"           # Get from https://console.apify.com/account/integrations
export OPENROUTER_API_KEY="your_openrouter_key" # Get from https://openrouter.ai/keys
export LANGFUSE_PUBLIC_KEY="pk-lf-..."          # Langfuse Cloud project settings
export LANGFUSE_SECRET_KEY="sk-lf-..."          # Langfuse Cloud project settings
export LANGFUSE_BASE_URL="https://us.cloud.langfuse.com"  # US, or https://cloud.langfuse.com (EU)
```

All three Langfuse vars are required; the runner fails fast (before any test runs) if any is missing and prints the two valid `LANGFUSE_BASE_URL` values.

### CLI Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--category <name>` | | Filter tests by category | All categories |
| `--id <id>` | | Run specific test by ID | All tests |
| `--test-cases-path <path>` | | Custom test cases file path | `test_cases.json` |
| `--agent-model <model>` | | Override agent model | `anthropic/claude-haiku-4.5` |
| `--judge-model <model>` | | Override judge model | `deepseek/deepseek-v4-flash` |
| `--tool-timeout <seconds>` | | Tool call timeout | `60` |
| `--concurrency <number>` | `-c` | Number of items to run in parallel (`maxConcurrency`) | `4` |
| `--help` | | Show help message | - |

### Concurrency

The `--concurrency` (or `-c`) option controls how many tests run in parallel.

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

### Results in Langfuse

Results are recorded in Langfuse Cloud, not to a local file. Each run:

- **Syncs the dataset** `workflow-evals` — every test case in `test_cases.json` is upserted by `id`, so the dataset stays complete regardless of `--id`/`--category` filters.
- **Runs an experiment** named `workflow-evals`, run name `<git-branch>-<agent-model>-<timestamp>`, with run metadata `{ agentModel, judgeModel, toolTimeout }`.
- **Traces** every item's agent/judge LLM calls (via `observeOpenAI`) and each MCP tool call (as a `tool` observation with its arguments and result) nested under the item's trace.
- **Scores** each item with three evaluators:
  - `workflow_judge` — `1` if the judge verdict is PASS, else `0` (comment = judge reason). This is the strict gate; an errored item scores `0`.
  - `total_tokens` — agent LLM tokens billed across the conversation.
  - `result_bytes` — UTF-8 bytes of tool results returned to the agent.

The console prints a compact pass/fail line per item plus a `passed/total` summary and the run link. Exit code is `0` only if every item scored `workflow_judge === 1`; otherwise `1`.

Compare tokens/bytes across runs (branches, models) directly in the Langfuse experiment view.

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
