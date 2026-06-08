import { FAILURE_CATEGORY, TOOL_STATUS } from '../../const.js';
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
 * `structuredContent` carries the data plus `summary` (and `nextStep` unless terminal);
 * `content[0]` is the JSON dump of `structuredContent` (spec compat for clients that read
 * `content[]`), `content[1]` is the human-readable `summary`/`nextStep`.
 * `nextStep` is omitted for terminal responses (e.g. get-key-value-store-record).
 */
export function buildStorageResponse(params: {
    structuredContent: Record<string, unknown>;
    summary: string;
    nextStep?: string;
}) {
    const { structuredContent, summary, nextStep } = params;
    const full = { ...structuredContent, summary, ...(nextStep !== undefined && { nextStep }) };
    return buildMCPResponse({
        texts: [JSON.stringify(full), nextStep !== undefined ? `${summary}\n${nextStep}` : summary],
        structuredContent: full,
    });
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
