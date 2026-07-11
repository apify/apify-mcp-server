import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import { APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED, FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import { buildToolCallErrorResult } from '../../src/mcp/tool_call_error_mapper.js';
import type { CallDiagnostics } from '../../src/types.js';
import { getToolCallErrorUserText } from '../../src/utils/mcp.js';

const TOOL_NAME = 'test-tool';
const ACTOR_NAME = 'apify/web-scraper';
const ACTOR_ID = 'abc123';
const PERMISSION_HTTP_STATUS = 403;

/** A 402 x402 payment-required condition. Any object with `statusCode: 402` satisfies the predicate. */
function makePaymentRequiredError(): Error {
    return Object.assign(new Error('Payment required'), { statusCode: 402 });
}

/** A real full-permission-not-approved `ApifyApiError`, built against the src/const.ts type constant. */
function makePermissionApprovalError(): ApifyApiError {
    return new ApifyApiError(
        {
            data: { error: { type: APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED, message: 'needs approval' } },
            status: PERMISSION_HTTP_STATUS,
        } as AxiosResponse,
        1,
    );
}

type Case = {
    label: string;
    makeError: () => unknown;
    kind: 'payment' | 'approval' | 'execution';
    toolStatus: string;
    callDiagnostics: CallDiagnostics;
    /** payment/approval carry a `response`; execution carries `userText`. */
    hasResponse: boolean;
};

const CASES: Case[] = [
    {
        label: '402 payment-required',
        makeError: makePaymentRequiredError,
        kind: 'payment',
        toolStatus: TOOL_STATUS.SOFT_FAIL,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            failure_http_status: 402,
            actor_name: ACTOR_NAME,
            actor_id: ACTOR_ID,
        },
        hasResponse: true,
    },
    {
        label: 'permission-approval',
        makeError: makePermissionApprovalError,
        kind: 'approval',
        toolStatus: TOOL_STATUS.SOFT_FAIL,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
            failure_http_status: PERMISSION_HTTP_STATUS,
            actor_name: ACTOR_NAME,
            actor_id: ACTOR_ID,
        },
        hasResponse: true,
    },
    {
        label: 'generic execution error',
        makeError: () => new Error('boom'),
        kind: 'execution',
        toolStatus: TOOL_STATUS.FAILED,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
            failure_detail: 'boom',
            actor_name: ACTOR_NAME,
            actor_id: ACTOR_ID,
        },
        hasResponse: false,
    },
];

describe('buildToolCallErrorResult()', () => {
    for (const tc of CASES) {
        it(`classifies a ${tc.label} error`, () => {
            const error = tc.makeError();
            const result = buildToolCallErrorResult(error, {
                toolName: TOOL_NAME,
                actorName: ACTOR_NAME,
                actorId: ACTOR_ID,
                isAborted: false,
            });

            expect(result.kind).toBe(tc.kind);
            expect(result.toolStatus).toBe(tc.toolStatus);
            // Fresh object per branch — no failure_http_status leaks into the generic case.
            expect(result.callDiagnostics).toEqual(tc.callDiagnostics);

            if (tc.hasResponse) {
                // payment/approval return a ready-to-send response, no userText.
                expect('response' in result && result.response).toBeTruthy();
                expect('userText' in result).toBe(false);
            } else {
                // execution returns user-facing text, no response.
                expect('userText' in result && result.userText).toBe(getToolCallErrorUserText(TOOL_NAME, error));
                expect('response' in result).toBe(false);
            }
        });
    }

    it('returns ABORTED toolStatus for an aborted execution error', () => {
        const result = buildToolCallErrorResult(new Error('boom'), {
            toolName: TOOL_NAME,
            actorName: ACTOR_NAME,
            actorId: ACTOR_ID,
            isAborted: true,
        });

        expect(result.kind).toBe('execution');
        expect(result.toolStatus).toBe(TOOL_STATUS.ABORTED);
    });
});
