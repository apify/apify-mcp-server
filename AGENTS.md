# Apify MCP server

TypeScript, ES modules. Runs in two modes: **stdio** (local CLI clients, `stdio.ts`) and **HTTP Streamable** (`dev_server.ts`).

**Before implementing**: work from an issue that is assigned or explicitly agreed. An open issue is not an invitation — many are stale or unrefined, and the fix isn't settled. If nobody asked for this change, open an issue instead of a PR (docs fixes excepted). Disclose AI use in the PR; never add a model as co-author. See [CONTRIBUTING.md](./CONTRIBUTING.md#before-you-write-code).

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

Conventional Commits for all three. Branch: `type/short-desc` (e.g. `fix/connection-timeout`). Commit/PR title: `type: Description` (e.g. `fix: Handle connection errors`). Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`. Append `!` for breaking changes. PR title ≤70 chars.

Use `git mv` (not `mv` + `rm`) when renaming files so git records a rename rather than delete+create.

## Verification (mandatory)

After every code change, run `pnpm run type-check`, `pnpm run lint`, `pnpm run test:unit`, `pnpm run format` and `pnpm run check:agents`.
Zero tolerance for errors — fix before proceeding, don't defer.

## Agent constraints

- **Do NOT use `pnpm run build` for type-checking.** Use `pnpm run type-check` — it is faster and skips JavaScript output generation. Only use `pnpm run build` when compiled output is explicitly needed (e.g., before mcpc probing).
- **Do NOT run integration tests as an agent.** They require a valid `APIFY_TOKEN` and are slow.

## Testing the MCP server end-to-end

When the user says "test with mcpc", **use mcpc** — do not invent a substitute (no curl, no ad-hoc Node/Python scripts, no unit tests in place of an e2e probe). Use the **apify CLI** (`apify datasets`, `apify key-value-stores`, `apify actors`, …) for ground-truth data — never curl the Apify API.

After `pnpm run build`, run `mcpc` (no args) to check sessions: if `@stdio` (default) / `@stdio-full` (non-default tools) is listed, `mcpc @stdio restart`; otherwise `mcpc connect .mcp.json:stdio @stdio` (non-default tools: `mcpc connect .mcp.json:stdio-full @stdio-full`). Use the `mcpc-tester` subagent for systematic spec/edge-case coverage; call mcpc directly for quick checks.

## Testing

- **Unit tests**: `pnpm run test:unit`.
- **Integration tests**: `pnpm run test:integration` (needs build + `APIFY_TOKEN`, humans only).
- **Conformance tests**: `pnpm run test:conformance` (needs `APIFY_TOKEN`) builds and runs both protocol eras locally. `_integration_tests.yaml` calls `_conformance_tests.yaml` for the same `2026-07-28` and `2025-11-25` coverage in CI. Both eras always run; the command exits with the first non-zero code. Scenarios excluded from each era's gate are listed with reasons in `scripts/conformance_expected_failures_2026_07_28.yaml` and `scripts/conformance_expected_failures_2025_11_25.yaml`.
- **Package manager**: this repo uses **pnpm 11+**. `devEngines.packageManager` is pinned with `onFail: "error"`, so npm / yarn refuse to run inside the checkout — use `pnpm install` only.
- `tests/integration/suite.ts` wires the `stdio`, `2025-11-25` (streamable HTTP) and `2026-07-28` (stateless HTTP) transport dimensions into one shared suite. Add new integration cases to the matching capability array in `tests/test_kit/cases/*.cases.ts` (registration, tools, actors, apps, tasks, storage, payments) — each is a plain `Case[]` (`{ name, isDeploymentTest, run, ... }`), registered via `registerCases(name, cases, ctx)`. Mark a case `isDeploymentTest: true` only if it's worth running against `apify-mcp-server-internal`'s live staging and production deploys — the flag doesn't just share the case, it makes internal execute it for real on every release (see [DEVELOPMENT.md](./DEVELOPMENT.md#test-organization-across-repos)). Shared assertion helpers live in `tests/test_kit/helpers.ts`. Cases that share expensive setup (e.g. one seeded Actor run, see `storage.cases.ts`'s `normalModeRunFixture`) do so via `ctx.getFixture(fixture)`, memoized once per transport dimension — not a vitest `beforeAll`, so any subset of cases can share it while staying flat `Case` objects.
- Follow existing test patterns (names, structure) — check neighboring files.
- **Test naming**: `describe('fnName()')`, plain-verb `it()` names (no `should` prefix). Group with nested `describe()` per method when a factory/class exposes several.

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

### Public/internal integration tests ownership

- **MCP and package-logic tests go in `tests/integration/suite.ts` here.** Hosted-only behavior (auth, rate limiter, Caddy, multi-node) lives in `apify-mcp-server-internal`, not here.
- **Flag PRs that touch what the hosted server consumes** — `internals.js` exports, `_meta`, `structuredContent`, `clientInfo`-based logic, `?ui=` / `?payment=` parsing, notification timing. Internal's contract suite likely needs a matching test.
- **Never delete a test here thinking internal covers it.** This repo is the source; internal only smoke-tests that our output survives its middleware. Full rules: [DEVELOPMENT.md → Test organization across repos](./DEVELOPMENT.md#test-organization-across-repos).

## Code conventions

- **Follow [CONTRIBUTING.md](./CONTRIBUTING.md) for all naming and coding standards.** It is the single source of truth for naming rules (function verbs, boolean prefixes, type suffixes, enumerations, file names, etc.), string formatting, parameters, error handling, and anti-patterns. Read it before writing code.
- **Validate tool inputs with Zod.** No ad-hoc shape checks.
- **Reference tool names via the `HELPER_TOOLS` `as const` object**, not hardcoded strings (exception: integration tests).
- **Apps vs default mode**: only `*-widget` tools differ between modes. All non-widget tools (`call-actor`, `get-actor-run`, direct actor tools, `search-actors`, `fetch-actor-details`) share a single implementation across modes.
- Per-directory detail lives in the child `AGENTS.md` files (see Child docs below).
- Always follow the latest [MCP spec](https://modelcontextprotocol.io/specification/2025-11-25) and [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

## Child docs — read the one for the directory you're editing

- **[src/AGENTS.md](./src/AGENTS.md)** — source map: entry points + the `mcp` / `tools` / `payments` / `resources` / `web` child docs.

## Further reading

- **[DEVELOPMENT.md](./DEVELOPMENT.md)** — project structure, setup, build system, hot-reload workflow, two-phase tool loading, manual MCP testing.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — naming and coding standards (single source of truth).
- **[res/](./res/index.md)** — ephemeral working notes only (in-flight checklists, dated experiment records). Not a reference: durable facts live in `AGENTS.md`, decision rationale in the docstring of the code that owns it.

## Keep AGENTS.md current

If your diff changes a fact, command, or constant stated in an `AGENTS.md` (or a doc it links as the owner) within the directory you touched or its parents, update that doc in the **same PR**. `pnpm run check:agents` validates the link tree.
