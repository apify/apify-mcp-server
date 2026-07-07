import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../const.js';
import { VERBATIM_LINKS_NUDGE } from '../../utils/console_link.js';
import { QUOTE_WRAPPER_CHARS } from '../../utils/generic.js';
import { buildMCPResponse } from '../../utils/mcp.js';

function suggestTool(toolName: string, loadedToolNames: string[]): string | undefined {
    return loadedToolNames.includes(toolName) ? toolName : undefined;
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
 * Soft-fail not-found response for storage tools. Centralizes
 * `isError: true` + SOFT_FAIL/INVALID_INPUT telemetry so call sites
 * only supply the message.
 */
export function buildStorageNotFound(text: string) {
    return buildMCPResponse({
        texts: [text],
        isError: true,
        telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
    });
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
    const dataText = JSON.stringify(structuredContent);
    const consoleLinkText = apifyConsoleLinkText(apifyConsoleUrl);
    return buildMCPResponse({
        texts: [dataText, summaryText, ...(consoleLinkText ? [consoleLinkText] : [])],
        structuredContent: full,
    });
}

/**
 * {summary, nextStep} for paginated storage listings (datasets, key-value stores).
 * When more items remain, nextStep points at the next page; otherwise at inspecting an entry.
 */
export function buildStorageListSummaryNextStep(params: {
    count: number;
    total: number;
    offset: number;
    noun: string;
    listToolName: string;
    inspectHint: string;
}): { summary: string; nextStep: string } {
    const { count, total, offset, noun, listToolName, inspectHint } = params;
    return {
        summary: `Listed ${count} of ${total} ${noun}.`,
        nextStep:
            offset + count < total
                ? `Call ${listToolName} again with offset=${offset + count} to fetch the next page.`
                : inspectHint,
    };
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
    loadedToolNames: string[];
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
}): { summary: string; nextStep: string } {
    const { keyValueStoreId, count, isTruncated, nextExclusiveStartKey, firstKey } = params;
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
            ? `Use ${HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET} with keyValueStoreId=${keyValueStoreId} and recordKey=${firstKey} to read a value.`
            : `Use ${HELPER_TOOLS.KEY_VALUE_STORE_GET} with keyValueStoreId=${keyValueStoreId} to inspect the store.`,
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
