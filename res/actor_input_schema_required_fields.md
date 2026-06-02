# Actor Input Schema: required vs default vs prefill

Reference for `fixZodSchemaRequired()` and `filterSchemaProperties()`
(`src/utils/ajv.ts`, `src/tools/utils.ts`). The #637 fix is already in the code; the
`ajv.ts` docstring is the source of truth for it. This file keeps the spec semantics and
the still-open #675 follow-up.

## Apify spec semantics

Per [Apify input-schema spec](https://docs.apify.com/platform/actors/development/actor-definition/input-schema/specification):

| Key | Who fills it | User must provide? |
|---|---|---|
| `required` | User | Yes — Actor cannot run without it (e.g. API token, search keyword) |
| `default` | Platform | No — platform fills it in if omitted (e.g. `maxResults: 3`) |
| `prefill` | UI hint only | No — shown in Apify Console as an example; doesn't reach the API |

**Spec rule**: "The combination of Default + Required doesn't make sense." A field with a
real default is effectively optional; advertising it in `required` forces MCP clients to
supply something the platform would have filled in anyway. So a field stays in `required`
only when it has no real (non-`undefined`) default — the value-check `fixZodSchemaRequired`
applies, mirroring Apify's platform-side validator.

Example — `apify/rag-web-browser` has `required: ["query"]`; `maxResults` (`default: 3`) and
`outputFormats` (`default: ["markdown"]`) are dropped from required because they have
defaults.

## Follow-up cleanup (#675, open)

The root cause of #637 was `filterSchemaProperties()` unconditionally assigning
`default: property.default`, creating phantom `default: undefined` keys. #637 patched the
symptom in `fixZodSchemaRequired` (value-check instead of key-presence). The structural fix
is still pending — see `TODO(#675)` in `src/tools/utils.ts`:

1. Make `filterSchemaProperties()` preserve only keys whose upstream value is not `undefined`.
2. Update the test assertion in `tests/unit/tools.utils.test.ts` (~line 725) that currently codifies the bug.
3. Add the `minItems ≥ 1 for required arrays` rule (currently missing).
4. Consider extracting shared helpers to a public `@apify/input_schema` so public and internal repos share one normalisation implementation.
