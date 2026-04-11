---
name: bug-triage
description: >-
  Triage open GitHub bug issues for Apify MCP server. Fetches issues, analyzes
  root causes, drafts developer-to-developer responses, and posts after user
  approval. Use when handling user bug reports, responding to issues, or
  cleaning up stale bugs.
argument-hint: "[issue numbers] [--label <label>] [--all]"
allowed-tools: [Read, Glob, Grep, Bash, WebFetch, Agent]
---

# Bug Triage

Triage open bug issues on `apify/apify-mcp-server`. Analyze, draft responses, get approval, post.

## Permissions

- **Read-only by default**: listing issues (`gh issue list`), viewing details and comments (`gh issue view`) — do these automatically, no need to ask.
- **Write requires approval**: commenting (`gh issue comment`), closing (`gh issue close`), editing (`gh issue edit`) — **always present the draft and wait for explicit user approval before executing**.

## Step 0: Parse arguments

`$ARGUMENTS` controls scope:

| Input | Behavior |
|---|---|
| `623 641 639` | Triage specific issue numbers |
| `--label bug` | Triage all open issues with label (default: `bug`) |
| `--all` | Triage all open bug-labeled issues |
| _(empty)_ | Same as `--all` |

## Step 1: Fetch issues

Use the arguments parsed in Step 0 to determine what to fetch.

**If specific issue numbers were provided**, skip the list queries and fetch each issue directly:

```bash
gh issue view <number> --repo apify/apify-mcp-server --comments
```

**Otherwise** (label mode, `--all`, or empty), fetch open bug reports. Use the label from Step 0 (default: `bug`). Bug reports come in two forms — find both:

1. **By label**: issues with the parsed label
2. **By title prefix**: issues with `[Bug]` in the title (the bug report template adds this, but the label isn't always applied)

```bash
# By label (use the label from Step 0, default: bug)
gh issue list --repo apify/apify-mcp-server --label <label> --state open --json number,title,labels,createdAt,body --limit 30

# By title prefix (catches unlabeled bug reports)
gh issue list --repo apify/apify-mcp-server --state open --search "[Bug] in:title" --json number,title,labels,createdAt,body --limit 30
```

Merge both lists and deduplicate by issue number.

For each issue, fetch full details **including all comments** (comments often contain the real context):

```bash
gh issue view <number> --repo apify/apify-mcp-server --comments
```

**Always read comments before drafting a response.** Previous team members may have already replied, asked for details, or provided workarounds. Don't duplicate existing responses.

## Step 2: Categorize each issue

Assign one of these categories:

| Category | Criteria | Typical action |
|---|---|---|
| **Known fix** | Root cause is clear, documented fix exists | Draft response with fix, optionally close |
| **Not our bug** | Server logs show it works; issue is in the MCP client (Claude Desktop, Cowork, etc.) | Explain findings, suggest workaround |
| **Duplicate** | Same root cause as another open issue | Comment with link, close as duplicate |
| **Needs info** | No logs, no config, vague description | Ask for specifics |
| **Stale** | We asked for info, no reply for 2+ weeks | Close with helpful pointer |
| **Actionable bug** | Real server-side bug we need to fix | Acknowledge, investigate further |

### Common root causes (from past triage)

These patterns recur. Check for them first:

1. **SSE endpoint removed** (April 1, 2026): Users on `/sse` URLs get connection failures. Fix: switch to `https://mcp.apify.com` (streamable HTTP).

2. **"Tools connected but Claude ignores them"**: MCP server logs show successful handshake and `tools/list`, but Claude doesn't use the tools in conversation. This is a Claude Desktop/Cowork behavior, not an Apify server bug. Users need to explicitly ask Claude to use Apify tools.

3. **"Unable to connect to extension server"**: Claude Desktop extension install issues. Usually caused by corrupted npx cache, Claude silently downgrading the extension, or Node.js not on the GUI app's PATH. Fix: use the remote server `https://mcp.apify.com` as a custom connector.

4. **npx cache corruption**: Stale cache prevents stdio server from starting. Fix: `rm -rf ~/.npm/_npx` (macOS/Linux) or `rmdir /s /q %LOCALAPPDATA%\npm-cache\_npx` (Windows).

5. **Claude Desktop connector downgrade**: Claude Desktop silently downgrades connectors to older versions. Fix: remove and re-add the connector.

## Step 3: Draft response

**Style rules:**
- Developer-to-developer, plain language
- Concise — 3-8 lines typical, no fluff
- Acknowledge the issue and apologize briefly if the user is stuck
- Reference documentation when a fix or troubleshooting guide exists
- If the server works correctly (logs prove it), say so clearly
- If closing, explain why and point to where to go next

**Key documentation links:**
- Setup guide: `https://docs.apify.com/platform/integrations/mcp`
- Claude Desktop troubleshooting: `https://docs.apify.com/platform/integrations/claude-desktop#troubleshooting`
- Configurator: `https://mcp.apify.com`

**Use Apify MCP tools** (`search-apify-docs`, `fetch-apify-docs`) to find the right doc link if the issue touches a topic not covered above.

**The default recommendation** for connection issues is the remote server:

> Add a custom connector in Claude Desktop with URL `https://mcp.apify.com` and follow the OAuth flow.

## Step 4: Present and get approval

Present each issue to the user with:
1. **Issue number + title + link** (`https://github.com/apify/apify-mcp-server/issues/<number>`)
2. **Category** (from Step 2)
3. **Summary** — one line on what's going on
4. **Proposed response** — the draft comment in a blockquote
5. **Proposed action** — comment only / comment + close / close as duplicate of #X / skip

**MANDATORY: Wait for explicit user approval before posting anything.** Never post, close, or modify an issue without the user saying yes.

## Step 5: Post

After approval:

```bash
# Comment only
gh issue comment <number> --repo apify/apify-mcp-server --body "<response>"

# Comment + close
gh issue comment <number> --repo apify/apify-mcp-server --body "<response>" && \
gh issue close <number> --repo apify/apify-mcp-server

# Close as duplicate
gh issue comment <number> --repo apify/apify-mcp-server --body "Closing as a duplicate of #<other> — same root cause. We'll track and update there." && \
gh issue close <number> --repo apify/apify-mcp-server
```

Then move to the next issue. After the last one, print a summary table:

| Issue | Category | Action taken |
|---|---|---|
| #623 | Known fix | Commented, SSE migration |
| #639 | Duplicate | Closed as dup of #641 |
| ... | ... | ... |
