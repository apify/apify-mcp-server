# Unit testing guide

Rules for writing unit tests that stay useful to human readers. The recurring failure mode in generated suites is volume without value: many overlapping cases, tests that re-verify dependencies or the language itself, and whole branches of the unit left uncovered. A large suite reads as "thoroughly tested" while proving less than a small, deliberate one.

Every anti-pattern below was taken from a real Apify test suite; the examples are anonymized, but each one happened.

## Scope: test the unit's own logic

Before writing anything, read the unit and separate what it **decides** from what it **delegates**. Test the decisions. For delegation, prove the wiring and stop.

- **Do not re-enumerate a dependency's semantics.** If a helper has its own test file, one passing and one failing case through the caller is enough to prove it is called with the right arguments. One reviewed suite spent 17 of its 33 tests re-proving two pattern-matching helpers that already had their own suites - two tests would have proven the delegation; the rest duplicated coverage and go stale twice when the helper changes.
- **Do not test the language or standard library.** The same suite wrapped its predicate in `[...].filter(...)` and asserted that filtering returns matching elements, returns an empty array when nothing matches, and returns everything when everything matches. That is `Array.prototype.filter`, not the unit. If callers filter with the predicate, that belongs to the caller's tests.
- **Do not assert compile-time properties at runtime.** A test that checks `result[0].extra === 'data'` to show a generic "preserves the element type" verifies TypeScript, not behavior. If the types were wrong it would not compile. (See also the core rule in [AGENTS.md](./AGENTS.md): do not test what TypeScript already checks.)
- **Test through the public entry point of the unit, in the shape callers use it.** Do not invent wrapper scenarios the unit does not own.
- **Do not re-assert fixture data.** When a unit passes a constant through (`createUsers(DEFAULT_ACCOUNTS)`), assert the pass-through once (`toHaveBeenCalledWith(DEFAULT_ACCOUNTS)`). One reviewed suite instead spent two tests re-typing the fixture's field values and hardcoded them again in a third assertion. Such tests are change detectors on data: any intentional edit to the fixture breaks them, and they can never catch a logic bug.

## Test doubles: prefer real infrastructure, fake only true externals

**Unit tests run in-process and need no credentials.** Use the real code the unit touches - `ActorsMcpServer`, the tool registry, Zod schemas, the MCP SDK - and reach for it before building an elaborate fake of it - the fake is where bugs hide. What still deserves a test double: the Apify API, other outbound HTTP calls, and anything slow or nondeterministic.

[`tests/unit/helpers/`](./unit/helpers) is the toolbox for this:

- **Apify API**: `mockApifyClient(methods)` (`tool_context.ts`) passes a stub client into the unit. `mockTaskApiClient` and `mockScheduleApiClient` are fakes that record every call, with `mockTask` and `mockSchedule` factories.
- **Server**: `withServer(run)` (`mcp_server.ts`) builds a real `ActorsMcpServer` and always closes it; `getRequestHandler` invokes an SDK request handler directly, without a transport.
- **Tool calls**: `stubToolCallContext` builds the tool call arguments; `textOf` reads text content; `expectSchemaConformingStructuredContent` checks `structuredContent` against the tool's `outputSchema` the way the SDK client does; `expectSoftFailInvalidInput` asserts soft-fail responses.

When you fake anyway, follow these rules:

- **Do not `vi.mock` a module and re-declare its constants.** One reviewed suite mocked a registry module and re-declared its window-size constant, then imported that constant from the mocked module to assert a computed date range - the test compares the mock to itself and keeps passing if the real default changes. Mock the smallest thing that needs replacing (there, an array of steps), and let real constants stay real.
- **No shared mutable mock state.** The same suite hoisted one module-level mock object that individual tests mutated (`mockStep.filter = [...]`, `(mockStep as any).extraHook = ...`) and `afterEach` reset field by field, including a `delete (mockStep as any).extraHook`. Every new mock field is a leak waiting for a forgotten reset, and the `as any` escapes show the mock does not even match its own type. Build a fresh mock per test from a small factory instead - and if faking a dependency requires module-mocking gymnastics, consider whether the unit should accept it as a parameter.
- **Keep fake return values shaped like the real contract.** One fake returned two fields where the real response carried six - including fields the code under test reads - so the tests silently exercised only the fallback paths and would keep passing if the real response shape changed. Derive the fake's type from the real signature (`Awaited<ReturnType<...>>`) so drift becomes a compile error.

## Assert contracts, not incidental output

- **Log wording is not a contract.** Substring assertions on log messages break on any copy edit while proving little. Asserting *that* a warning happened is legitimate when the warning is the observable behavior (a warn-and-skip path where the log line is the only outcome); pinning its phrasing, or substring-scanning a whole joined log stream for a summary table's contents, is testing presentation. Formatting belongs to the formatter's own unit, not to every caller. Text served to MCP clients is different: tool result text, descriptions, and errors are a contract (see [TOOL_GUIDELINES.md](../TOOL_GUIDELINES.md)). Assert the parts that carry it - a tool name, an ID, the instruction given - not whole sentences or paragraphs.
- **Control time; do not bracket it.** One test captured `Date.now()` before and after the call and used `toBeCloseTo(diffDays, 0)` to absorb the slack. Use `vi.setSystemTime()` and assert exact values - approximate assertions hide off-by-one bugs and eventually flake.

## Coverage: branches before variations

- **Enumerate the unit's branches from the source and give each outcome one test.** Only then consider variations. One reviewed suite had 33 tests and still missed an entire branch of the 30-line function under test - padding obvious cases hides real gaps, because a reviewer sees a long file and assumes the function is covered.
- **Distinguish boundaries from padding.** An empty list and an unknown (nullish) list take different paths when `[]` fails a required check but `null`/`undefined` skips it, so each deserves a test. But `null` vs `undefined` through a `??` fallback is the same path - one suite proved that single behavior three times by enumerating `undefined`/`null` combinations. When two inputs cannot take different paths, keep one.
- **A positive and a negative case per rule** ("matches" / "does not match") is usually the right amount. Add a third only when it exercises a genuinely different path, such as one input satisfying two patterns at once.

## One behavior per test

- Before adding a test, answer: **what does this prove that no existing test proves?** If nothing, do not add it. One reviewed suite contained two tests with byte-identical inputs and assertions under different names, and asserted the same empty-input case twice (once bare, once wrapped in `filter`).
- **Do not expand combinatorially.** Independent dimensions (URL match × required names × flags) do not need a test per combination; test each dimension where it branches, plus one composed case if the composition itself is a behavior ("multiple flags must all match").
- When a test fails, its name plus its body should identify the broken rule without reading other tests.

## Readability

These are the things the reviewed suites got right - keep doing them:

- **A factory helper with overrides** (`makeUser({ plan: 'BUSINESS', ...overrides })`) supplies required-but-irrelevant fields, so each test body shows only the values that matter to it.
- **`describe` blocks named after behaviors**, not method names: `explicit allowlist takes priority over discovered defaults`, not the function's name.
- **Test names are behavior statements** that read as documentation: `is not eligible when the allowlist excludes the required tool`.
- **Each test is self-contained**: arrange, act, assert visible in one screen, no shared mutable state, no hidden setup in `beforeEach`.
- **Comment only non-obvious expectations.** A one-line note explaining *why* the expected value is `false` (which rule fired, which spec default applies) earns its place; comments restating the test name do not.
- **Comments that state intent, not mechanics**: `// Best-effort: one failed step must not abort the whole run` tells the reader which product rule the test protects.
- **Realistic domain data** (`https://api.slack.com`, `send_message`) over `foo`/`bar` - it makes the scenario legible to someone who knows the domain.
- **Derive expectations from the unit's own exported source of truth.** Assert call counts against `USER_KEYS.length` exported by the unit instead of a hardcoded `2`, so adding an entry does not break unrelated tests. (Deriving *structure* is good; re-asserting the fixture's *values* is the anti-pattern above.)

## Checklist before finishing a suite

1. Every branch of the unit has a test; diff the source's conditionals against the describe blocks.
2. No test re-proves a dependency that has its own test file (beyond one wiring pair).
3. No test would still pass if the unit's body were replaced by the standard library call it wraps.
4. No two tests have inputs that take the same code path.
5. Test count roughly tracks the unit's branch count, not the input space's combination count.
6. Code the unit touches is real unless it is external (the Apify API, the network); every remaining fake matches the real contract's shape, and no mocked module re-declares real constants.
7. No test asserts on log or message wording unless that output is the behavior; no test mutates shared module-level mock state; time is controlled with fake timers, not bracketed.
