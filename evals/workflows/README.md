# Workflow Evaluation System

Tests AI agents performing multi-turn conversations with Apify MCP tools, evaluated by an LLM judge.

---

## Quick Start

**Prerequisites:**
- Node.js installed
- Apify account with API token
- OpenRouter API key

**Run evaluations:**
```bash
# 1. Set environment variables
export APIFY_TOKEN="your_apify_token"
export OPENROUTER_API_KEY="your_openrouter_key"

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

# Filter by line range in test_cases.json
pnpm run evals:workflow -- --lines 277-283

# Show detailed conversation logs
pnpm run evals:workflow -- --verbose

# Increase timeout for long-running Actors (default: 60s)
pnpm run evals:workflow -- --tool-timeout 300

# Run tests in parallel (default: 4)
pnpm run evals:workflow -- --concurrency 8

# Save results to JSON file
pnpm run evals:workflow -- --output

# Run paired Code Mode evaluations
pnpm run evals:workflow -- \
  --test-cases-path evals/workflows/code_mode_test_cases.json \
  --results-path evals/workflows/code_mode_results.json \
  --tool-timeout 600 --concurrency 1 --output
```

**Exit codes:**
- `0` = All tests passed ✅
- `1` = Any test failed or error occurred ❌

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

### 4. Judge Sees Bounded Tool Results

**Decision:** Judge sees tool calls, final responses, and up to 4,000 characters from each tool result.

**Why:**
- Tool evidence lets the judge detect unsupported final answers
- Per-result bounds prevent large datasets from dominating judge context
- Errors and Code Runtime output remain visible

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
- `mcp-client.ts` - MCP server wrapper (spawn, connect, call, retrieve instructions)
- `llm-client.ts` - OpenRouter wrapper
- `convert-mcp-tools.ts` - MCP → OpenAI tool format
- `conversation-executor.ts` - Multi-turn loop with dynamic tools and server instructions
- `workflow-judge.ts` - Judge evaluation
- `test-cases-loader.ts` - Load/filter test cases
- `output-formatter.ts` - Results formatting
- `run-workflow-evals.ts` - Main CLI entry

## Configuration

### Environment Variables (Required)

```bash
export APIFY_TOKEN="your_apify_token"           # Get from https://console.apify.com/account/integrations
export OPENROUTER_API_KEY="your_openrouter_key" # Get from https://openrouter.ai/keys
```

### CLI Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--category <name>` | | Filter tests by category | All categories |
| `--id <id>` | | Run specific test by ID | All tests |
| `--lines <range>` | `-l` | Filter by line range in test-cases.json | All tests |
| `--verbose` | | Show detailed conversation logs | `false` |
| `--test-cases-path <path>` | | Custom test cases file path | `test_cases.json` |
| `--agent-model <model>` | | Override agent model | `anthropic/claude-haiku-4.5` |
| `--judge-model <model>` | | Override judge model | `deepseek/deepseek-v4-flash` |
| `--tool-timeout <seconds>` | | Tool call timeout | `60` |
| `--test-timeout <seconds>` | | Wall-clock timeout for one whole test case (agent + judge) | `300` |
| `--repeat <n>` | | Run each test case N times, print an aggregated pass/completion/error-rate summary | `1` |
| `--concurrency <number>` | `-c` | Number of tests to run in parallel | `4` |
| `--output` | `-o` | Save results to JSON file | `false` |
| `--results-path <path>` | | Results JSON file | `results.json` |
| `--baseline <path>` | | Results JSON to compare against (prints byte/token deltas) | results path |
| `--traces <path>` | | Write full per-turn traces (LLM output, tool calls, full args/results, untruncated) to this JSON file | not written |
| `--help` | | Show help message | - |

### Line Range Filtering

The `--lines` (or `-l`) option filters test cases by their line numbers in the `test_cases.json` file.

**Format options:**
- **Single line:** `--lines 100` (includes tests that contain line 100)
- **Range:** `--lines 10-20` (includes tests that overlap with lines 10-20)
- **Multiple ranges:** `--lines 10-20,50-60,100` (comma-separated, includes tests that overlap with any range)

**Overlap logic (inclusive):**
- A test case is included if it overlaps with ANY specified range
- Example: `--lines 277-283` includes tests that start before line 283 AND end after line 277

**Combine with other filters (AND logic):**
```bash
# Line range + category
pnpm run evals:workflow -- --lines 100-200 --category call

# Line range + ID pattern
pnpm run evals:workflow -- --lines 50-100 --id "search.*"

# All three filters
pnpm run evals:workflow -- --lines 277-283 --category mcp --verbose
```

**Error handling:**
- Invalid format (e.g., `abc-def`) → Error with usage examples
- Invalid range (e.g., `300-200`) → Error: start must be ≤ end
- Out of bounds (e.g., `500-600` when file has 319 lines) → Error with line count

**Use cases:**
- Debug specific test cases by examining their location in the JSON file
- Run tests added in a specific PR by targeting the affected line ranges
- Quickly iterate on a subset of tests during development

**Examples:**
```bash
# Single test at specific line
pnpm run evals:workflow -- --lines 283

# Range of tests
pnpm run evals:workflow -- --lines 277-283

# Multiple ranges
pnpm run evals:workflow -- --lines 10-20,50-60,100-110

# With verbose output for debugging
pnpm run evals:workflow -- --lines 277-283 --verbose
```

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

### Test Timeout

`--tool-timeout` bounds one tool call; `--test-timeout` bounds the whole test
case — the agent's full multi-turn conversation plus judging — so a test
stuck retrying (e.g. a bad tool-call loop) can't block the run indefinitely.
Default: `300` seconds.

When a test times out, it's recorded as `FAIL` with reason `"Test exceeded
its wall-clock timeout"` and the run moves on to the next test. The
abandoned work isn't cancelled mid-flight (no cancellation token threads
through the LLM/MCP clients) — the harness just stops waiting for it and
cleans up that test's MCP client.

```bash
pnpm run evals:workflow -- --test-timeout 600   # for slower models / long chains
```

### Repeated Runs (`--repeat`)

A single run of a test case can't distinguish "this approach is worse" from
ordinary run-to-run noise — flaky upstream Actors, model variance, and (at
higher `--concurrency`) rate-limit contention all inject noise unrelated to
the thing you're actually trying to measure. `--repeat <n>` runs each
(filtered) test case N times and prints an aggregated summary in addition to
the normal per-attempt table.

**Job scheduling:** each `(test case, attempt)` pair is its own job through
the same `--concurrency` limiter as any other run — repeats of one test case
interleave with everything else exactly like distinct test cases do. For a
clean, low-noise comparison, run with `--concurrency 1` yourself; `--repeat`
doesn't invent a separate sequential mode for that.

**What gets averaged, and what doesn't:**
- `--traces` and `--results-path` (`--output`) record **every attempt
  individually**, tagged with `attemptIndex`/`totalAttempts` — never
  averaged. Use these for the exact numbers behind any one run.
- The printed **Repeat Summary** aggregates per test case:
  - `passRate` (strict PASS / N) and `completionRate` ((PASS + judge-FAIL) /
    N) are reported separately — a wrong-but-complete answer and a timeout
    are different failure modes needing different fixes, so they're not
    collapsed into one number.
  - Duration/token/tool-byte stats (median + mean) are computed **only over
    completed attempts** (PASS or judge-FAIL). An errored or timed-out
    attempt is excluded from these — including it would bias the "typical
    duration" toward whatever the timeout cap happened to be, which isn't a
    real measurement of anything.
  - `timedOut` (exceeded `--test-timeout` specifically) is counted
    separately from other errors.

**Exit code:** `--repeat` exists to characterize flakiness across N
attempts, not to gate CI on one unlucky run — the process exits `0`
regardless of individual attempt outcomes when `--repeat > 1`. The default
(`--repeat 1`, unused) keeps the normal all-attempts-must-pass exit code.

```bash
pnpm run evals:workflow -- --test-cases-path evals/workflows/code_mode_test_cases.json \
    --repeat 5 --concurrency 1 --test-timeout 900 --traces /tmp/code_mode_traces.json
```

### Saving Results to File

The `--output` (or `-o`) option saves test results to `evals/workflows/results.json`, or `--results-path`, for tracking over time.

**How it works:**
- Every run appends an attempt; previous attempts remain available
- Records include agent and judge token usage separately
- Records include tool calls, policy violations, final response, and complete conversation trace
- Results can be versioned in git or written to an ignored local path

**Data structure:**
```json
{
  "version": "2.0",
  "attempts": [
    {
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
      "judgeUsage": { "promptTokens": 1800, "completionTokens": 40, "totalTokens": 1840 },
      "toolCalls": 3,
      "failedToolCalls": 0,
      "policyViolations": [],
      "finalResponse": "...",
      "toolCallTrace": [],
      "error": null
    }
  ]
}
```

**Each result contains:**
- `timestamp` - ISO timestamp when test was run
- `agentModel` - LLM model used for the agent
- `judgeModel` - LLM model used for judging
- `testId`, `pairId`, `arm` - Test and experiment identifiers
- `verdict` - `PASS` or `FAIL`
- `reason` - Judge reasoning or error message
- `durationMs` - Test duration in milliseconds
- `turns` - Number of conversation turns
- `resultBytes` - Total UTF-8 bytes of tool results returned to the agent across the conversation (measured at the point each result is fed to the LLM, so it reflects what the agent actually receives). Compare across branches to quantify byte savings.
- `promptTokens` / `completionTokens` / `totalTokens` - Tokens billed across all agent LLM calls; judge calls excluded
- `cachedPromptTokens` / `reasoningTokens` - Provider-reported agent usage details
- `judgeUsage` - Judge tokens, kept separate from agent usage
- `toolCalls`, `failedToolCalls`, `policyViolations` - Execution counters and policy failures
- `finalResponse`, `toolCallTrace` - Agent answer and tool-call trace (name, arguments, success, byte size, `startedAt`/`durationMs`), including generated Code Mode scripts; result bodies are excluded to keep the file compact
- `usedCodeRuntime` - Whether the agent called `apify/code-runtime` at least once. Informational only — does not gate pass/fail, since a code-mode-arm agent may legitimately call other Actors directly for discovery.
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

# Save a separate benchmark
pnpm run evals:workflow -- --output --results-path evals/workflows/code_mode_results.json
```

**Partial runs:**
When using filters (`--category`, `--id`), attempts are appended only for matching tests. Existing attempts remain unchanged.

**Version control:**
The `results.json` file is tracked in git, allowing you to:
- See result changes over time in commits
- Compare results across branches
- Track performance regressions in PRs

### Comparing against a baseline (byte/token deltas)

Every run automatically compares against a baseline and prints per-test and aggregate **deltas** for tool bytes and tokens — no manual file diffing. This is how you answer "did this change grow the response size?".

- **Default baseline** is the selected results path. Each test is matched by agent model and test ID.
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

### Full Traces (`--traces`)

`results.json`'s `toolCallTrace` is deliberately compact — it excludes tool
result bodies to stay small over time. To inspect exactly what happened in
one test case (every LLM final response, every tool call's full arguments,
every tool result's full untruncated content), pass `--traces <path>`. It
writes one JSON array, one entry per test case, and is meant for manual
review — not for committing or diffing.

```bash
pnpm run evals:workflow --test-cases-path evals/workflows/code_mode_test_cases.json --traces /tmp/code_mode_traces.json
```

Each entry: `testId`, `category`, `arm`, `pairId`, `query`, `durationMs`,
`error`, `verdict`, `judgeReason`, and `conversation` (the full
`ConversationHistory` — every turn's `toolCalls`, `toolResults` (including
`result`, the raw tool output), `usage`, and `finalResponse`).

Every turn also carries `llmStartedAt` (ISO timestamp) / `llmDurationMs` for
its LLM call, and every tool result carries `startedAt` / `durationMs` for
that specific call — enough to reconstruct a full timeline of where time
went (LLM thinking vs. a specific nested Actor call). These same two fields
are also included in `results.json`'s compact `toolCallTrace`.

**Traces are written even when a test times out (`--test-timeout`) or
errors** — the run's error/timeout path preserves whatever turns completed
before the cutoff, so a stuck test's trace still shows exactly which tool
call it was in and how long that call had already been running.

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
    "tools": ["actors", "docs"],
    "disallowedTools": ["add-actor"],
    "agentInstructions": "Use regular MCP tools.",
    "disallowedCallActorTargets": ["apify/code-runtime"],
    "pairId": "test-pair",
    "arm": "standard"
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
- `tools` - Server-side tool allowlist passed as `--tools`
- `disallowedTools` - Hide tools from the agent and reject direct calls
- `allowedCallActorTargets` / `disallowedCallActorTargets` - Restrict Actor IDs used through `call-actor` (optional; the shipped Code Mode cases only set `disallowedCallActorTargets: ["apify/code-runtime"]` on the standard arm — the code-mode arm leaves Actor targets unrestricted so the agent can call any Actor directly for discovery and still use `apify/code-runtime` for the actual processing)
- `agentInstructions` - Evaluation-only system instructions
- `pairId` / `arm` - Group standard and Code Mode variants of the same prompt

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
