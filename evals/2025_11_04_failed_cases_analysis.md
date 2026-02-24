# Failed Cases Analysis & Implementation Guide

## Summary

103 failed test cases across 6 experiments. fix by improving tool descriptions (most important factor per `evals/README.md`).

**Failed cases:** 103
- experiment-cb4f5987004088687b05ab69: 11
- experiment-86552f5159c0ae4c4b3d92b2: 16  
- experiment-435995e92aaced9c46c5859c: 22
- experiment-9eb78796dd81ed5083eb2d58: 20
- experiment-d5587019ccdc52204cce0064: 20
- experiment-4dd9f161222374467d278cdc: 14

**Phoenix:** https://app.phoenix.arize.com/s/apify

---

## Implementation Strategy

⚠️ **Critical warning (from evals/README.md line 217-219):**
> **Never use an LLM to automatically fix tool descriptions.**
> Always make improvements **manually**, based on your understanding of the problem.
> LLMs are very likely to worsen the issue instead of fixing it.

**Guidelines (from evals/README.md):**
1. update one tool at a time (changing multiple tools simultaneously is untraceable)
2. focus on exact tool match first (easier to debug and track)
3. prioritize descriptions over examples (descriptions are most important)
4. test incrementally (subset → full dataset)
5. verify across multiple models (different models may behave differently)

**Tool description best practices (from evals/README.md):**
- Provide extremely detailed descriptions (most important factor)
- Explain: what it does, when to use it (and when not), what each parameter means
- Prioritize descriptions over examples (add examples only after comprehensive description)
- Aim for at least 3-4 sentences, more if complex
- Start with "use this when..." and call out disallowed cases

**Workflow:**
1. analyze phoenix results to understand the problem
2. manually write/update tool description based on understanding
3. `npm run evals:run`
4. check phoenix dashboard
5. verify no regressions
6. iterate experimentally (trial and error)
7. move to next tool

---

## Issue categories & fixes

### 1. 🔴 Critical: `call-actor` - step="info" vs step="call" confusion

**File:** `src/tools/actor.ts` lines 333-361  
**Impact:** ~30 cases (29%)

**Problem:**
LLM uses `step="info"` when user explicitly requests execution with parameters.

**Failed cases:**
- "Run apify/instagram-scraper to scrape #dwaynejohnson" → got `step="info"`, expected `step="call"` with hashtag
- "Call apify/google-search-scraper to find restaurants in London" → got `step="info"`, expected `step="call"` with query
- "Call epctex/weather-scraper for New York" → got `step="info"`, expected `step="call"` with location

**Root cause:**
Lines 349-358 say "MANDATORY TWO-STEP-WORKFLOW" and "You MUST do this step first", making LLM always start with "info" even when user explicitly requests execution.

**What needs to be addressed in description:**

1. **Clarify when to use step="info" vs step="call":**
   - add explicit "when to use step='info'" section at top
   - add explicit "when to use step='call' directly" section
   - emphasize: if user explicitly requests execution with parameters → use step="call" directly
   - only use step="info" if user asks about details or you need to discover schema

2. **Make workflow less prescriptive:**
   - change "MANDATORY TWO-STEP-WORKFLOW" to "two-step workflow (when needed)"
   - remove "You MUST do this step first" language
   - explain workflow is optional when user provides clear execution intent

3. **Add clear disallowed cases:**
   - do not use step="info" when user explicitly requests execution
   - do not use step="info" when user provides parameters in query

4. **Add examples (after comprehensive description):**
   - correct: user requests execution → step="call"
   - correct: user asks about parameters → step="info"
   - wrong: user requests execution → step="info"

⚠️ **Note:** Write the description manually based on understanding the problem. Do not use LLM-generated descriptions.

**Testing:**
- Filter by `category: "call-actor"` and `expectedTools: ["call-actor"]`
- focus on execution requests
- verify no regressions

---

### 2. 🟠 High: `search-actors` - keyword selection issues

**File:** `src/tools/store_collection.ts` lines 86-114  
**Impact:** ~35 cases (34%)

**Problem categories:**

#### 2a. Adding generic terms
**Failed cases:**
- "Find actors for scraping social media" → keywords: "social media scraper" (should be "social media")
- "What tools can extract data from e-commerce sites?" → keywords: "e-commerce scraper" (should be "e-commerce")
- "Find actors for flight data extraction" → keywords: "flight data extraction" (should be "flight data" or "flight booking")

**Root cause:**
Keyword rules exist at lines 47-48 in parameter description but are buried. LLM doesn't see them prominently.

**What needs to be addressed in description:**

1. **Move keyword rules to top of description:**
   - never include generic terms: "scraper", "crawler", "extractor", "extraction", "scraping"
   - use only platform names (instagram, twitter) and data types (posts, products, profiles)
   - add explicit examples: "instagram posts" (correct) | "instagram scraper" (wrong)

2. **Add simplicity rule:**
   - use simplest, most direct keywords possible
   - ignore additional context in user query (e.g., "about ai", "python")
   - if user asks "instagram posts about ai" → use keywords: "instagram posts" (not "instagram posts ai")

3. **Add single query rule:**
   - always use one search call with most general keyword
   - do not make multiple specific calls unless user explicitly asks for specific data types
   - example: "facebook data" → one call with "facebook" (not multiple calls for posts/pages/groups)

4. **Add "do not use" section:**
   - do not use for fetching actual data (news, weather, web content) → use apify-slash-rag-web-browser
   - do not use for running actors → use call-actor or dedicated actor tools
   - do not use for getting actor details → use fetch-actor-details
   - do not use for overly general queries → ask user for specifics

5. **Add "only use when" section:**
   - user specifies platform (instagram, twitter, amazon, etc.)
   - user specifies data type (posts, products, profiles, etc.)
   - user mentions specific service or website

⚠️ **Note:** Write the description manually based on understanding the problem. Do not use LLM-generated descriptions.

---

### 3. 🟡 Medium: wrong tool selection

**Impact:** ~20 cases (19%)

#### 3a. `search-actors` vs `apify-slash-rag-web-browser`

**Failed cases:**
- "Fetch recent articles about climate change" → used `search-actors`, expected `apify-slash-rag-web-browser`
- "Get the latest weather forecast for New York" → used `search-actors`, expected `apify-slash-rag-web-browser`
- "Get the latest tech industry news" → used `search-actors`, expected `apify-slash-rag-web-browser`

**Fix:**
Already covered in section 2 above (do not use section).

#### 3b. `call-actor` step="info" vs `fetch-actor-details`

**File:** `src/tools/fetch-actor-details.ts` lines 20-30

**Failed cases:**
- "What parameters does apify/instagram-scraper accept?" → used `call-actor` step="info", expected `fetch-actor-details`

**Root cause:**
Description doesn't clearly distinguish when to use `fetch-actor-details` vs `call-actor` step="info".

**What needs to be addressed in description:**

1. **add explicit "use this tool when" section:**
   - user asks about actor parameters, input schema, or configuration
   - user asks about actor documentation or how to use it
   - user asks about actor pricing or cost information
   - user asks about actor details, description, or capabilities

2. **add explicit "do not use" section:**
   - do not use `call-actor` with step="info" for these queries
   - use `fetch-actor-details` instead

3. **clarify distinction:**
   - `fetch-actor-details`: for getting actor information/documentation
   - `call-actor` step="info": for discovering input schema before calling (not for documentation queries)

⚠️ **Note:** Write the description manually based on understanding the problem. Do not use LLM-generated descriptions.

---

### 4. 🟢 Low: Missing Tool Calls

**Impact:** ~12 cases (12%)

**Failed cases:**
- "How does apify/rag-web-browser work?" → no tool called, expected `fetch-actor-details`
- "documentation" → no tool called, expected `search-apify-docs`
- "Look for news articles on AI" → no tool called, expected `apify-slash-rag-web-browser`

**Fix:**
Add "must use" section to each tool description. This might be model/configuration issue, but clearer guidance helps.

---

### 5. 🟢 Low: General Query Handling

**Impact:** ~6 cases (6%)

**Failed cases:**
- "Find actors for data extraction tasks" → used `search-actors`, expected to ask for specifics

**Fix:**
Already covered in section 2 above (do not use for overly general queries).

---

## Implementation Priority

### Phase 1: Quick Wins
1. fix `call-actor` description (when to use step="call" vs step="info")
2. fix `search-actors` keyword rules (move to top, add rules)
3. add "do not use" sections

**Estimated impact:** ~65 cases resolved (63%)

### Phase 2: Medium Priority
4. improve `fetch-actor-details` vs `call-actor` distinction
5. add explicit guidance about `apify-slash-rag-web-browser` vs `search-actors`

**Estimated impact:** ~30 cases resolved (29% of remaining)

### Phase 3: Lower Priority
6. add general query handling guidance
7. improve missing tool call handling (may require system prompt changes)

**Estimated impact:** ~8 cases resolved (8% of remaining)

---

## Code Changes

### `src/tools/actor.ts` lines 333-361
- add "when to use" section at top
- reorganize workflow (less prescriptive)
- add examples

### `src/tools/store_collection.ts` lines 86-114
- move keyword rules to top
- add "do not use" section
- add simplicity rule
- add single query rule

### `src/tools/fetch-actor-details.ts` lines 20-30
- add "use this tool when" section
- add "do not use call-actor" warning

---

## Testing

1. `npm run evals:run`
2. check phoenix dashboard
3. verify phase 1 cases now pass
4. check for regressions
5. iterate on phase 2

---

## Notes

- some test cases may have ambiguous expected behavior
- tool descriptions should be verbose and explicit
- examples come after comprehensive descriptions
- update one tool at a time, test incrementally
