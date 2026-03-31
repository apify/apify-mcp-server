---
name: benchmarking
description: >-
  Benchmark comparing two ways an AI agent can use the Apify MCP server:
  (A) standard MCP (tools in context) vs (B) mcpc CLI to remote mcp.apify.com.
  Produces test scenarios, runs them, logs everything, and reports metrics.
argument-hint: "--repeats <n> [--model <name>] [--output-dir <path>]"
allowed-tools: [Read, Glob, Grep, Bash, WebFetch, WebSearch, Agent]
---

# Apify MCP Benchmark: Native vs Remote mcpc CLI

Compare two conditions for an AI agent using the Apify MCP server:

- **Condition A (`mcp-native`)**: MCP server tools loaded directly into agent context. Agent makes structured tool calls (e.g. `search-actors`, `call-actor`, `fetch-actor-details`).
- **Condition B (`mcpc-remote`)**: Agent uses `mcpc` CLI to call the remote https://mcp.apify.com MCP server via shell commands (e.g. `mcpc @apify-prod tools-call search-actors keywords:="web scraper"`).

Both conditions hit the **same Apify MCP server at mcp.apify.com** — only the interface differs.

## Source documents

This benchmark design is informed by:

1. **AXI — Agent eXperience Interface** (Kun Chen, 2026): 10 design principles for agent-ergonomic CLI, benchmarking methodology across 985 runs comparing MCP vs CLI vs AXI across browser automation and GitHub API domains. Key insight: the interface design (not protocol choice) determines agent success rate and cost efficiency.
2. **[apify/awesome-skills](https://github.com/apify/awesome-skills)**: Community collection of real-world Apify agent workflows used as inspiration for scenario design.
3. **[apify/mcpc](https://github.com/apify/mcpc)**: Apify's MCP CLI client (`mcpc`), the tool used for Condition B.

## What we measure

| Metric | Formula | Notes |
|--------|---------|-------|
| Success rate | `succeeded / total_runs` | Binary pass/fail per scenario |
| Avg tokens | `sum(total_tokens) / total_runs` | Input + output + cache tokens per scenario, from JSONL |
| Avg cost | `sum(cost_usd) / total_runs` | Based on model pricing |
| Avg duration | `sum(duration_s) / total_runs` | Wall-clock seconds |
| Avg turns | `sum(turns) / total_runs` | One turn = one agent action |
| Session ctx growth | `ctx_end_tokens - ctx_start_tokens` | Whole-session context window delta (from `/context` at start + end) |

Rules:
- Failed and timed-out runs stay in the denominator.
- Report both "all runs" and "success-only" averages.
- Per-scenario token fields are populated **post-run** by filtering the session JSONL by timestamp window — never estimated.
- `/context` is captured **once at session start and once at session end** — gives total context growth for the session, not per-scenario.

## Execution model

**Two sessions total** — one per condition. Each session runs all 8 scenarios sequentially. `/context` is captured **only at session start and end** — not between scenarios. Per-scenario token costs are extracted post-run from the JSONL history file using timestamp windows.

```
Session A — mcp-native  (MCP tools loaded)
──────────────────────────────────────────────
/context  →  ctx_start  (record tokens + window size)

=== SCENARIO 1: search_actor_by_keyword ===
<agent runs scenario — record started_at, ended_at>

=== SCENARIO 2: get_actor_details ===
<agent runs scenario — record started_at, ended_at>

... (8 scenarios total)

/context  →  ctx_end  (record tokens + window size)
ctx_growth = ctx_end - ctx_start  (whole session)

Session B — mcpc-remote  (no MCP tools, Bash only)
──────────────────────────────────────────────────
(same pattern)
```

### Phase 1: Run phase

Run Session A then Session B. For each scenario: print the delimiter, run the scenario. Record `started_at`, `ended_at`, turns, tool calls, success/failure.

### Phase 2: Token extraction phase (post-run)

After all runs complete, ask the user for their Claude Code session history directory. Extract per-scenario token costs from the JSONL by filtering assistant turns within each scenario's `started_at`/`ended_at` window. Also extract session-level totals for cost accounting.

## Session setup

The two sessions require **different Claude Code configurations**:

| | `mcp-native` | `mcpc-remote` |
|---|---|---|
| MCP servers | `apify-prod` loaded | **none** (MCP disabled) |
| Tools available | `search-actors`, `call-actor`, etc. | `Bash` only |
| Context baseline | ~5–6k tokens (MCP tool defs) | ~0k (no tool defs) |
| Claude Code flags | default | `--no-mcp` or remove MCP servers from config |

The **first message** of each session must be an identifying header:

```
=== BENCHMARK SESSION ===
condition: mcp-native
session_id: <uuid>
scenarios: all (8)
=========================
```

Each scenario within the session is separated by this delimiter (sent as a message before the scenario prompt):

```
=== SCENARIO 3: run_actor_and_get_output ===
```

Run `/context` **once before the first scenario** (record `ctx_start_tokens`) and **once after the last scenario** (record `ctx_end_tokens`). Do not run `/context` between scenarios.

## Setup

### Launching a session for Condition A: `mcp-native`

Start Claude Code normally with the Apify MCP server registered. The agent calls MCP tools directly:

```bash
claude --model claude-haiku-4-5-20251001
# MCP config includes apify-prod server
```

The agent calls tools like:
```
Tool: search-actors
Arguments: { "keywords": "web scraper" }
```

### Launching a session for Condition B: `mcpc-remote`

Start Claude Code with **MCP servers disabled** so no tool definitions are loaded into context. The agent uses only `Bash`:

```bash
claude --model claude-haiku-4-5-20251001 --no-mcp
# Or: temporarily remove apify-prod from ~/.claude/settings.json MCP config
```

The agent calls tools via shell:
```bash
mcpc @apify-prod tools-call search-actors keywords:="web scraper" --json | jq .
```

**Authentication**: Requires `mcpc login https://mcp.apify.com` configured before the benchmark starts.

### Environment invariants

- Same model and version for both conditions
- Same system prompt (minus the interface-specific instructions)
- Same Apify token and account
- Fresh Claude Code session per run — **condition-appropriate config** (MCP on vs off)
- Same timeout budget per scenario
- `/context` baseline captured immediately after session start, before the benchmark header is sent

## Test scenarios

Eight scenarios covering discovery, execution, investigation, and real-world workflows from [apify/awesome-skills](https://github.com/apify/awesome-skills).

### Discovery (single-step)

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

### Execution (multi-step)

#### `run_actor_and_get_output`
- **Goal**: Run an Actor, wait for it, and retrieve output.
- **Prompt**: "Run `apify/web-scraper` with startUrls `https://example.com`, wait for it to finish, and show me the first item from the dataset."
- **Ground truth**: Agent returns at least one dataset item with a `url` field.
- **Success rubric**: Output contains structured data from the run's default dataset.

#### `compare_two_actors`
- **Goal**: Compare two Actors and recommend one.
- **Prompt**: "Compare `apify/web-scraper` and `apify/cheerio-scraper`. Tell me which one has more users and what the key differences are based on their descriptions."
- **Ground truth**: Agent fetches details for both and makes a comparison.
- **Success rubric**: Answer mentions both Actors by name and includes at least one factual difference.

### Real-world workflows

_Derived from [apify/awesome-skills](https://github.com/apify/awesome-skills) community workflows._

#### `local_business_lead_gen`
- **Goal**: Find businesses on Google Maps and extract contact info.
- **Prompt**: "Find 5 Italian restaurants in San Francisco using Apify. For each, give me the name, address, phone number, and website URL."
- **Ground truth**: Agent discovers a Google Maps scraper (e.g. `compass/crawler-google-places`), runs it, and returns structured business data.
- **Success rubric**: Answer contains at least 3 businesses with name, address, and at least one contact detail (phone or website) each.
- **Covers**: lead-generation, Google Maps

#### `ecommerce_price_comparison`
- **Goal**: Extract product pricing data from an e-commerce platform.
- **Prompt**: "Search Apify for an Amazon product scraper. Then use it to get the price, title, and rating for this product URL: `https://www.amazon.com/dp/B0CHX3QBCH`. Show me the results."
- **Ground truth**: Agent finds an Amazon scraper Actor, runs it with the product URL, and returns product data.
- **Success rubric**: Answer includes the product title, a numeric price, and a rating value.
- **Covers**: e-commerce, price intelligence

#### `instagram_profile_analysis`
- **Goal**: Retrieve and analyze an Instagram profile's public metrics.
- **Prompt**: "Use Apify to get the public profile data for the Instagram account `natgeo`. Tell me their follower count, post count, and bio."
- **Ground truth**: Agent finds an Instagram profile scraper (e.g. `apify/instagram-profile-scraper`), runs it, and returns profile metrics.
- **Success rubric**: Answer includes a numeric follower count, post count, and the account's bio text.
- **Covers**: content-analytics, audience-analysis, influencer-discovery

#### `google_maps_review_analysis`
- **Goal**: Scrape and summarize reviews for a business from Google Maps.
- **Prompt**: "Find an Apify Actor for scraping Google Maps reviews. Get the 10 most recent reviews for 'Chez Panisse Berkeley'. Summarize the overall sentiment and mention the average star rating."
- **Ground truth**: Agent finds a Google Maps reviews scraper (e.g. `compass/Google-Maps-Reviews-Scraper`), runs it, and analyzes the output.
- **Success rubric**: Answer includes a sentiment summary, an average rating, and references at least 2 specific review themes.
- **Covers**: brand-reputation-monitoring, market-research, competitor-intelligence

## Run logging

### Per-session record (`results/sessions.jsonl`)

One record per condition × repeat session. Context fields filled in Phase 1; token fields in Phase 2:

```json
{
  "session_id": "351e434a-5c60-45ac-b47e-69b13313b547",
  "condition": "mcp-native",
  "repeat": 1,
  "model": "claude-haiku-4-5-20251001",
  "started_at": "2026-03-31T12:00:00Z",
  "ended_at": "2026-03-31T12:05:30Z",
  "ctx_start_tokens": 5200,
  "ctx_end_tokens": 68900,
  "ctx_growth_tokens": 63700,
  "ctx_window_size": 200000,
  "input_tokens": null,
  "output_tokens": null,
  "cache_creation_tokens": null,
  "cache_read_tokens": null,
  "total_tokens": null,
  "cost_usd": null
}
```

### Per-scenario record (`results/runs.jsonl`)

One JSON object per scenario. Token fields populated in Phase 2 by filtering the session JSONL by timestamp window:

```json
{
  "run_id": "uuid",
  "session_id": "351e434a-5c60-45ac-b47e-69b13313b547",
  "condition": "mcp-native",
  "scenario_id": "search_actor_by_keyword",
  "scenario_index": 1,
  "repeat": 1,
  "model": "claude-haiku-4-5-20251001",
  "started_at": "2026-03-31T12:00:00Z",
  "ended_at": "2026-03-31T12:00:25Z",
  "duration_s": 25.0,
  "status": "succeeded",
  "success": true,
  "turns": 3,
  "tool_calls": 2,
  "failure_reason": null,
  "input_tokens": null,
  "output_tokens": null,
  "cache_creation_tokens": null,
  "cache_read_tokens": null,
  "total_tokens": null,
  "cost_usd": null
}
```

- `session_id`: links to the parent session record
- `scenario_index`: 1-based order within the session
- token fields: populated post-run by filtering session JSONL to the `[started_at, ended_at]` window

### Context snapshot capture (Phase 1, in-session)

Run `/context` **once at session start** (before the first scenario) and **once at session end** (after the last scenario). Parse the output line like `claude-haiku-4-5-20251001 · 68.9k/200k tokens (34%)`:

```bash
parse_context() {
  # Input: one line like "model · 68.9k/200k tokens (34%)"
  # Output: two numbers — used_tokens window_tokens
  echo "$1" | grep -oP '[\d.]+k?/[\d.]+[kM]' | \
    awk -F'/' '{
      used=$1; total=$2
      sub(/k$/, "000", used); sub(/k$/, "000", total); sub(/M$/, "000000", total)
      printf "%d %d\n", used, total
    }'
}
```

Record `ctx_start_tokens` and `ctx_end_tokens` in `sessions.jsonl`. Compute `ctx_growth_tokens = ctx_end - ctx_start`.

**What `/context` measures vs JSONL tokens:**
- `/context` = current context window usage (active input tokens in this session)
- JSONL `usage` = cumulative API billing tokens (input + output + cache) across all turns
- Use `/context` for session-level context growth; use JSONL for per-scenario cost accounting

### Token extraction (Phase 2)

After all runs complete, ask the user:

> "Please provide the path to your Claude Code session history directory (e.g. `~/.claude/projects/-home-jirka-apify-apify-mcp-server/`)"

**Session-level totals** (update `sessions.jsonl`):

```bash
SESSION_FILE="<history_dir>/<session_id>.jsonl"

jq -s '
  [ map(select(.type == "assistant" and .message.usage != null) | .message.usage)
    | unique_by(.)[]
  ] |
  {
    input_tokens:          map(.input_tokens                // 0) | add // 0,
    output_tokens:         map(.output_tokens               // 0) | add // 0,
    cache_creation_tokens: map(.cache_creation_input_tokens // 0) | add // 0,
    cache_read_tokens:     map(.cache_read_input_tokens     // 0) | add // 0
  } | .total_tokens = (.input_tokens + .output_tokens + .cache_creation_tokens + .cache_read_tokens)
' "$SESSION_FILE"
```

**Per-scenario tokens** (update each run in `runs.jsonl`):

```bash
START="2026-03-31T12:00:00Z"   # run started_at
END="2026-03-31T12:00:25Z"     # run ended_at

jq -s --arg start "$START" --arg end "$END" '
  [ map(select(
      .type == "assistant" and
      .message.usage != null and
      .timestamp >= $start and
      .timestamp <= $end
    ) | .message.usage)
    | unique_by(.)[]
  ] |
  {
    input_tokens:          map(.input_tokens                // 0) | add // 0,
    output_tokens:         map(.output_tokens               // 0) | add // 0,
    cache_creation_tokens: map(.cache_creation_input_tokens // 0) | add // 0,
    cache_read_tokens:     map(.cache_read_input_tokens     // 0) | add // 0
  } | .total_tokens = (.input_tokens + .output_tokens + .cache_creation_tokens + .cache_read_tokens)
' "$SESSION_FILE"
```

`unique_by(.)` deduplicates exact-duplicate usage objects that Claude Code emits for the same API response. Compute `cost_usd` from `total_tokens` using the model's pricing.

## Judging

- **Judge**: LLM evaluator (same model or stronger) with a fixed prompt template.
- **Decision**: Binary pass/fail based on the success rubric for each scenario.
- **Stored**: `success` (bool) and `failure_reason` (string or null) inline in `runs.jsonl`.
- **Ambiguity rule**: If the judge is uncertain, mark as `failed` and record the reason in `failure_reason`.

## Report format

After all runs complete (and tokens populated), produce `results/report.md`:

```markdown
# Benchmark: Apify MCP vs MCP-CLI
## Config
- Model: ...
- Repeats per scenario: ...
- Total runs: ...

## Leaderboard
| Condition   | Success | Avg Cost | Avg Duration | Avg Tokens | Avg Turns |
|-------------|---------|----------|--------------|------------|-----------|
| mcp-native  | ...     | ...      | ...          | ...        | ...       |
| mcpc-remote | ...     | ...      | ...          | ...        | ...       |

## Per-scenario breakdown
| Scenario                   | mcp-native | mcpc-remote |
|----------------------------|------------|-------------|
| search_actor_by_keyword    | 5/5        | 4/5         |
| ...                        | ...        | ...         |

## Failure analysis
(list failure reasons grouped by condition)

## Observations
(notable trajectory differences, cost outliers, recovery patterns)
```

## Execution checklist

### Phase 1: Run both sessions

1. **Setup**: confirm model, mcpc auth (`mcpc login https://mcp.apify.com`), pricing config.

2. **Session A — `mcp-native`** (MCP tools loaded, default config):
   a. Start a fresh Claude Code session. Note the session file name from `~/.claude/projects/…/` (it appears on first message).
   b. Run `/context` — record `ctx_start_tokens` and `ctx_window_size`. Write initial session record to `results/sessions.jsonl`.
   c. Send the session header (see Session setup). Record `session_id`.
   d. **For each scenario i = 1..8:**
      - Record `started_at`. Send the scenario delimiter: `=== SCENARIO i: <scenario_id> ===`
      - Send the scenario prompt. Let the agent complete it.
      - Record `ended_at`, `turns`, `tool_calls`, `status`, `success`, `failure_reason`.
      - Write scenario record to `results/runs.jsonl` (token fields = `null`).
   e. Run `/context` — record `ctx_end_tokens`. Update session record with `ctx_end_tokens` and `ctx_growth_tokens`.

3. **Session B — `mcpc-remote`** (no MCP, `--no-mcp` flag):
   Repeat step 2 with `mcpc` CLI instead of MCP tools.

4. Validate all logs (no missing records, all JSON parses, 16 scenario records total).

### Phase 2: Populate token fields

5. Ask user for the Claude Code session history directory (e.g. `~/.claude/projects/-home-jirka-apify-apify-mcp-server/`).
6. For each session in `sessions.jsonl`, extract totals from `<history_dir>/<session_id>.jsonl` using the session-level jq. Update token fields and `cost_usd`.
7. For each run in `runs.jsonl`, extract per-scenario tokens using the timestamp-window jq with the run's `started_at`/`ended_at`. Update token fields and `cost_usd`.

### Phase 3: Report

8. Compute aggregate metrics (per-scenario `total_tokens` for efficiency; session totals for cost).
9. Generate `results/report.md`.

## Validation gates

Before publishing results:
- `expected_runs == actual_runs` (no missing logs)
- All JSONL lines parse correctly
- Token fields fully populated in both `sessions.jsonl` and `runs.jsonl` (no nulls remaining)
- `ctx_start_tokens` and `ctx_end_tokens` populated in `sessions.jsonl`
- Recomputed metrics match reported metrics
