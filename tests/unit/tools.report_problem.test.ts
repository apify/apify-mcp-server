import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../src/const.js';
import {
    REPORT_PROBLEM_INVALID_INPUT_NUDGE,
    REPORT_PROBLEM_NUDGE,
    appendReportProblemNudge,
    reportProblem,
} from '../../src/tools/dev/report_problem.js';
import type { HelperTool } from '../../src/types.js';
import { type TextToolResult, stubToolCallContext } from './helpers/tool_context.js';

const errorResult = () => ({ content: [{ type: 'text', text: 'Actor not found.' }], isError: true });
const nudgeCount = (r: { content: { text: string }[] }) =>
    r.content.filter((c) => c.text === REPORT_PROBLEM_NUDGE).length;

describe('reportProblem', () => {
    describe('call()', () => {
        it('acknowledges a submission that has a message', async () => {
            const result = await (reportProblem as HelperTool).call(
                stubToolCallContext({ message: 'The search-actors results were unclear.' }, {} as never),
            );
            const { content, isError } = result as TextToolResult;

            expect(isError).toBe(false);
            expect(content[0].text).toContain('Problem reported');
        });
    });

    describe('annotations', () => {
        it('is not read-only (submitting a report writes to the Apify team)', () => {
            expect((reportProblem as HelperTool).annotations?.readOnlyHint).toBe(false);
        });
    });

    describe('input validation', () => {
        const validate = (reportProblem as HelperTool).ajvValidate;

        it('requires a message', () => {
            expect(validate({})).toBe(false);
        });

        it('accepts a message at the 2000-character cap', () => {
            expect(validate({ message: 'x'.repeat(2000) })).toBe(true);
        });

        it('rejects a message longer than 2000 characters', () => {
            expect(validate({ message: 'x'.repeat(2001) })).toBe(false);
        });

        it('rejects more than 20 related tools', () => {
            expect(validate({ message: 'stuck', relatedTools: Array.from({ length: 21 }, () => 'call-actor') })).toBe(
                false,
            );
        });

        it('accepts a related tool name at the 100-character cap', () => {
            expect(validate({ message: 'stuck', relatedTools: ['t'.repeat(100)] })).toBe(true);
        });

        it('rejects a related tool name longer than 100 characters', () => {
            expect(validate({ message: 'stuck', relatedTools: ['t'.repeat(101)] })).toBe(false);
        });

        it('rejects an over-long actorId', () => {
            expect(validate({ message: 'stuck', actorId: 'a'.repeat(201) })).toBe(false);
        });

        it('accepts an actorRunId at the 200-character cap', () => {
            expect(validate({ message: 'stuck', actorRunId: 'r'.repeat(200) })).toBe(true);
        });

        it('rejects an over-long actorRunId', () => {
            expect(validate({ message: 'stuck', actorRunId: 'r'.repeat(201) })).toBe(false);
        });

        it('accepts the optional actor, run, and related-tools fields', () => {
            expect(
                validate({
                    message: 'rag-web-browser worked well',
                    actorId: 'apify/rag-web-browser',
                    actorRunId: 'abc123',
                    relatedTools: ['call-actor', 'get-dataset-items'],
                }),
            ).toBe(true);
        });
    });

    describe('appendReportProblemNudge()', () => {
        it('appends the nudge to a failed result when the tool is available', () => {
            const result = appendReportProblemNudge(errorResult(), {
                failingToolName: HELPER_TOOLS.ACTOR_CALL,
                available: true,
            });
            expect(nudgeCount(result)).toBe(1);
        });

        it('does not append when the tool is unavailable', () => {
            const result = appendReportProblemNudge(errorResult(), {
                failingToolName: HELPER_TOOLS.ACTOR_CALL,
                available: false,
            });
            expect(nudgeCount(result)).toBe(0);
        });

        it('does not append when the failing tool is report-problem itself', () => {
            const result = appendReportProblemNudge(errorResult(), {
                failingToolName: HELPER_TOOLS.PROBLEM_REPORT,
                available: true,
            });
            expect(nudgeCount(result)).toBe(0);
        });

        it('does not append to a successful result', () => {
            const success = { content: [{ type: 'text', text: 'done' }], isError: false };
            const result = appendReportProblemNudge(success, {
                failingToolName: HELPER_TOOLS.ACTOR_CALL,
                available: true,
            });
            expect(nudgeCount(result)).toBe(0);
        });

        it.each([
            ['PERMISSION_APPROVAL_REQUIRED', FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED],
            ['AUTH', FAILURE_CATEGORY.AUTH],
        ])('does not append for the user-resolvable category %s', (_label, failureCategory) => {
            const result = appendReportProblemNudge(errorResult(), {
                failingToolName: HELPER_TOOLS.ACTOR_CALL,
                available: true,
                failureCategory,
            });
            expect(nudgeCount(result)).toBe(0);
        });

        it('appends the softer nudge for a genuine INVALID_INPUT with no 402 (input bug)', () => {
            const result = appendReportProblemNudge(errorResult(), {
                failingToolName: HELPER_TOOLS.ACTOR_CALL,
                available: true,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
            });
            expect(result.content.filter((c) => c.text === REPORT_PROBLEM_INVALID_INPUT_NUDGE)).toHaveLength(1);
            expect(nudgeCount(result)).toBe(0);
        });

        it('does not append any nudge for a 402 payment response, though 402 is classified INVALID_INPUT', () => {
            const result = appendReportProblemNudge(errorResult(), {
                failingToolName: HELPER_TOOLS.ACTOR_CALL,
                available: true,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                failureHttpStatus: 402,
            });
            expect(result.content.filter((c) => c.text === REPORT_PROBLEM_INVALID_INPUT_NUDGE)).toHaveLength(0);
            expect(nudgeCount(result)).toBe(0);
            expect(result.content).toHaveLength(1);
        });

        it('appends for a genuine INTERNAL_ERROR failure', () => {
            const result = appendReportProblemNudge(errorResult(), {
                failingToolName: HELPER_TOOLS.ACTOR_CALL,
                available: true,
                failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
            });
            expect(nudgeCount(result)).toBe(1);
        });

        it('appends when the failure category is undefined (unclassified)', () => {
            const result = appendReportProblemNudge(errorResult(), {
                failingToolName: HELPER_TOOLS.ACTOR_CALL,
                available: true,
                failureCategory: undefined,
            });
            expect(nudgeCount(result)).toBe(1);
        });

        it('does not mutate the input result', () => {
            const input = errorResult();
            const before = input.content.length;
            const result = appendReportProblemNudge(input, {
                failingToolName: HELPER_TOOLS.ACTOR_CALL,
                available: true,
            });
            expect(input.content.length).toBe(before);
            expect(result.content.length).toBe(before + 1);
            expect(result.content).not.toBe(input.content);
        });
    });
});
