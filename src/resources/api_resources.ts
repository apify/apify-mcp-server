import type {
    BlobResourceContents,
    ReadResourceResult,
    TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl } from '../apify_client.js';
import { classifyBinaryRecord } from '../tools/common/storage_helpers.js';
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

    // An empty response body (e.g. an Actor that wrote an empty OUTPUT) maps to `undefined`; emit empty
    // text, preserving the record's declared Content-Type. JSON `null` maps to JS `null` — a distinct,
    // meaningful value — so it is NOT treated as empty here and round-trips through the JSON branch below.
    if (data === undefined) {
        return buildTextResult(uri, '', contentType);
    }

    if (Buffer.isBuffer(data)) {
        const disposition = classifyBinaryRecord(contentType, data);
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

    // A JSON body must be re-serialized so primitives round-trip as valid JSON: a bare JSON string
    // `"hi"` parses to the JS string `hi`, and emitting it verbatim would drop the quotes; JSON `null`
    // must stay `null`, not collapse to empty text. Branch on the declared Content-Type, not the parsed
    // JS type, so the type alone can't misclassify a string body.
    if (isJsonContentType(contentType)) {
        return buildTextResult(uri, JSON.stringify(data), contentType ?? JSON_MIME_TYPE);
    }
    // text/xml bodies are JS strings, emitted verbatim with their declared Content-Type; any other
    // parsed object (no/unknown Content-Type) is lossless-serialized as JSON.
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return buildTextResult(uri, text, contentType ?? (typeof data === 'string' ? TEXT_MIME_TYPE : JSON_MIME_TYPE));
}
