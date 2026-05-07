# Apify MCP server

TypeScript, ES modules. Runs in two modes: **stdio** (local CLI clients, `stdio.ts`) and **HTTP Streamable** (`dev_server.ts`).

### Communication style — MANDATORY

**This applies to ALL written output: code comments, commit messages, PR descriptions, issue specs**

- **Plain language, no fluff.** Say what you mean in the fewest words. No filler phrases, no motivational preambles, no "this will improve the developer experience."

## Scope discipline

- **Minimal.** Implement only what's explicitly requested. No speculative features, no hypothetical future-proofing — solve the current problem, not imagined ones.
- **One thing per change.** Bug fix fixes only the bug — no cleanup, no renames, no drive-by refactors. Mention unrelated issues; don't fix them.
- **Test first for bug fixes.** Write a failing test that reproduces the bug, confirm it fails, then fix.
- **Refactoring is a separate PR.** If a feature needs refactoring, land the refactor first, then the feature. Never mix.
- **Fix by adjusting, not adding.** Prefer a 1-line fix over a 10-line fix. Prefer adjusting existing code over adding new branches. Search for existing helpers and patterns that already handle similar cases. Ask: "Am I adding code, or fixing the code that's already there?"
- **Self-review your diff.** Before declaring done, review: Is this the minimal fix? Am I reusing existing patterns? Did I leave any debug artifacts?

## Git: branch names, commits, PR titles

Conventional Commits for all three. Branch: `type/short-desc` (e.g. `fix/connection-timeout`). Commit/PR title: `type: Description` (e.g. `fix: Handle connection errors`). Types: `feat`, `fix`, `chore`, `refactor`, `docs`. Append `!` for breaking changes. PR title ≤70 chars.

Use `git mv` (not `mv` + `rm`) when renaming files so git records a rename rather than delete+create.

## Verification (mandatory)

After every code change, run `npm run type-check`, `npm run lint`, and `npm run test:unit`.
Zero tolerance for errors — fix before proceeding, don't defer.

## Agent constraints

- **Do NOT use `npm run build` for type-checking.** Use `npm run type-check` — it is faster and skips JavaScript output generation. Only use `npm run build` when compiled output is explicitly needed (e.g., before mcpc probing).
- **Do NOT run integration tests as an agent.** They require a valid `APIFY_TOKEN` and are slow.

## Testing the MCP server end-to-end

After code changes, verify the server works — not just that it compiles.

**mcpc** (scripted): needs `npm run build` first (runs `dist/stdio.js`) and `APIFY_TOKEN` in env.
```bash
npm run build
mcpc connect .mcp.json:stdio @stdio   # first time only
mcpc @stdio restart                    # after code changes
mcpc @stdio tools-call search-actors keywords:="web scraper"
```
Default tools to cover: `search-actors`, `fetch-actor-details`, `call-actor`, `get-actor-run`, `get-actor-output`, `search-apify-docs`, `fetch-apify-docs`.

**Native client** (Claude Code, Cursor): server is already connected — call tools directly. Ask the user if unsure which approach to use.

## Testing

- **Unit tests**: `npm run test:unit`.
- **Integration tests**: `npm run test:integration` (needs build + `APIFY_TOKEN`, humans only).
- `tests/integration/suite.ts` is the main suite, reused by stdio/streamable-http transports. Add new integration cases there, NOT in separate files.
- Follow existing test patterns (names, structure) — check neighboring files.

## External dependencies

**IMPORTANT**: This package (`@apify/actors-mcp-server`) is used in the private `apify-mcp-server-internal` repository for the hosted server.
Changes here may affect that server.
Breaking changes must be coordinated; check whether updates are needed in `apify-mcp-server-internal` before submitting a PR.

### Public/internal repo separation

- **Public repo** = core MCP server logic, interfaces, types (with generic/plain data types only)
- **Internal repo** = backend/DB/proprietary logic (Redis, MongoDB, IAM auth, multi-node)
- **Never** import private Apify libraries or internal DB schemas into the public repo — external users can't install them
- **Expose methods on `ActorsMcpServer`**, not raw data exports via `./internals` — minimize the coupling surface
- When designing a new feature, ask: can this land in one repo? Prefer exposing a method or interface over exporting internals that the other repo re-implements

## Code conventions

- **Follow [CONTRIBUTING.md](./CONTRIBUTING.md) for all naming and coding standards.** It is the single source of truth for naming rules (function verbs, boolean prefixes, type suffixes, enumerations, file names, etc.), string formatting, parameters, error handling, and anti-patterns. Read it before writing code.
- **Validate tool inputs with Zod.** No ad-hoc shape checks.
- **Reference tool names via the `HelperTools` enum**, not hardcoded strings (exception: integration tests).
- Always follow the latest [MCP spec](https://modelcontextprotocol.io/specification/2025-11-25) and [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

## Further reading

- **[DEVELOPMENT.md](./DEVELOPMENT.md)** — project structure, setup, build system, hot-reload workflow, manual MCP testing
- **[DESIGN_SYSTEM_AGENT_INSTRUCTIONS.md](./DESIGN_SYSTEM_AGENT_INSTRUCTIONS.md)** — UI widget design system rules (read this when doing any UI/widget work)
- **[res/](./res/index.md)** — ad-hoc notes: architecture analyses, refactor plans, protocol references. **May be obsolete** — verify against current code before trusting.
