import type {
    BlobResourceContents,
    ReadResourceResult,
    TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isAxiosError } from 'axios';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl } from '../apify_client.js';
import { MAX_INLINE_BYTES } from '../const.js';
import { parseBaseMimeType } from '../tools/storage/storage_helpers.js';
import { getHttpStatusCode, logHttpError } from '../utils/logging.js';
import { getHttpErrorHint } from '../utils/mcp.js';

const TEXT_MIME_TYPE = 'text/plain';

/** Textual base MIME types (returned as `text`); everything else becomes a base64 `blob`. */
function isTextualMimeType(baseMimeType: string | undefined): boolean {
    if (!baseMimeType) return false;
    return (
        baseMimeType.startsWith('text/') ||
        baseMimeType === 'application/json' ||
        baseMimeType.endsWith('+json') ||
        baseMimeType === 'application/xml' ||
        baseMimeType.endsWith('+xml') ||
        baseMimeType === 'application/javascript'
    );
}

/**
 * Maps a failed read's HTTP status to a JSON-RPC error code:
 * - 3xx/4xx except 429 → `InvalidParams` (the request/resource is the problem — bad URI, missing/invalid
 *   token, private resource, or a resource that does not exist; SEP-2164 remaps "nonexistent" here too).
 * - 429, 5xx, or no status (network failure) → `InternalError` (transient or upstream).
 */
function getErrorCodeForStatus(status: number | undefined): ErrorCode {
    if (status !== undefined && status < 500 && status !== 429) return ErrorCode.InvalidParams;
    return ErrorCode.InternalError;
}

/** Throw the standard resources/read failure McpError. Callers log the error first — the log source differs by site. */
function throwReadFailure(uri: string, status: number | undefined, message: string): never {
    const hint = getHttpErrorHint(status);
    throw new McpError(
        getErrorCodeForStatus(status),
        `Failed to read ${uri}: ${status ? `HTTP ${status}: ` : ''}${message}${hint ? `. ${hint}` : ''}`,
        { uri },
    );
}

/**
 * True when the URI is an Apify API URL (same origin as the configured API base).
 *
 * This is the security gate for the generic read proxy: the apify-client attaches the
 * session token as an `Authorization` header to every outbound request, so we must only
 * hand it Apify API URLs — never an arbitrary host. Userinfo-bearing URLs
 * (`user@api.apify.com`) are rejected even when the host is genuinely ours: axios drops
 * the default `Authorization` header for credentials-bearing URLs, so the read would
 * silently run unauthenticated.
 */
export function isApifyApiUri(uri: string): boolean {
    try {
        const url = new URL(uri);
        if (url.username || url.password) return false;
        return url.origin === new URL(getApifyAPIBaseUrl()).origin;
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
 * Download URL for a body too large to inline. For a key-value-store record URI, returns the
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

/** Single text-contents result; pass `mimeType` to preserve a body's declared Content-Type. */
function buildTextResult(uri: string, text: string, mimeType: string = TEXT_MIME_TYPE): ReadResourceResult {
    return { contents: [{ uri, mimeType, text } satisfies TextResourceContents] };
}

/** True when the URI is a key-value-store record path (a single record, not a pageable list). */
function isKvRecordUri(uri: string): boolean {
    try {
        return KV_RECORD_PATH_RE.test(new URL(uri).pathname);
    } catch {
        return false;
    }
}

/** Body too large to inline: a download-pointer text result. NOT a failure — the resource is readable, just not inline. */
async function buildLinkOutResult(uri: string, apifyClient: ApifyClient): Promise<ReadResourceResult> {
    const downloadUrl = await fetchRecordDownloadUrl(uri, apifyClient);
    // A KVS record is a single object with no paging; only a dataset/list can shrink via limit/offset.
    const pagingHint = isKvRecordUri(uri) ? '' : ' For a dataset/list, re-read with a smaller limit/offset range.';
    return buildTextResult(
        uri,
        `Response body exceeds the ${MAX_INLINE_BYTES}-byte inline limit. Download it from ${downloadUrl} ` +
            `(may require your Apify API token).${pagingHint}`,
    );
}

/** The mid-consumption abort axios raises when a streamed body crosses `maxContentLength`. */
function isMaxContentLengthAbort(err: unknown): boolean {
    return isAxiosError(err) && err.code === 'ERR_BAD_RESPONSE' && err.message.includes('maxContentLength');
}

/** `charset` parameter of a Content-Type header, lowercased; `undefined` when absent. */
function parseCharset(contentType: string | undefined): string | undefined {
    const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '');
    return match?.[1].trim().toLowerCase();
}

/** Drain a response stream into one Buffer. Chunks are Buffers (`objectMode: false`). */
async function collectStream(data: unknown): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of data as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

/** `error.message` from an Apify API error body, or `undefined` when the body isn't that shape. */
function parseApiErrorMessage(body: Buffer | undefined): string | undefined {
    if (!body || body.length === 0) return undefined;
    try {
        const parsed = JSON.parse(body.toString('utf-8')) as { error?: { message?: unknown } };
        return typeof parsed?.error?.message === 'string' ? parsed.error.message : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Read any Apify API GET endpoint as an MCP resource.
 *
 * A thin streaming proxy: the apify-client injects the session token (and the MCP-origin header),
 * the body streams in verbatim and is returned by its declared Content-Type — textual types
 * (text/*, JSON, XML) as `text`, anything else as a base64 `blob`. The body is never parsed, so
 * JSON primitives, formatting, and bytes round-trip exactly.
 *
 * Genuine failures (no token, bad origin, a missing resource, a bad token, a 5xx, a network error)
 * throw an `McpError` so the SDK returns a JSON-RPC error rather than success-shaped content for an
 * unreadable resource (see SEP-2164). A body over `MAX_INLINE_BYTES` is NOT a failure — it is a
 * successful read returning a download pointer.
 *
 * The request goes straight through `apifyClient.httpClient.axios` (the same axios instance
 * apify-client builds internally, so token/origin headers still apply) instead of
 * `httpClient.call()`: with `responseType: 'stream'`, a non-2xx reaches `call()` as an unconsumed
 * stream — its `ApifyApiError` message degrades to junk and each retry attempt strands an unread
 * socket. One attempt, no retries. `maxContentLength` is enforced by axios itself mid-consumption
 * (verified in axios@1.16.1: the adapter wraps streamed responses in a byte-counting generator
 * that throws `ERR_BAD_RESPONSE` when the decoded size crosses the limit), so an oversized body
 * is aborted at ~`MAX_INLINE_BYTES`, never buffered whole.
 */
export async function readApiResource(uri: string, apifyClient?: ApifyClient): Promise<ReadResourceResult> {
    if (!isApifyApiUri(uri)) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Failed to read ${uri}: only Apify API URLs (${getApifyAPIBaseUrl()}) are readable as resources.`,
            { uri },
        );
    }
    if (!apifyClient) {
        throw new McpError(ErrorCode.InvalidParams, `Failed to read ${uri}: no Apify token in this session.`, {
            uri,
        });
    }

    let response: { data: unknown; headers: Record<string, unknown>; status: number; statusText: string };
    try {
        // The raw axios instance skips `httpClient.call()` → `ensureNodeInit()`, so reads do NOT honor
        // `HTTPS_PROXY` (auth + MCP-origin headers are instance defaults and still apply — not a leak).
        // Fine for direct egress; a proxy-mandatory deployment needs an apify-client init hook.
        response = await apifyClient.httpClient.axios.request<unknown>({
            url: uri,
            method: 'GET',
            responseType: 'stream',
            maxContentLength: MAX_INLINE_BYTES,
        });
    } catch (err) {
        logHttpError(err, `resources/read request failed`, { uri });
        throwReadFailure(uri, getHttpStatusCode(err), err instanceof Error ? err.message : String(err));
    }

    let body: Buffer | undefined;
    let overLimit = false;
    try {
        body = await collectStream(response.data);
    } catch (err) {
        if (isMaxContentLengthAbort(err)) {
            overLimit = true;
        } else {
            // A drop mid-body (reset, truncation, bad gzip). Never return partial content.
            logHttpError(err, `resources/read response interrupted`, { uri });
            const message = err instanceof Error ? err.message : String(err);
            throw new McpError(ErrorCode.InternalError, `Failed to read ${uri}: response interrupted: ${message}`, {
                uri,
            });
        }
    }

    // `validateStatus: null` on this axios instance resolves non-2xx responses instead of throwing,
    // so a failed request is checked here. The error body was just collected above (Apify API error
    // bodies are small JSON; if one somehow crossed the limit, fall back to the status text).
    if (response.status >= 300) {
        const message = parseApiErrorMessage(body) ?? response.statusText;
        logHttpError(Object.assign(new Error(message), { statusCode: response.status }), `resources/read failed`, {
            uri,
        });
        throwReadFailure(uri, response.status, message);
    }

    // Second clause is runtime-redundant (undefined ⟺ overLimit) but narrows `body` to Buffer below.
    if (overLimit || body === undefined) {
        return buildLinkOutResult(uri, apifyClient);
    }

    const contentTypeHeader = response.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined;

    // Empty body → empty text preserving the declared Content-Type, matching get-key-value-store-record
    // (even for a binary type: an empty blob carries no bytes).
    if (body.length === 0) {
        return buildTextResult(uri, '', contentType);
    }

    const baseMimeType = parseBaseMimeType(contentType);
    const charset = parseCharset(contentType) ?? 'utf-8';
    // Decode with the DECLARED charset, not hardcoded UTF-8 — latin1 bytes decoded as UTF-8 mangle
    // irreversibly to U+FFFD. A charset Node cannot decode falls through to the blob branch (lossless
    // base64 beats text in a wrong encoding), the same rule as apify-client's body_parser. The full
    // Content-Type — charset included — rides along on the text result.
    if (isTextualMimeType(baseMimeType) && Buffer.isEncoding(charset)) {
        return buildTextResult(uri, body.toString(charset), contentType);
    }
    // Binary or undecodable text: base MIME type only (parameters are meaningless for a blob).
    return {
        contents: [
            {
                uri,
                ...(baseMimeType && { mimeType: baseMimeType }),
                blob: body.toString('base64'),
            } satisfies BlobResourceContents,
        ],
    };
}
