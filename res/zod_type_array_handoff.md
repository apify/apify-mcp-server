# Handoff: zod 4.6 `type` arrays vs. the tool-schema portability rule

Written 2026-11-09. Updated the same day after checking the spec and current client source. Branch `chore/bump-vulnerable-deps` in `apify/apify-mcp-server` (uncommitted working tree, off `master`).

Delete this note when the bump PR merges.

## Decision

Serve Zod's `type` arrays. Drop the post-processor that is on the branch now.

`anyOf` of bare types and a `type` array are the same JSON Schema constraint. MCP tool schemas are JSON Schema 2020-12, where a `type` array is legal. Claude's strict tool grammar counts both forms. Gemini's current MCP path sends the schema through as JSON Schema and accepts a `type` array. The repo rule that forbids them comes from an MCP Inspector warning about Gemini's old OpenAPI `parameters` field. Official Gemini MCP clients no longer send that field.

No live call of these six schemas was made against Gemini or Claude. The conclusion is from the spec and the client source linked below.

## What the bump forces

The branch bumps every vulnerable dependency (Dependabot had 110 alerts, `pnpm audit` is now clean). One bump forces this schema choice: zod 4.4.3 → 4.6.7 (security fix GHSA-mrhx-c7xc-m3w5, patched in 4.6.6, so staying below 4.5 is not an option).

Zod 4.6 did not remove `anyOf`. `toJSONSchema()` still builds it, then a final pass rewrites the boring case. `compactTypeUnion` in `node_modules/zod/v4/core/to-json-schema.js` turns `anyOf: [{type:"a"},{type:"b"}]` into `type: ["a","b"]` when every branch is a bare `{ type }`. There is no flag to turn that pass off. `target: "openapi-3.0"` skips it and changes the rest of the dialect, so it is not a local fix. The pass runs on the finished schema, so a hand-written `anyOf` passed through `.meta()` is rewritten too.

That pass is Zod PR #6339 (merged 2026-08-19, closes #6047). The request was from people who check generated schemas into git and wanted the short form `zod-to-json-schema` already printed, mainly `z.string().nullable()` as `type: ["string", "null"]`. Zod's comment on the function: every JSON Schema draft treats the two forms as equivalent, and most consumers render the nullable case better as a `type` array. `oneOf` is left alone. Branches that carry anything besides `type` (a description, `enum`, `const`, `$ref`, a constraint) are left alone.

## The six fields Zod 4.6.7 rewrites

`tests/unit/tools.schemas.test.ts` walks every registered tool's `inputSchema` and `outputSchema` and fails on a `type` array. With 4.6.7 and no post-processor it reports:

```
fetch-actor-details.inputSchema.properties.output.properties.serverInterface        z.union([z.boolean(), z.string()])
send-server-actor-request.inputSchema.properties.query.additionalProperties.anyOf[3].items   z.array(z.union([z.string(), z.number(), z.boolean()]))
send-server-actor-request.inputSchema.properties.body                                .meta(anyJsonValueSchema), a hand-written anyOf of six bare types
apify-api-read.inputSchema.properties.query.additionalProperties.anyOf[3].items      same query shape
apify-api-write.inputSchema.properties.query.additionalProperties.anyOf[3].items     same query shape
apify-api-write.inputSchema.properties.body                                          same meta schema
```

Definitions: `src/tools/actors/fetch_actor_details.ts` (`serverInterface`), `src/tools/api/apify_api_request.ts` (`queryValueSchema`), `src/tools/actors/send_server_actor_request.ts` (`queryValue`, `body`), `src/tools/structured_output_schemas.ts` (`anyJsonValueSchema`).

The query union stays `anyOf` at the outer level, because the array branch has `minItems`. Only `items` collapses. Raw 4.6.7 output for the three shapes:

```json
{ "type": ["boolean", "string"] }
```

```json
{
  "type": "array",
  "minItems": 1,
  "items": { "type": ["string", "number", "boolean"] }
}
```

```json
{ "type": ["object", "array", "string", "number", "boolean", "null"] }
```

`apify-api-write` serves the body through `.meta(anyJsonValueSchema)`. Its Ajv schema is compiled from `apifyApiWriteArgs` without that `.meta()`, so the validator's body is only `{ "description": "..." }`. The type array is on the served schema.

## What is on the branch right now

Option 3 below is implemented and should come back out.

- `src/utils/ajv.ts`: exported `toJsonSchema(schema)` = `z.toJSONSchema(schema)` followed by a walk over schema keywords (`properties`, `$defs`, `additionalProperties`, `items`, `not`, `propertyNames`, `anyOf`, `oneOf`, `allOf`, `prefixItems`) that writes `type: [...]` back as `anyOf`. Values under `default`/`const` are not walked.
- The four affected files call `toJsonSchema(...)` instead of `z.toJSONSchema(...)` for both `inputSchema` and the Ajv validator schema.
- `tests/unit/utils.ajv.test.ts`: three tests for `toJsonSchema`.
- All other `z.toJSONSchema` call sites are untouched.

Verified green on that state, before this research note: `pnpm run type-check`, `pnpm run lint`, `pnpm run format`, `pnpm run check:agents`, `pnpm run test:unit` (3630 passed, 1 skipped), `pnpm audit` (0). Re-ran `tests/unit/tools.schemas.test.ts` and `tests/unit/utils.ajv.test.ts` while checking the note: 16 passed.

## Why the repo forbids `type` arrays

PR #1548 (2026-10-15, commit 37541af5) added the check. Issue #1545 says the MCP Inspector flagged nullable output fields written as `type: ["string", "null"]`, and that clients mapping schemas onto a single-`type` dialect (the example given is Gemini's OpenAPI subset) may reject the tool or drop the constraint. The issue body does not record a measured client failure. Issue #1546 is a different rule in the same test: a subschema with no validation keyword. That one stays.

Do not treat #1545, the comment in `src/utils/ajv.ts`, or `src/tools/structured_output_schemas.ts` as evidence about Gemini. They repeat the Inspector warning.

## What the upstream sources say

Checked 2026-11-09. Links are the pages and files that were read, not this repo.

**MCP.** Tool `inputSchema` / `outputSchema` default to JSON Schema 2020-12 when `$schema` is absent. https://modelcontextprotocol.io/specification/draft/basic and SEP-1613 https://modelcontextprotocol.io/seps/1613-establish-json-schema-2020-12-as-default-dialect-f . In 2020-12, `type` is a string or an array of unique strings. A bare-type `anyOf` and a `type` array validate the same values.

**Inspector.** `core/json/schemaLint.ts` on `modelcontextprotocol/inspector` `main` warns on a legal `type` array and suggests `anyOf`. The warning says the array form is legal, that some providers recommend it for nullable fields (OpenAI structured outputs), and that a client which maps tool schemas onto a single-`type` dialect may reject the tool. It names the OpenAPI subset used for Gemini function declarations. The comment says the finding is a warning on purpose and does not fail the CLI `--strict` exit code. https://github.com/modelcontextprotocol/inspector/blob/main/core/json/schemaLint.ts

**Gemini has two fields.** `FunctionDeclaration.parameters` is an OpenAPI schema proto: `type` is one enum. A type array on that field fails with `Proto field is not repeating, cannot start list` (https://github.com/google/generative-ai-docs/issues/444). `processJsonSchema` / `flattenTypeArrayToAnyOf` in `googleapis/js-genai` `src/_transformers.ts` still rewrites type arrays, and `tTool` runs that only when `parameters` is set and has no `$schema`.

MCP tools take the other field. `mcpToGeminiTool` copies `inputSchema` into `parametersJsonSchema` and `outputSchema` into `responseJsonSchema` with no rewrite. https://github.com/googleapis/js-genai/blob/main/src/_transformers.ts

Gemini CLI `main`, `packages/core/src/tools/mcp-client.ts`, does the same: `McpCallableTool.tool()` sets `parametersJsonSchema` to the MCP `inputSchema`. The only type-array edit in `discoverTools` is a two-element array that contains `"null"`, rewritten to the other type plus `nullable: true`. `["boolean", "string"]` and `["string", "number", "boolean"]` are sent unchanged. The six-type body array is sent unchanged, because the rewrite requires length 2. https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-client.ts

A measurement of `parametersJsonSchema` and `responseJsonSchema` on `gemini-3.8-flash`, dated 2026-10-21, accepted `type: [..., "null"]`, `$ref`, `$defs`, `oneOf`, `allOf`, `const`, numeric `enum`, `patternProperties`, `additionalProperties`, and arrays without `items`. The four shapes that still 400'd were: `required` naming a property that is not declared, draft-04 boolean `exclusiveMinimum`, a tuple `items: [a, b]`, and a recursive `$ref` that is not behind an optional property or an array that may be empty. https://providerkit.dev/reference/index/functions/togeminitoolschema/

**Claude.** Anthropic's structured-output limits count "parameters that use `anyOf` or type arrays (for example `"type": ["string", "null"]`)" toward one budget of 16 per request. Both forms are in the supported strict grammar. https://platform.claude.com/docs/en/build-with-claude/structured-outputs . The Python SDK's `transform_schema` has a reported `AssertionError` on a type array (https://github.com/anthropics/anthropic-sdk-python/issues/1876); that is the SDK helper, and the docs above list the form as supported. A third-party server, Dokploy MCP, reported Anthropic rejecting type arrays and switched to `anyOf` (https://github.com/Dokploy/mcp/issues/37). That report disagrees with Anthropic's current page.

**Who still 400s.** A client that down-converts MCP schemas into the legacy `parameters` proto. The Vercel AI SDK's Google provider added `useParametersJsonSchema` as an opt-in and, in that PR, left the legacy field as the default (https://github.com/vercel/ai/pull/19000). The latest default of `@ai-sdk/google` was not re-checked. Official Gemini CLI and `@google/genai`'s MCP helper do not use that path.

## Ajv, checked locally against both shapes

The read, write, and Server Actor tools compile with `coerceTypes: false`. Under that setting, realistic payloads that pass the `anyOf` form also pass the `type` array, with the same output value. Samples that were compared: query `{limit: 10}`, `{desc: true}`, `{fields: ["id", "name"]}`, `{ids: [1, 2]}`, `{mixed: ["a", 1]}`, `null`, `[]`, and an object; `serverInterface` `true`, `false`, `"GET /search"`, `"true"`, `1`; body `{name: "leads-2026"}`, `["a"]`, `42`, `true`, `null`, `"hello"`, and a JSON string. `null` and `[]` fail both query forms. An object fails both query forms.

`coerceTypes: 'array'` is the shared `compileSchema`, which `fetch-actor-details` uses. Under it, `anyOf` rewrites a query array `[1, 2, 3]` into `["1", "2", "3"]`; the `type` array keeps the numbers. Both still validate. An array passed as `serverInterface` (`["GET /search"]`) is accepted by `anyOf` and rejected by the `type` array. That is not a value the tool asks for. These tools turned the shared coercing compiler off because it rewrites null query values and scalar bodies. Patching Ajv would not change what Gemini receives.

Calls that are valid either way:

```json
{ "actor": "apify/rag-web-browser", "serverInterface": "GET /search" }
```

```json
{ "actor": "apify/rag-web-browser", "serverInterface": true }
```

```json
{ "path": "/v2/acts", "query": { "limit": 10, "my": true, "fields": ["id", "name", 1] } }
```

```json
{ "path": "/v2/datasets/abc", "method": "PUT", "body": { "name": "leads-2026" } }
```

## What to change

1. Drop the `type` array check. Delete the `if (Array.isArray(node.type))` line in `tests/unit/tools.schemas.test.ts`. Leave the keyword-less-subschema check (#1546).
2. Delete `toJsonSchema` / `expandTypeArrays` and the `zod` import from `src/utils/ajv.ts`. Delete the three `toJsonSchema` tests.
3. Put the four call sites back on `z.toJSONSchema`. `git checkout -- src/tools src/utils tests` restores them. After that, only `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `src/web/package.json` belong to the bump.

`src/utils/schema_generation.ts` already emits `type` arrays for an inferred dataset schema. That value is tool output data, not a tool `inputSchema`. The guard test does not cover it.

The hosted repo `apify-mcp-server-internal` may snapshot these schemas in its contract tests. Check before merging. The served shape of those six fields changes from `anyOf` back to a `type` array, which is what Zod 4.4.3 did not emit and what 4.6.7 emits on its own.

Rejected alternatives:

- Decorating union members so `compactTypeUnion` skips them. It skips any branch with a key besides `type`. Honest only for `serverInterface`. For the query items and the body schema it is a trick tied to the current heuristic.
- `target: "openapi-3.0"`. Skips the pass and rewrites the dialect Ajv compiles.
- A patch of Zod's `compactTypeUnion`, or of Ajv. The first fights a printing choice the spec allows. The second never sees the schema a client rejects.

## How to check facts yourself

```bash
# zod's compaction rule
sed -n 254,280p node_modules/zod/v4/core/to-json-schema.js
# what 4.6.7 emits
node --input-type=module -e "import {z} from 'zod'; console.log(JSON.stringify(z.toJSONSchema(z.union([z.boolean(), z.string()]))))"
# the guard test alone
pnpm vitest run tests/unit/tools.schemas.test.ts
# the rule's origin
git show --stat --format=%B 37541af5
```

A scratch install of zod 4.4.3 for comparison: `npm` refuses to run inside the checkout because of `devEngines`. `npm i zod@4.4.3` in an empty directory outside the repo.

## Repo rules that apply

- Every change: `pnpm run type-check && pnpm run lint && pnpm run test:unit && pnpm run format && pnpm run check:agents`. Zero tolerance.
- New or edited unit tests follow `tests/UNIT_TESTING_GUIDE.md` (read it in full first). Test names are plain-verb behavior statements, no "should".
- No issue or PR numbers in code comments. State the reason instead.
- Ask before `git commit`, `git push`, or opening a PR. Conventional Commits; PR title ≤70 chars; disclose AI use in the PR body.
- Do not use `pnpm run build` for type-checking.

## Surrounding context, not part of this decision

- The same bump branch exists in `apify-mcp-server-internal` (`chore/bump-vulnerable-deps` off `develop`, also uncommitted). Its seven remaining alerts need upstream changes (`@apify-packages/opentelemetry` otel train, `@apify-packages/utils` query-string 6, the next `@apify/actors-mcp-server` release, elliptic has no fix). Its `telemetry.test.ts` memory-gauge test is load-flaky and predates the bump.
- Internal issue #878 (MCP SDK bump) is done via #891; the `maxToolInputElements` comment there does not apply because both servers use the SDK's low-level `Server` with Ajv validation, not `McpServer`.
- Advisory GHSA-ffrr-cj64-hrf5 on the public repo is still in triage with wrong fields; patched version is 0.20.0, not 0.19.5; affected `>= 0.9.16, < 0.20.0`.
- Tooling note: in this Claude Code setup, two parallel Bash calls that each start with `cd <dir>` raced on the working directory once. Wrap in a subshell `(cd dir && ...)` or run sequentially.
