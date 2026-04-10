---
name: mcpc
description: Probe the local Apify MCP server with mcpc after a code change. Use this when you want to verify real end-to-end tool behavior without running integration tests.
allowed-tools: Bash(mcpc:*), Bash(npm run build:*)
---

# Probing the local MCP server with mcpc

## Workflow after a code change

```bash
# 1. Compile the server
npm run build

# 2. Check if the local session exists
mcpc

# 3a. First time — connect using the repo config:
mcpc --config .mcp.json stdio connect @stdio

# 3b. Session already exists — restart to pick up the new build:
mcpc @stdio restart

# 4. Probe
mcpc @stdio tools-list
mcpc @stdio tools-call <tool-name> key:=value key2:="string value"

# 5. Machine-readable output
mcpc --json @stdio tools-call <tool-name> key:=value
```

## Argument syntax

Values are auto-parsed as JSON:

```bash
mcpc @stdio tools-call search-actors keywords:="web scraper" limit:=5
mcpc @stdio tools-call fetch-actor-details actorId:="apify/rag-web-browser"
mcpc @stdio tools-call some-tool config:='{"nested":"value"}'
```

## Inspect a specific tool

```bash
mcpc @stdio tools-get <tool-name>
```
