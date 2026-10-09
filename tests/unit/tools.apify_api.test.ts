import { ApifyApiError } from 'apify-client';
import axios, { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { apifyApiDetails } from '../../src/tools/api/apify_api_details.js';
import { apifyApiRead } from '../../src/tools/api/apify_api_read.js';
import {
    findClosestApiPaths,
    findPathOperations,
    normalizeApiPath,
    redactApiCallArgs,
} from '../../src/tools/api/apify_api_request.js';
import { apifyApiSearch } from '../../src/tools/api/apify_api_search.js';
import type * as ApifyApiSpecModule from '../../src/tools/api/apify_api_spec.js';
import { buildApiOperationIndex, fetchApiOperationIndex } from '../../src/tools/api/apify_api_spec.js';
import { apifyApiWrite } from '../../src/tools/api/apify_api_write.js';
import {
    apifyApiCallOutputSchema,
    apifyApiDetailsOutputSchema,
    apifyApiSearchOutputSchema,
} from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { ALL_TOOLS_PRESENT } from '../../src/types.js';
import { API_SPEC_FIXTURE } from './helpers/apify_api_spec_fixture.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    only,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

vi.mock('../../src/tools/api/apify_api_spec.js', async (importOriginal) => {
    const original = await importOriginal<typeof ApifyApiSpecModule>();
    const { API_SPEC_FIXTURE: spec } = await import('./helpers/apify_api_spec_fixture.js');
    return { ...original, fetchApiOperationIndex: vi.fn(async () => original.buildApiOperationIndex(spec)) };
});

const INDEX = buildApiOperationIndex(API_SPEC_FIXTURE);
const BASE_URL = 'https://api.apify.com/v2';

const requestMock = vi.fn();
const stubClient = {
    baseUrl: BASE_URL,
    httpClient: { axios: { request: requestMock } },
} as unknown as InternalToolArgs['apifyClient'];

function mockResponse(status: number, data: unknown, contentType = 'application/json; charset=utf-8') {
    return {
        status,
        statusText: 'Status',
        data,
        headers: { 'content-type': contentType },
        config: { method: 'get', url: `${BASE_URL}/datasets/abc` },
    };
}

async function callTool(tool: unknown, args: Record<string, unknown>, loadedToolNames?: string[]) {
    const context = stubToolCallContext(args, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (tool as HelperTool).call(context)) as TextToolResult & { toolTelemetry?: ToolTelemetrySnapshot };
}

beforeEach(() => {
    // The tools check every URL against the configured API origin; pin it so the shell's
    // APIFY_API_BASE_URL does not fail the tests.
    vi.stubEnv('APIFY_API_BASE_URL', new URL(BASE_URL).origin);
    requestMock.mockReset();
    vi.mocked(fetchApiOperationIndex).mockClear();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

/** The URL axios sends for the last request, with the query parameters added. */
function readSentUrl(): string {
    const [config] = requestMock.mock.lastCall as [{ url: string; params?: Record<string, unknown> }];
    return axios.getUri({ url: config.url, params: config.params });
}

describe('normalizeApiPath()', () => {
    it.each(['acts', 'v2/acts', '/v2/acts', 'V2/acts'])('takes %s as the CLI does', (path) => {
        expect(normalizeApiPath(path)).toBe('acts');
    });

    it('removes only one leading slash and one prefix', () => {
        expect(normalizeApiPath('//v2/acts')).toBe('/v2/acts');
        expect(normalizeApiPath('/v2/v2/acts')).toBe('v2/acts');
    });
});

describe('findPathOperations()', () => {
    function findIds(path: string): string[] {
        return findPathOperations(INDEX, path).map((operation) => operation.operationId);
    }

    it('returns every method on the matched template, for a path with values or a template', () => {
        const expected = ['dataset_get', 'dataset_put', 'dataset_delete'];
        expect(findIds('datasets/my%20data')).toEqual(expected);
        expect(findIds('datasets/{datasetId}')).toEqual(expected);
        expect(findIds('datasets/abc?limit=1')).toEqual(expected);
    });

    it('matches a literal segment only to itself and prefers the template with more literal segments', () => {
        expect(findIds('users/me')).toEqual(['users_me_get']);
        expect(findIds('users/abc')).toEqual(['user_get']);
        expect(findIds('request-queues/q/requests/batch')).toEqual([
            'requestQueue_requests_batch_post',
            'requestQueue_requests_batch_delete',
        ]);
        expect(findIds('request-queues/q/requests/r-1')).toEqual([
            'requestQueue_request_get',
            'requestQueue_request_put',
            'requestQueue_request_delete',
        ]);
        expect(findIds('actors/abc/runs/last')).toEqual(['actor_runs_last_get']);
        expect(findIds('actors/abc/runs/run-1')).toEqual([]);
        expect(findIds('datasets/')).toEqual([]);
    });

    it('looks up a legacy acts path as the actors path the spec lists', () => {
        expect(findIds('acts/john~my-actor')).toEqual(['actor_get', 'actor_put', 'actor_delete']);
        expect(findIds('acts/abc/runs/last?token=x')).toEqual(findIds('actors/abc/runs/last'));
        expect(findIds('actsx/abc')).toEqual([]);
    });

    it('matches a concrete path built from each template back to its own operation', () => {
        for (const operation of INDEX.values()) {
            const path = normalizeApiPath(operation.path.replace(/\{[^}]+\}/g, 'value-1'));
            const operations = findPathOperations(INDEX, path);

            expect(operations).toContainEqual(operation);
            expect(operations.filter((matched) => matched.path !== operation.path)).toEqual([]);
        }
    });
});

describe('findClosestApiPaths()', () => {
    it('ranks the paths as the CLI does and returns at most five', () => {
        const paths = findClosestApiPaths(INDEX, 'datasets/abc/itemz');

        expect(paths.slice(0, 2)).toEqual(['/v2/datasets/{datasetId}/items', '/v2/datasets/{datasetId}']);
        expect(paths.length).toBeLessThanOrEqual(5);
    });

    it('ranks a legacy acts path as the actors path', () => {
        expect(findClosestApiPaths(INDEX, 'acts/abc/runs/lastt')).toEqual(
            findClosestApiPaths(INDEX, 'actors/abc/runs/lastt'),
        );
    });
});

describe('apify-api-search', () => {
    it('returns the matching operations by method and path, with their docs page', async () => {
        const result = await callTool(apifyApiSearch, { query: 'delete dataset', limit: 1 });

        expectSchemaConformingStructuredContent(result, apifyApiSearchOutputSchema);
        expect(result.structuredContent).toEqual({
            operations: [
                {
                    method: 'DELETE',
                    path: '/v2/datasets/{datasetId}',
                    summary: 'Delete dataset',
                    docsUrl: 'https://docs.apify.com/api/v2/dataset-delete',
                },
            ],
        });
    });

    it('says so when nothing matches', async () => {
        const result = await callTool(apifyApiSearch, { query: 'zebra' });

        expect(result.structuredContent).toEqual({ operations: [] });
        expect(result.content[1].text).toBe('No API operation matches "zebra". Try other keywords.');
    });
});

describe('apify-api-details', () => {
    it.each(['datasets/abc', 'v2/datasets/abc', '/v2/datasets/abc'])(
        'returns every operation on %s when no method is given',
        async (path) => {
            const result = await callTool(apifyApiDetails, { path });

            expectSchemaConformingStructuredContent(result, apifyApiDetailsOutputSchema);
            const { operations } = result.structuredContent as { operations: { method: string; path: string }[] };
            expect(operations.map(({ method, path: template }) => `${method} ${template}`)).toEqual([
                'GET /v2/datasets/{datasetId}',
                'PUT /v2/datasets/{datasetId}',
                'DELETE /v2/datasets/{datasetId}',
            ]);
            expect(result.content[1].text).toBe('/v2/datasets/{datasetId}: GET, PUT, DELETE.');
        },
    );

    it('returns only the operation with the method, for a path template too', async () => {
        const result = await callTool(apifyApiDetails, { path: '/v2/actors/{actorId}', method: 'PUT' });

        expectSchemaConformingStructuredContent(result, apifyApiDetailsOutputSchema);
        expect(result.structuredContent).toEqual({
            operations: [
                {
                    method: 'PUT',
                    path: '/v2/actors/{actorId}',
                    summary: 'Update Actor',
                    description: '',
                    parameters: [expect.objectContaining({ name: 'actorId', in: 'path', isRequired: true })],
                    requestBody: {
                        isRequired: false,
                        schema: { type: 'object', properties: { title: { type: 'string' } } },
                    },
                },
            ],
        });
    });

    it('returns the actors operations for a legacy acts path', async () => {
        const result = await callTool(apifyApiDetails, { path: 'acts/john~my-actor' });

        expect(result.content[1].text).toBe('/v2/actors/{actorId}: GET, PUT, DELETE.');
    });

    it('lists the methods the path has when it has not the one asked for', async () => {
        const result = await callTool(apifyApiDetails, { path: '/v2/actor-runs/{runId}/abort', method: 'GET' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            'The path /v2/actor-runs/{runId}/abort has no GET operation; it matches method POST.',
        );
    });

    it('logs a query written into the path only as redacted', () => {
        expect((apifyApiDetails as HelperTool).redactArgs).toBe(redactApiCallArgs);
        expect(redactApiCallArgs({ path: '/v2/datasets/abc?token=token-secret', method: 'GET' })).toEqual({
            path: '/v2/datasets/abc?[REDACTED]',
            method: 'GET',
            query: undefined,
        });
        for (const path of ['/v2/datasets/abc/items?signature=sig-secret', '/v2/datasets/abc?token=token-secret#x']) {
            const logged = redactApiCallArgs({ path });

            expect(logged.path).toBe(`${path.slice(0, path.indexOf('?'))}?[REDACTED]`);
            expect(JSON.stringify(logged)).not.toContain('secret');
        }
    });

    it('names the search tool on a path not in the spec only when the session has it', async () => {
        const withSearch = await callTool(apifyApiDetails, { path: 'acts/john/my-actor' });
        const withoutSearch = await callTool(apifyApiDetails, { path: 'acts/john/my-actor' }, [
            HELPER_TOOLS.API_DETAILS,
        ]);

        const message =
            'The path /v2/acts/john/my-actor is not in the API spec. A name is written username~name, or ~name ' +
            'for one you own, as in /v2/actors/~my-actor.';
        expectSoftFailInvalidInput(withSearch);
        expect(withSearch.content[0].text).toBe(`${message} Find the path with ${HELPER_TOOLS.API_SEARCH}.`);
        expect(withoutSearch.content[0].text).toBe(message);
    });
});

describe('apify-api-read', () => {
    it('is annotated as not read-only, since a GET can start a run', () => {
        expect(apifyApiRead.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
        });
    });

    it('says a GET can start a paid run and names call-actor only when the session has it', () => {
        const withCallActor = apifyApiRead.buildDescription!(ALL_TOOLS_PRESENT);
        const withoutCallActor = apifyApiRead.buildDescription!(only(HELPER_TOOLS.API_READ));
        const paidRun = 'A GET can start a paid Actor run, as the synchronous run endpoints do.';

        expect(apifyApiRead.description).toBe(withCallActor);
        expect(withCallActor).toContain(`${paidRun} Run an Actor with ${HELPER_TOOLS.ACTOR_CALL}.`);
        expect(withoutCallActor).toContain(paidRun);
        expect(withoutCallActor).not.toContain(HELPER_TOOLS.ACTOR_CALL);
    });

    it('sends one GET to the path and returns the body as the API sends it', async () => {
        const body = { data: { total: 1, items: [{ id: 'abc' }] } };
        requestMock.mockResolvedValue(mockResponse(200, body));

        const result = await callTool(apifyApiRead, {
            path: '/v2/datasets/abc/items',
            query: { format: 'json', limit: 1 },
        });

        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(requestMock).toHaveBeenCalledWith({
            url: `${BASE_URL}/datasets/abc/items`,
            method: 'GET',
            params: { format: 'json', limit: 1 },
            maxContentLength: MAX_INLINE_BYTES,
            signal: expect.any(AbortSignal),
        });
        expectSchemaConformingStructuredContent(result, apifyApiCallOutputSchema);
        expect(result.structuredContent).toEqual({
            method: 'GET',
            path: '/v2/datasets/abc/items',
            statusCode: 200,
            contentType: 'application/json; charset=utf-8',
            data: body,
        });
        expect(result.content[1].text).toBe('GET /v2/datasets/abc/items returned HTTP 200.');
    });

    it.each(['acts', 'v2/acts', '/v2/acts', 'V2/acts'])('sends %s to /v2/acts', async (path) => {
        requestMock.mockResolvedValue(mockResponse(200, { data: {} }));

        const result = await callTool(apifyApiRead, { path });

        expect(readSentUrl()).toBe(`${BASE_URL}/acts`);
        expect(result.structuredContent).toMatchObject({ path: '/v2/acts' });
    });

    it('sends the path as it is written, without encoding it again', async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: {} }));

        await callTool(apifyApiRead, { path: 'key-value-stores/john~store/records/a%2Fb' });

        expect(readSentUrl()).toBe(`${BASE_URL}/key-value-stores/john~store/records/a%2Fb`);
    });

    it('keeps a query string written into the path and adds the query parameters after it', async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: {} }));

        const result = await callTool(apifyApiRead, { path: 'datasets/abc/items?format=json', query: { limit: 1 } });

        expect(readSentUrl()).toBe(`${BASE_URL}/datasets/abc/items?format=json&limit=1`);
        expect(result.structuredContent).toMatchObject({ path: '/v2/datasets/abc/items?format=json' });
    });

    it.each(['https://evil.example/steal', '//evil.example/steal', 'user:pass@evil.example/steal', '\\\\evil.example'])(
        'sends %s to the API host, never to another one',
        async (path) => {
            requestMock.mockResolvedValue(
                mockResponse(404, { error: { type: 'page-not-found', message: 'Not found' } }),
            );

            await callTool(apifyApiRead, { path }).catch(() => undefined);

            expect(new URL(readSentUrl()).origin).toBe(new URL(BASE_URL).origin);
        },
    );

    it.each(['https://example.com/v2', 'https://user:pass@api.apify.com/v2'])(
        'sends nothing when the client base URL %s is not the configured API origin',
        async (baseUrl) => {
            const client = {
                baseUrl,
                httpClient: { axios: { request: requestMock } },
            } as unknown as InternalToolArgs['apifyClient'];

            await expect(
                (apifyApiRead as HelperTool).call(stubToolCallContext({ path: 'datasets/abc' }, client)),
            ).rejects.toThrow(`The URL ${baseUrl}/datasets/abc is not on the API host.`);
            expect(requestMock).not.toHaveBeenCalled();
        },
    );

    it('sends a path the spec does not list, without loading the spec', async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: { ok: true } }));

        const result = await callTool(apifyApiRead, { path: 'not-in-spec/abc' });

        expect(readSentUrl()).toBe(`${BASE_URL}/not-in-spec/abc`);
        expect(result.structuredContent).toMatchObject({ statusCode: 200, data: { data: { ok: true } } });
        expect(fetchApiOperationIndex).not.toHaveBeenCalled();
    });

    it('masks the session token wherever the response echoes it', async () => {
        requestMock.mockResolvedValue(
            mockResponse(200, { data: { headers: { authorization: 'Bearer test-token' }, echo: ['test-token'] } }),
        );

        const result = await callTool(apifyApiRead, { path: 'browser-info' });

        expect(result.structuredContent).toMatchObject({
            data: { data: { headers: { authorization: 'Bearer [REDACTED]' }, echo: ['[REDACTED]'] } },
        });
        expect(JSON.stringify(result)).not.toContain('test-token');
    });

    it('masks the session token in a text body', async () => {
        requestMock.mockResolvedValue(mockResponse(200, 'Authorization: Bearer test-token', 'text/plain'));

        const result = await callTool(apifyApiRead, { path: 'browser-info' });

        expect(result.structuredContent).toMatchObject({ data: 'Authorization: Bearer [REDACTED]' });
        expect(JSON.stringify(result)).not.toContain('test-token');
    });

    it.each([
        ['JSON', { error: { type: 'invalid-input', message: 'Bearer test-token rejected' } }, 'application/json'],
        ['binary', Buffer.from('{"error":{"message":"Bearer test-token rejected"}}'), 'application/octet-stream'],
    ])('masks the session token in a %s error body', async (_kind, body, contentType) => {
        requestMock.mockResolvedValue(mockResponse(400, body, contentType));

        const error = await callTool(apifyApiRead, { path: 'datasets/abc' }).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(ApifyApiError);
        expect(error).toMatchObject({ statusCode: 400, message: 'Bearer [REDACTED] rejected' });
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('test-token');
    });

    it('masks nothing when the session has no token', async () => {
        const body = { data: { headers: { authorization: 'Bearer ' } } };
        requestMock.mockResolvedValue(mockResponse(200, body));
        const context = stubToolCallContext({ path: 'browser-info' }, stubClient);
        context.apifyToken = '';

        const result = (await (apifyApiRead as HelperTool).call(context)) as TextToolResult;

        expect(result.structuredContent).toMatchObject({ data: body });
    });

    it('throws a non-2xx response as the ApifyApiError apify-client builds', async () => {
        requestMock.mockResolvedValue(
            mockResponse(400, { error: { type: 'invalid-input', message: 'Invalid limit' } }),
        );

        const call = callTool(apifyApiRead, { path: '/v2/datasets/abc' });

        await expect(call).rejects.toBeInstanceOf(ApifyApiError);
        await expect(call).rejects.toMatchObject({ statusCode: 400, type: 'invalid-input', message: 'Invalid limit' });
    });

    it('keeps a query written into the path out of the thrown error, whose stack a 5xx logs', async () => {
        requestMock.mockResolvedValue(mockResponse(500, { error: { type: 'internal-error', message: 'Failed' } }));

        const error = await callTool(apifyApiRead, { path: 'datasets/abc?signature=sig-secret' }).catch(
            (thrown: unknown) => thrown,
        );

        expect(error).toMatchObject({ statusCode: 500, path: '/v2/datasets/abc' });
        expect((error as Error).stack).not.toContain('sig-secret');
    });

    it.each([
        ['Page not found.', 'Page not found.'],
        [
            'We have bad news: there is no API endpoint at this URL. Did you specify it correctly?',
            'We have bad news: there is no API endpoint at this URL. Did you specify it correctly?',
        ],
        ['Page not found', 'Page not found.'],
    ])('adds the closest paths of the spec to a page-not-found 404: %s', async (apiMessage, sentence) => {
        requestMock.mockResolvedValue(mockResponse(404, { error: { type: 'page-not-found', message: apiMessage } }));

        const call = callTool(apifyApiRead, { path: 'datasets/abc/itemz' });

        await expect(call).rejects.toBeInstanceOf(ApifyApiError);
        await expect(call).rejects.toMatchObject({
            statusCode: 404,
            type: 'page-not-found',
            message: `${sentence} The closest paths in the API spec: ${findClosestApiPaths(INDEX, 'datasets/abc/itemz').join(', ')}`,
        });
    });

    it.each([
        ['record-not-found', 'actor-runs/abc', 'Actor run was not found.'],
        ['record-or-token-not-found', 'actors/abc', 'Actor was not found.'],
    ])('returns a %s 404 as the API sends it, without loading the spec', async (type, path, message) => {
        requestMock.mockResolvedValue(mockResponse(404, { error: { type, message } }));

        const call = callTool(apifyApiRead, { path });

        await expect(call).rejects.toBeInstanceOf(ApifyApiError);
        await expect(call).rejects.toMatchObject({ statusCode: 404, type, message });
        expect(fetchApiOperationIndex).not.toHaveBeenCalled();
    });

    it('returns the plain 404 when the spec cannot be loaded', async () => {
        vi.mocked(fetchApiOperationIndex).mockRejectedValueOnce(new Error('Failed to load the Apify API operations'));
        requestMock.mockResolvedValue(
            mockResponse(404, { error: { type: 'page-not-found', message: 'Page not found.' } }),
        );

        await expect(callTool(apifyApiRead, { path: 'datasets/abc/itemz' })).rejects.toMatchObject({
            message: 'Page not found.',
        });
    });

    it('does not wait for a stalled spec download for the 404 hint once the call is cancelled', async () => {
        vi.mocked(fetchApiOperationIndex).mockReturnValueOnce(new Promise(() => undefined));
        requestMock.mockResolvedValue(
            mockResponse(404, { error: { type: 'page-not-found', message: 'Page not found.' } }),
        );
        const controller = new AbortController();
        controller.abort();
        const context = stubToolCallContext({ path: 'datasets/abc/itemz' }, stubClient);
        context.signal = controller.signal;

        await expect((apifyApiRead as HelperTool).call(context)).rejects.toMatchObject({ message: 'Page not found.' });
    });

    /** The abort axios throws for a body over `maxContentLength`; Node's request keeps the response status. */
    function buildOversizeError(statusCode: number) {
        return new AxiosError(`maxContentLength size of ${MAX_INLINE_BYTES} exceeded`, 'ERR_BAD_RESPONSE', undefined, {
            res: { statusCode },
        });
    }

    it('does not return a body over the inline limit and names the parameters that narrow it', async () => {
        requestMock.mockRejectedValue(buildOversizeError(200));

        const result = await callTool(apifyApiRead, { path: '/v2/datasets/abc/items', query: { format: 'json' } });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            `The response of GET /v2/datasets/abc/items is larger than ${MAX_INLINE_BYTES} bytes, so it is not ` +
                'returned. Narrow the request with the limit query parameter.',
        );
    });

    it('sends a log over the inline limit to the log tool when the session has it', async () => {
        requestMock.mockRejectedValue(buildOversizeError(200));

        const withLogTool = await callTool(apifyApiRead, { path: '/v2/actor-runs/abc/log' }, [
            HELPER_TOOLS.ACTOR_RUNS_LOG,
        ]);
        const withoutLogTool = await callTool(apifyApiRead, { path: '/v2/actor-runs/abc/log' }, []);

        expect(withLogTool.content[0].text).toContain(
            `Get the end of the log with ${HELPER_TOOLS.ACTOR_RUNS_LOG} instead.`,
        );
        expect(withoutLogTool.content[0].text).toBe(
            `The response of GET /v2/actor-runs/abc/log is larger than ${MAX_INLINE_BYTES} bytes, so it is not ` +
                'returned.',
        );
    });

    it('gives the plain message for a large body when the spec cannot be loaded', async () => {
        vi.mocked(fetchApiOperationIndex).mockRejectedValueOnce(new Error('Failed to load the Apify API operations'));
        requestMock.mockRejectedValue(buildOversizeError(200));

        const result = await callTool(apifyApiRead, { path: 'datasets/abc/items' });

        expect(result.content[0].text).toBe(
            `The response of GET /v2/datasets/abc/items is larger than ${MAX_INLINE_BYTES} bytes, so it is not ` +
                'returned.',
        );
    });

    it('rethrows any other request failure without the request config, which holds the token', async () => {
        const config = { headers: new AxiosHeaders({ Authorization: 'Bearer secret-token' }) };
        requestMock.mockRejectedValue(new AxiosError('socket hang up', 'ECONNRESET', config));

        const error = await callTool(apifyApiRead, { path: '/v2/datasets/abc' }).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(AxiosError);
        expect(error).toMatchObject({ message: 'socket hang up', code: 'ECONNRESET' });
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('secret-token');
    });

    it('returns the empty response for a cancelled call instead of throwing it as a tool error', async () => {
        const controller = new AbortController();
        controller.abort();
        requestMock.mockRejectedValue(new CanceledError());
        const context = stubToolCallContext({ path: '/v2/datasets/abc' }, stubClient);
        context.signal = controller.signal;

        await expect((apifyApiRead as HelperTool).call(context)).resolves.toEqual({});
    });

    it('describes a binary body instead of returning it', async () => {
        requestMock.mockResolvedValue(mockResponse(200, Buffer.from([1, 2, 3]), 'application/zip'));

        const result = await callTool(apifyApiRead, { path: '/v2/datasets/abc' });

        expectSchemaConformingStructuredContent(result, apifyApiCallOutputSchema);
        expect(result.structuredContent).toMatchObject({ contentType: 'application/zip', data: null });
        expect(result.content[1].text).toBe(
            'GET /v2/datasets/abc returned HTTP 200 with a binary body (application/zip, 3 bytes), which is not shown.',
        );
    });

    it('logs a token, a storage signature, or webhooks only as redacted', () => {
        const args = {
            path: '/v2/datasets/abc/items',
            query: { format: 'json', signature: 'sig-secret', webhooks: 'W3t9XQ==', token: 'token-secret' },
        };

        expect((apifyApiRead as HelperTool).redactArgs).toBe(redactApiCallArgs);
        expect(redactApiCallArgs(args)).toEqual({
            path: '/v2/datasets/abc/items',
            query: { format: 'json', signature: '[REDACTED]', webhooks: '[REDACTED]', token: '[REDACTED]' },
        });
        // The tool itself still gets the real values.
        expect(args.query.signature).toBe('sig-secret');
    });

    it('logs only the declared arguments and a body only as redacted', () => {
        const logged = redactApiCallArgs({
            path: '/v2/datasets/abc',
            method: 'PUT',
            body: { value: 'secret' },
            extra: 'secret',
        });

        expect(logged).toEqual({ path: '/v2/datasets/abc', method: 'PUT', query: undefined, body: '[REDACTED]' });
        expect(JSON.stringify(logged)).not.toContain('secret');
    });

    it('logs a query or a path of the wrong type only as redacted', () => {
        for (const args of [
            { path: '/v2/datasets/abc', query: 'signature=sig-secret' },
            { path: '/v2/datasets/abc', query: ['token=token-secret'] },
            { path: ['/v2/datasets/abc?token=token-secret'] },
        ]) {
            const logged = redactApiCallArgs(args);

            expect(JSON.stringify(logged)).not.toContain('secret');
            expect(JSON.stringify(logged)).toContain('[REDACTED]');
        }
    });
});

describe('apify-api-write', () => {
    const REQUEST_BASE = { params: undefined, maxContentLength: MAX_INLINE_BYTES, signal: expect.any(AbortSignal) };

    it('is annotated as destructive and open-world, since it starts runs and creates webhooks to any URL', () => {
        expect(apifyApiWrite.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        });
    });

    it('sends one request with the body serialized as JSON and returns the response', async () => {
        const body = { data: { id: 'abc', name: 'leads-2026' } };
        requestMock.mockResolvedValue(mockResponse(200, body));

        const result = await callTool(apifyApiWrite, {
            path: 'datasets/abc',
            method: 'PUT',
            body: { name: 'leads-2026' },
        });

        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(requestMock).toHaveBeenCalledWith({
            ...REQUEST_BASE,
            url: `${BASE_URL}/datasets/abc`,
            method: 'PUT',
            data: '{"name":"leads-2026"}',
            headers: { 'Content-Type': 'application/json' },
        });
        expectSchemaConformingStructuredContent(result, apifyApiCallOutputSchema);
        expect(result.structuredContent).toMatchObject({ method: 'PUT', path: '/v2/datasets/abc', data: body });
    });

    it('sends any body field the API takes, such as isPublic', async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: {} }));

        await callTool(apifyApiWrite, { path: 'acts/john~my-actor', method: 'PUT', body: { isPublic: true } });

        expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ data: '{"isPublic":true}' }));
    });

    it('sends a DELETE', async () => {
        requestMock.mockResolvedValue(mockResponse(204, undefined, ''));

        const result = await callTool(apifyApiWrite, { path: '/v2/datasets/abc', method: 'DELETE' });

        expect(requestMock).toHaveBeenCalledWith({
            ...REQUEST_BASE,
            url: `${BASE_URL}/datasets/abc`,
            method: 'DELETE',
        });
        expect(result.structuredContent).toMatchObject({ method: 'DELETE', statusCode: 204, data: null });
    });

    it('sends a PATCH', async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: {} }));

        await callTool(apifyApiWrite, { path: 'datasets/abc', method: 'PATCH', body: { name: 'leads' } });

        expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'PATCH' }));
    });

    it.each([
        [
            [HELPER_TOOLS.API_WRITE, HELPER_TOOLS.API_READ],
            `The path has only the GET method, which this tool does not send; call it with ${HELPER_TOOLS.API_READ}.`,
        ],
        [[HELPER_TOOLS.API_WRITE], 'The path has only the GET method, which this tool does not send.'],
    ])('never sends a GET for a path whose only method is GET (session %j)', async (loadedToolNames, message) => {
        const result = await callTool(apifyApiWrite, { path: 'users/me' }, loadedToolNames);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(message);
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('does not need the spec when the method is given, even for a path the spec does not list', async () => {
        requestMock.mockResolvedValue(mockResponse(201, { data: {} }));

        await callTool(apifyApiWrite, { path: 'not-in-spec', method: 'POST', body: {} });

        expect(readSentUrl()).toBe(`${BASE_URL}/not-in-spec`);
        expect(fetchApiOperationIndex).not.toHaveBeenCalled();
    });

    it("uses the path's only method in the spec when none is given, and sends no body when none is given", async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: { id: 'run-1', status: 'ABORTING' } }));

        await callTool(apifyApiWrite, { path: 'actor-runs/run-1/abort' });

        expect(requestMock).toHaveBeenCalledWith({
            ...REQUEST_BASE,
            url: `${BASE_URL}/actor-runs/run-1/abort`,
            method: 'POST',
        });
    });

    it('uses the method of the actors path for a legacy acts path', async () => {
        requestMock.mockResolvedValue(mockResponse(201, { data: {} }));

        await callTool(apifyApiWrite, { path: 'acts/john~my-actor/runs/last/dataset/items', body: [] });

        expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));
        expect(readSentUrl()).toBe(`${BASE_URL}/acts/john~my-actor/runs/last/dataset/items`);
    });

    it('asks for the method when the spec cannot be loaded to choose it', async () => {
        vi.mocked(fetchApiOperationIndex).mockRejectedValueOnce(new Error('Failed to load the Apify API operations'));

        const result = await callTool(apifyApiWrite, { path: 'actor-runs/run-1/abort' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            'The API spec could not be loaded to choose the method; specify the method.',
        );
        expect(requestMock).not.toHaveBeenCalled();
    });

    it.each([
        [
            'request-queues/q/requests/batch',
            'The path matches methods POST and DELETE; specify which one to call the endpoint with.',
        ],
        ['not-in-spec/abc', 'The path is not in the API spec; specify the method.'],
    ])('asks for the method of %s without a request', async (path, message) => {
        const result = await callTool(apifyApiWrite, { path, body: { name: 'x' } });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(message);
        expect(requestMock).not.toHaveBeenCalled();
    });

    it.each([
        [
            'datasets/abc',
            'The path matches methods PUT and DELETE; specify which one to call the endpoint with. This tool ' +
                `does not send its GET; call it with ${HELPER_TOOLS.API_READ}.`,
        ],
        [
            'webhooks',
            'The path matches method POST; specify it to call the endpoint with. This tool does not send its ' +
                `GET; call it with ${HELPER_TOOLS.API_READ}.`,
        ],
    ])('asks only for a write method of %s and sends its GET to the read tool', async (path, message) => {
        const result = await callTool(apifyApiWrite, { path, body: { name: 'x' } }, [
            HELPER_TOOLS.API_WRITE,
            HELPER_TOOLS.API_READ,
        ]);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(message);
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('does not name the read tool for the GET of a path when the session lacks it', async () => {
        const result = await callTool(apifyApiWrite, { path: 'datasets/abc' }, [HELPER_TOOLS.API_WRITE]);

        expect(result.content[0].text).toBe(
            'The path matches methods PUT and DELETE; specify which one to call the endpoint with. This tool ' +
                'does not send its GET.',
        );
    });

    it('sends the body as application/json through the real apify-client axios instance, a string as the value it holds', async () => {
        const client = new ApifyClient({ token: 'test-token', baseUrl: 'https://api.apify.com' });
        const sent: { url?: string; data?: unknown; contentType?: unknown }[] = [];
        client.httpClient.axios.defaults.adapter = async (config) => {
            sent.push({ url: config.url, data: config.data, contentType: config.headers.get('Content-Type') });
            return {
                status: 201,
                statusText: 'Created',
                headers: { 'content-type': 'application/json' },
                data: Buffer.from('{"data":{}}'),
                config,
                request: {},
            };
        };
        const call = async (body: unknown) => {
            const context = stubToolCallContext(
                { path: '/v2/key-value-stores/s/records/a%2FK', method: 'PUT', body },
                client,
            );
            return (await (apifyApiWrite as HelperTool).call(context)) as TextToolResult;
        };

        const results = [
            await call({ name: 'x' }),
            await call(42),
            await call('{"name":"x"}'),
            await call(' [{"key":"a"}] '),
            await call('"text"'),
        ];

        expect(results.map((result) => result.structuredContent)).toEqual(
            Array(5).fill(expect.objectContaining({ statusCode: 201, data: { data: {} } })),
        );
        const url = 'https://api.apify.com/v2/key-value-stores/s/records/a%2FK';
        expect(sent).toEqual([
            { url, data: '{"name":"x"}', contentType: 'application/json' },
            { url, data: '42', contentType: 'application/json' },
            { url, data: '{"name":"x"}', contentType: 'application/json' },
            { url, data: '[{"key":"a"}]', contentType: 'application/json' },
            { url, data: '"text"', contentType: 'application/json' },
        ]);
    });

    it.each(['text', '', '{"name":'])(
        'refuses the string body %j, which is not JSON, without a request',
        async (body) => {
            const result = await callTool(apifyApiWrite, { path: 'datasets/abc', method: 'PUT', body });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(
                'The body is a string that is not valid JSON; give it as a JSON object or array.',
            );
            expect(requestMock).not.toHaveBeenCalled();
        },
    );

    /** The abort axios throws for a body over `maxContentLength`, with the status Node's request keeps. */
    function buildOversizeError(statusCode?: number) {
        return new AxiosError(
            `maxContentLength size of ${MAX_INLINE_BYTES} exceeded`,
            'ERR_BAD_RESPONSE',
            undefined,
            statusCode === undefined ? undefined : { res: { statusCode } },
        );
    }

    it('reports a write whose response is over the inline limit as done, not failed', async () => {
        requestMock.mockRejectedValue(buildOversizeError(200));

        const result = await callTool(apifyApiWrite, { path: 'datasets/abc', method: 'PUT', body: { name: 'x' } });

        expect(result.isError).toBe(false);
        expectSchemaConformingStructuredContent(result, apifyApiCallOutputSchema);
        expect(result.structuredContent).toEqual({
            method: 'PUT',
            path: '/v2/datasets/abc',
            statusCode: 200,
            data: null,
        });
        expect(result.content[1].text).toBe(
            `PUT /v2/datasets/abc returned HTTP 200. The response is larger than ${MAX_INLINE_BYTES} bytes, so ` +
                'it is not returned; check the result with a GET.',
        );
    });

    it.each([
        { statusCode: 400, hint: '' },
        { statusCode: 429, hint: ' Rate limit exceeded, wait before retrying.' },
    ])(
        'reports a failed write whose error body is over the inline limit with its status $statusCode',
        async ({ statusCode, hint }) => {
            requestMock.mockRejectedValue(buildOversizeError(statusCode));

            const result = await callTool(apifyApiWrite, { path: 'datasets/abc', method: 'PUT', body: { name: 'x' } });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(
                `PUT /v2/datasets/abc failed with HTTP ${statusCode}. Its error body is larger than ` +
                    `${MAX_INLINE_BYTES} bytes, so it is not returned.${hint}`,
            );
        },
    );

    it('says the request was sent when an oversize response has no status', async () => {
        requestMock.mockRejectedValue(buildOversizeError());

        const result = await callTool(apifyApiWrite, { path: 'datasets/abc', method: 'PUT', body: { name: 'x' } });

        expect(result.content[0].text).toBe(
            `The response of PUT /v2/datasets/abc is larger than ${MAX_INLINE_BYTES} bytes, so it is not returned. ` +
                'The request itself was sent; check its effect with a GET.',
        );
    });

    describe('redactArgs()', () => {
        const { redactArgs } = apifyApiWrite as HelperTool;

        it('shares the read tool redactor, so a token is redacted too', () => {
            const args = { path: '/v2/datasets/abc', method: 'PUT', query: { token: 'secret' } };

            expect(redactArgs).toBe(redactApiCallArgs);
            expect(JSON.stringify(redactArgs?.(args))).not.toContain('secret');
        });

        it('redacts the body in the logged copy without changing the arguments', () => {
            const path = '/v2/acts/john~my-actor/versions/0.1/env-vars/API_KEY';
            const args = { path, method: 'PUT', body: { value: 'secret' } };

            expect(redactArgs?.(args)).toEqual({ path, method: 'PUT', body: '[REDACTED]' });
            expect(args.body).toEqual({ value: 'secret' });
        });

        it('redacts a body given as a JSON string', () => {
            const args = { path: '/v2/datasets/abc', method: 'PUT', body: '{"value":"secret"}' };

            expect(redactArgs?.(args)).toEqual({ path: '/v2/datasets/abc', method: 'PUT', body: '[REDACTED]' });
        });

        it('logs only the declared arguments, so a body under another key is left out', () => {
            const args = { path: '/v2/datasets/abc', requestBody: { value: 'secret' } };

            expect(JSON.stringify(redactArgs?.(args))).not.toContain('secret');
        });

        it('redacts the webhooks query parameter, whose webhooks carry headers', () => {
            const args = {
                path: '/v2/acts/john~my-actor/runs',
                query: { memory: 1024, webhooks: 'W3siaGVhZGVyc1RlbXBsYXRlIjoic2VjcmV0In1d' },
            };

            expect(redactArgs?.(args)).toEqual({
                path: '/v2/acts/john~my-actor/runs',
                query: { memory: 1024, webhooks: '[REDACTED]' },
            });
            expect(args.query.webhooks).not.toBe('[REDACTED]');
        });
    });
});
