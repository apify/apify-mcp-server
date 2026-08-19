# Code Mode eval — runbook

A/B experiment: does `apify/code-runtime` (Code Mode) beat normal Actor tool use
(Manual)? Seven tests, T1–T7, spanning a range of task shapes and sizes.

**This runbook is deliberately blind.** It states no expected outcome for any test, and
no per-test hypothesis about which mode should win or why. Grade only against the
mechanical check printed under each test. If you find yourself reasoning about which
mode "should" have won, stop — that reasoning is not in this file for a reason.

## The one variable

Each test runs twice. The query, model, and tools are identical. The only difference
is one line prepended to the query:

| Mode | Line |
|---|---|
| Manual | `Do not use apify/code-runtime.` |
| Code | `You must use apify/code-runtime. Do all data processing inside it.` |

Both lines must compel, not permit. `Use apify/code-runtime.` was tried and does not
work: agents read it as permission, judge the task too small to be worth a sandboxed
script, and silently run Manual — producing a Code column that is a second Manual run.
The compulsion is part of the variable being tested, not a hint.

Do not add anything else — no output format, no procedural hints, no field names, no
tool bans beyond the mode line. Extra instructions change agent behaviour and
contaminate the comparison.

## How to run

One subagent per (test, mode), on **Sonnet 5**:

```
Agent(subagent_type: "general-purpose", model: "sonnet",
      run_in_background: false, prompt: <preamble> + <mode line> + <query>)
```

Always set `model` explicitly. A subagent without it inherits the parent session's
model, and token counts are model-specific — mixing models across a comparison
invalidates it.

Subagents start without the Apify MCP schemas loaded, so the preamble is:

```
The Apify MCP tools are available but their schemas are not loaded. Use ToolSearch
with query "select:mcp__apify-dev-3001__search-actors,mcp__apify-dev-3001__fetch-actor-details,mcp__apify-dev-3001__call-actor,mcp__apify-dev-3001__get-dataset-items,mcp__apify-dev-3001__apify--code-runtime"
to load them before use.
```

The Code Mode tool is in that list on purpose. Leaving it out makes the Code mode line
unactionable, and whether an agent then thinks to search for it on its own becomes an
uncontrolled variable.

Run the two modes of a test back to back, so both hit the same live data.

## What to record

| Field | Where from |
|---|---|
| mode held | did the run actually use the mode it was assigned? |
| tokens | subagent transcript (see Cost below) — not the harness `subagent_tokens` counter |
| wall-clock | session duration for the subagent |
| retries | count re-issued Actor calls / re-run scripts in the transcript |
| Apify cost | `apify runs ls <actor> --limit N --desc` |
| LLM cost | tokens × the rates below |
| pass/fail | the test's grading check below |
| model | Sonnet 5 — record it with every number |

Check **mode held** first, before anything else. Ask the finished subagent to list the
tool calls it made, in order. A Code run that never called `apify--code-runtime`, or a
Manual run that did, is void — discard both modes of that test and re-run the pair. Its
numbers are not a result, and a defected Code run looks like a narrow Code Mode win
because it *is* a Manual run.

Then grade pass/fail. A mode can win every efficiency number and still fail.

## Cost

Two components, both required — a mode can win on tokens and lose on Actor spend.

**Tokens.** The harness's `subagent_tokens` field is a single number and is not the
billed input/output split; pricing it directly gives the wrong answer, and can invert
the ranking. Sum the real usage from the subagent transcript at
`~/.claude/projects/<project>/<session>/subagents/agent-<agentId>.jsonl`:

```
jq -s '[.[] | select(.message.usage) | select(.timestamp < "<cutoff>") | .message.usage]
  | {in:(map(.input_tokens//0)|add), cache_w:(map(.cache_creation_input_tokens//0)|add),
     cache_r:(map(.cache_read_input_tokens//0)|add), out:(map(.output_tokens//0)|add)}' agent-<id>.jsonl
```

Set `<cutoff>` to just after the run's last turn. Follow-up messages to the subagent
(the mode-held audit) land in the same file and must not be counted as run cost.

**Rates** ($/MTok input / output). Cache write bills at 1.25× input on a 5-minute TTL,
2× on a 1-hour TTL; cache read at 0.1× input. Record which TTL was assumed.

| Model | Input | Output |
|---|---|---|
| Sonnet 5 | 2.00 | 10.00 |
| Sonnet 5 (from 2026-09-01) | 3.00 | 15.00 |
| Opus 5 / Opus 4.8 | 5.00 | 25.00 |

**Apify.** `apify runs ls <actor> --limit N --desc` gives per-run usage in USD. Match
runs by start time. Code mode bills the `apify/code-runtime` run *and* every Actor run
it starts from inside the sandbox — sum all of them, plus any probe runs the agent made
to discover field names. Never read these from the API with curl.

## Why there are no answer keys

The underlying data is live and changes between runs, so the same query minutes apart
returns different results. A fixed answer key would measure that drift rather than the
mode. Each test therefore has a **grading check** that holds whatever the live data
says.

---

## T1

```
I'm mapping out who owns search visibility in the web-data-for-AI market. Using the
Google Search Results Scraper (apify/google-search-scraper), search for each of
these:

best web scraping api, firecrawl alternatives, exa vs tavily, best search api for
llm, web scraping mcp server, best crawler for rag, tavily alternatives, apify vs
firecrawl, web search api for ai agents, best data extraction api

Across all ten sets of results, which domains dominate? Give me the top 10 by how
many times they appear, along with their average ranking position.
```

**Grading check.** The run must report roughly 7–9 organic results per query (~70–90
total). Reporting ~10 total means it counted dataset items instead of unnesting the
results inside them. Also check the top-10 list is genuinely ordered by appearance
count — an entry with fewer appearances than an excluded domain is a fail.

## T2

```
Using the Website Content Crawler (apify/website-content-crawler), crawl these 12
documentation sites, about 5 pages each, and rank them by how long their average
page is in words:

docs.apify.com/academy, qdrant.tech/documentation, weaviate.io/developers/weaviate,
milvus.io/docs, docs.trychroma.com, redis.io/docs/latest, docs.crawlee.dev,
playwright.dev/docs/intro, docs.pytest.org/en/stable, vitest.dev/guide,
docs.astro.build/en/getting-started, svelte.dev/docs
```

**Grading check.** All 12 sites present with a non-zero page count. A site silently
dropped after a failed run is a fail. Note in the transcript whether the run hit the
account memory ceiling and how it recovered.

## T3

```
Using the YouTube Scraper (streamers/youtube-scraper), pull 150 videos for me — 30
each across these topics: web scraping tutorial, playwright automation, vector
database tutorial, rag pipeline tutorial, browser automation python.

For channels that show up at least twice, give me the 10 with the best median
engagement (likes per view), with their video count and subscriber count.
```

**Grading check.** Around 150 videos collected; every channel listed has at least 2
videos; the reported statistic is a median, not a mean.

## T4

```
Using the Google Search Results Scraper (apify/google-search-scraper), search for:
open source observability stack, open source feature flags, open source workflow
orchestration.

Take the 10 best-ranked distinct domains across all three searches, then use the
Website Content Crawler (apify/website-content-crawler) to crawl each of those sites
(a few pages each) and tell me each one's homepage title and how many words of
content it has in total.
```

**Grading check.** Exactly 10 distinct domains selected, and all 10 crawled. Far
fewer than 10 domains means the search results were not unnested correctly. Crawling
fewer sites than were selected means work was dropped silently.

## T5

```
Compare these six vector databases for me: Milvus, Qdrant, Weaviate, Chroma,
pgvector, FAISS.

For each one, use the YouTube Scraper (streamers/youtube-scraper) to find about 10
videos about it and total up the views, and use the Website Content Crawler
(apify/website-content-crawler) to crawl its documentation site and measure how much
documentation it has.

Rank them by (total views / 1000) + (documentation words / 1000).
```

**Grading check.** All 6 products present, each with non-null values from both the
video and the documentation side. A product missing one side means the join dropped
it. Record which documentation URL each mode chose — the URLs are deliberately not
given, so the two modes may pick differently, and that must stay separable from join
quality.

---

## T6

```
Using the YouTube Scraper (streamers/youtube-scraper), search "kubernetes tutorial"
and find me the 5 best videos that actually teach Kubernetes from scratch. Skip the
clickbait, the paid course adverts, the conference talks and the "top 10 tools"
listicles — I want real hands-on tutorials.
```

**Grading check — graded on the answer, not process.** Open the 5 videos each mode
returned and count how many are genuinely hands-on beginner tutorials. Record the hit
count out of 5 alongside the efficiency numbers. Judge each video on its own merits;
do not let a mode's tool usage influence the count.

## T7

```
Using the YouTube Scraper (streamers/youtube-scraper), what are the top 3 videos for
"apify web scraping"? Just title, views and channel.
```

**Grading check.** 3 videos returned. This test measures cost, not correctness — it
isolates the fixed cost of each mode on the smallest possible task, which is the
baseline every other test's margin is measured against. Run it even though it looks
trivial.
