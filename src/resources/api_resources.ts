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

/**
 * Base MIME types emitted as `text` contents; everything else (including a missing
 * Content-Type) is emitted as a base64 `blob`. JSON and XML are text so the raw body
 * stays readable and byte-exact — the proxy never parses or re-serializes it.
 */
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
function statusToErrorCode(status: number | undefined): ErrorCode {
    if (status !== undefined && status < 500 && status !== 429) return ErrorCode.InvalidParams;
    return ErrorCode.InternalError;
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

/**
 * Single text-contents result. Defaults to text/plain (link-outs); pass `mimeType`
 * to preserve a body's declared Content-Type (e.g. an empty record).
 */
function buildTextResult(uri: string, text: string, mimeType: string = TEXT_MIME_TYPE): ReadResourceResult {
    return { contents: [{ uri, mimeType, text } satisfies TextResourceContents] };
}

/**
 * Successful read of a body too large to inline: a download pointer instead of the content.
 * NOT a failure (no McpError) — the resource is readable, just not inline. The link is only
 * auth-free for a key-value-store record whose store has a URL-signing key; an unsigned record
 * URL and every other (token-gated) API URL still need the Apify token.
 */
async function buildLinkOutResult(uri: string, apifyClient: ApifyClient): Promise<ReadResourceResult> {
    const downloadUrl = await fetchRecordDownloadUrl(uri, apifyClient);
    return buildTextResult(
        uri,
        `Response body exceeds the ${MAX_INLINE_BYTES}-byte inline limit. Download it from ${downloadUrl} ` +
            `(may require your Apify API token). For a dataset/list, re-read with a smaller limit/offset range.`,
    );
}

/** The mid-consumption abort axios raises when a streamed body crosses `maxContentLength`. */
function isMaxContentLengthAbort(err: unknown): boolean {
    return isAxiosError(err) && err.code === 'ERR_BAD_RESPONSE' && err.message.includes('maxContentLength');
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
    // Origin first: a non-Apify URL is never readable, with or without a token.
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
        response = await apifyClient.httpClient.axios.request<unknown>({
            url: uri,
            method: 'GET',
            responseType: 'stream',
            maxContentLength: MAX_INLINE_BYTES,
        });
    } catch (err) {
        logHttpError(err, `resources/read request failed`, { uri });
        const status = getHttpStatusCode(err);
        const message = err instanceof Error ? err.message : String(err);
        const hint = getHttpErrorHint(status);
        throw new McpError(
            statusToErrorCode(status),
            `Failed to read ${uri}: ${status ? `HTTP ${status}: ` : ''}${message}${hint ? `. ${hint}` : ''}`,
            { uri },
        );
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
        const hint = getHttpErrorHint(response.status);
        logHttpError(Object.assign(new Error(message), { statusCode: response.status }), `resources/read failed`, {
            uri,
        });
        throw new McpError(
            statusToErrorCode(response.status),
            `Failed to read ${uri}: HTTP ${response.status}: ${message}${hint ? `. ${hint}` : ''}`,
            { uri },
        );
    }

    if (overLimit || body === undefined) {
        return buildLinkOutResult(uri, apifyClient);
    }

    const contentTypeHeader = response.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined;

    // An empty body (e.g. an Actor that wrote an empty OUTPUT) is empty text preserving the
    // declared Content-Type, matching the empty-record behavior of get-key-value-store-record.
    if (body.length === 0) {
        return buildTextResult(uri, '', contentType);
    }

    const baseMimeType = parseBaseMimeType(contentType);
    if (isTextualMimeType(baseMimeType)) {
        // Verbatim, with the FULL declared Content-Type — charset included, a client needs it to decode.
        return buildTextResult(uri, body.toString('utf-8'), contentType);
    }
    // Binary: base MIME type only (parameters are meaningless for a blob).
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
