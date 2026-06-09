import { FAILURE_CATEGORY, TOOL_STATUS } from '../../const.js';
import { VERBATIM_LINKS_NUDGE } from '../../utils/console_link.js';
import { QUOTE_WRAPPER_CHARS } from '../../utils/generic.js';
import { buildMCPResponse } from '../../utils/mcp.js';

/**
 * Optional extra text content item carrying the storage's personalized Console link
 * (Console UI token sessions only). Spread into the tool's `content` array.
 */
export function buildConsoleLinkContent(consoleUrl: string | undefined): { type: 'text'; text: string }[] {
    if (!consoleUrl) return [];
    return [{ type: 'text', text: `Console: ${consoleUrl}\n${VERBATIM_LINKS_NUDGE}` }];
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
