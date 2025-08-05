
# LLM Scenario Testing for Apify MCP Server

This directory provides a framework for testing real-world LLM (Large Language Model) scenarios against the Apify MCP server. It enables automated evaluation of scenario outputs against defined requirements using the Amazon Q Developer CLI.

## Directory Structure

- `entries/` — Contains scenario JSON files. Each file defines a test scenario with input, requirements, and (optionally) expected output.
- `run.ts` — Script to execute a scenario and evaluate its output.

## Scenario Entry Format

Each scenario in `entries/` is a JSON file with the following structure:

```json
{
  "input": "<string describing the scenario, essentially the input prompt to the LLM>",
  "requirements": [
    "<requirement 1>",
    "<requirement 2>",
    "..."
  ]
}
```

**Example:**

```json
{
    "input": "Use Apify to show me latest post about Apify on Twitter/X.com.",
    "requirements": [
       "6 tool calls used at maximum",
       "needs to find appropriate Actor for Twitter/X.com scraping",
       "needs present the posts to the user"
    ]
}
```

## How It Works

1. **Scenario Execution:**
   - The scenario input is passed to the Amazon Q Developer CLI (`q chat -a --no-interactive <input>`).
   - The output is captured.

2. **Automated Evaluation:**
   - The output and requirements are combined into an evaluation prompt.
   - The prompt is sent to the Amazon Q Developer CLI to determine if the requirements are met.
   - The CLI must output a final verdict in the format:
     ```
     VERDICT: OK
     or
     VERDICT: FAILED
     ```

3. **Result:**
   - If `VERDICT: OK` is found in the evaluation output, the scenario passes.
   - Otherwise, it fails.

## Usage

### Prerequisites

- [Amazon Q Developer CLI](https://github.com/aws/amazon-q-developer-cli) must be installed and configured. See [official documentation](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line.html).

### Running a Scenario

From the `tests/scenarios/` directory, run:

```bash
node run.ts entries/<scenario-file>.json
```

Example:

```bash
node run.ts entries/find-restaurant-near.json
```

The script will print the scenario output, evaluation, and final verdict.

## Adding New Scenarios

1. Create a new JSON file in `entries/` following the format above.
2. Add meaningful requirements that can be evaluated from the output.
3. Run the scenario as described above.

## Notes

- The evaluation relies on the Amazon Q Developer CLI to interpret requirements and output a verdict.
- All scenario files must be valid JSON.