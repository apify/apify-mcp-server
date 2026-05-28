import { FAILURE_CATEGORY, TOOL_STATUS } from '../../const.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { buildMCPResponse } from '../../utils/mcp.js';

/**
 * Wrap a JSON-serializable value in a Markdown ` ```json ` code fence.
 * Used by every storage tool that returns SDK payloads to the LLM.
 */
export function wrapJsonText(value: unknown): string {
    return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
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
 * Normalize a dataset / key-value store id before SDK lookup.
 *
 * LLMs commonly wrap ids in markdown backticks or smart quotes, which the
 * Apify API treats as distinct strings and 404s. Mirrors the trim/strip
 * half of `fixActorNameInput` (no slash-padding — storage ids use `~`).
 */
export function normalizeStorageId(id: string): string {
    return stripQuoteWrappers(id);
}
