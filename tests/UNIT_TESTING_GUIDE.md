# Unit testing guide

Rules for writing unit tests that stay useful to human readers. The recurring failure mode in generated suites is volume without value: many overlapping cases, tests that re-verify dependencies or the language itself, and whole branches of the unit left uncovered. A large suite reads as "thoroughly tested" while proving less than a small, deliberate one.

Applies to new and edited tests. Existing tests predate it and often break its rules; when a neighboring file conflicts with the guide, the guide wins.

## Scope: test the unit's own logic

Before writing anything, read the unit and separate what it **decides** from what it **delegates**. Test the decisions. For delegation, prove the wiring and stop.

- **Do not re-enumerate a dependency's semantics.** If a helper has its own test file, one case where the helper accepts and one where it rejects, each asserting the caller's reaction, is enough to prove it is called with the right arguments. Anything more duplicates the helper's suite and goes stale twice when the helper changes.
- **Do not test the language or standard library.** Wrapping a predicate in `[...].filter(...)` and asserting that filtering returns matching elements, an empty array when nothing matches, and everything when everything matches tests `Array.prototype.filter`, not the unit. If callers filter with the predicate, that belongs to the caller's tests.
- **Do not assert compile-time properties at runtime.** A test that checks `result[0].extra === 'data'` to show a generic "preserves the element type" verifies TypeScript, not behavior. If the types were wrong it would not compile.
- **Test through the public entry point of the unit, in the shape callers use it.** Do not invent wrapper scenarios the unit does not own.
- **Do not re-assert fixture data.** When a unit passes a fixture through (a task tool forwarding `mockTask().input` to the API client), assert the pass-through once with `toHaveBeenCalledWith`. Re-typing the fixture's field values in further tests makes change detectors on data: any intentional edit to the fixture breaks them, and they can never catch a logic bug.

## Test doubles: prefer real infrastructure, fake only true externals

**Unit tests run in-process and need no credentials.** Use the real code the unit touches — `ActorsMcpServer`, the tool registry, Zod schemas, the MCP SDK — and reach for it before building an elaborate fake of it; the fake is where bugs hide. What still deserves a test double: the Apify API, other outbound HTTP calls, and anything slow or nondeterministic.

[`tests/unit/helpers/`](./unit/helpers) is the toolbox for this:

- **Apify API**: `mockApifyClient(methods)` (`tool_context.ts`) passes a stub client into the unit. It casts the supplied methods to the client type; it does not check their signatures or return values. `mockTaskApiClient` and `mockScheduleApiClient` are fakes that record every call, with `mockTask` and `mockSchedule` factories.
- **Server**: `withServer(run)` (`mcp_server.ts`) builds a real `ActorsMcpServer` and always closes it; `getRequestHandler` invokes an SDK request handler directly, without a transport.
- **Tool calls**: `stubToolCallContext` builds the tool call arguments; `textOf` reads text content; `expectSchemaConformingStructuredContent` checks `structuredContent` against the tool's `outputSchema` the way the SDK client does; `expectSoftFailInvalidInput` asserts soft-fail responses.

When you fake anyway, follow these rules:

- **Do not `vi.mock` a module and re-declare its constants.** A test that imports a constant from the module it mocked compares the mock to itself and keeps passing if the real default changes. Mock the smallest thing that needs replacing, and let real constants stay real.
- **No shared mutable mock state.** A module-level mock object that tests mutate and `afterEach` resets field by field leaks on the first forgotten reset, and `as any` escapes on it show the mock does not match its own type. Build a fresh mock per test from a small factory (`mockTask(overrides)`) instead — and if faking a dependency requires module-mocking gymnastics, consider whether the unit should accept it as a parameter.
- **Keep fake return values shaped like the real contract.** A fake that returns two fields where the real response carries six silently exercises only the fallback paths and keeps passing if the real response shape changes. Derive the fake's type from the real signature (`Awaited<ReturnType<...>>`) so drift becomes a compile error.

## Assert contracts, not incidental output

- **Log wording is not a contract.** Substring assertions on log messages break on any copy edit while proving little. Asserting *that* a warning happened is legitimate when the warning is the observable behavior (a warn-and-skip path where the log line is the only outcome); pinning its phrasing, or substring-scanning a whole joined log stream for a summary table's contents, is testing presentation. Formatting belongs to the formatter's own unit, not to every caller. Text served to MCP clients is different: tool result text, descriptions, and errors are a contract (see [TOOL_GUIDELINES.md](../TOOL_GUIDELINES.md)). Assert the parts that carry it — a tool name, an ID, the instruction given — not whole sentences or paragraphs.
- **Control time; do not bracket it.** Capturing `Date.now()` before and after the call and absorbing the slack with `toBeCloseTo` hides off-by-one bugs and eventually flakes. Use `vi.useFakeTimers()` / `vi.setSystemTime()` and assert exact values.

## Coverage: branches before variations

- **Enumerate the unit's branches from the source and give each outcome one test.** Only then consider variations. Padding obvious cases hides real gaps, because a reviewer sees a long file and assumes the function is covered.
- **Distinguish boundaries from padding.** An empty list and an unknown (nullish) list take different paths when `[]` fails a required check but `null`/`undefined` skips it, so each deserves a test. But `null` vs `undefined` through a `??` fallback is the same path. When two inputs cannot take different paths, keep one.
- **A positive and a negative case per rule** ("matches" / "does not match") is usually the right amount. Add a third only when it exercises a genuinely different path, such as one input satisfying two patterns at once.

## One behavior per test

- Before adding a test, answer: **what does this prove that no existing test proves?** If nothing, do not add it. Two tests with the same inputs and assertions under different names prove one thing.
- **Do not expand combinatorially.** Independent dimensions (URL match × required names × flags) do not need a test per combination; test each dimension where it branches, plus one composed case if the composition itself is a behavior ("multiple flags must all match").
- When a test fails, its name plus its body should identify the broken rule without reading other tests.

## Readability

- **A factory helper with overrides** (`mockTask({ publicConfig: { publishedAt: null } })`) supplies required-but-irrelevant fields, so each test body shows only the values that matter to it.
- **`describe` blocks named after behaviors**, not method names: `explicit allowlist takes priority over discovered defaults`, not the function's name.
- **Test names are behavior statements** that read as documentation: `is not eligible when the allowlist excludes the required tool`.
- **Each test is self-contained**: arrange, act, assert visible in one screen, no shared mutable state, no hidden setup in `beforeEach`.
- **Comment only non-obvious intent or expectations.** Explain which rule fired or which spec default applies; do not restate the test name or mechanics. For example, `// Best-effort: one failed step must not abort the whole run` identifies the product rule the test protects.
- **Realistic domain data** (`apify/rag-web-browser`, `get-dataset-items`) over `foo`/`bar` — it makes the scenario legible to someone who knows the domain.
- **Derive expectations from the unit's own exported source of truth.** Assert a truncated name against `MAX_TOOL_NAME_LENGTH` exported by the unit instead of a hardcoded `64`, so changing the limit does not break unrelated tests. (Deriving *structure* is good; re-asserting the fixture's *values* is the anti-pattern above.)

## Checklist before finishing a suite

1. Every branch of the unit has a test; diff the source's conditionals against the describe blocks.
2. No test re-proves a dependency that has its own test file (beyond one wiring pair).
3. No two tests have inputs that take the same code path.
4. Test count roughly tracks the unit's branch count, not the input space's combination count.
5. Code the unit touches is real unless it is external (the Apify API, the network); every remaining fake matches the real contract's shape, and no mocked module re-declares real constants.
6. No test asserts on log or message wording unless that output is the behavior; no test mutates shared module-level mock state; time is controlled with fake timers, not bracketed.
