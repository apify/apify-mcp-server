# MCP Tool Calling Evaluations

This directory contains Python-based evaluations for the Apify MCP Server using Arize Phoenix platform.

## Overview

The evaluation system tests how well different AI models can correctly identify and call the appropriate MCP tools based on user questions. It runs automatically in CI/CD on master branch merges and generates detailed reports.

## Quick Start

### 1. One-time Setup: Create Phoenix Dataset

```bash
# Set required environment variables
export PHOENIX_API_KEY="your_phoenix_api_key"
export OPENAI_API_KEY="your_openai_api_key" 
export ANTHROPIC_API_KEY="your_anthropic_api_key"
export APIFY_TOKEN="your_apify_token"

# Create dataset in Phoenix (run once)
python3 evals/create_dataset.py
```

### 2. Export Current Tools

```bash
# Export current tool definitions to tools.json
npm run evals:export-tools
```

### 3. Run Evaluations

```bash
# Run evaluations via vitest
npm run test:evals

# Or run directly with Python
npm run test:evals:dev
```

## Files

- `pyproject.toml` - Python dependencies (uses uv)
- `config.py` - Configuration settings
- `test_cases.json` - Ground truth test cases
- `create_dataset.py` - One-time Phoenix dataset creation
- `run_evaluation.py` - Main evaluation script
- `eval.test.ts` - Vitest wrapper for CI/CD integration

## Configuration

Key settings in `config.py`:

- `PHOENIX_ENDPOINT` - Phoenix platform URL
- `MODELS_TO_EVALUATE` - List of models to test
- `PASS_THRESHOLD` - Accuracy threshold (default: 85%)
- `SYSTEM_PROMPT` - System prompt for models

## Test Cases

Test cases are stored in `test_cases.json` with the following structure:

```json
{
  "version": "1.0",
  "test_cases": [
    {
      "id": "unique-id",
      "category": "tool-category",
      "question": "User question",
      "expected_tools": ["expected-tool-name"]
    }
  ]
}
```

## CI/CD Integration

Evaluations run automatically on master branch merges via dedicated GitHub Actions workflow (`.github/workflows/evaluations.yaml`):

1. Exports current tool definitions
2. Installs Python dependencies with uv
3. Runs evaluations across configured models
4. Generates JSON and HTML reports
5. Uploads reports as artifacts
6. Comments on PRs with evaluation results (if applicable)

## Reports

Evaluation reports are generated in `evals/reports/`:

- `evaluation_results.json` - Machine-readable results
- `evaluation_report.html` - Human-readable dashboard

## Environment Variables

Required environment variables:

- `PHOENIX_API_KEY` - Arize Phoenix API key
- `OPENAI_API_KEY` - OpenAI API key
- `ANTHROPIC_API_KEY` - Anthropic API key
- `APIFY_TOKEN` - Apify platform token

## Troubleshooting

### Missing tools.json
```bash
npm run evals:export-tools
```

### Missing dataset_info.json
```bash
python3 evals/create_dataset.py
```

### Python dependencies
```bash
# Install with uv
uv pip install -e evals/

# Or with pip
pip install -e evals/
```

## Adding New Test Cases

1. Edit `test_cases.json`
2. Add new test case with unique ID
3. Specify expected tool(s) in `expected_tools` array
4. Set appropriate category

## Adding New Models

1. Edit `MODELS_TO_EVALUATE` in `config.py`
2. Ensure model is supported by OpenAI or Anthropic clients
3. Model will be automatically tested in next evaluation run
