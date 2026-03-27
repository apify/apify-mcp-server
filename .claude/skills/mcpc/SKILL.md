---
name: mcpc
description: Probe the local Apify MCP server with mcpc after a code change. Use this when you want to verify real end-to-end tool behavior without running integration tests.
allowed-tools: Bash(mcpc:*), Bash(npm run build:*)
---

# Probing the local Apify MCP server with mcpc

## Key principles

1. **Prefer mcpc + jq piping.** Strongly prefer `mcpc ... | jq` pipelines for all verification. Use pipes to chain commands and extract what you need. Node.js or Python are acceptable as a last resort when jq genuinely can't do the job, but reach for mcpc + jq first.
2. **Keep commands short.** Every Bash command requires user permission. Avoid long multi-line commands, complex jq pipelines, or heredocs. Prefer simple, single-line `mcpc ... | jq '...'` calls. If a pipeline gets complex, break it into multiple shorter calls.
3. **End-to-end focus.** mcpc verifies that the server behaves correctly as a whole (tools appear, calls return expected output, schemas are correct). Pure function logic and edge cases belong in unit tests (`npm run test:unit`).

## Sessions (defined in `.mcp.json`)

| Session | Transport | When to use |
|---|---|---|
| `@stdio` | `node dist/stdio.js` | Default — core tools only |
| `@stdio-full` | `node dist/stdio.js --tools=...` | When you need non-default tools (add-actor, all categories, specific actors) |
| `@dev` | `http://localhost:3001` | Widget / UI mode, or when you need **server logs** — requires `npm run dev` running |

Server arguments come from `.mcp.json` — you cannot pass them inline. To test a different server configuration, add a new named entry to `.mcp.json` with the desired `args`, then connect it as a new session.

Available `stdio.js` arguments: `--tools` (comma-separated tool names or actor IDs), `--actors` (comma-separated actor IDs), `--enable-adding-actors`, `--ui`.

> **Tip:** `@dev` shows server logs in the `npm run dev` terminal as requests come in — useful for observing server-side behavior, request flow, and debugging issues that aren't visible from the tool output alone.

## Workflow

```bash
npm run build
mcpc                                                     # check sessions
mcpc --config .mcp.json stdio connect @stdio             # first time only
mcpc --config .mcp.json stdio connect @stdio-full        # first time only (non-default tools)
mcpc @stdio restart                                      # after each build
```

## Calling tools

Arguments auto-parse as JSON (`key:=value`):

```bash
mcpc @stdio tools-list
mcpc @stdio tools-get <tool-name>

mcpc @stdio tools-call search-actors keywords:="web scraper" limit:=5
mcpc @stdio tools-call fetch-actor-details actorId:="apify/rag-web-browser"
mcpc @stdio tools-call call-actor actorId:="apify/rag-web-browser" input:='{"query":"hello"}'
mcpc @stdio tools-call get-actor-output datasetId:="<id>" fields:="url,title"
mcpc @stdio tools-call search-apify-docs query:="pagination"
```

## Testing different use cases

Use `search-actors` and `fetch-actor-details` to dynamically load actors into the server, then verify their behavior. This lets you test tool registration, naming, schemas, and output for any actor — not just the defaults.

```bash
# Find actors for a use case
mcpc @stdio tools-call search-actors keywords:="google maps" limit:=3

# Load one — this registers it as a new tool on the server
mcpc @stdio tools-call fetch-actor-details actorId:="compass/crawler-google-places"

# Verify it appeared in the tool list
mcpc --json @stdio tools-list | jq '.[].name'

# Inspect its schema
mcpc @stdio tools-get <tool-name>

# Call it and check the output
mcpc --json @stdio tools-call <tool-name> key:="value" | jq '.content[0].text'
```

## Parsing output with jq

Use `mcpc --json ... | jq` to inspect structured output. Keep jq pipelines short and readable — if you need multiple checks, run multiple commands rather than one giant pipeline.

```bash
# List tool names
mcpc --json @stdio tools-list | jq '.[].name'

# Check tool annotations
mcpc --json @stdio tools-list --full | jq '[.[] | {name, readOnly: .annotations.readOnlyHint}]'

# Check a single tool's annotations
mcpc --json @stdio tools-list --full | jq '.[] | select(.name == "call-actor") | .annotations'

# Count read-only tools
mcpc --json @stdio tools-list --full | jq '[.[] | select(.annotations.readOnlyHint == true)] | length'
```
