import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED,
    FAILURE_CATEGORY,
    HELPER_TOOLS,
    TOOL_STATUS,
} from '../../src/const.js';
import { ActorLoadError } from '../../src/errors.js';
import * as mcpClient from '../../src/mcp/client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../src/mcp/const.js';
import {
    buildCallActorAppsDescription,
    buildCallActorDescription,
    buildCallActorErrorResponse,
    callActorArgs,
    handleMcpToolCall,
    resolveAndValidateActor,
} from '../../src/tools/actors/call_actor.js';
import type { InternalToolArgs, ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { textOf, type TextToolResult } from './helpers/tool_context.js';

vi.mock('../../src/tools/actors/actor_tools_factory.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../src/tools/actors/actor_tools_factory.js');
    return { ...actual, getActorsAsTools: vi.fn() };
});

const { getActorsAsTools } = await import('../../src/tools/actors/actor_tools_factory.js');

describe('call_actor_common', () => {
    describe('buildCallActorDescription', () => {
        it('builds the description with public helper tools and waitSecs guidance', () => {
            const description = buildCallActorDescription();

            expect(description).toContain(`Use ${HELPER_TOOLS.ACTOR_GET_DETAILS} to get the Actor's input schema`);
            expect(description).toContain(`use ${HELPER_TOOLS.STORE_SEARCH} to resolve the correct Actor first`);
            expect(description).toContain('waitSecs');
            expect(description).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
            expect(description).not.toContain('always runs asynchronously');
            expect(description).not.toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
        });

        // The waitSecs: 0 path (buildStartRunSharedContent) returns id-only storages and never
        // reaches buildRunDataset, so the field-metadata promise must stay tied to waitSecs > 0.
        it('promises dataset field metadata only for a non-zero wait', () => {
            expect(buildCallActorDescription()).toContain('with waitSecs > 0 also reports dataset field metadata');
        });
    });

    describe('buildCallActorAppsDescription', () => {
        it('appends widget guidance to the shared description', () => {
            const description = buildCallActorAppsDescription();

            expect(description).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
            expect(description).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
            expect(description).toContain('waitSecs');
            expect(description).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
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
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS],
            });

            expect(response.isError).toBe(true);
            const allText = (response.content ?? []).map(textOf).join('\n');
            expect(allText).toContain(`search for available Actors using ${HELPER_TOOLS.STORE_SEARCH}`);
            expect(allText).toContain(`get Actor details using ${HELPER_TOOLS.ACTOR_GET_DETAILS}`);
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
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS],
            });

            expect(response.isError).toBe(true);
            const allText = (response.content ?? []).map(textOf).join('\n');
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

        it('forwards the standby payment error message verbatim as a user error', () => {
            const error = ActorLoadError.standbyPaymentNotSupported('apify/rag-web-browser');

            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error,
                actorId: 'actor-standby-payment',
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS],
            });

            expect(response.isError).toBe(true);
            expect((response.content ?? []).map(textOf).join('\n')).toBe(error.message);
            expect(response.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                    failureDetail: error.kind,
                    actorId: 'actor-standby-payment',
                }),
            );
        });

        // Only the two standby kinds take the user-error branch. LOAD_FAILED masks a backend fault,
        // so it must stay on the generic server-error path and keep its INTERNAL_ERROR telemetry.
        it('keeps a LOAD_FAILED Actor load failure on the generic server-error path', () => {
            const error = ActorLoadError.loadFailed('apify/rag-web-browser');

            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error,
                actorId: 'actor-load-failed',
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS],
            });

            expect(response.isError).toBe(true);
            const allText = (response.content ?? []).map(textOf).join('\n');
            expect(allText).toContain(`Failed to call Actor 'apify/rag-web-browser': ${error.message}`);
            expect(allText).not.toBe(error.message);
            expect(response.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.FAILED,
                    failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
                    failureDetail: error.message,
                    actorId: 'actor-load-failed',
                }),
            );
        });

        it('uses public search helper name for generic errors', () => {
            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error: new Error('boom'),
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS],
            });

            const allText = (response.content ?? []).map(textOf).join('\n');
            expect(allText).toContain(`search for available Actors using ${HELPER_TOOLS.STORE_SEARCH}`);
            expect(allText).toContain(`get Actor details using ${HELPER_TOOLS.ACTOR_GET_DETAILS}`);
            expect(response.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.FAILED,
                    failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
                    failureDetail: 'boom',
                }),
            );
        });

        it('omits the recovery hint entirely when neither tool is loaded in this session', () => {
            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error: new Error('boom'),
                loadedToolNames: [],
            });

            const allText = (response.content ?? []).map(textOf).join('\n');
            expect(allText).not.toContain(HELPER_TOOLS.STORE_SEARCH);
            expect(allText).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        });

        it('names only the loaded recovery tool when the session has a partial tool set', () => {
            const response = buildCallActorErrorResponse({
                actorName: 'apify/rag-web-browser',
                error: new Error('boom'),
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH],
            });

            const allText = (response.content ?? []).map(textOf).join('\n');
            expect(allText).toContain(`search for available Actors using ${HELPER_TOOLS.STORE_SEARCH}`);
            expect(allText).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
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
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS],
            });

            expect(response.isError).toBe(true);
            const allText = (response.content ?? []).map(textOf).join('\n');
            expect(allText).toContain('memory limit of 8192MB');
            expect(allText).toContain('Account memory quota exceeded');
            expect(allText).toContain('callOptions.memory');
            // Regression: must not nudge the LLM toward aborting unrelated runs to free capacity.
            expect(allText).not.toContain(HELPER_TOOLS.ACTOR_RUNS_ABORT);
            expect(allText).not.toContain('verify the Actor name');
            // 402 memory-limit derives SOFT_FAIL (4xx) with the memory-limit failureDetail.
            expect(response.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                    failureHttpStatus: 402,
                    failureDetail: APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED,
                    actorId: 'actor-789',
                }),
            );
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
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS],
            });

            expect(response.isError).toBe(true);
            const allText = (response.content ?? []).map(textOf).join('\n');
            expect(allText).toContain('account limit for concurrent Actor runs');
            expect(allText).toContain('console.apify.com/billing/subscription');
            // Run-limit must not fall through to the generic "verify the Actor name" hint.
            expect(allText).not.toContain('verify the Actor name');
            // Run-limit derives SOFT_FAIL even though it arrives as 402/5xx (billing condition).
            expect(response.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                    failureDetail: 'cannot-start-actor-runs',
                    actorId: 'actor-999',
                }),
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

    describe('resolveAndValidateActor', () => {
        const INPUT_SCHEMA = { type: 'object', properties: { query: { type: 'string' } } };
        const stubToolArgs = { apifyClient: {}, mcpSessionId: 'session-1' } as unknown as InternalToolArgs;

        beforeEach(() => {
            vi.mocked(getActorsAsTools).mockReset();
        });

        function mockActorTool(ajvValidate: ((input: unknown) => boolean) & { errors?: unknown }): void {
            const tool = {
                type: TOOL_TYPE.ACTOR,
                name: 'apify--rag-web-browser',
                actorId: 'actor-id-rag',
                actorFullName: 'apify/rag-web-browser',
                inputSchema: INPUT_SCHEMA,
                ajvValidate,
            } as unknown as ToolEntry;
            vi.mocked(getActorsAsTools).mockResolvedValue({ tools: [tool], errors: [] });
        }

        it('returns a SOFT_FAIL/404 not-found error when the Actor is missing', async () => {
            vi.mocked(getActorsAsTools).mockResolvedValue({ tools: [], errors: [] });

            const resolution = await resolveAndValidateActor({
                actorName: 'apify/missing',
                input: { query: 'x' },
                toolArgs: stubToolArgs,
            });

            expect('error' in resolution).toBe(true);
            const { error } = resolution as { error: TextToolResult & { toolTelemetry?: unknown } };
            expect(error.isError).toBe(true);
            expect(error.content[0].text).toContain("Actor 'apify/missing' was not found");
            expect(error.toolTelemetry).toEqual({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                failureHttpStatus: 404,
                failureDetail: "Actor 'apify/missing' was not found",
            });
        });

        // Byte-identity guard for #937: the input-required error embeds the input schema in a
        // ```json fence built via wrapJsonText — the exact bytes of the former hand-rolled fence.
        it('embeds the input schema in an unchanged ```json fence for the input-required error', async () => {
            mockActorTool((() => true) as never);

            const resolution = await resolveAndValidateActor({
                actorName: 'apify/rag-web-browser',
                input: null as unknown as Record<string, unknown>,
                toolArgs: stubToolArgs,
            });

            const { error } = resolution as { error: TextToolResult & { toolTelemetry?: Record<string, unknown> } };
            expect(error.content[2].text).toBe(`\`\`\`json\n${JSON.stringify(INPUT_SCHEMA)}\n\`\`\``);
            expect(error.toolTelemetry).toEqual({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                failureDetail: 'input is required',
                actorId: 'actor-id-rag',
            });
        });

        // Byte-identity guard for #937: the validation-failed error keeps the `Input schema:\n`
        // prefix before the wrapJsonText fence.
        it('embeds the input schema in an unchanged ```json fence for the validation-failed error', async () => {
            const ajvValidate = Object.assign(() => false, {
                errors: [{ message: 'must have required property query' }],
            });
            mockActorTool(ajvValidate as never);

            const resolution = await resolveAndValidateActor({
                actorName: 'apify/rag-web-browser',
                input: { wrong: 1 },
                toolArgs: stubToolArgs,
            });

            const { error } = resolution as { error: TextToolResult & { toolTelemetry?: Record<string, unknown> } };
            expect(error.content[1].text).toBe(`Input schema:\n\`\`\`json\n${JSON.stringify(INPUT_SCHEMA)}\n\`\`\``);
            expect(error.toolTelemetry).toMatchObject({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                actorId: 'actor-id-rag',
            });
        });
    });

    describe('handleMcpToolCall()', () => {
        beforeEach(() => {
            vi.restoreAllMocks();
        });

        it('forwards signal and timeout into client.callTool options', async () => {
            const callTool = vi.fn().mockResolvedValue({
                content: [{ type: 'text', text: 'remote ok' }],
                isError: false,
            });
            vi.spyOn(mcpClient, 'connectMCPClient').mockResolvedValue({
                callTool,
                close: vi.fn().mockResolvedValue(undefined),
            } as unknown as Client);

            const controller = new AbortController();
            const result = await handleMcpToolCall({
                baseActorName: 'apify/mcp-demo',
                mcpToolName: 'search',
                input: { q: 'x' },
                resolution: {
                    toolType: TOOL_TYPE.ACTOR_MCP,
                    mcpServerUrl: 'https://example.invalid/mcp',
                    actorFullName: 'apify/mcp-demo',
                },
                apifyToken: 'token',
                signal: controller.signal,
            });

            expect(result?.isError).not.toBe(true);
            expect(callTool).toHaveBeenCalledTimes(1);
            const options = callTool.mock.calls[0][2] as { signal?: AbortSignal; timeout?: number };
            expect(options.signal).toBe(controller.signal);
            expect(options.timeout).toBe(EXTERNAL_TOOL_CALL_TIMEOUT_MSEC);
        });

        it('returns aborted when the signal is already aborted before the remote call', async () => {
            const connectSpy = vi.spyOn(mcpClient, 'connectMCPClient').mockResolvedValue(null);
            const controller = new AbortController();
            controller.abort();

            const result = await handleMcpToolCall({
                baseActorName: 'apify/mcp-demo',
                mcpToolName: 'search',
                input: { q: 'x' },
                resolution: {
                    toolType: TOOL_TYPE.ACTOR_MCP,
                    mcpServerUrl: 'https://example.invalid/mcp',
                    actorFullName: 'apify/mcp-demo',
                },
                apifyToken: 'token',
                signal: controller.signal,
            });

            expect(result).toEqual({});
            expect(connectSpy).not.toHaveBeenCalled();
        });

        it('returns aborted when the remote call rejects after the signal aborts', async () => {
            const controller = new AbortController();
            vi.spyOn(mcpClient, 'connectMCPClient').mockResolvedValue({
                callTool: vi.fn().mockImplementation(async () => {
                    controller.abort();
                    throw new Error('aborted');
                }),
                close: vi.fn().mockResolvedValue(undefined),
            } as unknown as Client);

            const result = await handleMcpToolCall({
                baseActorName: 'apify/mcp-demo',
                mcpToolName: 'search',
                input: { q: 'x' },
                resolution: {
                    toolType: TOOL_TYPE.ACTOR_MCP,
                    mcpServerUrl: 'https://example.invalid/mcp',
                    actorFullName: 'apify/mcp-demo',
                },
                apifyToken: 'token',
                signal: controller.signal,
            });

            expect(result).toEqual({});
        });
    });
});
