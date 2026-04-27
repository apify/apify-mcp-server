import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../src/const.js';
import {
    buildCallActorDescription,
    buildCallActorErrorResponse,
    buildStartAsyncResponse,
} from '../../src/tools/core/call_actor_common.js';

describe('call_actor_common', () => {
    describe('buildCallActorDescription', () => {
        it('builds the default description with public helper tools and sync guidance', () => {
            const description = buildCallActorDescription({
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
                storeSearchTool: HelperTools.STORE_SEARCH,
                useInternalSearchWarning: false,
                alwaysAsync: false,
            });

            expect(description).toContain(`Use ${HelperTools.ACTOR_GET_DETAILS} to get the Actor's input schema`);
            expect(description).toContain(`use ${HelperTools.STORE_SEARCH} to resolve the correct Actor first`);
            expect(description).toContain('When `async: false` or not provided');
            expect(description).not.toContain('always runs asynchronously');
            expect(description).not.toContain(`Do NOT use ${HelperTools.STORE_SEARCH} for name resolution`);
        });

        it('builds the apps description with internal search helper and async guidance', () => {
            const description = buildCallActorDescription({
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
                storeSearchTool: HelperTools.STORE_SEARCH_INTERNAL,
                useInternalSearchWarning: true,
                alwaysAsync: true,
            });

            expect(description).toContain(`Use ${HelperTools.ACTOR_GET_DETAILS} to get the Actor's input schema`);
            expect(description).toContain(`use ${HelperTools.STORE_SEARCH_INTERNAL} to resolve the correct Actor first`);
            expect(description).toContain('always runs asynchronously');
            expect(description).toContain('do NOT poll or call any other tool');
            expect(description).toContain(`Do NOT use ${HelperTools.STORE_SEARCH} for name resolution`);
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
                storeSearchTool: HelperTools.STORE_SEARCH,
            });

            expect(response.isError).toBe(true);
            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain(`using the tool: ${HelperTools.STORE_SEARCH}`);
            expect(allText).toContain(`using: ${HelperTools.ACTOR_GET_DETAILS}`);
            expect(response.toolTelemetry).toEqual(expect.objectContaining({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                failureHttpStatus: 404,
                failureDetail: 'Actor not found',
                actorId: 'actor-123',
            }));
        });

        it('uses internal search helper name in apps mode', () => {
            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error: new Error('boom'),
                isAsync: true,
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
                storeSearchTool: HelperTools.STORE_SEARCH_INTERNAL,
            });

            const allText = response.content.map((c) => c.text).join('\n');
            expect(allText).toContain(`using the tool: ${HelperTools.STORE_SEARCH_INTERNAL}`);
            expect(allText).toContain(`using: ${HelperTools.ACTOR_GET_DETAILS}`);
            expect(response.toolTelemetry).toEqual(expect.objectContaining({
                toolStatus: TOOL_STATUS.FAILED,
                failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
                failureDetail: 'boom',
            }));
        });
    });
});
