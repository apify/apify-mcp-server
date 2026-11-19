/**
 * Tests for the 402 Payment Required and permission-approval error-response builders.
 */
import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import {
    buildPaymentRequiredResponse,
    buildPermissionApprovalResponse,
    isPaymentRequiredError,
} from '../../src/utils/payment_errors.js';
import { textOf } from './helpers/tool_context.js';

describe('isPaymentRequiredError()', () => {
    it('returns true for a plain 402, false for the concurrent-run limit arriving as 402', () => {
        expect(isPaymentRequiredError(Object.assign(new Error('Payment required'), { statusCode: 402 }))).toBe(true);
        const runLimitError = Object.assign(new Error('You will exceed your limit of 25 concurrent Actor runs.'), {
            statusCode: 402,
            type: 'concurrent-runs-limit-exceeded',
        });
        expect(isPaymentRequiredError(runLimitError)).toBe(false);
    });
});

describe('buildPaymentRequiredResponse()', () => {
    it('returns the error message as an error result without structuredContent', () => {
        const message = 'You have exceeded your monthly usage limit.';
        const result = buildPaymentRequiredResponse(Object.assign(new Error(message), { statusCode: 402 }));

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(result.content).toEqual([{ type: 'text', text: message }]);
    });
});

describe('buildPermissionApprovalResponse()', () => {
    const makeError = (approvalUrl?: string) =>
        new ApifyApiError(
            {
                data: {
                    error: {
                        type: 'full-permission-actor-not-approved',
                        message:
                            'This Actor requires full access to your account. You must approve its permissions before running it.',
                        ...(approvalUrl ? { data: { approvalUrl } } : {}),
                    },
                },
                status: 403,
            } as AxiosResponse,
            1,
        );

    it('includes the approval URL when present', () => {
        const approvalUrl = 'https://console.apify.com/actors/abc123?approvePermissions=true';
        const response = buildPermissionApprovalResponse(makeError(approvalUrl));

        expect(response.isError).toBe(true);
        const allText = (response.content ?? []).map(textOf).join('\n');
        expect(allText).toContain('This Actor requires full access to your account');
        expect(allText).toContain(approvalUrl);
    });

    it('omits the URL line when approvalUrl is missing from error.data', () => {
        const response = buildPermissionApprovalResponse(makeError());

        expect(response.isError).toBe(true);
        expect(response.content).toHaveLength(1);
        const firstBlock = (response.content ?? [])[0];
        expect(firstBlock && 'text' in firstBlock ? firstBlock.text : undefined).toContain(
            'This Actor requires full access to your account',
        );
    });
});
