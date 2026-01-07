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
- **Two-step Actor execution**: `call-actor` requires `step="info"` to get schema, then `step="call"` to execute

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

## Validating TypeScript changes

MANDATORY: Always check for TypeScript compilation errors before running tests or declaring work complete.

### TypeScript compilation steps

- Run `npm run type-check` to check for TypeScript errors without building
- Run `npm run build` to compile TypeScript files and check for errors
- Fix all compilation errors before running tests or committing changes

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
- Run `npm run type-check` and `npm run build` to validate TypeScript changes
- Run `npm run test:unit` for unit tests which don't require authentication
- Skip integration tests - these must be run by humans with valid Apify credentials

### Test structure

- `tests/unit/` - Unit tests for individual modules
- `tests/integration/` - Integration tests for MCP server functionality
- `tests/helpers.ts` - Shared test utilities
- `tests/const.ts` - Test constants

### Test guidelines

- Write tests for new features and bug fixes
- Use descriptive test names that explain what is being tested
- Follow existing test patterns in the codebase
- Ensure all tests pass before submitting a PR

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
   - **call-actor** requires two-step workflow (`step="info"` then `step="call"`)
   - All tools return helpful error messages with suggestions
   - **get-actor-output** supports field filtering using dot notation
   - Search tools support pagination with `limit` and `offset`

**Tools to test:**
- **search-actors** - Search Apify Store (test: valid keywords, empty keywords, non-existent platforms)
- **fetch-actor-details** - Get Actor info (test: valid actor, non-existent actor)
- **call-actor** - Execute Actor in two steps: `step="info"` to get schema, then `step="call"` to run
- **get-actor-output** - Retrieve Actor results (test: valid datasetId, field filtering, non-existent dataset)
- **search-apify-docs** - Search documentation (test: relevant terms, non-existent topics)
- **fetch-apify-docs** - Fetch doc page (test: valid URL, non-existent page)

## Coding guidelines

### Indentation

We use **4 spaces** for indentation (configured in `.editorconfig`).

### Naming conventions

- **Constants**: Use uppercase `SNAKE_CASE` for global, immutable constants (e.g., `ACTOR_MAX_MEMORY_MBYTES`, `SERVER_NAME`)
- **Functions & Variables**: Use `camelCase` format (e.g., `fetchActorDetails`, `actorClient`)
- **Classes, Types, Interfaces**: Use `PascalCase` format (e.g., `ActorsMcpServer`, `ActorDetailsResult`)
- **Files & Folders**: Use lowercase `snake_case` format (e.g., `actor_details.ts`, `key_value_store.ts`)
- **Booleans**: Prefix with `is`, `has`, or `should` (e.g., `isValid`, `hasFinished`, `shouldRetry`)
- **Units**: Suffix with the unit of measure (e.g., `intervalMillis`, `maxMemoryBytes`)
- **Date/Time**: Suffix with `At` (e.g., `createdAt`, `updatedAt`)
- **Zod Validators**: Suffix with `Validator` (e.g., `InputValidator`)

### Types and interfaces

- Prefer `type` for flexibility.
- Use `interface` only when it's required for class implementations (`implements`).

### Comments

- Use JSDoc style comments (`/** */`) for functions, interfaces, enums, and classes
- Use `//` for generic inline comments
- Avoid `/* */` multiline comments (single asterisk)
- Use proper English (spelling, grammar, punctuation, capitalization)

### Code structure

- **Avoid `else`**: Return early to reduce indentation and keep logic flat
- **Keep functions small**: Small, focused functions are easier to understand and test
- **Minimal parameters**: Functions should only accept what they actually use
  - Use comma-separated parameters for up to three parameters
  - Use a single object parameter for more than three parameters
- **Declare variables close to use**: Variables should be declared near their first use
- **Extract reusable logic**: Extract complex or reusable logic into named helper functions
- **Avoid intermediate variables for single-use expressions**: Don't create constants or variables if they're only used once. Inline them directly. For example:
  - ❌ Don't: `const docSourceEnum = z.enum([...]); const schema = z.object({ docSource: docSourceEnum })`
  - ✅ Do: `const schema = z.object({ docSource: z.enum([...]) })`
  - Exception: Only create intermediate variables if they improve readability for complex expressions or serve a documentation purpose

### Async functions

- Use `async` and `await` over `Promise` and `then` calls
- Use `await` when you care about the Promise result or exceptions
- Use `void` when you don't need to wait for the Promise (fire-and-forget)
- Use `return await` when returning Promises to preserve accurate stack traces

### Imports and import ordering

- Imports are automatically ordered and grouped by ESLint:
  - Groups: builtin → external → parent/sibling → index → object
  - Alphabetized within groups
  - Newlines between groups
- Use `import type` for type-only imports
- Do not duplicate imports – always reuse existing imports if present
- Do not use dynamic imports unless explicitly told to do so

### Error handling

- **User Errors**: Use appropriate error codes (4xx for client errors), log as `softFail`
- **Internal Errors**: Use appropriate error codes (5xx for server errors), log with `log.exception` or `log.error`
- Always handle and propagate errors clearly
- Use custom error classes from `src/errors.ts` when appropriate
- **Don't log then throw**: Do NOT call `log.error()` immediately before throwing. Errors are already logged by the caller or error handler. This creates duplicate logs and violates separation of concerns.
  - ❌ Don't:
    ```typescript
    if (!indexConfig) {
        const error = `Unknown documentation source: ${docSource}`;
        log.error(`[Algolia] ${error}`);
        throw new Error(error);
    }
    ```
  - ✅ Do:
    ```typescript
    if (!indexConfig) {
        throw new Error(`Unknown documentation source: ${docSource}`);
    }
    ```

### Code quality

- All files must follow ESLint rules (run `npm run lint` before committing)
- Prefer readability over micro-optimizations
- Avoid mutating function parameters (use immutability when possible)
- If mutation is necessary, clearly document and explain it with a comment
- Clean up temporary files, scripts, or helper files created during development

### Common patterns

- **Tool implementation**: Tools are defined in `src/tools/` using Zod schemas for validation
- **Actor interaction**: Use `src/utils/apify-client.ts` for Apify API calls, never call Apify API directly
- **Error responses**: Return user-friendly error messages with suggestions
- **Input validation**: Always validate tool inputs with Zod before processing
- **Caching**: Use TTL-based caching for Actor schemas and details (see `src/utils/ttl-lru.ts`)

### Input validation best practices

- **No double validation**: When using Zod schemas with AJV validation (`ajvValidate` in tool definitions), do NOT add additional manual validation checks in the tool implementation. The Zod schema and AJV both validate inputs before the tool is executed. Any checks redundant to the schema definition should be removed.
  - ❌ Don't: Define enum validation in Zod, then manually check the enum again in the tool function
  - ✅ Do: Let Zod and AJV handle all validation; use the parsed data directly in the tool implementation

### Anti-patterns

- **Don't** call Apify API directly – always use the Apify client utilities
- **Don't** mutate function parameters without clear documentation
- **Don't** skip input validation – all tool inputs must be validated with Zod
- **Don't** use `Promise.then()` - prefer `async/await`
- **Don't** create tools without proper error handling and user-friendly messages

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

## Development workflow

### Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Build the project: `npm run build`

### Development commands

- `npm run start:dev` - Start development server (uses `tsx` for direct TypeScript execution)
- `npm run build` - Build TypeScript to JavaScript
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint issues automatically
- `npm run type-check` - Type check without building
- `npm run test` - Run unit tests
- `npm run test:integration` - Run integration tests (requires build)
- `npm run clean` - Clean build artifacts
