# Reference: commands, shapes, probes

Repo: `apify-mcp-server`. Harness docs: `evals/mcp_agent/README.md` (read it first; it documents the dataset, id scheme, `kind`/`tier`/`expectedErrors`, scores, and flags).

## Running evals

```bash
# The default dataset, mcp-server-evals; strict gate (judge PASS and tool_errors == 0)
pnpm run evals:mcp-agent --agent-model claude-opus-5 --subscription

# One family, by its id prefix
pnpm run evals:mcp-agent --id '^<family>/' --agent-model claude-opus-5 --subscription

# A case with metadata.expectedErrors: until #260, the runner doesn't consume that field yet,
# so a plain run fails it on the zero-tool-error gate. --allow-tool-errors works around that
# for now, but tolerates ANY tool failing on the run, not just the named one.
pnpm run evals:mcp-agent --id '<case-id>' --allow-tool-errors --agent-model <m> --subscription

# Narrow further: --category <name>; --concurrency N; --tool-timeout secs
```

- `--subscription` deletes `ANTHROPIC_API_KEY` from the process env so the Agent SDK's Claude Code subprocess uses the local login. Without it the run bills the API key.
- `--claude-judge` runs the judge on the Agent SDK too (`--judge-model` then takes an Anthropic ID, default `claude-sonnet-5`); with `--subscription --claude-judge` a run needs only `APIFY_TOKEN` + Langfuse keys. Caveat: a Claude judge scoring a Claude agent can be self-lenient — prefer the OpenRouter judge for comparable numbers.
- Ladder: `claude-opus-5` (calibration) → `claude-sonnet-5` → `claude-haiku-4-5` (default; the sensitive probe). A chained shell command's exit code is the LAST run's — read each log's `📊` line, not the chain status.
- Known flakes, retry the single item once before diagnosing: `🔥 Never completed (task threw)` (harness/SDK spawn); in remote/sandboxed environments, the agent reading "MCP servers still connecting" and falling back to built-ins (doesn't reproduce locally).
- Between runs of suites that create named resources: `pnpm run evals:mcp-agent:tasks-fixtures` (adapt per family) deletes leftover `eval-*` resources and reseeds the permanent fixture. Web-target families that create no named state need no fixtures script — say so in the README instead.

## Dataset item shape (Langfuse)

```json
{
  "datasetName": "mcp-server-evals",
  "id": "<family>/<tool>-<difficulty>-1",
  "input": { "query": "<user-language prompt, no tool names>" },
  "expectedOutput": "PASS only if <tool> was called with <args> and the final answer states <fact>. FAIL if <specific bad behavior>.",
  "metadata": { "category": "<tool-or-chain>", "kind": "agent", "tier": ["full"], "maxTurns": 10, "tools": ["<family>", "actors"] }
}
```

- `metadata` is strict-validated (`langfuse_dataset.ts`): unknown keys fail the run before LLM spend. Knobs: `category`, `kind`, `tier`, `expectedTools`, `expectedErrors`, `maxTurns`, `tools`, `failTools`.
- `category` = tool under test (what `--category` filters); difficulty goes in the id's `<slug>` half.
- `kind: "agent"` requires `expectedOutput`; `kind: "selection"` (not yet run by this harness, #260) requires a non-empty `expectedTools` instead and has no `expectedOutput`.
- A case that provokes an error on purpose sets `expectedErrors: ["<tool-name>", ...]` — the tool(s) allowed to fail on that item.
- The id is `<family>/<slug>`: `<family>` is the coarse dataset-migration category (`mcp-agent`, `tasks`, `web-fetch`, `web-selection`), distinct from the fine-grained `metadata.category` above. Filter one family with `--id '^<family>/'`.
- Items upsert on `id`. Ids are **project-unique forever**, even after archive/delete-and-recreate elsewhere. Retire a case by upserting `"status": "ARCHIVED"`.
- `maxTurns` guide: single tool 6–8, create+verify 10, chains 12–18. Budget for the longest path the reference permits (explore → decline → fallback), not the happy path; Actor-run cases need headroom for a poll cycle when the run outlives the wait cap.

## Langfuse environment

Instance: `https://langfuse.apify.dev`, project **MCP Workflow**. The harness and CLI need:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...     # project settings → API keys
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://langfuse.apify.dev
```

They live in the repo-root `.env` (the harness loads it via dotenv). Git **worktrees don't share
`.env`** — copy it from the main checkout first (`cp <main-checkout>/.env .env`). The CLI reads
`LANGFUSE_HOST`, not `LANGFUSE_BASE_URL`, so export both.

## Langfuse CLI

`npx` refuses to run inside the repo (pnpm-pinned `devEngines`) — run from any other directory.
Working preamble for CLI calls:

```bash
cd /tmp && export $(grep -E '^LANGFUSE' <repo>/.env | xargs) && export LANGFUSE_HOST="$LANGFUSE_BASE_URL"
```

```bash
npx -y langfuse-cli api datasets list --json                # mcp-server-evals already exists; no need to create it
jq -c '.[0]' items.json | npx -y langfuse-cli api dataset-items create --body-file -   # create = UPSERT on id: iterate on a case by re-posting the same id
npx -y langfuse-cli api dataset-items get <id>
npx -y langfuse-cli api dataset-items delete <id>          # irreversible, frees nothing (id stays burned) — archive instead (status: "ARCHIVED")
```

The edit loop per case: upsert item → `pnpm run evals:mcp-agent:export-dataset --dataset <name>` →
re-run just that item with `--id '<substring-regex>'` → read the transcript.

Read failing transcripts (judge reason + per-turn tool calls). `--from-start-time` is **required**;
the item's `output` field is a JSON **string** — pipe through `fromjson`:

```bash
npx -y langfuse-cli api experiment-items list \
  --experiment-name "<runName from console>" --from-start-time "<ISO>" --fields core,io --all --json \
  | jq -r '.body.data[] | (.output | fromjson) as $o | $o.id + " " + $o.judgeResult.verdict + "\n"
      + ([$o.transcript[] | to_entries[] | "  " + .key + ": " + (.value | tostring | .[0:300])] | join("\n"))'
```

Sweep for unexpected errors after a run (a run with no `expectedErrors` items must contribute zero rows):

```bash
npx -y langfuse-cli api observations list --level ERROR \
  --from-start-time "<run start ISO>" --fields core,basic,io --limit 100
```

## Snapshot to git (after every dataset edit)

```bash
pnpm run evals:mcp-agent:export-dataset   # writes dataset_snapshot_mcp-server-evals.json, committed
```

## API probe pattern (before writing platform-dependent cases)

Throwaway script in `evals/mcp_agent/probe_*_tmp.ts`, run with `pnpm exec tsx`, **delete after use**. Probe with the real `apify-client` exactly what the case will depend on: required fields, uniqueness errors, publish requirements, length limits, secret handling. Capture exact error messages and `type` slugs — references can require the agent to react to them (tool errors include `(API error type: <slug>)`). For live-web cases, probe the exact target URL and verify the fetched *content* supports the premise (status, body, the fact the answer needs) — and prefer stable hosts (rfc-editor.org, example.com) over flaky ones (httpbin.org 503s regularly) wherever content is the deliverable.

```ts
import 'dotenv/config';
import { ApifyClient } from 'apify-client';
const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
// create the thing the case assumes, read it back, print the error/shape, delete it
```

## Fixtures script pattern

One script per stateful family (`evals/mcp_agent/tasks_fixtures.ts` is the template): delete leftover `eval-*` resources except the permanent fixture, create the fixture if missing, and **reset the fixture's mutable state** every run (an eval agent may have mutated it). Wire as `evals:mcp-agent:<family>-fixtures` in package.json.

## Coverage matrix (definition of done for the dataset)

For each tool: at least one dedicated case, plus every argument group exercised somewhere (create: input/name/config; get: found + not-found; update: each independently updatable group; lifecycle tools: a clean happy-path case plus a requirement-discovery case with `expectedErrors` set). A tool exercised only as the tail of another case (like unpublish) is acceptable if a dedicated case would duplicate an existing one — say so explicitly when reporting coverage.

## Fixing tools from findings (order of preference)

1. **Response summary/nextStep text** — e.g. "stored values are never returned…", "to re-check publication state, use get-actor-task". Reaches every agent on every call. Summaries must never state conclusions the platform can't back yet (an unverified zero count is "reads 0, can lag", not "no items found") — agents quote the summary and give up on it.
2. **Argument schema constraints + describe()** — encode API limits (`.max(60)`) so invalid calls fail client-side before the API. Parameter descriptions are read at argument-writing time, so a constraint note there beats a description tail — but even that has limits (a weak model kept silently rewriting ftp:// to https:// through both); after fixing every owned layer, document the residual.
3. **Field renames / shape alignment** — if a field name invites misreading or diverges from the API contract, align with the API object (`structuredContent` changes must be flagged for the internal repo's contract suite).
4. **Description USAGE lines** — bias-to-act nudges ("resolve loose Actor references with search-actors instead of asking"), conditional on `hasTool()`.

After any tool change: `pnpm run build` happens via `evals:mcp-agent` automatically; rerun only the affected model/case pairs first, full ladder last.
