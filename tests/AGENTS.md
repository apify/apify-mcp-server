<!-- agents-scope: tests -->
# Testing

↑ [Root](../AGENTS.md)

> [!IMPORTANT]
> **Before writing or editing any unit test, read [UNIT_TESTING_GUIDE.md](./UNIT_TESTING_GUIDE.md) in full.** Open the file; do not rely on this summary or your memory of it.

## Core conventions

- Fix tests that your change breaks.
- Add unit tests for self-contained logic changes: cover the unit's own branches, one behavior per test, and do not re-test dependencies that have their own suites.
- Unit tests fake only the Apify API; helpers for that live in [`unit/helpers/`](./unit/helpers) (see the guide's test doubles section).
- Add integration coverage for behavior that depends on the real Apify API or a transport: a case in `test_kit/cases/*.cases.ts` (see the root [Testing](../AGENTS.md) section).
- Vitest runs with globals enabled.

## What to test

Choose the smallest test layer that gives confidence, and add broader coverage when the change crosses boundaries. The layers and their commands are in the [Testing](../DEVELOPMENT.md#testing) table in DEVELOPMENT.md.

In practice, many changes need more than one layer. For example:

- a utility or parser change may only need unit tests
- a new tool or a change to a tool's API calls may need unit tests plus an integration case
- a tool description change may need an eval case
