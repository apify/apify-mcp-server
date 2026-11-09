import { HELPER_TOOLS, HTTP_NOT_FOUND, MAX_INLINE_BYTES } from '../../const.js';
import { getResourceByIdOrName, isAmbiguousResourceId } from '../../utils/apify_resource_id.js';
import { VERBATIM_LINKS_NUDGE } from '../../utils/console_link.js';
import { QUOTE_WRAPPER_CHARS } from '../../utils/generic.js';
import { getHttpStatusCode } from '../../utils/logging.js';
import { respondOk } from '../../utils/mcp.js';

/**
 * Wrap a storage SDK promise to convert a 404 rejection into null.
 *
 * The Apify SDK soft-catches 404 on `.get()`, `.getStatistics()`, and `.getRecord()` (returning
 * falsy instead of throwing), but list methods like `.listItems()` and `.listKeys()` throw
 * ApifyApiError on a missing storage. This helper wraps those list calls to provide consistent
 * 404 handling: resolves with the promise's value, returns null if it rejects with a 404, or
 * rethrows any other error. Call sites check `if (!result) return respondUserError(...)` as usual.
 */
export async function catchNotFound<T>(promise: Promise<T>): Promise<T | null> {
    try {
        return await promise;
    } catch (err: unknown) {
        if (getHttpStatusCode(err) === HTTP_NOT_FOUND) {
            return null;
        }
        throw err;
    }
}

/**
 * Runs `fetch` against a storage given by ID, name, or `username~name`, where a name alone means one of
 * the caller's own (see `getResourceByIdOrName`), and reads a 404 as a miss. Returns the result with the
 * API-safe id it was found under, or `undefined` when there is no such storage.
 */
export async function fetchStorageByIdOrName<T>(
    idOrName: string,
    fetch: (safeId: string) => Promise<T | undefined>,
): Promise<{ result: T; safeId: string } | undefined> {
    return getResourceByIdOrName(idOrName, async (safeId) => {
        const result = (await catchNotFound(fetch(safeId))) ?? undefined;
        return result === undefined ? undefined : { result, safeId };
    });
}

/**
 * The storage's ID, for URLs that do not resolve a name: Console pages, and public record links, which
 * an anonymous `~name` cannot reach. A hit under an ID-shaped safe id was an ID; any other is read back
 * once through `get`.
 */
export async function resolveStorageId(
    safeId: string,
    get: (safeId: string) => Promise<{ id: string } | undefined>,
): Promise<string> {
    if (isAmbiguousResourceId(safeId)) return safeId;
    return (await get(safeId))?.id ?? safeId;
}

const STORAGE_ARG = {
    dataset: { noun: 'Dataset', arg: 'datasetId', plural: 'datasets' },
    keyValueStore: { noun: 'Key-value store', arg: 'keyValueStoreId', plural: 'key-value stores' },
} as const;

/** The `describe()` text of a storage id argument. */
export function storageIdArgDescription(kind: keyof typeof STORAGE_ARG): string {
    const { noun, plural } = STORAGE_ARG[kind];
    return `${noun} ID, name (resolved against your own ${plural}), or full name as username~name.`;
}

/** The not-found error for a storage id argument, naming the forms it takes. */
export function storageNotFoundText(kind: keyof typeof STORAGE_ARG, idOrName: string): string {
    const { noun, arg, plural } = STORAGE_ARG[kind];
    return `${noun} '${idOrName}' not found. The ${arg} argument takes an ID, a name (resolved against your own ${plural}), or a full name as username~name.`;
}

function suggestTool(toolName: string, loadedToolNames: readonly string[]): string | undefined {
    return loadedToolNames.includes(toolName) ? toolName : undefined;
}

/** `nextStep` when the session was served the sibling tool it names, otherwise `fallback`, which names no tool (see #1296). */
export function resolveSiblingNextStep(
    toolName: string,
    loadedToolNames: readonly string[],
    nextStep: string,
    fallback = 'No follow-up step.',
): string {
    return suggestTool(toolName, loadedToolNames) ? nextStep : fallback;
}

/**
 * The "Apify Console: <url>" line plus the verbatim-links nudge, or `undefined` when there is no
 * link (non-Console session). Single source for both the text-channel suffix in `buildStorageResponse`
 * and the standalone content item in `buildConsoleLinkContent` (binary KV records).
 */
export function apifyConsoleLinkText(apifyConsoleUrl: string | undefined): string | undefined {
    return apifyConsoleUrl ? `Apify Console: ${apifyConsoleUrl}\n${VERBATIM_LINKS_NUDGE}` : undefined;
}

/**
 * Optional extra text content item carrying the storage's personalized Console link
 * (Console UI token sessions only). Spread into a tool's `content` array — used by the
 * binary key-value-store-record path, which bypasses `buildStorageResponse`.
 */
export function buildConsoleLinkContent(apifyConsoleUrl: string | undefined): { type: 'text'; text: string }[] {
    const text = apifyConsoleLinkText(apifyConsoleUrl);
    return text ? [{ type: 'text', text }] : [];
}

/**
 * Build a storage tool response, mirroring `actor_run_response.ts`:
 * `structuredContent` carries the data plus `summary` (and `nextStep` unless terminal).
 * `nextStep` is omitted for terminal responses (e.g. get-key-value-store-record).
 *
 * `content[0]` is the JSON-stringified `structuredContent`; `content[1]` carries `summary`/`nextStep`
 * as plain text. `structuredContent` is the lossless source of truth — programmatic consumers read
 * it, not `content[]`.
 */
export function buildStorageResponse(params: {
    structuredContent: Record<string, unknown>;
    summary: string;
    nextStep?: string;
    /** Personalized Apify Console link (Console UI token sessions); appended as a trailing text item. */
    apifyConsoleUrl?: string;
}) {
    const { structuredContent, summary, nextStep, apifyConsoleUrl } = params;
    const full = { ...structuredContent, summary, ...(nextStep !== undefined && { nextStep }) };
    const summaryText = nextStep !== undefined ? `${summary}\n${nextStep}` : summary;
    const consoleLinkText = apifyConsoleLinkText(apifyConsoleUrl);
    return respondOk([JSON.stringify(structuredContent), summaryText, ...(consoleLinkText ? [consoleLinkText] : [])], {
        structuredContent: full,
    });
}

/**
 * {summary, nextStep} for paginated storage listings (datasets, key-value stores).
 * When more items remain, nextStep points at the next page; on an empty last page, at what
 * `unnamed=true` adds when it is not set; otherwise at inspecting an entry.
 */
export function buildStorageListSummaryNextStep(params: {
    count: number;
    total: number;
    offset: number;
    noun: string;
    listToolName: string;
    inspectHint: string;
    /** The API's default `unnamed=false` lists only named storages; Actor runs write to unnamed ones. */
    isNamedOnly: boolean;
}): { summary: string; nextStep: string } {
    const { count, total, offset, noun, listToolName, inspectHint, isNamedOnly } = params;
    const summary = `Listed ${count} of ${total} ${isNamedOnly ? 'named ' : ''}${noun}.`;
    if (offset + count < total) {
        return {
            summary,
            nextStep: `Call ${listToolName} again with offset=${offset + count} to fetch the next page.`,
        };
    }
    if (count === 0) {
        return {
            summary,
            nextStep: isNamedOnly
                ? `unnamed=true includes the unnamed ${noun} that Actor runs create.`
                : 'No follow-up step.',
        };
    }
    return { summary, nextStep: inspectHint };
}

/**
 * Pagination-aware {summary, nextStep}: when more items remain, point at the next page;
 * otherwise point at get-dataset for the field list (structure lives there, not in a heavy schema dump).
 */
export function buildDatasetItemsSummaryNextStep(params: {
    datasetId: string;
    itemCount: number;
    totalItemCount: number;
    offset: number;
    /** Active loaded tool set; gates the terminal get-dataset reference (see #1007). */
    loadedToolNames: readonly string[];
}): { summary: string; nextStep: string } {
    const { datasetId, itemCount, totalItemCount, offset, loadedToolNames } = params;
    if (offset + itemCount < totalItemCount) {
        return {
            summary: `Fetched ${itemCount} of ${totalItemCount} items (offset=${offset}).`,
            nextStep: `Call ${HELPER_TOOLS.DATASET_GET_ITEMS} again with offset=${offset + itemCount} to fetch the next page.`,
        };
    }
    const summary =
        offset === 0 && itemCount === totalItemCount
            ? `Fetched all ${itemCount} items.`
            : `Fetched ${itemCount} of ${totalItemCount} items (offset=${offset}); no more pages.`;
    return {
        summary,
        nextStep: suggestTool(HELPER_TOOLS.DATASET_GET, loadedToolNames)
            ? `Use ${HELPER_TOOLS.DATASET_GET} with datasetId=${datasetId} to see the field list if you need the data structure.`
            : `No more pages. Inspect the returned items directly.`,
    };
}

/**
 * {summary, nextStep} for cursor-paginated key-value store key listings.
 * When truncated, nextStep points at the next page; otherwise at inspecting a record or the store.
 */
export function buildKvsKeysSummaryNextStep(params: {
    keyValueStoreId: string;
    count: number;
    isTruncated: boolean;
    nextExclusiveStartKey?: string;
    firstKey?: string;
    /** Active loaded tool set; gates the terminal record and store references (see #1296). */
    loadedToolNames: readonly string[];
}): { summary: string; nextStep: string } {
    const { keyValueStoreId, count, isTruncated, nextExclusiveStartKey, firstKey, loadedToolNames } = params;
    const noun = count === 1 ? 'key' : 'keys';
    const summary = `Listed ${count} ${noun}${isTruncated ? ' (more available)' : ''}.`;
    if (isTruncated && nextExclusiveStartKey) {
        return {
            summary,
            nextStep: `Call ${HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET} again with exclusiveStartKey=${nextExclusiveStartKey} to fetch the next page.`,
        };
    }
    return {
        summary,
        nextStep: firstKey
            ? resolveSiblingNextStep(
                  HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
                  loadedToolNames,
                  `Use ${HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET} with keyValueStoreId=${keyValueStoreId} and recordKey=${firstKey} to read a value.`,
              )
            : resolveSiblingNextStep(
                  HELPER_TOOLS.KEY_VALUE_STORE_GET,
                  loadedToolNames,
                  `Use ${HELPER_TOOLS.KEY_VALUE_STORE_GET} with keyValueStoreId=${keyValueStoreId} to inspect the store.`,
              ),
    };
}

/**
 * Normalize a key-value store record key before SDK lookup.
 *
 * Strips the same LLM-leaked wrapper chars as `stripQuoteWrappers` (shared
 * `QUOTE_WRAPPER_CHARS`), but preserves the apostrophe — Apify record keys
 * allow `'` as a valid character (`/^[a-zA-Z0-9!\-_.'()]{1,256}$/`), so
 * stripping it could corrupt a real key.
 */
const NORMALIZE_RECORD_KEY_REGEX = new RegExp(`^[${QUOTE_WRAPPER_CHARS}]+|[${QUOTE_WRAPPER_CHARS}]+$`, 'g');
export function normalizeRecordKey(key: string): string {
    return key.trim().replace(NORMALIZE_RECORD_KEY_REGEX, '').trim();
}

/**
 * How to surface a binary key-value-store record value: inline as base64 below
 * `MAX_INLINE_BYTES`, otherwise link out (inlining a multi-MB blob would blow up the
 * client's context). `mimeType` is the Content-Type with parameters stripped and lowercased
 * (`Image/PNG; charset=…` → `image/png`), or `undefined` when no Content-Type was declared.
 */
export type BinaryRecordDisposition =
    | { kind: 'inline'; mimeType?: string; base64: string }
    | { kind: 'linkOut'; mimeType?: string; bytes: number };

/**
 * Base MIME type of a Content-Type header: parameters stripped, lowercased
 * (`Image/PNG; charset=…` → `image/png`), `undefined` when no header was declared.
 * Shared by the get-key-value-store-record tool and the API-resource proxy.
 */
export function parseBaseMimeType(contentType: string | undefined): string | undefined {
    return contentType?.split(';')[0].trim().toLowerCase();
}

/**
 * Build the transport disposition for a binary record value: normalize the MIME type, decide
 * inline-vs-link-out at the byte threshold, base64-encode when inlining. It does NOT mint the
 * link-out URL — the caller handles `linkOut` by minting its own URL via async calls.
 */
export function buildBinaryRecordDisposition(contentType: string | undefined, value: Buffer): BinaryRecordDisposition {
    const mimeType = parseBaseMimeType(contentType);
    if (value.length > MAX_INLINE_BYTES) {
        return { kind: 'linkOut', ...(mimeType !== undefined && { mimeType }), bytes: value.length };
    }
    return { kind: 'inline', ...(mimeType !== undefined && { mimeType }), base64: value.toString('base64') };
}
