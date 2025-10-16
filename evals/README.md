# MCP tool selection evaluation

Evaluates MCP server tool selection. Phoenix used only for storing results and visualization.

## CI Workflow

The evaluation workflow runs automatically on:
- **Master branch pushes** - for production evaluations (saves CI cycles)
- **PRs with `validated` label** - for testing evaluation changes before merging

To trigger evaluations on a PR, add the `validated` label to your pull request.

## Two evaluation methods

1. **exact match** (`tool-exact-match`) - binary tool name validation
2. **LLM judge** (`tool-selection-llm`) - Phoenix classifier with structured prompt

## Why OpenRouter?

unified API for Gemini, Claude, GPT. no separate integrations needed.

## Judge model

- model: `openai/gpt-4o-mini`
- prompt: structured eval with context + tool definitions
- output: "correct"/"incorrect" → 1.0/0.0 score (and explanation)

## Config (`config.ts`)

```typescript
MODELS_TO_EVALUATE = ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'google/gemini-2.5-flash']
PASS_THRESHOLD = 0.6
TOOL_SELECTION_EVAL_MODEL = 'openai/gpt-4o-mini'
```

## Setup

```bash
export PHOENIX_BASE_URL="your_url"
export PHOENIX_API_KEY="your_key"
export OPENROUTER_API_KEY="your_key"
export OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"

npm ci
npm run evals:create-dataset  # one-time
npm run evals:run
```

## Test cases

40+ cases across 7 tool categories: `fetch-actor-details`, `search-actors`, `apify-slash-rag-web-browser`, `search-apify-docs`, `call-actor`, `get-actor-output`, `fetch-apify-docs`

## Output

- Phoenix dashboard with detailed results
- console: pass/fail per model + evaluator
- exit code: 0 = success, 1 = failure

## Adding new test cases

### How to contribute?

1. **Create an issue or PR** with your new test cases
2. **Explain why it should pass** - add a `reference` field with clear reasoning
3. **Test locally** before submitting
4. **Publish** - we'll review and merge

### Test case structure

Each test case in `test-cases.json` has this structure:

```json
{
  "id": "unique-test-id",
  "category": "tool-category",
  "query": "user query text",
  "expectedTools": ["tool-name"],
  "reference": "explanation of why this should pass (optional)",
  "context": [/* conversation history (optional) */]
}
```

### Simple examples

**Basic tool selection:**
```json
{
  "id": "fetch-actor-details-1",
  "category": "fetch-actor-details",
  "query": "What are the details of apify/instagram-scraper?",
  "expectedTools": ["fetch-actor-details"]
}
```

**With reference explanation:**
```json
{
  "id": "fetch-actor-details-3",
  "category": "fetch-actor-details",
  "query": "Scrape details of apify/google-search-scraper",
  "expectedTools": ["fetch-actor-details"],
  "reference": "It should call the fetch-actor-details with the actor ID 'apify/google-search-scraper' and return the actor's documentation."
}
```

### Advanced examples with context

**Multi-step conversation flow:**
```json
{
  "id": "weather-mcp-search-then-call-1",
  "category": "flow",
  "query": "Now, use the mcp to check the weather in Prague, Czechia?",
  "expectedTools": ["call-actor"],
  "context": [
    { "role": "user", "content": "Search for weather MCP server" },
    { "role": "assistant", "content": "I'll help you to do that" },
    { "role": "tool_use", "tool": "search-actors", "input": {"search": "weather mcp", "limit": 5} },
    { "role": "tool_result", "tool_use_id": 12, "content": "Tool 'search-actors' successful, Actor found: jiri.spilka/weather-mcp-server" }
  ]
}
```
