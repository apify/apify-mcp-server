import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import { APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED, FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../src/const.js';
import {
    buildCallActorAppsDescription,
    buildCallActorDescription,
    buildCallActorErrorResponse,
    buildPermissionApprovalResponse,
    callActorArgs,
} from '../../src/tools/actors/call_actor.js';

describe('call_actor_common', () => {
    describe('buildCallActorDescription', () => {
        it('builds the description with public helper tools and waitSecs guidance', () => {
            const description = buildCallActorDescription();

            expect(description).toContain(`Use ${HelperTools.ACTOR_GET_DETAILS} to get the Actor's input schema`);
            expect(description).toContain(
                `${HelperTools.STORE_SEARCH} is available in this session, use it to resolve the correct Actor first`,
            );
            expect(description).toContain('waitSecs');
            expect(description).toContain(HelperTools.DATASET_GET_ITEMS);
            expect(description).not.toContain('always runs asynchronously');
            expect(description).not.toContain(HelperTools.ACTOR_CALL_WIDGET);
        });
    });

    describe('buildCallActorAppsDescription', () => {
        it('appends widget guidance to the shared description', () => {
            const description = buildCallActorAppsDescription();

            expect(description).toContain(HelperTools.ACTOR_CALL_WIDGET);
            expect(description).toContain(HelperTools.STORE_SEARCH_WIDGET);
            expect(description).toContain('waitSecs');
            expect(description).toContain(HelperTools.DATASET_GET_ITEMS);
        });
    });

    describe('buildCallActorErrorResponse', () => {
        it('uses public helper tool names and preserves telemetry fields', () => {
            const error = Object.assign(new Error('Actor not found'), { statusCode: 404 });

            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error,
                actorId: 'actor-123',
                mcpSessionId: 'session-123',
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });

            expect(response.isError).toBe(true);
            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain(`If ${HelperTools.STORE_SEARCH} is available in this session`);
            expect(allText).toContain(`using: ${HelperTools.ACTOR_GET_DETAILS}`);
            expect(response.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                    failureHttpStatus: 404,
                    failureDetail: 'Actor not found',
                    actorId: 'actor-123',
                }),
            );
        });

        it('returns approval URL for full-permission-actor-not-approved error', () => {
            const approvalUrl = 'https://console.apify.com/actors/abc123?approvePermissions=true';
            const error = new ApifyApiError(
                {
                    data: {
                        error: {
                            type: 'full-permission-actor-not-approved',
                            message:
                                'This Actor requires full access to your account. You must approve its permissions before running it.',
                            data: { approvalUrl },
                        },
                    },
                    status: 403,
                } as AxiosResponse,
                1,
            );

            const response = buildCallActorErrorResponse({
                actorName: 'apify/some-actor',
                error,
                actorId: 'actor-456',
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });

            expect(response.isError).toBe(true);
            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain('This Actor requires full access to your account');
            expect(allText).toContain(approvalUrl);
            expect(response.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
                    failureHttpStatus: 403,
                    actorId: 'actor-456',
                }),
            );
        });

        it('uses public search helper name for generic errors', () => {
            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error: new Error('boom'),
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });

            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain(`If ${HelperTools.STORE_SEARCH} is available in this session`);
            expect(allText).toContain(`using: ${HelperTools.ACTOR_GET_DETAILS}`);
            expect(response.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.FAILED,
                    failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
                    failureDetail: 'boom',
                }),
            );
        });

        it('returns memory-quota recovery hint for HTTP 402 memory-limit errors', () => {
            const error = new ApifyApiError(
                {
                    data: {
                        error: {
                            type: APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED,
                            message:
                                'By launching this job you will exceed the memory limit of 8192MB for all your Actor runs and builds.',
                        },
                    },
                    status: 402,
                } as AxiosResponse,
                1,
            );

            const response = buildCallActorErrorResponse({
                actorName: 'compass/crawler-google-places',
                error,
                actorId: 'actor-789',
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });

            expect(response.isError).toBe(true);
            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain('memory limit of 8192MB');
            expect(allText).toContain('Account memory quota exceeded');
            expect(allText).toContain('callOptions.memory');
            // Regression: must not nudge the LLM toward aborting unrelated runs to free capacity.
            expect(allText).not.toContain(HelperTools.ACTOR_RUNS_ABORT);
            expect(allText).not.toContain('verify the Actor name');
        });

        it('returns the concurrent-run-limit billing hint for cannot-start-actor-runs errors', () => {
            const error = new ApifyApiError(
                {
                    data: {
                        error: {
                            type: 'cannot-start-actor-runs',
                            message:
                                'Cannot start new Actor runs. Underlying error: By launching this job you will exceed your limit of 25 concurrent Actor runs.',
                        },
                    },
                    status: 402,
                } as AxiosResponse,
                1,
            );

            const response = buildCallActorErrorResponse({
                actorName: 'apify/instagram-scraper',
                error,
                actorId: 'actor-999',
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });

            expect(response.isError).toBe(true);
            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain('account limit for concurrent Actor runs');
            expect(allText).toContain('console.apify.com/billing/subscription');
            // Run-limit must not fall through to the generic "verify the Actor name" hint.
            expect(allText).not.toContain('verify the Actor name');
            expect(response.toolTelemetry).toEqual(
                expect.objectContaining({ failureDetail: 'cannot-start-actor-runs', actorId: 'actor-999' }),
            );
        });
    });

    describe('callActorArgs.callOptions', () => {
        const baseArgs = { actor: 'apify/rag-web-browser', input: { query: 'hello' } };

        it.each([
            ['memory', { memory: 1024 }],
            ['timeout', { timeout: 60 }],
            ['build', { build: 'latest' }],
            ['maxItems', { maxItems: 3 }],
            ['maxTotalChargeUsd', { maxTotalChargeUsd: 1.5 }],
            ['memory + build', { memory: 1024, build: 'latest' }],
        ])('accepts %s', (_name, callOptions) => {
            const result = callActorArgs.safeParse({ ...baseArgs, callOptions });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.callOptions).toEqual(callOptions);
            }
        });

        it('rejects negative maxItems', () => {
            const result = callActorArgs.safeParse({
                ...baseArgs,
                callOptions: { maxItems: -1 },
            });
            expect(result.success).toBe(false);
        });
    });

    describe('buildPermissionApprovalResponse', () => {
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
            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain('This Actor requires full access to your account');
            expect(allText).toContain(approvalUrl);
        });

        it('omits the URL line when approvalUrl is missing from error.data', () => {
            const response = buildPermissionApprovalResponse(makeError());

            expect(response.isError).toBe(true);
            expect(response.content).toHaveLength(1);
            expect(response.content[0]?.text).toContain('This Actor requires full access to your account');
        });
    });
});
