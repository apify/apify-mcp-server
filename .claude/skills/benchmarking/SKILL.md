---
name: benchmarking
description: >-
  Benchmark comparing two ways an AI agent can use the Apify MCP server:
  (A) standard MCP (tools in context) vs (B) MCP-CLI via mcpc shell commands.
  Produces test scenarios, runs them, logs everything, and reports metrics.
argument-hint: "--repeats <n> [--model <name>] [--output-dir <path>]"
allowed-tools: [Read, Glob, Grep, Bash, WebFetch, WebSearch, Agent]
---

# Apify MCP vs MCP-CLI Benchmark

Compare two conditions for an AI agent using the Apify MCP server:

- **Condition A (`mcp-native`)**: MCP server tools loaded directly into agent context. Agent makes structured tool calls (e.g. `search-actors`, `call-actor`, `fetch-actor-details`).
- **Condition B (`mcp-cli`)**: Agent uses `mcpc` CLI to call the same MCP server via shell commands (e.g. `mcpc @apify tools-call search-actors keywords:="web scraper"`).

Both conditions hit the **same Apify MCP server** — only the interface differs.

## Source documents

This benchmark design is informed by:

1. **AXI — Agent eXperience Interface** (Kun Chen, 2026): 10 design principles for agent-ergonomic CLI, benchmarking methodology across 985 runs comparing MCP vs CLI vs AXI across browser automation and GitHub API domains. Key insight: the interface design (not protocol choice) determines agent success rate and cost efficiency.
2. **[apify/awesome-skills](https://github.com/apify/awesome-skills)**: Community collection of real-world Apify agent workflows used as inspiration for scenario design.
3. **[apify/mcpc](https://github.com/apify/mcpc)**: Apify's MCP CLI client (`mcpc`), the tool used for Condition B.

## What we measure

| Metric | Formula | Notes |
|--------|---------|-------|
| Success rate | `succeeded / total_runs` | Binary pass/fail per scenario |
| Avg tokens | `sum(total_tokens) / total_runs` | Input + output combined |
| Avg cost | `sum(cost_usd) / total_runs` | Based on model pricing |
| Avg duration | `sum(duration_s) / total_runs` | Wall-clock seconds |
| Avg turns | `sum(turns) / total_runs` | One turn = one agent action |

Rules:
- Failed and timed-out runs stay in the denominator.
- Report both "all runs" and "success-only" averages.

## Setup

### Condition A: `mcp-native`

The agent has Apify MCP tools registered directly in its tool context. It calls them like any other MCP tool:

```
Tool: search-actors
Arguments: { "keywords": "web scraper" }
```

### Condition B: `mcp-cli`

The agent connects to the same server via `mcpc` and calls tools through shell:

```bash
mcpc connect "npx -y @apify/actors-mcp-server" @apify
mcpc @apify tools-call search-actors keywords:="web scraper" --json
```

The agent parses JSON stdout and decides next steps.

### Environment invariants

- Same model and version for both conditions
- Same system prompt (minus the interface-specific instructions)
- Same Apify token and account
- Fresh workspace per run (no shared state)
- Same timeout budget per scenario

## Test scenarios

### Category 1: Discovery (single-step)

#### `search_actor_by_keyword`
- **Goal**: Find a web scraping Actor for Instagram.
- **Prompt**: "Search the Apify Store for an Instagram scraper and tell me the name of the most popular one."
- **Ground truth**: The answer must contain a valid Actor name from the store (e.g. `apify/instagram-scraper` or similar top result).
- **Success rubric**: Agent returns a real Actor `username/name` slug that exists in the Apify Store.

#### `get_actor_details`
- **Goal**: Get the input schema of a specific Actor.
- **Prompt**: "Get the input schema for the Actor `apify/web-scraper` and list its required fields."
- **Ground truth**: The answer must list actual required fields from the Actor's input schema.
- **Success rubric**: Agent returns at least the `startUrls` required field.

### Category 2: Execution (multi-step)

#### `run_actor_minimal_input`
- **Goal**: Run an Actor with minimal valid input and confirm it started.
- **Prompt**: "Run the Actor `apify/web-scraper` with startUrls set to `https://example.com` and tell me the run ID and status."
- **Ground truth**: A valid run ID is returned and status is one of READY/RUNNING/SUCCEEDED.
- **Success rubric**: Agent returns a real Apify run ID (alphanumeric string).

#### `run_actor_and_get_output`
- **Goal**: Run an Actor, wait for it, and retrieve output.
- **Prompt**: "Run `apify/web-scraper` with startUrls `https://example.com`, wait for it to finish, and show me the first item from the dataset."
- **Ground truth**: Agent returns at least one dataset item with a `url` field.
- **Success rubric**: Output contains structured data from the run's default dataset.

### Category 3: Investigation (multi-step)

#### `compare_two_actors`
- **Goal**: Compare two Actors and recommend one.
- **Prompt**: "Compare `apify/web-scraper` and `apify/cheerio-scraper`. Tell me which one has more users and what the key differences are based on their descriptions."
- **Ground truth**: Agent fetches details for both and makes a comparison.
- **Success rubric**: Answer mentions both Actors by name and includes at least one factual difference.

#### `explore_actor_output_schema`
- **Goal**: Understand what data an Actor produces.
- **Prompt**: "What fields does the output dataset of `apify/instagram-scraper` contain? Get the dataset schema or run it with a minimal example to find out."
- **Ground truth**: Agent returns actual field names from the dataset schema or a sample run.
- **Success rubric**: Answer lists at least 3 real output field names.

## Run logging

### Per-run record (`results/runs.jsonl`)

One JSON object per line:

```json
{
  "run_id": "uuid",
  "condition": "mcp-native",
  "scenario_id": "search_actor_by_keyword",
  "repeat": 1,
  "model": "claude-sonnet-4-20250514",
  "started_at": "2026-03-31T12:00:00Z",
  "ended_at": "2026-03-31T12:00:25Z",
  "duration_s": 25.0,
  "status": "succeeded",
  "success": true,
  "input_tokens": 5200,
  "output_tokens": 800,
  "total_tokens": 6000,
  "cost_usd": 0.021,
  "turns": 3,
  "tool_calls": 2,
  "failure_reason": null,
  "transcript_path": "artifacts/uuid/transcript.jsonl"
}
```

### Per-turn event log (`artifacts/<run_id>/transcript.jsonl`)

One JSON object per agent turn:

```json
{
  "turn": 1,
  "ts": "2026-03-31T12:00:02Z",
  "type": "tool_call",
  "tool": "search-actors",
  "latency_ms": 1200,
  "status": "ok",
  "input_tokens_so_far": 2400,
  "output_tokens_so_far": 150
}
```

This is enough to reconstruct the full conversation flow and compute per-tool latencies.

## Judging

- **Judge**: LLM evaluator (same model or stronger) with a fixed prompt template.
- **Decision**: Binary pass/fail based on the success rubric for each scenario.
- **Stored**: Full judge input/output saved to `artifacts/<run_id>/judge.json`.
- **Ambiguity rule**: If the judge is uncertain, mark as `failed` and flag for manual review.

## Report format

After all runs complete, produce `results/report.md`:

```markdown
# Benchmark: Apify MCP vs MCP-CLI
## Config
- Model: ...
- Repeats per scenario: ...
- Total runs: ...

## Leaderboard
| Condition  | Success | Avg Cost | Avg Duration | Avg Tokens | Avg Turns |
|------------|---------|----------|--------------|------------|-----------|
| mcp-native | ...     | ...      | ...          | ...        | ...       |
| mcp-cli    | ...     | ...      | ...          | ...        | ...       |

## Per-scenario breakdown
| Scenario                   | mcp-native | mcp-cli |
|----------------------------|------------|---------|
| search_actor_by_keyword    | 5/5        | 4/5     |
| ...                        | ...        | ...     |

## Failure analysis
(list failure reasons grouped by condition)

## Observations
(notable trajectory differences, cost outliers, recovery patterns)
```

## Execution checklist

1. Set up environment (model, token, pricing config).
2. For each scenario x condition x repeat:
   a. Create fresh workspace.
   b. Run the agent with the scenario prompt.
   c. Log the run record.
   d. Save transcript.
   e. Run judge.
3. Validate all logs (no missing fields, correct run count).
4. Compute metrics.
5. Generate report.

## Validation gates

Before publishing results:
- `expected_runs == actual_runs` (no missing logs)
- All JSONL lines parse correctly
- Recomputed metrics match reported metrics
- At least one transcript spot-checked per condition
