import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import { buildToolCallErrorResult, TOOL_CALL_ERROR_KIND } from '../../src/mcp/tool_call_error_mapper.js';
import type { CallDiagnostics } from '../../src/types.js';
import { getToolCallErrorUserText } from '../../src/utils/mcp.js';
import { makePaymentRequiredError, makePermissionApprovalError, PERMISSION_HTTP_STATUS } from './helpers/mcp_server.js';

const TOOL_NAME = 'test-tool';
const ACTOR_NAME = 'apify/web-scraper';
const ACTOR_ID = 'abc123';

const X402_PAYMENT_DATA = {
    x402Version: 1,
    accepts: [{ scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000' }],
};

type Case = {
    label: string;
    makeError: () => unknown;
    kind: (typeof TOOL_CALL_ERROR_KIND)[keyof typeof TOOL_CALL_ERROR_KIND];
    toolStatus: string;
    callDiagnostics: CallDiagnostics;
    /** Exact `response` payload for payment/approval; execution carries `userText` instead. */
    response?: Record<string, unknown>;
};

const CASES: Case[] = [
    {
        label: '402 payment-required without payment data',
        makeError: () => makePaymentRequiredError(),
        kind: TOOL_CALL_ERROR_KIND.PAYMENT,
        toolStatus: TOOL_STATUS.SOFT_FAIL,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            failure_http_status: 402,
            actor_name: ACTOR_NAME,
            actor_id: ACTOR_ID,
        },
        response: { content: [{ type: 'text', text: 'Payment required' }], isError: true },
    },
    {
        label: '402 payment-required with an x402 payload',
        makeError: () => makePaymentRequiredError(X402_PAYMENT_DATA),
        kind: TOOL_CALL_ERROR_KIND.PAYMENT,
        toolStatus: TOOL_STATUS.SOFT_FAIL,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            failure_http_status: 402,
            actor_name: ACTOR_NAME,
            actor_id: ACTOR_ID,
        },
        // Payment clients parse both carriers — pin the exact x402 shape.
        response: {
            content: [
                { type: 'text', text: JSON.stringify(X402_PAYMENT_DATA) },
                { type: 'text', text: 'Payment required to run this Actor or access this resource.' },
            ],
            isError: true,
            structuredContent: X402_PAYMENT_DATA,
        },
    },
    {
        label: 'permission-approval',
        makeError: makePermissionApprovalError,
        kind: TOOL_CALL_ERROR_KIND.APPROVAL,
        toolStatus: TOOL_STATUS.SOFT_FAIL,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
            failure_http_status: PERMISSION_HTTP_STATUS,
            actor_name: ACTOR_NAME,
            actor_id: ACTOR_ID,
        },
        response: { content: [{ type: 'text', text: 'needs approval' }], isError: true },
    },
    {
        label: 'generic execution error',
        makeError: () => new Error('boom'),
        kind: TOOL_CALL_ERROR_KIND.EXECUTION,
        toolStatus: TOOL_STATUS.FAILED,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
            failure_detail: 'boom',
            actor_name: ACTOR_NAME,
            actor_id: ACTOR_ID,
        },
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

            if (tc.response) {
                // payment/approval return the exact ready-to-send response, no userText.
                expect('response' in result && result.response).toEqual(tc.response);
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

        expect(result.kind).toBe(TOOL_CALL_ERROR_KIND.EXECUTION);
        expect(result.toolStatus).toBe(TOOL_STATUS.ABORTED);
    });

    it('classifies a standard-code McpError as an execution error', () => {
        // The sync catch rethrows McpErrors before mapping; the task sink hands them to the
        // mapper, where negative JSON-RPC codes fail both predicates and classify as execution.
        const result = buildToolCallErrorResult(new McpError(ErrorCode.InvalidParams, 'bad params'), {
            toolName: TOOL_NAME,
            isAborted: false,
        });

        expect(result.kind).toBe(TOOL_CALL_ERROR_KIND.EXECUTION);
    });

    it('classifies an McpError carrying code 402 as payment', () => {
        // Documents the containment invariant the sync catch relies on: getHttpStatusCode falls
        // through to `.code`, so a protocol error with code 402 satisfies the x402 predicate.
        // Such an error must never reach the sync catch (all remote-McpError routes are sealed by
        // inner catches); if this pin surprises you, re-check that containment before touching the
        // McpError re-throw order in server.ts.
        const result = buildToolCallErrorResult(new McpError(402 as ErrorCode, 'remote 402'), {
            toolName: TOOL_NAME,
            isAborted: false,
        });

        expect(result.kind).toBe(TOOL_CALL_ERROR_KIND.PAYMENT);
    });
});
