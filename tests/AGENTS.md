<!-- agents-scope: tests -->
# Testing

↑ [Root](../AGENTS.md)

> [!IMPORTANT]
> **Before writing or editing ANY unit test, you MUST read [UNIT_TESTING_GUIDE.md](./UNIT_TESTING_GUIDE.md) in full — Read the file, do not rely on this summary or your memory of it.** This is a hard gate, not a suggestion: a linked reference is not a substitute for opening the file. Do not write a single `it(...)` until you have read it this session. If you are about to add unit tests and have not yet read it, stop and read it first.

## Core conventions

- **Writing unit tests? Read [UNIT_TESTING_GUIDE.md](./UNIT_TESTING_GUIDE.md) first — this is mandatory (see the callout above).**
- Fix tests that your change breaks.
- Add unit tests for self-contained logic changes: cover the unit's own branches, one behavior per test, and do not re-test dependencies that have their own suites.
- Unit tests fake the Apify API - pass a stub client with `mockApifyClient` from [`unit/helpers/tool_context.ts`](./unit/helpers/tool_context.ts), which also has other test helpers. Prefer that over building elaborate fakes.
- Add integration coverage for behavior that depends on the real Apify API or a transport: a case in `test_kit/cases/*.cases.ts` (see the root [Testing](../AGENTS.md) section).
- Keep existing tests passing when your change touches their area.
- Vitest runs with globals enabled.
- In newly created unit tests, do not focus too closely on logic that is already checked by TypeScript.

## What to test

Choose the smallest test layer that gives confidence, and add broader coverage when the change crosses boundaries:

- Unit tests for self-contained logic, utilities, helpers, tool handlers, and server request handlers
- Integration cases for behavior against the real Apify API and across the stdio, streamable HTTP, and stateless HTTP transports
- Conformance tests for MCP protocol behavior
- mcpc probing to confirm a change works end to end
- MCP agent evals for how models pick and call tools

In practice, many changes need more than one layer. For example:

- a utility or parser change may only need unit tests
- a new tool or a change to a tool's API calls may need unit tests plus an integration case
- a tool description change may need an eval case

Commands for each layer are in the [Testing](../DEVELOPMENT.md#testing) section of DEVELOPMENT.md.
