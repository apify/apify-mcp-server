---
name: benchmarking
description: >-
  Benchmark comparing two ways an AI agent can use the Apify MCP server:
  (A) standard MCP (tools in context) vs (B) mcpc CLI to remote mcp.apify.com.
  Runs test scenarios, logs results, extracts token costs from session JSONL.
argument-hint: "run scenarios 1-3 for mcp-native"
allowed-tools: [Bash, Write, Edit]
---

# Apify MCP Benchmark

Compare two ways an AI agent can use the Apify MCP server:

- **`mcp-native`**: MCP tools loaded in context. Agent calls `search-actors`, `call-actor`, etc. directly.
- **`mcp-cli`**: No MCP tools. Agent uses `mcpc` CLI via Bash (e.g. `mcpc @apify-prod tools-call search-actors keywords:="web scraper" --json | jq .`).

Both hit the same Apify MCP server at mcp.apify.com — only the interface differs.

## Scenarios

Eight scenarios. Each has a prompt to send verbatim and a success rubric.

| # | ID | Prompt | Success rubric |
|---|---|---|---|
| 1 | `search_actor_by_keyword` | "Search the Apify Store for an Instagram scraper and tell me the name of the most popular one." | Returns a real `username/name` Actor slug |
| 2 | `get_actor_details` | "Get the input schema for the Actor `apify/instagram-scraper` and list its required fields." | Lists at least `directUrls` or `username` |
| 3 | `run_actor_and_get_output` | "Run `apify/instagram-scraper` for the username `natgeo`, scrape 1 post, and show me the first item from the dataset." | Returns structured data with a `url` or `shortCode` field |
| 4 | `compare_two_actors` | "Compare `apify/web-scraper` and `apify/cheerio-scraper`. Tell me which one has more users and what the key differences are based on their descriptions." | Mentions both Actors and at least one factual difference |
| 5 | `local_business_lead_gen` | "Find 5 Italian restaurants in San Francisco using Apify. For each, give me the name, address, phone number, and website URL." | At least 3 businesses with name, address, and one contact detail |
| 6 | `ecommerce_price_comparison` | "Search Apify for an Amazon product scraper. Then use it to get the price, title, and rating for this product URL: `https://www.amazon.com/dp/B0CHX3QBCH`. Show me the results." | Includes product title, price, and rating |
| 7 | `instagram_profile_analysis` | "Use Apify to get the public profile data for the Instagram account `natgeo`. Tell me their follower count, post count, and bio." | Includes follower count, post count, and bio text |
| 8 | `google_maps_review_analysis` | "Find an Apify Actor for scraping Google Maps reviews. Get the 10 most recent reviews for 'Chez Panisse Berkeley'. Summarize the overall sentiment and mention the average star rating." | Includes sentiment summary, average rating, and 2+ review themes |

## How to run

### Session isolation — MANDATORY

**Each condition requires its own dedicated, fresh Claude Code session. Never mix conditions in the same session.**

The entire point of this benchmark is to compare the baseline context cost of the two approaches:
- `mcp-native` loads ~7700 tokens of MCP tool definitions into context at startup
- `mcp-cli` starts with near-zero tool-definition overhead

If you run `mcp-cli` scenarios in a session that already has `mcp-native` context (or vice versa), the `ctx_start` values are garbage and the comparison is invalid.

**Before running any scenarios, verify your session is correct:**

```bash
# Check whether MCP tools are loaded — for mcp-cli this MUST return 0
mcpc @apify-prod tools-list 2>/dev/null | wc -l   # irrelevant — check Claude's context instead
```

The correct way to check: if you can call MCP tools directly (e.g. `search-actors` appears as a tool in Claude's tool list), you are in an `mcp-native` session. If the only way to call them is via `mcpc ... | jq`, you are in an `mcp-cli` session.

**STOP and tell the user to restart in the correct session type if there is a mismatch.**

Do NOT read or reference `runs.jsonl` entries from a previous session's condition when running a new condition. Each set of runs for a condition is self-contained.

### 1. Run scenarios

For **mcp-native**: start Claude Code normally (MCP servers loaded). **Before the first scenario**, run `/context` and record the baseline token count — this captures the cost of MCP tool definitions in context. Then run each scenario prompt. The agent calls MCP tools directly.

For **mcp-cli**: start Claude Code with `--no-mcp` (no MCP servers). Run `/context` to capture the baseline (should be near zero — no tool defs in context). Then run each scenario prompt. The agent must use `mcpc @apify-prod tools-call ... --json | jq .` via Bash. Requires `mcpc login https://mcp.apify.com` beforehand.

**Always resolve the session ID from the filesystem — never guess it:**
```bash
ls -t ~/.claude/projects/-home-jirka-apify-apify-mcp-server/*.jsonl | head -1
```

Record the baseline in `evals/benchmark/runs.jsonl` as a special entry with `scenario_id: "_baseline"`, then one line per scenario:

```jsonc
{
  "session_id": "be242ce4-...",     // basename of Claude Code session JSONL (without .jsonl)
  "condition": "mcp-native",        // or "mcp-cli"
  "scenario_id": "search_actor_by_keyword",
  "scenario_index": 1,
  "model": "claude-sonnet-4-6",
  "started_at": "2026-03-31T20:33:33Z",  // timestamp BEFORE sending the prompt
  "ended_at": "2026-03-31T20:33:50Z",    // timestamp AFTER agent finishes
  "duration_s": 17.0,
  "success": true,
  "failure_reason": null,
  "turns": 1,
  "tool_calls": 1
  // token fields are null — filled by extract-benchmark.ts
}
```

### 2. Extract tokens

After all scenarios are done, run the extractor with the Claude Code session JSONL path:

```bash
npx tsx evals/benchmark/extract-benchmark.ts <path-to-session.jsonl>
```

The session JSONL lives at `~/.claude/projects/<project-dir>/<session_id>.jsonl`.

The script:
- Filters assistant turns by each run's `[started_at, ended_at]` window
- Deduplicates streaming chunks (Claude Code emits identical usage objects per chunk)
- Computes per-run: `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `total_tokens`, `cost_usd`
- Computes context delta: `total_input` (`cache_read + cache_creation + input`) on last vs first unique turn
- Updates `evals/benchmark/runs.jsonl` in place
- Prints a summary table including `cache%` (fraction of total tokens served from cache)

**Always run the extractor after all scenarios, then:**
1. Show the full printed table (including TOTAL row) in your response
2. Write the results to `evals/benchmark/results-<condition>-<date>.md` using the Write tool, with this format:

```markdown
# Benchmark results — <condition> (<model>)

**Date:** <date>
**Session:** <session_id>
**Scenarios run:** <n>

| scenario | ctx_start | ctx_delta | input | output | cache_write | cache_read | total | cache% | cost | dur | success |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _baseline | - | - | 0 | 0 | 0 | 0 | 0 | - | $0 | 0s | - |
| search_actor_by_keyword | ... | ... | ... | ... | ... | ... | ... | ...% | $... | ...s | true |
| ... |
| **TOTAL** | - | - | <sum> | <sum> | <sum> | <sum> | <sum> | <pct>% | $<sum> | <sum>s | |
```

Use plain text in the `success` column: `true`, `false`, or `-` (for baseline). No emojis.
```

## What we measure

| Metric | Notes |
|--------|-------|
| Success | Binary pass/fail per scenario based on rubric |
| Duration | Wall-clock seconds (`ended_at - started_at`) |
| Turns | Number of agent actions |
| Context Δ | `total_input_last_turn - total_input_first_turn` per scenario |
| Token breakdown | `input`, `output`, `cache_write`, `cache_read` from JSONL |
| Cost | Computed from token breakdown × model pricing |
