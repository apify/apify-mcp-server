# Apify MCP server development instructions

## Overview

The codebase is built with TypeScript using ES modules and follows a modular architecture with clear separation of concerns.

The server can run in multiple modes:
- **Standard Input/Output (stdio)**: For local integrations and command-line tools like Claude Desktop
- **HTTP Streamable**: For hosted deployments and web-based MCP clients
- **Legacy SSE over HTTP**: Legacy version of the protocol for hosted deployments and web-based clients (deprecated and will be removed in the future)

### Root directories
- `src/`: Main TypeScript source code
- `tests/`: Unit and integration tests
- `dist/`: Compiled JavaScript output (generated during build)
- `evals/`: Evaluation scripts and test cases for AI agent interactions

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

## Testing

### Running tests

- **Unit tests**: `npm run test:unit` (runs `vitest run tests/unit`)
- **Integration tests**: `npm run test:integration` (requires build first, requires `APIFY_TOKEN`)

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
  - Use comma-separated parameters for up to 3 parameters
  - Use a single object parameter for more than 3 parameters
- **Declare variables close to use**: Variables should be declared near their first use
- **Extract reusable logic**: Extract complex or reusable logic into named helper functions

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
- Do not duplicate imports - always reuse existing imports if present
- Do not use dynamic imports unless explicitly told to do so

### Error handling

- **User Errors**: Use appropriate error codes (4xx for client errors), log as `softFail`
- **Internal Errors**: Use appropriate error codes (5xx for server errors), log with `log.exception` or `log.error`
- Always handle and propagate errors clearly
- Use custom error classes from `src/errors.ts` when appropriate

### Code quality

- All files must follow ESLint rules (run `npm run lint` before committing)
- Prefer readability over micro-optimizations
- Avoid mutating function parameters (use immutability when possible)
- If mutation is necessary, clearly document and explain it with a comment
- Clean up temporary files, scripts, or helper files created during development

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
