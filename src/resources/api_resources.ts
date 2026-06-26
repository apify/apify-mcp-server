import type {
    BlobResourceContents,
    ReadResourceResult,
    TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl } from '../apify_client.js';
import { KV_RECORD_MAX_INLINE_BYTES } from '../const.js';
import { getHttpStatusCode, logHttpError } from '../utils/logging.js';

const JSON_MIME_TYPE = 'application/json';
const TEXT_MIME_TYPE = 'text/plain';

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

/** Matches an Apify key-value-store record path, capturing the store id and the record key. */
const KV_RECORD_PATH_RE = /^\/v2\/key-value-stores\/([^/]+)\/records\/(.+)$/;

/**
 * Download URL for a binary too large to inline. For a key-value-store record URI, returns the
 * store's signed `recordPublicUrl` — fetchable without an API token when the client can read the
 * store's URL signing key. Falls back to the original API URL for any other endpoint, or if minting
 * the signed URL fails (fetching that link then needs a token).
 */
async function getRecordDownloadUrl(uri: string, apifyClient: ApifyClient): Promise<string> {
    let pathname: string;
    try {
        pathname = new URL(uri).pathname;
    } catch {
        return uri;
    }
    const match = KV_RECORD_PATH_RE.exec(pathname);
    if (!match) return uri;
    try {
        const store = apifyClient.keyValueStore(decodeURIComponent(match[1]));
        return await store.getRecordPublicUrl(decodeURIComponent(match[2]));
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
 * A thin proxy: the apify-client injects the session token (and MCP-origin / payment headers),
 * performs the GET, and parses the body by Content-Type — JSON to an object, text/xml to a
 * string, anything else to a Buffer, an empty body to `undefined`. We branch on that resulting
 * JS type, not the MIME type. Errors (a missing resource, a bad token, a 5xx) never throw; they
 * return an explanatory text block, matching the resources/read soft-fail contract.
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

    let response: { data: unknown; headers: Record<string, unknown> };
    try {
        // Default responseType is `arraybuffer`, which lets the client's parse interceptor decode
        // the body by Content-Type. Do NOT set `forceBuffer` — that would keep everything as raw bytes.
        response = await apifyClient.httpClient.call({ url: uri, method: 'GET', responseType: 'arraybuffer' });
    } catch (err) {
        const status = getHttpStatusCode(err);
        const message = err instanceof Error ? err.message : String(err);
        return buildTextResult(uri, `Failed to read ${uri}: ${status ? `HTTP ${status}: ` : ''}${message}`);
    }

    const contentTypeHeader = response.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined;
    const { data } = response;

    // An empty body (e.g. an Actor that wrote an empty OUTPUT) is legitimate; emit empty text,
    // preserving the record's declared Content-Type when present.
    if (data === undefined || data === null) {
        return buildTextResult(uri, '', contentType);
    }

    if (Buffer.isBuffer(data)) {
        const mimeType = contentType?.split(';')[0].trim().toLowerCase();
        // Inlining a large binary as base64 would blow up the client's context, so above the inline
        // limit link out instead: an explanatory text block with the URL, size, and type (resources/read
        // has no resource_link content type), matching the soft-fail contract. For a key-value-store record
        // the link is the signed public URL, fetchable without a token; other endpoints fall back to the
        // (token-gated) API URL.
        if (data.length > KV_RECORD_MAX_INLINE_BYTES) {
            const downloadUrl = await getRecordDownloadUrl(uri, apifyClient);
            return buildTextResult(
                uri,
                `Content (${mimeType ?? 'binary'}, ${data.length} bytes) is too large to inline. ` +
                    `Fetch it directly from: ${downloadUrl}`,
            );
        }
        return {
            contents: [
                { uri, ...(mimeType && { mimeType }), blob: data.toString('base64') } satisfies BlobResourceContents,
            ],
        };
    }

    // JSON (already parsed to an object/array) or text/xml (a string). A string is emitted verbatim
    // with its declared Content-Type; anything else is lossless-serialized as JSON.
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return {
        contents: [
            {
                uri,
                mimeType: contentType ?? (typeof data === 'string' ? TEXT_MIME_TYPE : JSON_MIME_TYPE),
                text,
            } satisfies TextResourceContents,
        ],
    };
}
