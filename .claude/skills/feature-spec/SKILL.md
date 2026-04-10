---
name: feature-spec
description: >-
  Plan and specify a new feature for the Apify MCP server. Use when the user
  asks to "spec a feature", "plan a feature", "design a feature", "write a
  feature spec", or describes a new capability they want to add. Activates
  planning mode with full project context and produces a GitHub issue spec.
argument-hint: "<feature-description> [--sdk <path>] [--ext-apps <path>] [--internal <path>]"
allowed-tools: [Read, Glob, Grep, Bash, WebFetch, WebSearch, Agent]
---

# Feature Spec Skill

You are planning a new feature for the Apify MCP server. Your job is to explore the codebase, design the feature, and produce a GitHub issue spec. **Do NOT edit any files** — this is a planning-only workflow.

## Step 0: Parse arguments

`$ARGUMENTS` contains the feature description and optional repo path overrides:

| Flag           | Default                          | Purpose                        |
|----------------|----------------------------------|--------------------------------|
| `--sdk`        | `../typescript-sdk`              | MCP SDK source repo path       |
| `--ext-apps`   | `../ext-apps`                    | MCP Apps SDK source repo path  |
| `--internal`   | `../apify-mcp-server-internal`   | Internal server repo path      |

Everything not matching a flag is the **feature description**.

Examples:
- `/feature-spec add resource links to dataset tools`
- `/feature-spec --sdk ~/github/typescript-sdk add resource links`
- `/feature-spec --ext-apps ~/github/ext-apps --internal ~/apify/apify-mcp-server-internal add widget support`

**Resolution order** for source repos: flag path → default sibling path → `node_modules/` (compiled types only) → GitHub URL (last resort). Always verify the path exists before using it.

## Step 1: Enter planning mode

Use the `EnterPlanMode` tool to activate planning mode. This ensures you explore and design without making changes.

## Step 2: Project context

You might have access to these resources during planning (paths marked "if available" can be overridden via Step 0 flags):

| Resource               | Path / URL                                                          | Use for                                                     |
|------------------------|---------------------------------------------------------------------|-------------------------------------------------------------|
| **Public repo**        | `.` (this repo root)                                                | Main codebase — tools, widgets, tests                       |
| **Internal repo**      | `../apify-mcp-server-internal` (if available — search for it)       | Hosted server — assess impact of changes                    |
| **MCP SDK (types)**    | `node_modules/@modelcontextprotocol/sdk`                            | Protocol types, server/client APIs (compiled only)          |
| **MCP SDK (source)**   | `../typescript-sdk` (if available — search for it)                  | Examples, tests, full source — faster than GitHub           |
| **MCP spec**           | `https://modelcontextprotocol.io/specification/2025-11-25`          | Protocol-level features                                     |
| **MCP Apps SDK (types)** | `node_modules/@modelcontextprotocol/ext-apps`                     | MCP Apps types, React hooks, server helpers (compiled only) |
| **MCP Apps SDK (source)** | `../ext-apps` (if available — search for it)                     | Examples, tests, spec, full source — faster than GitHub     |
| **MCP Apps spec**      | `https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx` | MCP Apps extension specification                            |
| **Dev server (no UI)** | `http://localhost:3001/` / tools: `mcp__apify-dev__*`               | Test tools without widgets                                  |
| **Dev server (UI)**    | `http://localhost:3001/?ui=true` / tools: `mcp__apify-dev-ui__*`    | Test tools with widget rendering                            |
| **mcpc stdio**         | `mcpc @stdio tools-call ...` (requires `npm run build`)             | Test tools — no running server needed                       |

## Step 3: Key conventions

Follow these when designing:

- **Simple > complex, ruthlessly minimal** — only what's explicitly in scope
- **Reuse before creating.** Search for existing helpers, patterns, and utilities that already handle similar cases. Extend what exists rather than adding new abstractions.
- **Smallest possible feature.** Design the minimal version that solves the problem. If you're adding new parameters, methods, or abstractions, ask: is there a simpler way using what's already there?
- **Zod** for input validation, **HelperTools enum** for tool names
- Integration tests go in `tests/integration/suite.ts`
- Changes may affect `apify-mcp-server-internal` — always assess impact
- Verification: `npm run type-check`, `npm run lint`, `npm run test:unit`
- **Live verification:** `mcpc` — after implementing, probe the real server to confirm behavior matches the spec. Use `@stdio` (requires `npm run build`, no running server needed). Use `@dev` only for widget/UI work (requires `npm run dev`).
- See `CLAUDE.md`, `CONTRIBUTING.md`, and `DEVELOPMENT.md` for full conventions

## Step 4: Planning guidance

During planning, explore:

1. **Current implementation** in the area being changed — read the relevant source files
2. **Similar existing features** as patterns to follow
3. **Internal repo dependencies** on affected modules (check `../apify-mcp-server-internal` if available)
4. **MCP spec/SDK** if the feature involves protocol behavior
5. **MCP Apps spec/SDK** if the feature involves widgets or interactive UIs — check both the spec and `node_modules/@modelcontextprotocol/ext-apps`
6. Use `mcpc @stdio tools-call` to probe current behavior (run `npm run build` first), or use `mcp__apify-dev__*` / `mcp__apify-dev-ui__*` tools if the dev server is running locally

**Public/internal repo separation**: See `CLAUDE.md § Public/internal repo separation`.

Ask clarifying questions if the feature description is ambiguous. Prefer narrowing scope over guessing intent.

## Step 5: Check existing issues

Before creating anything, search for duplicates and related issues across all three repos:

```
gh issue list -R apify/apify-mcp-server --search "<feature keywords>" --json number,title,state
gh issue list -R apify/ai-team --search "<feature keywords>" --json number,title,state
gh issue list -R apify/apify-mcp-server-internal --search "<feature keywords>" --json number,title,state
```

If a matching issue exists, update it with `gh issue edit` instead of creating a new one. Reference related issues from other repos in the description.

## Step 6: Produce GitHub issues

When planning is complete, exit planning mode with `ExitPlanMode`, then create issues.

**One issue per implementation phase.** A phase ≈ one PR-sized unit of work (roughly 50–200 lines changed). Example: phase 1 = add the new Zod schema + types, phase 2 = wire up the tool handler + tests. If the feature has multiple phases, create a separate issue for each. Each issue should be independently implementable.

Use the repo's `feature_spec.yml` template (not `feature_request.yml` — that one is for external users). Write **concrete, concise, no empty sections** issues. Only include sections that have real content for this specific issue.

```markdown
## Problem
[Be concrete — numbers, error messages, user reports, Slack/issue links. "Users are confused" is weak; "3 users reported X in #channel" is strong.]

## Proposed solution
[Short explanation of the approach. Reference existing code paths. If files need changing, list them here inline — don't make a separate table unless there are 5+ files.]

## Plan
- [ ] Step 1 (with PR links or assignees if known)
- [ ] Step 2
- [ ] ...

## Alternatives considered
[Only if you actually evaluated other approaches. Skip if there's one obvious solution.]
```

**Style rules:**
- Skip any section that would be empty or generic
- Lead with real evidence (data, links, screenshots), not abstract motivation
- Keep it short — the best issues are 10-30 lines, not 100
- A checklist plan with concrete steps beats a wall of prose

**Before presenting the issues**, self-review the design:
- Is this the minimal design? Could the scope be smaller?
- Am I reusing existing patterns or reinventing?
- Could this be done by adjusting existing code rather than adding new code?
- Does the feature require refactoring first? If so, split into a separate refactoring PR that must merge before the feature work begins. Never mix refactoring with feature changes — the combined diff is hard to review and easy to break.

Present the issue content to the user for review before creating. Use `gh issue create` with appropriate title and `t-ai` labels.
