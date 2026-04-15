# Actor Input Schema: required vs default vs prefill

Reference for the `fixZodSchemaRequired()` pipeline (fix for [#637](https://github.com/apify/apify-mcp-server/issues/637)).

## Apify spec semantics

Per [Apify input-schema spec](https://docs.apify.com/platform/actors/development/actor-definition/input-schema/specification):

| Key | Who fills it | User must provide? |
|---|---|---|
| `required` | User | Yes — Actor cannot run without it (e.g. API token, search keyword) |
| `default` | Platform | No — platform fills it in if omitted (e.g. `maxResults: 3`) |
| `prefill` | UI hint only | No — shown in Apify Console as an example value; doesn't reach the API |

**Spec rule**: "The combination of Default + Required doesn't make sense to use." A field with a real default is effectively optional — advertise it in `required` and MCP clients will force users to supply something the platform would have filled in anyway.

## Worked example — `apify/rag-web-browser`

Upstream `INPUT_SCHEMA.json` (abbreviated):

```json
{
    "properties": {
        "query":         { "type": "string",  "prefill": "web browser for RAG pipelines" },
        "maxResults":    { "type": "integer", "default": 3 },
        "outputFormats": { "type": "array",   "default": ["markdown"] }
    },
    "required": ["query"]
}
```

What MCP `tools/list` should advertise: `"required": ["query"]`

- `query` — required, no default, has prefill. User MUST supply it.
- `maxResults` — has default. Not in required; platform passes `3`.
- `outputFormats` — has default. Not in required; platform passes `["markdown"]`.

## Real Actors and their field outcomes

| Actor | Field | required | default | Outcome in `required` |
|---|---|---|---|---|
| apify/rag-web-browser | `query` | yes | (none) | stays |
| apify/rag-web-browser | `maxResults` | no | `3` | n/a (not required upstream) |
| apify/website-content-crawler | `startUrls` | yes | (none) | stays |
| apify/website-content-crawler | `proxyConfiguration` | yes | `{...}` | removed (spec-discouraged combo; default wins) |
| apify/google-search-scraper | `queries` | yes | (none) | stays |
| apify/instagram-post-scraper | `username` | yes | (none) | stays |

## The bug (#637) and the fix

### Root cause

`filterSchemaProperties()` (`src/tools/utils.ts`) unconditionally assigns every whitelisted key,
including `default: property.default`, creating a phantom `default: undefined` in-memory key on
every property that had no upstream default.

Before the fix, `fixZodSchemaRequired()` used a key-presence check:

```typescript
// OLD — broken: 'default' in field matches phantom `default: undefined`
return !('default' in fieldSchema);
```

This stripped every field from `required` for every Actor. Every Actor input looked fully optional.

### Fix (value-check)

```typescript
// NEW — value-check: only real defaults (non-undefined) count
return (fieldSchema as { default?: unknown }).default === undefined;
```

Schema before fix reaching `fixZodSchemaRequired` (after `filterSchemaProperties`):

```json
{
    "properties": {
        "query":         { "type": "string", "default": undefined, "prefill": "…" },
        "maxResults":    { "type": "integer", "default": 3 }
    },
    "required": ["query"]
}
```

After fix — output:

```json
{ "required": ["query"] }
```

### Canonical reference

The same value-check (`field?.default !== undefined`) is used by Apify's platform-side
input-schema validator. The fix deliberately mirrors that pattern.

## Follow-up cleanup (#675)

The phantom-key corruption originates in `filterSchemaProperties()`. The downstream value-check
in `fixZodSchemaRequired()` is a symptom fix. The follow-up PR should:

1. Make `filterSchemaProperties()` preserve only keys whose upstream value is not `undefined`.
2. Update the test assertion in `tools.utils.test.ts` (~line 725) that currently codifies the bug.
3. Consider extracting shared helpers to `@apify/input_schema` so public and internal repos
   share the same normalisation logic.
