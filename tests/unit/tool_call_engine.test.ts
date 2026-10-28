import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import type { InvalidToolCall, PreparedCall } from '../../src/mcp/tool_call_engine.js';
import {
    buildPreflightFailureOutcome,
    classifyToolCallError,
    executeSyncToolCall,
    prepareToolCall,
} from '../../src/mcp/tool_call_engine.js';
import { fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { sendServerActorRequest } from '../../src/tools/actors/send_server_actor_request.js';
import {
    REPORT_PROBLEM_INVALID_INPUT_NUDGE,
    REPORT_PROBLEM_NUDGE,
    reportProblem,
} from '../../src/tools/dev/report_problem.js';
import { getActorRunList } from '../../src/tools/runs/get_actor_run_list.js';
import type { ToolCallTelemetryProperties, ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { respondRaw, respondUserError } from '../../src/utils/mcp.js';
import { makePaymentRequiredError, makeRecorderTool, makeThrowingTool, withServer } from './helpers/mcp_server.js';

/** An abort signal for direct engine tests, optionally already aborted. */
function makeSignal(aborted = false): AbortSignal {
    const controller = new AbortController();
    if (aborted) controller.abort();
    return controller.signal;
}

/** Server-derived plain values that `prepareToolCall` reads. */
function prepareFields(server: ActorsMcpServer) {
    return {
        tools: server.tools,
        paymentProvider: server.options.paymentProvider,
        allowUnauthMode: server.options.allowUnauthMode,
    };
}

/** Suppresses expected failure logs. */
function silenceLogs(): void {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    vi.spyOn(log, 'exception').mockImplementation(() => log);
    vi.spyOn(log, 'softFail').mockImplementation(() => log);
    vi.spyOn(log, 'warning').mockImplementation(() => log);
}

describe('prepareToolCall()', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns InvalidToolCall with AUTH category when no token is provided', async () => {
        await withServer(async (server) => {
            const telemetryData = {} as ToolCallTelemetryProperties;
            const result = await prepareToolCall({
                ...prepareFields(server),
                apifyToken: '',
                name: 'anything',
                args: {},
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData,
                clientContext: undefined,
            });
            expect('message' in result).toBe(true);
            const invalid = result as InvalidToolCall;
            expect(invalid.toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
            expect(invalid.callDiagnostics.failure_category).toBe(FAILURE_CATEGORY.AUTH);
            expect(invalid.message).toContain('Apify API token is required');
            expect(telemetryData.trace_id).toBe('s1');
        });
    });

    it('returns InvalidToolCall for an unknown tool name', async () => {
        await withServer(async (server) => {
            const telemetryData = {} as ToolCallTelemetryProperties;
            const result = await prepareToolCall({
                ...prepareFields(server),
                apifyToken: 'fake-token',
                name: 'does-not-exist',
                args: {},
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData,
                clientContext: undefined,
            });
            expect('message' in result).toBe(true);
            const invalid = result as InvalidToolCall;
            expect(invalid.callDiagnostics.failure_category).toBe(FAILURE_CATEGORY.INVALID_INPUT);
            expect(invalid.message).toContain('was not found');
            expect(telemetryData.trace_id).toBe('s1');
        });
    });

    it('returns InvalidToolCall for missing arguments', async () => {
        await withServer(async (server) => {
            const { tool } = makeRecorderTool('recorder-tool');
            server.upsertTools([tool]);
            const result = await prepareToolCall({
                ...prepareFields(server),
                apifyToken: 'fake-token',
                name: 'recorder-tool',
                args: undefined,
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData: null,
                clientContext: undefined,
            });
            expect('message' in result).toBe(true);
            const invalid = result as InvalidToolCall;
            expect(invalid.message).toContain('Missing arguments');
        });
    });

    it('returns a PreparedCall and updates telemetry tool_name for a valid call', async () => {
        await withServer(async (server) => {
            const { tool } = makeRecorderTool('recorder-tool');
            server.upsertTools([tool]);
            const telemetryData = { tool_name: 'recorder-tool' } as unknown as ToolCallTelemetryProperties;
            const result = await prepareToolCall({
                ...prepareFields(server),
                apifyToken: 'fake-token',
                name: 'recorder-tool',
                args: {},
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData,
                clientContext: undefined,
            });
            expect('message' in result).toBe(false);
            const prepared = result as PreparedCall;
            expect(prepared.tool.name).toBe('recorder-tool');
            expect(prepared.standbyRejection).toBeNull();
            expect(prepared.paymentRequiredResult).toBeUndefined();
            expect(telemetryData.tool_name).toBe('recorder-tool');
        });
    });

    it('carries the trace id on the client and in telemetry only when telemetry is on', async () => {
        await withServer(async (server) => {
            const { tool } = makeRecorderTool('recorder-tool');
            server.upsertTools([tool]);
            const call = (telemetryData: ToolCallTelemetryProperties | null) =>
                prepareToolCall({
                    ...prepareFields(server),
                    apifyToken: 'fake-token',
                    name: 'recorder-tool',
                    args: {},
                    meta: { 'com.apify/traceId': 'thread-1', 'com.apify/useCase': 'find a scraper' },
                    requestHeaders: undefined,
                    isTaskRequest: false,
                    mcpSessionId: 's1',
                    telemetryData,
                    clientContext: {
                        protocolVersion: '2025-06-18',
                        clientInfo: { name: 'apify-ai', version: '1' },
                        capabilities: {},
                    },
                }) as Promise<PreparedCall>;

            const telemetryData = { tool_name: 'recorder-tool' } as unknown as ToolCallTelemetryProperties;
            const tracked = await call(telemetryData);
            expect(tracked.apifyClient.storeSearchTracking).toEqual({ traceId: 'thread-1' });
            expect(telemetryData.trace_id).toBe('thread-1');
            expect(JSON.stringify(telemetryData)).not.toContain('find a scraper');

            const untracked = await call(null);
            expect(untracked.apifyClient.storeSearchTracking).toBeUndefined();
        });
    });

    describe('argument failure hint', () => {
        const STRICT_SCHEMA = {
            type: 'object',
            properties: { query: { type: 'string', minLength: 1 } },
            required: ['query'],
        };

        function makeStrictTool(type: typeof TOOL_TYPE.INTERNAL | typeof TOOL_TYPE.ACTOR): ToolEntry {
            const base = {
                name: 'strict-tool',
                description: 'requires a non-empty query',
                inputSchema: STRICT_SCHEMA as ToolInputSchema,
                ajvValidate: compileSchema(STRICT_SCHEMA),
            };
            return type === TOOL_TYPE.ACTOR
                ? { ...base, type, actorId: 'actor-id-1', actorFullName: 'apify/strict-actor' }
                : { ...base, type, call: async () => respondRaw({ content: [] }) };
        }

        // The map is built per case, so each one controls exactly whether fetch-actor-details is served.
        async function failureMessage(
            tool: ToolEntry,
            fetchActorDetailsServed: boolean,
            args: Record<string, unknown> | undefined,
        ): Promise<string> {
            const tools = new Map<string, ToolEntry>([[tool.name, tool]]);
            if (fetchActorDetailsServed) tools.set(HELPER_TOOLS.ACTOR_GET_DETAILS, fetchActorDetails);
            const result = await prepareToolCall({
                tools,
                apifyToken: 'fake-token',
                name: tool.name,
                args,
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData: null,
                clientContext: undefined,
            });
            expect('message' in result).toBe(true);
            return (result as InvalidToolCall).message;
        }

        it('points a non-Actor tool with missing arguments at its tools/list schema, not fetch-actor-details', async () => {
            const message = await failureMessage(makeStrictTool(TOOL_TYPE.INTERNAL), true, undefined);

            expect(message).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
            expect(message).toContain('tools/list');
        });

        it('gives a non-Actor tool with invalid arguments no schema pointer', async () => {
            const message = await failureMessage(makeStrictTool(TOOL_TYPE.INTERNAL), true, { query: '' });

            expect(message).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
            expect(message).not.toContain('tools/list');
        });

        describe.each([
            ['invalid', { query: '' }],
            ['missing', undefined],
        ])('%s arguments', (_label, args) => {
            it('points an Actor tool at fetch-actor-details when the session serves it', async () => {
                const message = await failureMessage(makeStrictTool(TOOL_TYPE.ACTOR), true, args);

                expect(message).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
            });

            it('points an Actor tool at tools/list when fetch-actor-details is not served', async () => {
                const message = await failureMessage(makeStrictTool(TOOL_TYPE.ACTOR), false, args);

                expect(message).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
                expect(message).toContain('tools/list');
            });
        });
    });

    describe('argument failure names what was received and what the parameter takes', () => {
        const SCHEMA = {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path on the Actor Server, starting with /.' },
                query: { type: 'object', description: 'Query parameters, by name, for example {"limit": 10}.' },
                tags: { type: 'array', items: { type: 'string', description: 'One tag, such as "news".' } },
            },
            required: ['path'],
        };
        const tool: ToolEntry = {
            type: TOOL_TYPE.INTERNAL,
            name: 'send-server-actor-request',
            description: 'sends one request',
            inputSchema: SCHEMA as ToolInputSchema,
            ajvValidate: compileSchema(SCHEMA),
            call: async () => respondRaw({ content: [] }),
        };

        async function failureMessage(args: Record<string, unknown>, selectedTool: ToolEntry = tool): Promise<string> {
            const result = await prepareToolCall({
                tools: new Map([[selectedTool.name, selectedTool]]),
                apifyToken: 'fake-token',
                name: selectedTool.name,
                args,
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData: null,
                clientContext: undefined,
            });
            return (result as InvalidToolCall).message;
        }

        it('lists the allowed values for an invalid enum', async () => {
            const message = await failureMessage({ status: 'SUCCESS' }, getActorRunList);

            expect(message).toContain('/status: must be equal to one of the allowed values');
            expect(message).toContain('"SUCCEEDED"');
            expect(message).toContain('"FAILED"');
        });

        it('uses the parent description for an invalid query value', async () => {
            const message = await failureMessage(
                { actor: 'apify/web-search', method: 'GET', path: '/', query: { limit: {} } },
                sendServerActorRequest,
            );

            expect(message).toContain('/query/limit: must be string, got object');
            expect(message).toContain('Parameter /query: Query parameters, by name');
        });

        it('reports the received type and the description for a wrong type', async () => {
            const message = await failureMessage({ path: '/', query: '{"ai"}' });

            expect(message).toContain('/query: must be object, got string');
            expect(message).toContain('Parameter /query: Query parameters, by name');
        });

        it('reports the description of a missing required parameter', async () => {
            const message = await failureMessage({ query: {} });

            expect(message).toContain("must have required property 'path'");
            expect(message).toContain('Parameter /path: The path on the Actor Server');
        });

        it('reports the description of an array item', async () => {
            // An object, since the shared validator coerces a number to a string.
            const message = await failureMessage({ path: '/', tags: [{}] });

            expect(message).toContain('/tags/0: must be string, got object');
            expect(message).toContain('Parameter /tags/0: One tag');
        });
    });
});

describe('executeSyncToolCall()', () => {
    afterEach(() => vi.restoreAllMocks());

    async function prepare(server: ActorsMcpServer, name: string, tool: unknown) {
        server.upsertTools([tool as never]);
        const prepared = (await prepareToolCall({
            ...prepareFields(server),
            apifyToken: 'fake-token',
            name,
            args: {},
            meta: undefined,
            requestHeaders: undefined,
            isTaskRequest: false,
            mcpSessionId: 's1',
            telemetryData: null,
            clientContext: undefined,
        })) as PreparedCall;
        return prepared;
    }

    /** Server-derived plain values that `executeSyncToolCall` reads. */
    function syncParams(server: ActorsMcpServer, toolName: string, aborted = false) {
        return {
            apifyToken: 'fake-token',
            toolName,
            mcpSessionId: 's1',
            progressToken: undefined,
            tools: server.tools,
            actorStore: server.actorStore,
            paymentProvider: server.options.paymentProvider,
            signal: makeSignal(aborted),
            sendNotification: vi.fn(),
            emitLog: vi.fn(),
        };
    }

    it('returns a success outcome for a normal dispatch', async () => {
        await withServer(async (server) => {
            const { tool } = makeRecorderTool('recorder-tool');
            const prepared = await prepare(server, 'recorder-tool', tool);
            const outcome = await executeSyncToolCall(prepared, syncParams(server, 'recorder-tool'));
            expect(outcome.toolStatus).toBe(TOOL_STATUS.SUCCEEDED);
            expect((outcome.result.content as { text: string }[])[0].text).toBe('ok');
        });
    });

    it('classifies a 402 dispatch error as a payment outcome', async () => {
        await withServer(async (server) => {
            silenceLogs();
            const tool = makeThrowingTool({ name: 'payment-throwing-tool', error: makePaymentRequiredError() });
            const prepared = await prepare(server, 'payment-throwing-tool', tool);
            const outcome = await executeSyncToolCall(prepared, syncParams(server, 'payment-throwing-tool'));
            expect(outcome.toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
            expect(outcome.callDiagnostics.failure_http_status).toBe(402);
            expect(outcome.result.isError).toBe(true);
        });
    });

    it('reports ABORTED status when the signal is aborted', async () => {
        await withServer(async (server) => {
            silenceLogs();
            const tool = makeThrowingTool({ name: 'aborting-tool', error: new Error('boom') });
            const prepared = await prepare(server, 'aborting-tool', tool);
            const outcome = await executeSyncToolCall(prepared, syncParams(server, 'aborting-tool', true));
            expect(outcome.toolStatus).toBe(TOOL_STATUS.ABORTED);
            expect(outcome.result.isError).toBe(true);
            expect(outcome.result.toolTelemetry).toEqual({ toolStatus: TOOL_STATUS.ABORTED });
        });
    });
});

describe('classifyToolCallError()', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        ['an internal failure gets the general sentence', new Error('boom'), REPORT_PROBLEM_NUDGE],
        [
            'a 4xx failure gets the friction sentence',
            Object.assign(new Error('Not found'), { statusCode: 404 }),
            REPORT_PROBLEM_INVALID_INPUT_NUDGE,
        ],
    ])('appends one report-problem sentence to an execution error: %s', (_label, error, sentence) => {
        silenceLogs();
        const outcome = classifyToolCallError(error, {
            tools: new Map<string, ToolEntry>([[HELPER_TOOLS.PROBLEM_REPORT, reportProblem]]),
            toolName: 'some-tool',
            failingToolName: 'some-tool',
            actorName: undefined,
            actorId: undefined,
            isAborted: false,
            mcpSessionId: 's1',
        });
        const texts = (outcome.result.content as { text: string }[]).map((c) => c.text);
        expect(texts).toHaveLength(2);
        expect(texts[1]).toBe(sentence);
    });
});

describe('standby rejection outcome', () => {
    it('keeps the internal telemetry off the wire and records its failure detail', () => {
        const outcome = buildPreflightFailureOutcome(
            respondUserError('Actor apify/example-mcp-server is not supported in agentic payment mode.', {
                detail: 'standby-payment-not-supported',
            }),
            undefined,
            'apify/example-mcp-server',
            undefined,
        );

        expect(outcome.result).not.toHaveProperty('toolTelemetry');
        expect(outcome.callDiagnostics).toEqual({
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            failure_detail: 'standby-payment-not-supported',
            actor_name: 'apify/example-mcp-server',
        });
    });
});
