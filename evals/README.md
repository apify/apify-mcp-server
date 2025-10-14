# MCP Tool Calling Evaluations

TypeScript-based evaluations for the Apify MCP Server using Arize Phoenix platform.

## Objectives

The MCP server tool calls evaluation has several key objectives:

1. **Identify problems** in the description of the tools
2. **Create a test suite** that can be run manually or automatically in CI
3. **Allow for quick iteration** on tool descriptions

## 1. ✍️ **Create test cases manually**

- **Pros:**
  - Straightforward approach
  - Simple to create test cases for each tool
  - Direct control over test scenarios

- **Cons:**
  - Complicated to create flows (several tool calls in a row)
  - Requires maintenance when MCP server changes
  - Manual effort for comprehensive coverage

## Test case examples

### Simple tool selection
```
"What are the best Instagram scrapers" → "search-actors"
```

### Multi-step flow
```
User: "Search for the weather MCP server and then add it to available tools"
Expected sequence:
1. search-actors (with input: {"search": "weather mcp", "limit": 5})
2. add-actor (to add the found weather MCP server)
```

## Workflow

The evaluation process has two steps:

1. **Create dataset** (if not exists) - Upload test cases to Phoenix
2. **Run evaluation** - Test models against ground truth

## Quick start

```bash
# 1. Set environment variables
export PHOENIX_BASE_URL="phoenix_base_url"
export PHOENIX_API_KEY="your_key"
export OPENAI_API_KEY="your_key"
export ANTHROPIC_API_KEY="your_key"

# 2. Install dependencies
npm ci

# 3. Create dataset (one-time)
npm run evals:create-dataset

# 5. Run evaluation
npm run evals:run
```

## Files

- `config.ts` - Configuration (models, threshold, Phoenix settings)
- `test-cases.json` - Ground truth test cases
- `run-evaluation.ts` - Main evaluation script
- `create-dataset.ts` - Upload test cases to Phoenix
- `evaluation_2025.ipynb` - Interactive analysis notebook (Python-based, requires `pip install -e .`)

## Configuration

Key settings in `config.ts`:
- `MODELS_TO_EVALUATE` - Models to test (default: `['gpt-4o-mini', 'claude-3-5-haiku-latest']`)
- `PASS_THRESHOLD` - Accuracy threshold (default: 0.8)
- `DATASET_NAME` - Phoenix dataset name

## Test cases

40+ test cases covering 7 tool categories:
- `fetch-actor-details` - Actor information queries
- `search-actors` - Actor discovery
- `apify-slash-rag-web-browser` - Web browsing
- `search-apify-docs` - Documentation search
- `call-actor` - Actor execution
- `get-actor-output` - Dataset retrieval
- `fetch-apify-docs` - Specific docs fetching

## Results

- **Phoenix Dashboard**: Detailed experiment results
- **Console Output**: Pass/fail status with threshold check
- **Exit Code**: 0 for success, 1 for failure (CI/CD ready)

## Troubleshooting

```bash
# Missing dataset
npm run evals:create-dataset

# Environment issues
# Make sure .env file exists with required API keys
```

## Adding test cases

1. Edit `test-cases.json`
3. Run `npm run evals:create-dataset`
