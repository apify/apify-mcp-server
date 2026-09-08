/** Selection-mode scoring. Calls are captured by the deny-all hook in `claude_agent.ts`. */

import { stripToolPrefix } from './config.js';

/**
 * Denial wording for selection-mode items, calibrated by spike (2026-09-04): stops the
 * agent cleanly after exactly one denied call on every sample query. The `failTools`
 * nudge (`REPORT_PROBLEM_NUDGE`) reads as "work around this" and measurably causes
 * retries instead — do not reuse it here.
 */
export const SELECTION_DENY_REASON =
    'Tool calls are disabled in this evaluation. Do not retry with a different tool or ' +
    'arguments — report to the user, in your final answer, which tool you would have ' +
    'called and with what arguments, then stop.';

export const SELECTION_MAX_TURNS = 2;

export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch';

export type AttemptedToolCall = {
    toolName: string;
    input: unknown;
};

function formatCall(name: string, input: unknown): string {
    return `${name}(${JSON.stringify(input ?? {})})`;
}

function isDeepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => isDeepEqual(v, b[i]));
    }
    if (typeof a === 'object' && typeof b === 'object') {
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        return (
            aKeys.length === bKeys.length &&
            aKeys.every((key) => isDeepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
        );
    }
    return false;
}

function argAt(input: unknown, key: string): unknown {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
    return (input as Record<string, unknown>)[key];
}

function resolveArgMismatch(
    input: unknown,
    expectedArgs: Record<string, unknown>,
): { key: string; expected: unknown; got: unknown } | undefined {
    for (const [key, expected] of Object.entries(expectedArgs)) {
        const got = argAt(input, key);
        if (!isDeepEqual(got, expected)) return { key, expected, got };
    }
    return undefined;
}

/** Match the selected tool name and the listed argument subset. */
export function resolveFirstToolMatch(
    attempts: AttemptedToolCall[],
    expectedTools: string[],
    expectedArgs?: Record<string, unknown>,
): { isMatch: boolean; comment: string } {
    // `ToolSearch` is Claude Code routing, not the tool choice this mode measures.
    const skippedCount = attempts.filter((attempt) => attempt.toolName === TOOL_SEARCH_TOOL_NAME).length;
    const measured = attempts.find((attempt) => attempt.toolName !== TOOL_SEARCH_TOOL_NAME);
    const skipSuffix =
        skippedCount > 0
            ? ` (${skippedCount} ${TOOL_SEARCH_TOOL_NAME} capture${skippedCount === 1 ? '' : 's'} skipped)`
            : '';

    if (!measured) {
        return { isMatch: false, comment: `no tool call attempted${skipSuffix}` };
    }

    const name = stripToolPrefix(measured.toolName);
    const call = formatCall(name, measured.input);

    if (!expectedTools.includes(name)) {
        return { isMatch: false, comment: `${call} — expected one of [${expectedTools.join(', ')}]${skipSuffix}` };
    }

    if (expectedArgs) {
        const mismatch = resolveArgMismatch(measured.input, expectedArgs);
        if (mismatch) {
            return {
                isMatch: false,
                comment:
                    `${call} — tool name matched; arg "${mismatch.key}" expected ` +
                    `${JSON.stringify(mismatch.expected)}, got ${JSON.stringify(mismatch.got)}${skipSuffix}`,
            };
        }
    }

    return { isMatch: true, comment: `${call} — matched expectedTools [${expectedTools.join(', ')}]${skipSuffix}` };
}
