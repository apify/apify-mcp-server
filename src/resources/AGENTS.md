<!-- agents-scope: src/resources -->
# src/resources — MCP resources + widget registry

↑ [src/](../AGENTS.md) · sideways: [`../web/AGENTS.md`](../web/AGENTS.md)

Three files serving the MCP `resources/*` surface:

- `resource_service.ts` — handles `ListResources` / `ListResourceTemplates` /
  read-resource requests. Takes an optional `apifyClient` on list/read; the server
  builds it from the per-request token (`_meta.apifyToken || options.token`). This is
  token-only by design — it does not forward payment headers like the CallTool path, so a
  payment-only session (x402/Skyfire, no token) gets no client and every read soft-fails.
- `api_resources.ts` — a thin MCP-resource proxy over the Apify API: any Apify API GET
  endpoint is readable as a resource, identified by its real API URL.
- `widgets.ts` — the registry of UI widgets (the metadata that maps a widget name to
  its resource); the widgets themselves are built in [`../web`](../web/AGENTS.md).

## API resources (`api_resources.ts`)

Resource URIs are real Apify API GET URLs (`https://api.apify.com/v2/...`), built from the storage
IDs that Actors and tools return (e.g. a `datasetId` → `.../datasets/{id}/items`) — no custom scheme
to translate. `isApifyApiUri()` gates reads to the configured API origin
(`getApifyAPIBaseUrl()`): the apify-client attaches the session token as an `Authorization`
header to **every** outbound request, so we must never hand it a non-Apify host.

`readApiResource()` is a generic proxy: `apifyClient.httpClient.axios.request({ method: 'GET', responseType: 'arraybuffer', maxContentLength: MAX_DOWNLOAD_BYTES })`
(do **not** set `forceBuffer` — that skips the client's Content-Type parsing). It calls the
apify-client's own axios instance directly instead of `httpClient.call()`, deliberately skipping
apify-client's retry wrapper: that wrapper would misclassify the `maxContentLength` abort below as a
retryable network error and retry it 8 times (~127s of backoff) instead of failing fast — so this is
one attempt, no retries. `MAX_DOWNLOAD_BYTES` (5 MB) is enforced mid-flight by axios as bytes arrive, so
an oversized dataset/log is aborted during download instead of being buffered whole first; on trip, the
proxy links out the same way as an oversized inline body (below), skipping straight past the parse step.
The parsed body is JSON → object, text/xml → string, anything else → `Buffer`, empty → `undefined`.
Binary and empty bodies are keyed off the JS type; a JSON body is re-serialized with `JSON.stringify`
(keyed off the declared Content-Type) so `null` and bare-string primitives round-trip, and text/xml
strings are emitted verbatim. Buffers over `MAX_INLINE_BYTES`
(256 KB, unchanged) link out — an explanatory `text/plain` block naming the URL + size + type
(`resources/read` has no `resource_link` content type) — instead of inlining base64. For a KVS
record the URL is the store's `recordPublicUrl` (auth-free only when the store has a URL-signing key);
an unsigned record URL and every other endpoint fall back to the token-gated API URL, so the block says
the link may require the token. A text/JSON body over the same `MAX_INLINE_BYTES` cap links out the same
way — the signed `recordPublicUrl` for a KVS record, else the token-gated API URL — with a hint to page a
dataset/list via `limit`/`offset` (measured on the serialized bytes we would emit, not a `Content-Length`
header; a single record or log can't be paged, so the link is the real remedy). Errors never throw past
this function: this axios instance resolves non-2xx responses (`validateStatus: null`) instead of
throwing, so a missing resource or 5xx is checked on the resolved `status` and returned as an
explanatory `text` block; only network-level failures (and the `maxContentLength` abort) reach the
`catch`.

Discovery is the server-instructions prose, not a fixed list: `resources/templates/list` returns
nothing and `resources/list` serves only widgets + the usage guide. The read path is a generic
proxy, so any Apify API GET URL works whether or not it was ever listed.

## Gotcha

`widgets.ts` is **metadata only** — it registers and locates widgets. The actual
React widget code and design rules live in [`../web/AGENTS.md`](../web/AGENTS.md);
keep the two in sync (a widget registered here must exist there, and vice versa).

After any change here run the root [Verification](../../AGENTS.md) steps.
