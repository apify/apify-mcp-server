<!-- agents-scope: src/resources -->
# src/resources — MCP resources + widget registry

↑ [src/](../AGENTS.md) · sideways: [`../web/AGENTS.md`](../web/AGENTS.md)

Three files serving the MCP `resources/*` surface:

- `resource_service.ts` — handles `ListResources` / `ListResourceTemplates` /
  read-resource requests. Takes an optional `apifyClient` on list/read; the server
  builds it from the per-request token (`_meta.apifyToken || options.token`).
- `api_resources.ts` — a thin MCP-resource proxy over the Apify API: any Apify API GET
  endpoint is readable as a resource, identified by its real API URL.
- `widgets.ts` — the registry of UI widgets (the metadata that maps a widget name to
  its resource); the widgets themselves are built in [`../web`](../web/AGENTS.md).

## API resources (`api_resources.ts`)

Resource URIs are real Apify API GET URLs (`https://api.apify.com/v2/...`), so URLs that
Actors and tools return in their responses can be read back verbatim — no scheme to
translate. `isApifyApiUri()` gates reads to the configured API origin
(`getApifyAPIBaseUrl()`): the apify-client attaches the session token as an `Authorization`
header to **every** outbound request, so we must never hand it a non-Apify host.

`readApiResource()` is a generic proxy: `apifyClient.httpClient.call({ method: 'GET', responseType: 'arraybuffer' })`
(do **not** set `forceBuffer` — that skips the client's Content-Type parsing). The parsed
body is JSON → object, text/xml → string, anything else → `Buffer`, empty → `undefined`.
Binary and empty bodies are keyed off the JS type; a JSON body is re-serialized with `JSON.stringify`
(keyed off the declared Content-Type) so `null` and bare-string primitives round-trip, and text/xml
strings are emitted verbatim. Buffers over `KV_RECORD_MAX_INLINE_BYTES`
(256 KB) link out — an explanatory `text/plain` block naming the URL + size + type
(`resources/read` has no `resource_link` content type) — instead of inlining base64. For a KVS
record the URL is the store's `recordPublicUrl` (auth-free only when the store has a URL-signing key);
an unsigned record URL and every other endpoint fall back to the token-gated API URL, so the block says
the link may require the token. Text/JSON bodies are not size-capped (the model paginates via
`limit`/`offset`). Errors never throw: a missing resource, bad token, or 5xx returns an explanatory
`text` block.

Discovery is the server-instructions prose, not a fixed list: `resources/templates/list` returns
nothing and `resources/list` serves only widgets + the usage guide. The read path is a generic
proxy, so any Apify API GET URL works whether or not it was ever listed.

## Gotcha

`widgets.ts` is **metadata only** — it registers and locates widgets. The actual
React widget code and design rules live in [`../web/AGENTS.md`](../web/AGENTS.md);
keep the two in sync (a widget registered here must exist there, and vice versa).

After any change here run the root [Verification](../../AGENTS.md) steps.
