/**
 * Selection mode: `kind: "selection"` items measure only which tool the agent would have
 * called, and with what arguments. Nothing executes and no judge runs.
 *
 * A per-item deny-all `PreToolUse` hook (built in `claude_agent.ts`) refuses every tool
 * call with `SELECTION_DENY_REASON` and records the attempt. This module owns the pure,
 * zero-spend part of the contract: which of the recorded attempts is "the" measurement
 * (skipping Claude Code's own `ToolSearch` meta-tool, a false first call once built-in
 * tools sit behind tool search), and whether it matches the item's `expectedTools` /
 * `expectedArgs`.
 */

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

/** Fixed turn budget for selection items: the wording above stops the agent in 2 turns. */
export const SELECTION_MAX_TURNS = 2;

/** Claude Code's own tool-search meta-tool; never the intended measurement. */
export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch';

/** One attempted tool call, as captured by the deny-all `PreToolUse` hook. */
export type AttemptedToolCall = {
    /** Raw SDK-reported name, e.g. "mcp__apify__fetch-actor-details" or "ToolSearch". */
    toolName: string;
    /** Raw `tool_input` as captured by the hook. */
    input: unknown;
};

/** `${name}(${json args})`, the rendering shared by every comment format below. */
function formatCall(name: string, input: unknown): string {
    return `${name}(${JSON.stringify(input ?? {})})`;
}

/** Structural equality, order-independent for object keys. */
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

/** The value at `key` on a captured tool input, or undefined when it is not an object. */
function argAt(input: unknown, key: string): unknown {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
    return (input as Record<string, unknown>)[key];
}

/** The first `expectedArgs` key whose captured value differs, or undefined when all match. */
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

/**
 * The measured call: the first attempt that is not `ToolSearch`, plus how many `ToolSearch`
 * captures were skipped along the way (spike finding: with built-ins gated behind tool
 * search, the first captured call can be `ToolSearch`, not the tool the item cares about).
 */
export function resolveMeasuredCall(attempts: AttemptedToolCall[]): {
    measured?: AttemptedToolCall;
    skippedCount: number;
} {
    const skippedCount = attempts.filter((attempt) => attempt.toolName === TOOL_SEARCH_TOOL_NAME).length;
    const measured = attempts.find((attempt) => attempt.toolName !== TOOL_SEARCH_TOOL_NAME);
    return { measured, skippedCount };
}

/**
 * Score `first_tool_match` for a selection item: name membership (`mcp__apify__` prefix
 * stripped, built-in names compared verbatim) against `expectedTools`, then - only once the
 * name matches - `expectedArgs` deep-equality per listed key (keys not listed are ignored).
 */
export function resolveFirstToolMatch(
    attempts: AttemptedToolCall[],
    expectedTools: string[],
    expectedArgs?: Record<string, unknown>,
): { isMatch: boolean; comment: string } {
    const { measured, skippedCount } = resolveMeasuredCall(attempts);
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
