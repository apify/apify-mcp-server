import { FAILURE_CATEGORY, TOOL_STATUS, HelperTools } from '../../const.js';
import { encodeToon } from '../../utils/encode_text.js';
import { QUOTE_WRAPPER_CHARS } from '../../utils/generic.js';
import { buildMCPResponse } from '../../utils/mcp.js';

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
 * `toon: true` (the list tools) emits a single text: the data TOON-encoded in a ```toon fence
 * (token-cheaper for uniform-row arrays; `summary`/`nextStep` are prose, not tabular, so they
 * stay out of the fence) followed by `summary`/`nextStep` as plain text. Single-object tools
 * leave it off and ship `content[0]` as the raw-JSON dump of `structuredContent` plus
 * `content[1]` with `summary`/`nextStep`. Either way `structuredContent` is the lossless source
 * of truth — programmatic consumers read it, not `content[]`.
 */
export function buildStorageResponse(params: {
    structuredContent: Record<string, unknown>;
    summary: string;
    nextStep?: string;
    toon?: boolean;
}) {
    const { structuredContent, summary, nextStep, toon } = params;
    const full = { ...structuredContent, summary, ...(nextStep !== undefined && { nextStep }) };
    const summaryText = nextStep !== undefined ? `${summary}\n${nextStep}` : summary;
    return buildMCPResponse({
        texts: toon ? [encodeToon(structuredContent), summaryText] : [JSON.stringify(structuredContent), summaryText],
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
 * otherwise point at get-dataset-schema for structure inspection.
 */
export function buildDatasetItemsSummaryNextStep(params: {
    datasetId: string;
    itemCount: number;
    totalItemCount: number;
    offset: number;
}): { summary: string; nextStep: string } {
    const { datasetId, itemCount, totalItemCount, offset } = params;
    if (offset + itemCount < totalItemCount) {
        return {
            summary: `Fetched ${itemCount} of ${totalItemCount} items (offset=${offset}).`,
            nextStep: `Call ${HelperTools.DATASET_GET_ITEMS} again with offset=${offset + itemCount} to fetch the next page.`,
        };
    }
    const summary =
        offset === 0 && itemCount === totalItemCount
            ? `Fetched all ${itemCount} items.`
            : `Fetched ${itemCount} of ${totalItemCount} items (offset=${offset}); no more pages.`;
    return {
        summary,
        nextStep: `Use ${HelperTools.DATASET_SCHEMA_GET} with datasetId=${datasetId} to inspect structure if needed.`,
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
            nextStep: `Call ${HelperTools.KEY_VALUE_STORE_KEYS_GET} again with exclusiveStartKey=${nextExclusiveStartKey} to fetch the next page.`,
        };
    }
    return {
        summary,
        nextStep: firstKey
            ? `Use ${HelperTools.KEY_VALUE_STORE_RECORD_GET} with keyValueStoreId=${keyValueStoreId} and recordKey=${firstKey} to read a value.`
            : `Use ${HelperTools.KEY_VALUE_STORE_GET} with keyValueStoreId=${keyValueStoreId} to inspect the store.`,
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
