---
name: mcpc
description: Probe the local Apify MCP server with mcpc after a code change. Use this when you want to verify real end-to-end tool behavior without running integration tests.
allowed-tools: Bash(mcpc:*), Bash(npm run build:*)
---

# Probing the local Apify MCP server with mcpc

## Sessions (defined in `.mcp.json`)

| Session | Transport | When to use |
|---|---|---|
| `@stdio` | `node dist/stdio.js` | Core tool behavior — requires `npm run build` |
| `@dev` | `http://localhost:3001` | Widget / UI mode — requires `npm run dev` running |

## Workflow

```bash
npm run build
mcpc                                            # check sessions
mcpc --config .mcp.json stdio connect @stdio   # first time only
mcpc @stdio restart                             # after each build
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

mcpc --json @stdio tools-call search-actors keywords:="scraper" | jq '.content[0].text | fromjson'
```
