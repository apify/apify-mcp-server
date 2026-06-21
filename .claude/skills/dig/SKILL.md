---
name: dig
description: >-
  Explore, analyze, plan, or spec features for the Apify MCP server. Adapts to
  what the user asks — from quick code exploration to full GitHub issue specs.
  Use when the user asks to explore code, understand behavior, plan a change,
  design a feature, or create an issue spec.
argument-hint: "<your request> [--sdk <path>] [--ext-apps <path>] [--internal <path>]"
allowed-tools: [Read, Glob, Grep, Bash, WebFetch, WebSearch, Agent]
---

# Dig

Flexible skill for exploring, planning, and speccing work on the Apify MCP server. **Do NOT edit source files** — this skill is for understanding and planning only.

## Step 0: Parse arguments and determine intent

`$ARGUMENTS` contains the user's request and optional repo path overrides.

**Flags** (optional):

| Flag           | Default                          | Purpose                        |
|----------------|----------------------------------|--------------------------------|
| `--sdk`        | `../typescript-sdk`              | MCP SDK source repo path       |
| `--ext-apps`   | `../ext-apps`                    | MCP Apps SDK source repo path  |
| `--internal`   | `../apify-mcp-server-internal`   | Internal server repo path      |

Everything not matching a flag is the **user's request**.

**Resolution order** for source repos: flag path → default sibling path → `node_modules/` (compiled types only) → GitHub URL (last resort). Always verify the path exists before using it.

### Determine the intent

Infer the intent from the user's natural language. There are three modes:

| Intent | What you do | Examples |
|--------|-------------|---------|
| **Explore** | Read code, explain findings, answer questions | "how does tool naming work", "look at the widget code", "why is this broken", "what would break if we change X" |
| **Plan** | Enter plan mode, design the approach, assess impact | "plan implementing resource links", "figure out how to refactor metadata", "design the simplification" |
| **Spec** | Plan + create GitHub issues | "write an issue for X", "create a spec for Y", "spec out resource links" |

**Rules:**
- Default to **Explore**. When in doubt, do less — the user can always ask for more.
- Only enter plan mode for **Plan** and **Spec**.
- Only create GitHub issues for **Spec**.

## Step 1: Explore

Read the relevant source files and explain your findings. This is the baseline for all intents.

**What to do:**
1. Read the relevant source files in this repo
2. Check similar existing features as reference
3. Only check the internal repo, MCP SDK/spec, or MCP Apps SDK/spec if the user's question touches those areas
4. If you spot a related open issue, mention it casually — but don't go searching for issues unless it's relevant

**Stop here if the intent is Explore.**

## Step 2: Plan (Plan and Spec only)

Use the `EnterPlanMode` tool, then design the approach — and **commit to one**. If the request is
genuinely ambiguous (e.g. it maps to two different existing knobs), surface the fork up front and
ask; otherwise pick the most defensible design and commit rather than listing options.

**Investigate first:**
1. Assess internal repo impact (check `../apify-mcp-server-internal` if available)
2. Check MCP spec/SDK if the feature involves protocol behavior
3. Check MCP Apps spec/SDK if it involves widgets or interactive UIs
4. Use `mcpc @stdio tools-call` to probe current behavior if useful (requires `pnpm run build`)
5. Read the repo's convention docs — follow them, don't reinvent

**Conventions live in the repo, not here.** `AGENTS.md`, `CONTRIBUTING.md`, and `DEVELOPMENT.md`
hold the naming, validation, test-layout, and public/internal-separation rules — read them. Design
**minimally**: reuse and adjust before adding.

**Design output — required sections.** A plan has to be implementable by someone else, so produce:

1. **Approach** — the chosen design in a few sentences and the main trade-off you accepted.
2. **Files to change** — each file to create or modify with a one-line note on what changes (path + change; no line numbers needed).
3. **Interfaces** — the key function/type signatures you add or change (names, params, returns), so the implementer and reviewers know the contract.
4. **Test strategy (the oracle)** — which unit/integration tests prove it, where they live, and what each asserts. This is how "done" is judged — never leave it implicit.
5. **Risks & impact** — edge cases, and `apify-mcp-server-internal` impact.
6. **Data flow** — only when non-trivial: entry → transforms → output.

Sections 2–4 must be concrete (real files, signatures, and tests — no "TBD", no "add error
handling"). Sections 1, 5, 6 stay brief. This structure is for **Plan**; Explore and Spec stay lean.

**Stop here if the intent is Plan.** Exit plan mode with `ExitPlanMode`.

## Step 3: Spec (Spec only)

Create GitHub issues. First exit plan mode with `ExitPlanMode`.

### Check existing issues

Search for duplicates and related issues:

```
gh issue list -R apify/apify-mcp-server --search "<keywords>" --json number,title,state
gh issue list -R apify/ai-team --search "<keywords>" --json number,title,state
gh issue list -R apify/apify-mcp-server-internal --search "<keywords>" --json number,title,state
```

If a matching issue exists, update it with `gh issue edit` instead of creating a new one.

### Create issues

**One issue per implementation phase.** A phase = one PR-sized unit of work (~50-200 lines changed). Each issue should be independently implementable.

Use the repo's `feature_spec.yml` template. Only the **Problem** and **Proposed solution** fields are required. Include **Plan** and **Alternatives considered** only when they add real value. No fluff, no filler — straight to the point.

```markdown
## Problem
[Concrete evidence: error messages, user reports, issue links. Not "users are confused" — instead "3 users reported X in #channel".]

## Proposed solution
[Short. Reference existing code paths. List files inline if needed.]

## Plan
- [ ] Step 1
- [ ] Step 2

## Alternatives considered
[Only if you actually evaluated other approaches.]
```

**Style** (Explore explanations and Spec issues):
- Plain language, no fluff — see `CLAUDE.md § Communication style`
- Skip any section that would be empty or generic
- 10-30 lines, not 100
- Concrete steps > prose

(A **Plan**'s design follows its required-sections structure above — keep each section tight, but
don't truncate files / interfaces / test strategy to hit a line count.)

**Self-review before presenting:**
- Is this the minimal design? Could scope be smaller?
- Am I reusing existing patterns or reinventing?
- Could this adjust existing code rather than add new code?
- Does it require refactoring first? If so, that's a separate issue.

Present issue content to the user for review before creating. Use `gh issue create` with `t-ai` label.

## Available resources

| Resource               | Path / URL                                                          | Use for                                                     |
|------------------------|---------------------------------------------------------------------|-------------------------------------------------------------|
| **Public repo**        | `.` (this repo root)                                                | Main codebase — tools, widgets, tests                       |
| **Internal repo**      | `../apify-mcp-server-internal` (if available)                       | Hosted server — assess impact of changes                    |
| **MCP SDK (types)**    | `node_modules/@modelcontextprotocol/sdk`                            | Protocol types, server/client APIs (compiled only)          |
| **MCP SDK (source)**   | `../typescript-sdk` (if available)                                  | Examples, tests, full source — faster than GitHub           |
| **MCP spec**           | `https://modelcontextprotocol.io/specification/2025-11-25`          | Protocol-level features                                     |
| **MCP Apps SDK (types)** | `node_modules/@modelcontextprotocol/ext-apps`                     | MCP Apps types, React hooks, server helpers (compiled only) |
| **MCP Apps SDK (source)** | `../ext-apps` (if available)                                     | Examples, tests, spec, full source — faster than GitHub     |
| **MCP Apps spec**      | `https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx` | MCP Apps extension specification                            |
| **Dev server (no UI)** | `http://localhost:3001/` / tools: `mcp__apify-dev__*`               | Test tools without widgets                                  |
| **Dev server (UI)**    | `http://localhost:3001/?ui=true` / tools: `mcp__apify-dev-ui__*`    | Test tools with widget rendering                            |
| **mcpc stdio**         | `mcpc @stdio tools-call ...` (requires `pnpm run build`)             | Test tools — no running server needed                       |
