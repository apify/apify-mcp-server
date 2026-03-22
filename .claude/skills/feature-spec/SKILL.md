---
name: feature-spec
description: >-
  Plan and specify a new feature for the Apify MCP server. Use when the user
  asks to "spec a feature", "plan a feature", "design a feature", "write a
  feature spec", or describes a new capability they want to add. Activates
  planning mode with full project context and produces a GitHub issue spec.
argument-hint: <feature-description>
allowed-tools: [Read, Glob, Grep, Bash, WebFetch, WebSearch, Agent]
---

# Feature Spec Skill

You are planning a new feature for the Apify MCP server. Your job is to explore the codebase, design the feature, and produce a GitHub issue spec. **Do NOT edit any files** — this is a planning-only workflow.

## Step 1: Enter planning mode

Use the `EnterPlanMode` tool to activate planning mode. This ensures you explore and design without making changes.

## Step 2: Project context

You might have access to these resources during planning:

| Resource               | Path / URL                                                          | Use for                                  |
|------------------------|---------------------------------------------------------------------|------------------------------------------|
| **Public repo**        | `~/apify/apify-mcp-server`                                          | Main codebase — tools, widgets, tests    |
| **Internal repo**      | `~/apify/apify-mcp-server-internal`                                 | Hosted server — assess impact of changes |
| **MCP SDK**            | `~/github/typescript-sdk`                                           | Protocol types, server/client APIs       |
| **MCP spec**           | `https://modelcontextprotocol.io/specification/2025-11-25`          | Protocol-level features                  |
| **Dev server (no UI)** | `http://localhost:3001/mcp` / tools: `mcp__apify-dev__*`            | Test tools without widgets               |
| **Dev server (UI)**    | `http://localhost:3001/mcp?ui=true` / tools: `mcp__apify-dev-ui__*` | Test tools with widget rendering         |
| **MCPJam**             | `npx @mcpjam/inspector@latest`                                      | Manual widget testing                    |
| **ChatGPT via ngrok**  | `mcp-apify.ngrok.dev`                                               | End-to-end ChatGPT testing               |

## Step 3: Key conventions

Follow these when designing:

- **Simple > complex, ruthlessly minimal** — only what's explicitly in scope
- **Zod** for input validation, **HelperTools enum** for tool names
- Integration tests go in `tests/integration/suite.ts`
- Changes may affect `apify-mcp-server-internal` — always assess impact
- Verification: `npm run type-check`, `npm run lint`, `npm run test:unit`
- See `CLAUDE.md`, `CONTRIBUTING.md`, and `DEVELOPMENT.md` for full conventions

## Step 4: Planning guidance

During planning, explore:

1. **Current implementation** in the area being changed — read the relevant source files
2. **Similar existing features** as patterns to follow
3. **Internal repo dependencies** on affected modules (check `/home/jirka/apify/apify-mcp-server-internal`)
4. **MCP spec/SDK** if the feature involves protocol behavior
5. Use `mcp__apify-dev__*` and `mcp__apify-dev-ui__*` tools to test current behavior if the dev servers are running

Ask clarifying questions if the feature description is ambiguous. Prefer narrowing scope over guessing intent.

## Step 5: Produce the GitHub issue

When planning is complete, exit planning mode with `ExitPlanMode`, then create a GitHub issue using `gh issue create` with this structure:

```markdown
## Context and motivation
[Why this feature is needed]

## Scope

### In scope
- [bullet list]

### Out of scope
- [bullet list]

## Technical design

### Overview
[High-level approach]

### Detailed design
[Implementation details, referencing existing code by file path]

### Files to modify
| File | Change |
|------|--------|
| `src/...` | Description |

### New files (if any)
| File | Purpose |
|------|---------|
| `src/...` | Description |

## Internal repo impact
[Does apify-mcp-server-internal need changes? Check imports/usage.]

## Testing strategy

### Unit tests
- [Key test cases, target files]

### Integration tests
- [Cases to add to tests/integration/suite.ts]

### Manual testing
- [Steps using local dev servers, MCPJam, or ChatGPT]

## Verification checklist
- [ ] `npm run type-check` passes
- [ ] `npm run lint` passes
- [ ] `npm run test:unit` passes
- [ ] Internal repo impact assessed
- [ ] No breaking changes (or coordinated)

## Open questions
- [Anything needing human decision]
```

Present the issue content to the user for review before creating it. Use `gh issue create` with appropriate title and labels.
