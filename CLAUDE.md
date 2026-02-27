# Apify MCP server development instructions

## Overview

This is an MCP (Model Context Protocol) server that exposes [Apify Actors](https://apify.com/store) as tools.
It enables AI assistants to discover and use thousands of web scraping and automation tools from the Apify Store.

The codebase is built with TypeScript using ES modules and follows a modular architecture with clear separation of concerns.

The server can run in multiple modes:
- **Standard Input/Output (stdio)**: For local integrations and command-line tools like Claude Desktop
- **HTTP Streamable**: For hosted deployments and web-based MCP clients
- **Legacy SSE over HTTP**: Legacy version of the protocol for hosted deployments and web-based clients (deprecated and will be removed in the future)

### Key concepts

- **MCP**: Model Context Protocol defines tools, resources, and prompts that AI agents can use
- **Apify Actors**: Reusable automation tools (web scrapers, data extractors) available on Apify Store
- **Tool discovery**: Actors are dynamically converted to MCP tools based on their input schemas

### Core Philosophy

- Simple is better than complex
- If the implementation is hard to explain, it's (usually) a bad idea.
- **Ruthlessly minimal**: Only implement what's explicitly in scope
- **Lightweight**: Measure complexity by lines of code, not abstractions
- **No over-engineering**: Solve the current problem, not hypothetical future ones
- **No unsolicited features**: Don't add anything not explicitly requested by human operator

### Root directories
- `src/`: Main TypeScript source code
- `tests/`: Unit and integration tests
- `dist/`: Compiled JavaScript output (generated during build)
- `evals/`: Evaluation scripts and test cases for AI agent interactions
- `res/`: Resources directory containing technical documentation, insights, and analysis about complex subsystems (see [res/INDEX.md](./res/INDEX.md))

### Core architecture (`src/` directory)

The codebase is organized into logical modules:

- `src/mcp/` - Core MCP protocol implementation
- `src/tools/` - MCP tool implementations
- `src/utils/` - Shared utility modules
- `src/actor/` - Actor-specific implementation (for Apify platform deployment) (only used for testing)

- Entry points:
  - `src/index.ts` - Main library export (`ActorsMcpServer` class)
  - `src/index-internals.ts` - Internal exports for testing and advanced usage
  - `src/stdio.ts` - Standard input/output entry point (CLI, used for Docker)
  - `src/main.ts` - Actor entry point (for Apify platform)
  - `src/input.ts` - Input processing and validation

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

**⚠️ IMPORTANT: Do NOT use `npm run build` for routine code verification.** Always use `npm run type-check` instead — it is faster and sufficient for validating TypeScript correctness. Only run `npm run build` when you explicitly need compiled JavaScript output (e.g., before integration tests or deployment).

**When to run verification:**
- After implementing a feature
- After fixing a bug
- After any refactor
- Before marking any task as complete

**What to do if verification fails:**
1. DO NOT proceed to the next task
2. Fix the issue immediately
3. Re-run verification until green
4. Only then continue

### Quick validation workflow

**When to use `type-check` only:**
- When you just want to verify TypeScript compilation without updating `dist/`
- For quick validation during development iterations
- When reviewing code changes before committing
- Faster than `build` since it skips JavaScript output generation

**When to use `build`:**
- Before running integration tests (they require compiled JavaScript in `dist/`)
- When you need the compiled output for testing or deployment

## Testing

### Running tests

- **Unit tests**: `npm run test:unit` (runs `vitest run tests/unit`)
- **Integration tests**: `npm run test:integration` (requires build first, requires `APIFY_TOKEN`)

### Important: Integration tests require APIFY_TOKEN

**⚠️ DO NOT attempt to run integration tests as an agent.** Integration tests require a valid `APIFY_TOKEN` environment variable, which only humans have access to. As an agent, you should:
- Run `npm run type-check` to validate TypeScript changes (do NOT use `npm run build` for this)
- Run `npm run test:unit` for unit tests which don't require authentication
- Skip integration tests - these must be run by humans with valid Apify credentials

### Test structure

- `tests/unit/` - Unit tests for individual modules
- `tests/integration/` - Integration tests for MCP server functionality
  - `tests/integration/suite.ts` - **Main integration test suite** where all test cases should be added
  - Other files in this directory set up different transport modes (stdio, SSE, streamable-http) that all use suite.ts
- `tests/helpers.ts` - Shared test utilities
- `tests/const.ts` - Test constants

### Test guidelines

- Write tests for new features and bug fixes
- Use descriptive test names that explain what is being tested
- Follow existing test patterns in the codebase
- Ensure all tests pass before submitting a PR

### Adding integration tests

**IMPORTANT**: When adding integration test cases, add them to `tests/integration/suite.ts`, NOT as separate test files.

The `suite.ts` file contains a test suite factory function `createIntegrationTestsSuite()` that is used by all transport modes (stdio, SSE, streamable-http). Adding tests here ensures they run across all transport types.

**How to add a test case:**
1. Open `tests/integration/suite.ts`
2. Add your test case inside the `describe` block (before the closing braces at the end)
3. Use `it()` or `it.runIf()` for conditional tests
4. Follow the existing patterns for client creation and assertions
5. Use `client = await createClientFn(options)` to create the test client
6. Always call `await client.close()` when done

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

### Manual testing as an MCP client

To test the MCP server, a human must first configure the MCP server.
Once configured, the server exposes tools that become available to the coding agent.

#### 1. Human setup (required before testing)

1. **Configure the MCP server** in your environment (e.g., Claude code, VS Code, Cursor)
2. **Verify connection**: The client should connect and list available tools automatically
3. **Tools are now available**: Once connected, all MCP tools are exposed and ready to use

#### 2. Coding agent for MCP server testing

**Note**: Only execute the tests when explicitly requested by the user.

Once the MCP server is configured, test the MCP tools by:

1. **Invoke each tool** through the MCP client (e.g., ask the AI agent to "search for actors" or "fetch actor details for apify/rag-web-browser")
2. **Test with valid inputs** (happy path) – verify outputs match expected formats
3. **Test with invalid inputs** (edge cases) – verify error messages are clear and helpful
4. **Verify key behaviors**:
   - All tools return helpful error messages with suggestions
   - **get-actor-output** supports field filtering using dot notation
   - Search tools support pagination with `limit` and `offset`

**Tools to test:**
- **search-actors** - Search Apify Store (test: valid keywords, empty keywords, non-existent platforms)
- **fetch-actor-details** - Get Actor info (test: valid actor, non-existent actor)
- **call-actor** - Execute Actor with input
- **get-actor-output** - Retrieve Actor results (test: valid datasetId, field filtering, non-existent dataset)
- **search-apify-docs** - Search documentation (test: relevant terms, non-existent topics)
- **fetch-apify-docs** - Fetch doc page (test: valid URL, non-existent page)

## Coding guidelines

See [CONTRIBUTING.md](./CONTRIBUTING.md) for all coding standards, common patterns, anti-patterns, and design system rules.

## Branching strategy

Follow [CONTRIBUTING.md](./CONTRIBUTING.md) for commit message format, PR best practices, and coding standards.

## External dependencies

### Important relationship: apify-mcp-server-internal

**IMPORTANT**: This package (`@apify/actors-mcp-server`) is imported and used in the private repository `~/apify/apify-mcp-server-internal` for the hosted server implementation.

**Key points:**
- Changes to this repository may affect the hosted server
- Breaking changes must be coordinated between both repositories
- The hosted server uses this package as a dependency
- Canary releases can be created using the `beta` tag on PR branches (see README.md)

**Before making changes:**
- Consider the impact on the hosted server
- Test changes locally before submitting PRs
- Coordinate breaking changes with the team
- Check if changes require updates in `apify-mcp-server-internal`

**Using pkg.pr.new for cross-repo testing:**

PRs with the `beta` label automatically publish a preview package to [pkg.pr.new](https://pkg.pr.new). The internal repo can install it to verify compatibility before the core PR is merged:

```bash
# In apify-mcp-server-internal:
npm i https://pkg.pr.new/apify/apify-mcp-server/@apify/actors-mcp-server@<PR_NUMBER>
npm run type-check && npm run lint

# After core PR merges and releases, restore:
npm install @apify/actors-mcp-server@^<RELEASED_VERSION>
```

## Development workflow

### Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Build the project: `npm run build`

### Development commands

- `npm run start` - Start standby server (uses `tsx` for direct TypeScript execution)
- `npm run dev` - Run standby server with hot-reload
- `npm run build` - Build TypeScript and UI widgets
- `npm run build:web` - Build UI widgets only
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint issues automatically
- `npm run type-check` - Type check without building
- `npm run test` - Run unit tests
- `npm run test:integration` - Run integration tests (requires build)
- `npm run clean` - Clean build artifacts
