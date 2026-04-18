# Apify MCP server

TypeScript, ES modules. Runs in two modes: **stdio** (local CLI clients, `stdio.ts`) and **HTTP Streamable** (`dev_server.ts`).

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

- **One thing per change.** Bug fix fixes only the bug — no cleanup, no renames, no drive-by refactors. Mention unrelated issues; don't fix them.
- **Test first for bug fixes.** Write a failing test that reproduces the bug, confirm it fails, then fix.
- **Refactoring is a separate PR.** If a feature needs refactoring, land the refactor first, then the feature. Never mix.
- **Fix by adjusting, not adding.** Prefer a 1-line fix over a 10-line fix. Prefer adjusting existing code over adding new branches. Search for existing helpers and patterns that already handle similar cases. Ask: "Am I adding code, or fixing the code that's already there?"
- **Self-review your diff.** Before declaring done, review: Is this the minimal fix? Am I reusing existing patterns? Did I leave any debug artifacts?
- **Refactoring is a separate PR.** If a feature requires refactoring, do the refactoring first in its own PR, get it merged, then implement the feature. Never mix refactoring with feature work — the combined diff is hard to review and easy to break.

## Git: branch names, commits, PR titles

Conventional Commits for all three. Branch: `type/short-desc` (e.g. `fix/connection-timeout`). Commit/PR title: `type: Description` (e.g. `fix: Handle connection errors`). Types: `feat`, `fix`, `chore`, `refactor`, `docs`. Append `!` for breaking changes. PR title ≤70 chars.

## Verification (mandatory)

After every code change, run `npm run type-check`, `npm run lint`, and `npm run test:unit`.
Zero tolerance for errors — fix before proceeding, don't defer.

## Agent constraints

- **Do NOT use `npm run build` for type-checking.** Use `npm run type-check` — it is faster and skips JavaScript output generation. Only use `npm run build` when compiled output is explicitly needed (e.g., before mcpc probing).
- **Do NOT run integration tests as an agent.** They require a valid `APIFY_TOKEN` and are slow.

## Testing the MCP server end-to-end

After code changes, verify the server works — not just that it compiles. There are two ways:

**1. mcpc** — CLI client, best for scripted/automated verification.
- Requires `APIFY_TOKEN` in the environment (see [DEVELOPMENT.md](./DEVELOPMENT.md) § *Configuring APIFY_TOKEN*).
- Requires `npm run build` before each session (mcpc runs `dist/stdio.js`).
- Discover tools with `mcpc @stdio tools-list`.
- Test all default tools: `search-actors`, `fetch-actor-details`, `call-actor`, `get-actor-run`, `get-actor-output`, `search-apify-docs`, `fetch-apify-docs`.

```bash
npm run build
mcpc connect .mcp.json:stdio @stdio   # first time
mcpc @stdio restart                    # after code changes
mcpc @stdio tools-call search-actors keywords:="web scraper"
```

**2. Native MCP client** (e.g. Claude Code, Cursor) — the server is already connected and tools are in context.
- Auth is handled by the user's MCP config (token or OAuth).
- Tools are already discoverable — just call them directly.
- Use this when verifying behavior as a real client sees it.

If unsure which approach to use or how to authenticate, ask the user.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for mcpc setup details and examples.

## Testing

### Running tests

- **Unit tests**: `npm run test:unit` (runs `vitest run tests/unit`)
- **Integration tests**: `npm run test:integration` (requires build first, requires `APIFY_TOKEN` — humans only)

### Test structure

- `tests/unit/` — unit tests for individual modules
- `tests/integration/` — integration tests for MCP server functionality
  - `tests/integration/suite.ts` — **main integration test suite** where all test cases should be added
  - Other files in this directory set up different transport modes (stdio, SSE, streamable-http) that all use `suite.ts`
- `tests/helpers.ts` — shared test utilities
- `tests/const.ts` — test constants

### Test guidelines

- Write tests for new features and bug fixes
- Use descriptive test names that explain what is being tested
- Follow existing test patterns in the codebase
- Ensure all tests pass before submitting a PR

### Adding integration tests

**IMPORTANT**: Add integration test cases to `tests/integration/suite.ts`, NOT as separate test files.

`suite.ts` exports `createIntegrationTestsSuite()`, used by all transport modes (stdio, SSE, streamable-http). Adding tests here ensures they run across all transport types.

**How to add a test case:**
1. Open `tests/integration/suite.ts`
2. Add your test case inside the `describe` block
3. Use `it()` or `it.runIf()` for conditional tests
4. Use `client = await createClientFn(options)` to create the test client
5. Always call `await client.close()` when done

**Example:**
```typescript
it('should do something awesome', async () => {
    client = await createClientFn({ tools: ['actors'] });
    const result = await client.callTool({
        name: HelperTools.SOME_TOOL,
        arguments: { /* ... */ },
    });
    expect(result.content).toBeDefined();
    await client.close();
});
```

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
