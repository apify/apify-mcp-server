# MCP Tool Calling Evaluations

Python-based evaluations for the Apify MCP Server using Arize Phoenix platform.

> **Note**: The TypeScript package had connection issues, so we use the Python implementation instead.

## Workflow

The evaluation process has 4 steps:

1. **Create dataset** (if not exists) - Upload test cases to Phoenix
2. **Update dataset ID** in `config.py` - Point to the correct Phoenix dataset  
3. **Export tools** - Get current MCP tool definitions
4. **Run evaluation** - Test models against ground truth

## Quick Start

```bash
# 1. Set environment variables
export PHOENIX_API_KEY="your_key"
export OPENAI_API_KEY="your_key" 
export ANTHROPIC_API_KEY="your_key"

# 2. Install dependencies
uv pip install -e evals/

# 3. Create dataset (one-time)
python3 evals/create_dataset.py

# 4. Update DATASET_NAME in config.py with the returned dataset ID

# 5. Export tools and run evaluation
npm run evals:export-tools
python3 evals/run_evaluation.py
```

## Files

- `config.py` - Configuration (models, threshold, Phoenix settings)
- `test_cases.json` - Ground truth test cases
- `run_evaluation.py` - Main evaluation script
- `create_dataset.py` - Upload test cases to Phoenix
- `export-tools.ts` - Export MCP tools to JSON
- `evaluation_2025.ipynb` - Interactive analysis notebook

## Configuration

Key settings in `config.py`:
- `MODELS_TO_EVALUATE` - Models to test (default: `['gpt-4o-mini', 'claude-3-5-haiku-latest']`)
- `PASS_THRESHOLD` - Accuracy threshold (default: 0.8)
- `DATASET_NAME` - Phoenix dataset name

## Test Cases

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
# Missing tools.json
npm run evals:export-tools

# Missing dataset
python3 evals/create_dataset.py

# Environment issues
python3 -c "from dotenv import load_dotenv; load_dotenv()"
```

## Adding Test Cases

1. Edit `test_cases.json`
2. Update version number
3. Run `python3 evals/create_dataset.py`
