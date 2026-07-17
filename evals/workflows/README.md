# Workflow Evaluation System

Tests AI agents performing multi-turn tasks against the Apify MCP server, scored by an LLM judge.

**Harbor executes, Opik observes.** Each test case becomes a [Harbor](https://github.com/harbor-framework/harbor) task that runs in a Docker container. Runs go through the `opik harbor run` wrapper (from the Python `opik` package), which logs every trial to the local self-hosted Opik as a trace: the agent trajectory steps become nested spans (tool calls, observations, token usage) and the verifier reward becomes a feedback score. Traces only. No Opik experiments, no Opik datasets.

---

## Architecture

```
run_workflow_evals.ts (host orchestrator)
  1. generate one Harbor task dir per test case      (task_generator.ts -> harbor/tasks/<id>/)
  2. build the shared image apify-mcp-evals:local     (harbor/Dockerfile)
  3. uv run opik harbor run ...                        (harbor/pyproject.toml)
       -> Harbor runs each task in Docker, Opik logs the trace
  4. read each trial reward, print summary, set exit code
```

- **One task per test case.** `test_cases.json` stays the single source of truth. The generator emits `harbor/tasks/<id>/` with `instruction.md` (the query), `task.toml` (metadata + prebuilt image + timeouts), `tests/` (the verifier script + the per-case reference), and an empty `environment/` (the prebuilt image needs no Dockerfile). Generated task dirs are build output: gitignored, regenerated each run.
- **One prebuilt image.** `harbor/Dockerfile` builds `apify-mcp-evals:local` once (node per `.nvmrc`, `pnpm install`, `dist/`, the eval runner + verifier). Every task's `[environment].docker_image` references it. Local Docker only.
- **Judge = Harbor verifier.** After the agent runs, the verifier (`run_judge.ts`) reads the agent's ATIF trajectory plus the case reference and reuses `workflow_judge.ts` unchanged (same prompt, same model `deepseek/deepseek-v4-flash`). It emits the Harbor reward: `1` for PASS, `0` for FAIL. The judge's reason is printed to the verifier stdout, which Harbor captures and the orchestrator surfaces in its summary table.
- **ATIF trajectory.** Both harnesses leave an [ATIF](https://github.com/harbor-framework/harbor) trajectory at `/logs/agent/trajectory.json`. The ts-executor entrypoint writes it directly; Harbor writes it for claude-code from its session logs. The verifier reads it the same way for both, so the judge is harness-agnostic.

## Harnesses

Two swappable agent harnesses run the same tasks. **claude-code is the default.**

- **claude-code** (`--harness claude-code`): Harbor's built-in Claude Code agent with its natural, unrestricted toolset. The Apify MCP server is exposed to it via `[[environment.mcp_servers]]` in each task. Default model `claude-haiku-4-5` (the native Anthropic id in dash form; Harbor sets `ANTHROPIC_MODEL` from it and calls the native API, which rejects the dotted OpenRouter slug). Requires `ANTHROPIC_API_KEY`. This harness has not been exercised end-to-end here (no `ANTHROPIC_API_KEY` available), so confirm it with one live run.
- **ts-executor** (`--harness ts-executor`): a custom Harbor agent (`harbor/ts_executor_agent.py`) that runs `run_single_trial.ts` in the container. That entrypoint reuses the existing TypeScript conversation executor, MCP client, and LLM client, and writes the ATIF trajectory. Agent model via OpenRouter (`OPENROUTER_API_KEY`), same as before.

### Known consequence: unrestricted claude-code

The claude-code harness is deliberately not restricted to the MCP server. If Claude Code routes around the server (for example by using its own Bash tool) and the case reference mandates specific MCP tool calls, the judge will FAIL it. That is intended signal, not a bug.

### failTools is ts-executor only

`failTools` (synthetic tool-failure injection) lives in `mcp_client.ts` and only the TS harness can inject it. The one case that uses it (`report-problem-on-tool-error`) is skipped under claude-code. The skip is logged, not silent.

### maxTurns

Per-case `maxTurns` is applied by the ts-executor harness. Harbor's claude-code agent takes `--max-turns` only as a run-wide flag, not per task, so per-case `maxTurns` is not wired for claude-code; it uses the agent's own default. Per-case `maxTurns` still shapes each task's agent timeout for both harnesses.

---

## Quick Start

**Prerequisites:**
- Docker (running)
- [uv](https://docs.astral.sh/uv/) (manages the Python Harbor + Opik sub-package)
- A local self-hosted Opik server at `http://localhost:5173`
- `APIFY_TOKEN` and `OPENROUTER_API_KEY`
- `ANTHROPIC_API_KEY` (only for the default claude-code harness)

**Start Opik locally (once):**
```bash
git clone https://github.com/comet-ml/opik.git
cd opik && ./opik.sh
```
Opik serves its UI at `http://localhost:5173` and its API at `http://localhost:5173/api`.

**Run:**
```bash
export APIFY_TOKEN="your_apify_token"
export OPENROUTER_API_KEY="your_openrouter_key"
export ANTHROPIC_API_KEY="your_anthropic_key"   # claude-code harness only

# Default harness (claude-code), all cases
pnpm run evals:workflow

# ts-executor harness, one case
pnpm run evals:workflow -- --harness ts-executor --id search-google-maps

# Filter by category, more parallelism
pnpm run evals:workflow -- --category search --concurrency 8
```

The first run builds the Docker image and lets uv create the Harbor/Opik environment, so it is slower. Later runs reuse both.

**Exit codes:**
- `0` = every executed trial passed
- `1` = any trial failed or errored, or Harbor itself failed

---

## CLI Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--harness <name>` | | `claude-code` or `ts-executor` | `claude-code` |
| `--id <id>` | | Run a specific test case by id | all |
| `--category <name>` | | Filter test cases by category | all |
| `--agent-model <model>` | | Agent model (Harbor `-m`); passed through verbatim | per harness: claude-code `claude-haiku-4-5`, ts-executor `anthropic/claude-haiku-4.5` |
| `--judge-model <model>` | | Judge model | `deepseek/deepseek-v4-flash` |
| `--tool-timeout <seconds>` | | MCP tool call timeout, passed into containers | `60` |
| `--concurrency <n>` | `-c` | Concurrent trials (Harbor `-n`) | `4` |

Filters pick which tasks are generated and run.

---

## Viewing traces in Opik

Open `http://localhost:5173`. Traces land in project **`workflow-evals`** (workspace `default`). Each trial is one trace named `<agent>/<trial>`; expand it to see per-step spans with the messages, tool calls, observations, and token usage, plus the verifier reward as a feedback score. The orchestrator points the Python SDK at the local server via `OPIK_URL_OVERRIDE=http://localhost:5173/api`; it never falls through to the Comet cloud.

---

## Environment Variables

```bash
export APIFY_TOKEN="..."           # https://console.apify.com/account/integrations
export OPENROUTER_API_KEY="..."    # https://openrouter.ai/keys (agent for ts-executor, judge for both)
export ANTHROPIC_API_KEY="..."     # claude-code harness only
export OPIK_URL_OVERRIDE="http://localhost:5173/api"  # optional; this is the default
```

---

## Files

- `run_workflow_evals.ts` - host orchestrator (generate tasks, build image, invoke `opik harbor run`, exit code)
- `task_generator.ts` - test case to Harbor task dir mapping, instruction/config marker, harness filtering
- `harness.ts` - harness selection and `opik harbor run` flag/env mapping
- `atif.ts` - conversation to/from ATIF trajectory
- `run_single_trial.ts` - ts-executor container entrypoint (runs the conversation, writes ATIF)
- `run_judge.ts` - verifier entrypoint (reads ATIF + reference, runs the judge, emits reward)
- `conversation_executor.ts`, `mcp_client.ts`, `llm_client.ts` - reused conversation engine
- `workflow_judge.ts` - judge logic (unchanged)
- `config.ts` - models, prompts, constants
- `output_formatter.ts` - end-of-run summary table
- `test_cases_loader.ts`, `test_cases.json` - test cases
- `harbor/` - Python sub-package: `pyproject.toml` (pins harbor + opik), `ts_executor_agent.py` (custom agent), `Dockerfile` (prebuilt image)

## Test Case Format

File: `test_cases.json`

```json
[
  {
    "id": "search-google-maps",
    "category": "search",
    "query": "Is there any Google Maps scraping tool on Apify?",
    "reference": "The agent must search for actors related to Google Maps and return at least 3 results.",
    "tools": ["actors", "docs"],
    "maxTurns": 10,
    "failTools": ["call-actor"]
  }
]
```

**Required:** `id`, `category`, `query`, `reference`.
**Optional:** `tools` (MCP tools to enable), `maxTurns` (default 10), `failTools` (ts-executor only; forces a synthetic tool failure carrying the real `report-problem` nudge).
