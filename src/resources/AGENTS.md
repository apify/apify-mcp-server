<!-- agents-scope: src/resources -->
# src/resources — MCP resources + widget registry

↑ [src/](../AGENTS.md) · sideways: [`../web/AGENTS.md`](../web/AGENTS.md)

Three files serving the MCP `resources/*` surface:

- `resource_service.ts` — handles `ListResources` / `ListResourceTemplates` / read-resource
  requests. Takes an optional `apifyClient` on read, built by the server from the per-request
  token (`_meta.apifyToken || options.token`). Token-only by design — no payment headers, so a
  payment-only session (x402/Skyfire) gets no client and every read fails with `InvalidParams`.
  Routes every http(s) URI to `readApiResource()`, which owns the single origin gate; non-http
  schemes fall through to widgets/usage-guide/fallback.
- `api_resources.ts` — a thin streaming MCP-resource proxy: any Apify API GET endpoint is
  readable as a resource, identified by its real API URL.
- `widgets.ts` — the registry of UI widgets; the widgets themselves are built in
  [`../web`](../web/AGENTS.md).

## API resources (`api_resources.ts`)

Resource URIs are real Apify API GET URLs (`https://api.apify.com/v2/...`), built from the storage
IDs that Actors and tools return. This is a deliberate deviation from the MCP spec's `https://`
scheme guidance (SHOULD only be used for client-fetchable URLs — ours are token-gated): the
identity with the platform's own URLs is the feature. Revisit when tools start emitting
`resource_link`s, where clients may fetch `https://` URIs directly. `isApifyApiUri()` gates reads
to the configured API origin and rejects userinfo-bearing URLs (axios drops the `Authorization`
header for those, silently degrading to unauthenticated).

`readApiResource()` streams the body verbatim —
`httpClient.axios.request({ method: 'GET', responseType: 'stream', maxContentLength: MAX_INLINE_BYTES })`
— and branches on the declared Content-Type: textual base types (text/*, JSON, XML) as `text` with
the full header, decoded with the declared charset (default utf-8; a charset Node cannot decode
falls through to blob — lossless beats mangled text, same rule as apify-client's body_parser);
everything else (including no Content-Type) as a base64 `blob` with the base MIME type; empty body
as empty text preserving the Content-Type. The body is never parsed, so bytes round-trip exactly. axios enforces `MAX_INLINE_BYTES` (256 KB) mid-consumption on streamed
responses (axios ≥1.16: byte-counting wrapper throws `ERR_BAD_RESPONSE`, counting decoded bytes) —
after the request resolves, outside any retry wrapper. On trip, the proxy links out: a `text/plain`
block carrying the store's signed `recordPublicUrl` for a KVS record, else the token-gated API URL,
plus a `limit`/`offset` paging hint. It calls the client's axios instance directly, not
`httpClient.call()`: with a stream body, `call()` hands non-2xx responses to `ApifyApiError`
unconsumed (junk message, stranded socket per retry) — one attempt, no retries; the error body is
read here to surface the API's message.

Genuine failures **throw** an `McpError` carrying `data: { uri }` (SEP-2164 / draft spec: a
JSON-RPC error, never success-shaped content): 3xx/4xx except 429 → `InvalidParams`; 429, 5xx, no
status (network, mid-stream drop) → `InternalError`. 401/403 append a hint via `getHttpErrorHint()`
(shared with `tools/call`); failures are logged via `logHttpError` (5xx → exception). Size
link-outs are **successful** reads returning a download pointer, not failures. Discovery is the
server-instructions prose plus `resources/templates/list`, which advertises the common URL shapes
(dataset items, KVS record/keys, run, log) as RFC 6570 templates with paging params — advertisement
only, not a route table: the read path stays generic and accepts any Apify API GET URL.

## Gotcha

`widgets.ts` is **metadata only** — it registers and locates widgets. The actual React widget code
and design rules live in [`../web/AGENTS.md`](../web/AGENTS.md); keep the two in sync.

After any change here run the root [Verification](../../AGENTS.md) steps.
