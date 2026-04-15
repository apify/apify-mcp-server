# Apify MCP server

MCP server that exposes [Apify Actors](https://apify.com/store) as tools for AI assistants.

The codebase is built with TypeScript using ES modules and follows a modular architecture with clear separation of concerns.

The server can run in multiple modes:
- **Standard Input/Output (stdio)**: For local integrations and command-line tools like Claude Desktop
- **HTTP Streamable**: For hosted deployments and web-based MCP clients
- **Legacy SSE over HTTP**: Legacy version of the protocol for hosted deployments and web-based clients (deprecated and will be removed in the future)

### Core philosophy

- Simple is better than complex
- If the implementation is hard to explain, it's (usually) a bad idea.
- **Ruthlessly minimal**: Only implement what's explicitly in scope
- **Lightweight**: Measure complexity by lines of code, not abstractions
- **No over-engineering**: Solve the current problem, not hypothetical future ones
- **No unsolicited features**: Don't add anything not explicitly requested by the human operator

### Communication style — MANDATORY

**This applies to ALL written output: code comments, commit messages, PR descriptions, issue specs**

- **Plain language, no fluff.** Say what you mean in the fewest words. No filler phrases, no motivational preambles, no "this will improve the developer experience."

## Scope discipline

- **Bug fix = bug fix.** When fixing a bug, fix only the bug. Don't refactor surrounding code, don't improve naming, don't add comments, don't "clean up while you're here."
- **One thing per change.** Each change should do exactly one thing: fix a bug, add a feature, or refactor. Never combine. If you spot something unrelated that needs fixing, mention it — don't fix it.
- **Test first.** For bug fixes, write a failing test that reproduces the bug before touching source code. Run it to confirm it fails. Then fix.
- **Fix by adjusting, not adding.** Prefer a 1-line fix over a 10-line fix. Prefer adjusting existing code over adding new branches. Search for existing helpers and patterns that already handle similar cases. Ask: "Am I adding code, or fixing the code that's already there?"
- **Self-review your diff.** Before declaring done, review: Is this the minimal fix? Am I reusing existing patterns? Did I leave any debug artifacts?
- **Refactoring is a separate PR.** If a feature requires refactoring, do the refactoring first in its own PR, get it merged, then implement the feature. Never mix refactoring with feature work — the combined diff is hard to review and easy to break.

## ⚠️ MANDATORY: Verification after every implementation

**THIS IS NON-NEGOTIABLE. DO NOT SKIP.**

After completing ANY code change (feature, fix, refactor), you MUST:

1. **Type check**: `npm run type-check`
   - Fix ALL TypeScript errors before proceeding
   - Zero tolerance for type errors

2. **Lint**: `npm run lint`
   - Fix ALL lint errors before proceeding
   - Use `npm run lint:fix` for auto-fixable issues

3. **Unit tests**: `npm run test:unit`
   - ALL tests must pass
   - If a test fails, fix it before moving on

**What to do if verification fails:**
1. DO NOT proceed to the next task
2. Fix the issue immediately
3. Re-run verification until green
4. Only then continue

## Agent constraints

- **Do NOT use `npm run build` for type-checking.** Use `npm run type-check` — it is faster and skips JavaScript output generation. Only use `npm run build` when compiled output is explicitly needed (e.g., before mcpc probing).
- **Do NOT run integration tests as an agent.** They require a valid `APIFY_TOKEN` and are slow.

## MCP development — references

Basic references for work on MCP protocol, SDK, and MCP Apps (widgets). Deeper docs live in [res/index.md](./res/index.md).

| Resource | Location |
|---|---|
| MCP spec | https://modelcontextprotocol.io/specification/2025-11-25 |
| MCP Apps spec | https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx |
| MCP SDK (types) | `node_modules/@modelcontextprotocol/sdk` |
| MCP SDK (source, if cloned) | `../typescript-sdk` |
| MCP Apps SDK (types) | `node_modules/@modelcontextprotocol/ext-apps` |
| MCP Apps SDK (source, if cloned) | `../ext-apps` |
| Internal (hosted) server repo | `../apify-mcp-server-internal` |

**Transport modes and key files:**
- stdio → `src/stdio.ts`
- Streamable HTTP and legacy SSE → `src/dev_server.ts`, `src/mcp/server.ts`

**Deep-dives in [res/](./res/index.md):** task lifecycle, Server→McpServer refactor, resources analysis, SDK/FastMCP patterns for simplification.

## Testing

- Unit tests: `npm run test:unit`
- Integration tests: requires `APIFY_TOKEN` and `npm run build` — humans only. See [DEVELOPMENT.md § Testing](./DEVELOPMENT.md#testing).
- Add integration test cases to `tests/integration/suite.ts` — shared across all transport modes.
- End-to-end probing with mcpc: see [DEVELOPMENT.md § Live probing with mcpc](./DEVELOPMENT.md#live-probing-with-mcpc).

## External dependencies

**IMPORTANT**: This package (`@apify/actors-mcp-server`) is used in the private `apify-mcp-server-internal` repository for the hosted server. Changes here may affect that server. Breaking changes must be coordinated; check whether updates are needed in `apify-mcp-server-internal` before submitting a PR. See README.md for canary (`beta`) releases via `pkg.pr.new`.

### Public/internal repo separation (see [internal#419](https://github.com/apify/apify-mcp-server-internal/issues/419))

- **Public repo** = core MCP server logic, interfaces, types (with generic/plain data types only)
- **Internal repo** = backend/DB/proprietary logic (Redis, MongoDB, IAM auth, multi-node)
- **Never** import private Apify libraries or internal DB schemas into the public repo — external users can't install them
- **Expose methods on `ActorsMcpServer`**, not raw data exports via `./internals` — minimize the coupling surface
- When designing a new feature, ask: can this land in one repo? Prefer exposing a method or interface over exporting internals that the other repo re-implements

## Further reading

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — coding standards, patterns, anti-patterns, commit format, PR guidelines, design system rules
- **[DEVELOPMENT.md](./DEVELOPMENT.md)** — project structure, setup, build system, hot-reload workflow, manual MCP testing
- **[DESIGN_SYSTEM_AGENT_INSTRUCTIONS.md](./DESIGN_SYSTEM_AGENT_INSTRUCTIONS.md)** — UI widget design system rules (read this when doing any UI/widget work)
- **[res/](./res/index.md)** — architecture analyses, refactor plans, and protocol references (MCP tasks, SDK features, tool mode separation, etc.)
