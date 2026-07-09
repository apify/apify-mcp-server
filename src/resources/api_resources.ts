import type {
    BlobResourceContents,
    ReadResourceResult,
    TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';
import { isAxiosError } from 'axios';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl } from '../apify_client.js';
import { MAX_DOWNLOAD_BYTES, MAX_INLINE_BYTES } from '../const.js';
import { classifyBinaryRecordSize } from '../tools/storage/storage_helpers.js';
import { getHttpStatusCode, logHttpError } from '../utils/logging.js';

const JSON_MIME_TYPE = 'application/json';
const TEXT_MIME_TYPE = 'text/plain';

/** True when the declared Content-Type is JSON, so the body must be re-serialized to round-trip primitives. */
function isJsonContentType(contentType: string | undefined): boolean {
    return contentType?.split(';')[0].trim().toLowerCase() === JSON_MIME_TYPE;
}

/**
 * True when the URI is an Apify API URL (same origin as the configured API base).
 *
 * This is the security gate for the generic read proxy: the apify-client attaches the
 * session token as an `Authorization` header to every outbound request, so we must only
 * hand it Apify API URLs — never an arbitrary host.
 */
export function isApifyApiUri(uri: string): boolean {
    try {
        return new URL(uri).origin === new URL(getApifyAPIBaseUrl()).origin;
    } catch {
        return false;
    }
}

/**
 * Matches an Apify key-value-store record path, capturing the store id and the record key.
 * Both groups exclude `/?#` so a trailing query or fragment can't leak into the captured key.
 */
const KV_RECORD_PATH_RE = /^\/v2\/key-value-stores\/([^/?#]+)\/records\/([^/?#]+)$/;

/** `decodeURIComponent` that returns the input unchanged on malformed percent-encoding instead of throwing. */
function safeDecodeURIComponent(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Download URL for a binary too large to inline. For a key-value-store record URI, returns the
 * store's signed `recordPublicUrl` — fetchable without an API token when the client can read the
 * store's URL signing key. Falls back to the original API URL for any other endpoint, or if minting
 * the signed URL fails (fetching that link then needs a token).
 */
async function fetchRecordDownloadUrl(uri: string, apifyClient: ApifyClient): Promise<string> {
    let pathname: string;
    try {
        pathname = new URL(uri).pathname;
    } catch {
        return uri;
    }
    const match = KV_RECORD_PATH_RE.exec(pathname);
    if (!match) return uri;
    try {
        const store = apifyClient.keyValueStore(safeDecodeURIComponent(match[1]));
        return await store.getRecordPublicUrl(safeDecodeURIComponent(match[2]));
    } catch (err) {
        logHttpError(err, `Failed to mint signed download URL for ${uri}; falling back to API URL`);
        return uri;
    }
}

/**
 * Single text-contents result. Defaults to text/plain (errors, refusals, link-outs); pass
 * `mimeType` to preserve a body's declared Content-Type (e.g. an empty record).
 */
function buildTextResult(uri: string, text: string, mimeType: string = TEXT_MIME_TYPE): ReadResourceResult {
    return { contents: [{ uri, mimeType, text } satisfies TextResourceContents] };
}

/**
 * Read any Apify API GET endpoint as an MCP resource.
 *
 * A thin proxy: the apify-client injects the session token (and the MCP-origin header),
 * performs the GET, and parses the body by Content-Type — JSON to an object, text/xml to a
 * string, anything else to a Buffer, an empty body to `undefined`. We branch on that resulting
 * JS type, not the MIME type. Errors (a missing resource, a bad token, a 5xx) never throw; they
 * return an explanatory text block, matching the resources/read soft-fail contract.
 *
 * The download itself goes straight through `apifyClient.httpClient.axios` (the same axios
 * instance apify-client builds internally, so token/origin headers and Content-Type parsing
 * still apply) instead of `httpClient.call()`. This is one attempt, no retries: `call()` would
 * retry the size-cap abort below as if it were a flaky network error, adding 8 retries and
 * ~127s of backoff for what is a deliberate, permanent rejection. The download is capped at
 * `MAX_DOWNLOAD_BYTES` (5 MB) via axios's `maxContentLength`, checked incrementally as bytes
 * arrive — so an oversized dataset/log is aborted mid-flight instead of being buffered whole
 * before the (separate, smaller) `MAX_INLINE_BYTES` inline check ever runs.
 */
export async function readApiResource(uri: string, apifyClient?: ApifyClient): Promise<ReadResourceResult> {
    if (!apifyClient) {
        return buildTextResult(uri, `Cannot read ${uri}: no Apify token in this session.`);
    }
    if (!isApifyApiUri(uri)) {
        return buildTextResult(
            uri,
            `Cannot read ${uri}: only Apify API URLs (${getApifyAPIBaseUrl()}) are readable as resources.`,
        );
    }

    let response: { data: unknown; headers: Record<string, unknown>; status: number; statusText: string };
    try {
        // Default responseType is `arraybuffer`, which lets the client's parse interceptor decode
        // the body by Content-Type. Do NOT set `forceBuffer` — that would keep everything as raw bytes.
        response = await apifyClient.httpClient.axios.request<unknown>({
            url: uri,
            method: 'GET',
            responseType: 'arraybuffer',
            maxContentLength: MAX_DOWNLOAD_BYTES,
        });
    } catch (err) {
        if (isAxiosError(err) && err.code === 'ERR_BAD_RESPONSE' && err.message.includes('maxContentLength')) {
            const downloadUrl = await fetchRecordDownloadUrl(uri, apifyClient);
            return buildTextResult(
                uri,
                `Response body exceeds the ${MAX_DOWNLOAD_BYTES}-byte download limit. Download it from ${downloadUrl} ` +
                    `(may require your Apify API token), or for a dataset/list re-read the URL with a smaller limit/offset range.`,
            );
        }
        const status = getHttpStatusCode(err);
        const message = err instanceof Error ? err.message : String(err);
        return buildTextResult(uri, `Failed to read ${uri}: ${status ? `HTTP ${status}: ` : ''}${message}`);
    }

    // `validateStatus: null` on this axios instance resolves non-2xx responses instead of throwing,
    // so a failed request must be checked here rather than in the catch block above.
    if (response.status >= 300) {
        const body = response.data as { error?: { message?: unknown } } | undefined;
        const message = typeof body?.error?.message === 'string' ? body.error.message : response.statusText;
        return buildTextResult(uri, `Failed to read ${uri}: HTTP ${response.status}: ${message}`);
    }

    const contentTypeHeader = response.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined;
    const { data } = response;

    // An empty response body (e.g. an Actor that wrote an empty OUTPUT) maps to `undefined`; emit empty
    // text, preserving the record's declared Content-Type. JSON `null` maps to JS `null` — a distinct,
    // meaningful value — so it is NOT treated as empty here and round-trips through the JSON branch below.
    if (data === undefined) {
        return buildTextResult(uri, '', contentType);
    }

    if (Buffer.isBuffer(data)) {
        const disposition = classifyBinaryRecordSize(contentType, data);
        // Above the inline limit, link out with an explanatory text block (resources/read has no
        // resource_link content type), matching the soft-fail contract. The link is only auth-free for a
        // key-value-store record whose store has a URL-signing key; an unsigned record URL and every other
        // (token-gated) API URL still need the Apify token — so the message says it may require it.
        if (disposition.kind === 'linkOut') {
            const downloadUrl = await fetchRecordDownloadUrl(uri, apifyClient);
            return buildTextResult(
                uri,
                `Content (${disposition.mimeType ?? 'binary'}, ${disposition.bytes} bytes) is too large to inline. ` +
                    `Download it from ${downloadUrl} (may require your Apify API token).`,
            );
        }
        return {
            contents: [
                {
                    uri,
                    ...(disposition.mimeType && { mimeType: disposition.mimeType }),
                    blob: disposition.base64,
                } satisfies BlobResourceContents,
            ],
        };
    }

    // Serialize the body to the exact text we would inline, then size-guard it below.
    let text: string;
    let mimeType: string;
    if (isJsonContentType(contentType)) {
        // A JSON body must be re-serialized so primitives round-trip as valid JSON: a bare JSON string
        // `"hi"` parses to the JS string `hi`, and emitting it verbatim would drop the quotes; JSON `null`
        // must stay `null`, not collapse to empty text. Branch on the declared Content-Type, not the parsed
        // JS type, so the type alone can't misclassify a string body.
        text = JSON.stringify(data);
        mimeType = contentType ?? JSON_MIME_TYPE;
    } else {
        // text/xml bodies are JS strings, emitted verbatim with their FULL declared Content-Type — charset
        // included, since a client needs it to decode the text. This is deliberately unlike the binary path,
        // where `classifyBinaryRecordSize` strips the Content-Type to its base MIME type (only the base type is
        // meaningful for a blob, and the image/audio routing keys off it). Any other parsed object (no/unknown
        // Content-Type) is lossless-serialized as JSON.
        text = typeof data === 'string' ? data : JSON.stringify(data);
        mimeType = contentType ?? (typeof data === 'string' ? TEXT_MIME_TYPE : JSON_MIME_TYPE);
    }

    // Symmetric with the binary link-out above: a body over the inline limit would blow up the caller's
    // context, so link out instead of inlining. We measure the serialized bytes we would actually emit —
    // not a Content-Length header, which reports the original wire body (a different size after
    // re-serialization) and is often absent on chunked/gzip list responses. The link is the store's signed
    // `recordPublicUrl` for a KVS record (fetchable without a token) and the token-gated API URL otherwise;
    // limit/offset paging only works for a dataset/list, so it's offered as a secondary hint, not the sole
    // remedy — a single record or log cannot be paged and would otherwise dead-end.
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_INLINE_BYTES) {
        const downloadUrl = await fetchRecordDownloadUrl(uri, apifyClient);
        return buildTextResult(
            uri,
            `Response body (~${bytes} bytes) is too large to inline. Download it from ${downloadUrl} ` +
                `(may require your Apify API token), or for a dataset/list re-read the URL with a smaller limit/offset range.`,
        );
    }
    return buildTextResult(uri, text, mimeType);
}
