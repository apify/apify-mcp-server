import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../src/const.js';
import {
    buildCallActorDescription,
    buildCallActorErrorResponse,
    buildPermissionApprovalResponse,
    buildStartAsyncResponse,
} from '../../src/tools/core/call_actor_common.js';

describe('call_actor_common', () => {
    describe('buildCallActorDescription', () => {
        it('builds the default description with public helper tools and sync guidance', () => {
            const description = buildCallActorDescription({
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
                alwaysAsync: false,
            });

            expect(description).toContain(`Use ${HelperTools.ACTOR_GET_DETAILS} to get the Actor's input schema`);
            expect(description).toContain(`${HelperTools.STORE_SEARCH} is available in this session, use it to resolve the correct Actor first`);
            expect(description).toContain('When `async: false` or not provided');
            expect(description).not.toContain('always runs asynchronously');
        });

        it('builds the apps description with public search helper and silent-async guidance pointing to the widget sibling', () => {
            const description = buildCallActorDescription({
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
                alwaysAsync: true,
            });

            expect(description).toContain(`Use ${HelperTools.ACTOR_GET_DETAILS} to get the Actor's input schema`);
            expect(description).toContain(`${HelperTools.STORE_SEARCH} is available in this session, use it to resolve the correct Actor first`);
            expect(description).toContain('always runs asynchronously');
            expect(description).toContain('It renders no UI');
            expect(description).toContain(`call ${HelperTools.ACTOR_CALL_WIDGET} instead`);
            expect(description).toContain(`poll ${HelperTools.ACTOR_RUNS_GET} with the runId`);
            expect(description).not.toContain(`Do NOT use ${HelperTools.STORE_SEARCH} for name resolution`);
            expect(description).not.toContain('When `async: false` or not provided');
        });
    });

    describe('buildStartAsyncResponse', () => {
        const actorRun = {
            id: 'run-123',
            status: 'RUNNING',
            startedAt: new Date('2026-01-02T03:04:05.000Z'),
        };

        it('builds the default async response without widget metadata', () => {
            const response = buildStartAsyncResponse({
                actorName: 'apify/rag-web-browser',
                actorRun,
                input: { query: 'latest AI news' },
                widget: false,
            });

            expect(response.content).toEqual([{
                type: 'text',
                text: 'Started Actor "apify/rag-web-browser" (Run ID: run-123).',
            }]);
            expect(response.structuredContent).toEqual({
                runId: 'run-123',
                actorName: 'apify/rag-web-browser',
                status: 'RUNNING',
                startedAt: '2026-01-02T03:04:05.000Z',
                input: { query: 'latest AI news' },
            });
            expect(response._meta).toBeUndefined();
        });

        it('builds the apps async response with widget metadata', () => {
            const response = buildStartAsyncResponse({
                actorName: 'apify/rag-web-browser',
                actorRun,
                input: { query: 'latest AI news' },
                widget: true,
            });

            expect(response.content[0]?.text).toContain('A live progress widget has been rendered');
            expect(response.content[0]?.text).toContain(`use ${HelperTools.ACTOR_OUTPUT_GET} with the datasetId`);
            expect(response.content[0]?.text).toContain(`Do NOT proactively poll using ${HelperTools.ACTOR_RUNS_GET}`);
            expect(response._meta).toBeDefined();
            expect(response._meta?.ui).toEqual(expect.objectContaining({
                resourceUri: 'ui://widget/actor-run.html',
            }));
            expect(response._meta?.['openai/widgetDescription']).toBe('Actor run progress for apify/rag-web-browser');
        });
    });

    describe('buildCallActorErrorResponse', () => {
        it('uses public helper tool names and preserves telemetry fields', () => {
            const error = Object.assign(new Error('Actor not found'), { statusCode: 404 });

            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error,
                actorId: 'actor-123',
                isAsync: false,
                mcpSessionId: 'session-123',
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });

            expect(response.isError).toBe(true);
            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain(`If ${HelperTools.STORE_SEARCH} is available in this session`);
            expect(allText).toContain(`using: ${HelperTools.ACTOR_GET_DETAILS}`);
            expect(response.toolTelemetry).toEqual(expect.objectContaining({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                failureHttpStatus: 404,
                failureDetail: 'Actor not found',
                actorId: 'actor-123',
            }));
        });

        it('returns approval URL for full-permission-actor-not-approved error', () => {
            const approvalUrl = 'https://console.apify.com/actors/abc123?approvePermissions=true';
            const error = new ApifyApiError({
                data: {
                    error: {
                        type: 'full-permission-actor-not-approved',
                        message: 'This Actor requires full access to your account. You must approve its permissions before running it.',
                        data: { approvalUrl },
                    },
                },
                status: 403,
            } as AxiosResponse, 1);

            const response = buildCallActorErrorResponse({
                actorName: 'apify/some-actor',
                error,
                actorId: 'actor-456',
                isAsync: false,
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });

            expect(response.isError).toBe(true);
            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain('This Actor requires full access to your account');
            expect(allText).toContain(approvalUrl);
            expect(response.toolTelemetry).toEqual(expect.objectContaining({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
                failureHttpStatus: 403,
                actorId: 'actor-456',
            }));
        });
    });

    describe('buildPermissionApprovalResponse', () => {
        const makeError = (approvalUrl?: string) => new ApifyApiError({
            data: {
                error: {
                    type: 'full-permission-actor-not-approved',
                    message: 'This Actor requires full access to your account. You must approve its permissions before running it.',
                    ...(approvalUrl ? { data: { approvalUrl } } : {}),
                },
            },
            status: 403,
        } as AxiosResponse, 1);

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

    describe('buildCallActorErrorResponse', () => {
        it('uses public search helper name in apps mode', () => {
            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error: new Error('boom'),
                isAsync: true,
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });

            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain(`If ${HelperTools.STORE_SEARCH} is available in this session`);
            expect(allText).toContain(`using: ${HelperTools.ACTOR_GET_DETAILS}`);
            expect(response.toolTelemetry).toEqual(expect.objectContaining({
                toolStatus: TOOL_STATUS.FAILED,
                failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
                failureDetail: 'boom',
            }));
        });
    });
});
