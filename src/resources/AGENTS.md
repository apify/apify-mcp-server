<!-- agents-scope: src/resources -->
# src/resources — MCP resources + widget registry

↑ [src/](../AGENTS.md) · sideways: [`../web/AGENTS.md`](../web/AGENTS.md)

Three files serving the MCP `resources/*` surface:

- `resource_service.ts` — handles `ListResources` / `ListResourceTemplates` /
  read-resource requests. Takes an optional `apifyClient` on list/read; the server
  builds it from the per-request token (`_meta.apifyToken || options.token`). This is
  token-only by design — it does not forward payment headers like the CallTool path, so a
  payment-only session (x402/Skyfire, no token) gets no client and every read fails with an
  `InvalidParams` JSON-RPC error. It routes every http(s) URI to `readApiResource()`, which
  owns the single origin gate; only non-http schemes fall through to widgets/usage-guide/fallback.
- `api_resources.ts` — a thin MCP-resource proxy over the Apify API: any Apify API GET
  endpoint is readable as a resource, identified by its real API URL.
- `widgets.ts` — the registry of UI widgets (the metadata that maps a widget name to
  its resource); the widgets themselves are built in [`../web`](../web/AGENTS.md).

## API resources (`api_resources.ts`)

Resource URIs are real Apify API GET URLs (`https://api.apify.com/v2/...`), built from the storage
IDs that Actors and tools return (e.g. a `datasetId` → `.../datasets/{id}/items`) — no custom scheme.
`isApifyApiUri()` gates reads to the configured API origin (`getApifyAPIBaseUrl()`): the apify-client
attaches the session token as an `Authorization` header to **every** outbound request, so we must
never hand it a non-Apify host.

`readApiResource()` streams the body verbatim —
`apifyClient.httpClient.axios.request({ method: 'GET', responseType: 'stream', maxContentLength: MAX_INLINE_BYTES })`
— and branches on the declared Content-Type: textual base types (text/*, JSON, XML) return as `text`
with the full header (charset included), everything else (including no Content-Type) as a base64
`blob` with the base MIME type, an empty body as empty text preserving the Content-Type. The body is
never parsed, so JSON primitives and bytes round-trip exactly. axios enforces `MAX_INLINE_BYTES`
(256 KB) mid-consumption on streamed responses (axios ≥1.16: byte-counting wrapper throws
`ERR_BAD_RESPONSE`, counting decoded bytes), so an oversized body aborts at the limit instead of
buffering — the abort happens after the request resolves, outside any retry wrapper. On trip, the
proxy links out: an explanatory `text/plain` block (`resources/read` has no `resource_link` type)
carrying the store's `recordPublicUrl` for a KVS record (auth-free only with a URL-signing key) or
the token-gated API URL otherwise, plus a `limit`/`offset` paging hint for datasets/lists. It calls
the client's axios instance directly instead of `httpClient.call()`: with a stream body, `call()`
would hand non-2xx responses to `ApifyApiError` unconsumed (junk message, stranded socket per retry)
— so this is one attempt, no retries, and the error body is read here to surface the API's message.

Genuine failures **throw** an `McpError` so the SDK returns a JSON-RPC error, not success-shaped
content for an unreadable resource (the direction SEP-2164 makes a MUST). `statusToErrorCode()`:
3xx/4xx except 429 → `InvalidParams` (bad URI, missing/invalid token, private or nonexistent
resource); 429, 5xx, or no status (network, mid-stream drop) → `InternalError`. The no-token and
bad-origin guards throw `InvalidParams` directly; 401/403 append a hint via `getHttpErrorHint()`
(shared with `tools/call` in `utils/mcp.ts`); non-2xx and network failures are logged via
`logHttpError` (5xx → exception). Size link-outs are the exception — **successful** reads returning
a download pointer. The sibling `resource_service.ts` throws the same `InvalidParams` from its
generic non-http fallback; widget-not-found branches stay as content.

Discovery is the server-instructions prose, not a fixed list: `resources/templates/list` returns
nothing and `resources/list` serves only widgets + the usage guide.

## Gotcha

`widgets.ts` is **metadata only** — it registers and locates widgets. The actual
React widget code and design rules live in [`../web/AGENTS.md`](../web/AGENTS.md);
keep the two in sync (a widget registered here must exist there, and vice versa).

After any change here run the root [Verification](../../AGENTS.md) steps.
