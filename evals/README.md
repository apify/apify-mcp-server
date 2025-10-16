# MCP tool selection evaluation

Evaluates MCP server tool selection. Phoenix used only for storing results and visualization.

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

## Updating test cases

to add/modify test cases:
1. edit `test-cases.json` 
2. run `npm run evals:create-dataset` to update Phoenix dataset
3. run `npm run evals:run` to test changes
