import { ApifyApiError } from 'apify-client';
import axios, { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    it.each(['test-token', ''])('redacts nested signing keys with token %j', async (apifyToken) => {
        const recordsPublicUrl = `${BASE_URL}/key-value-stores/kv-1/records?signature=sig-1`;
        requestMock.mockResolvedValue(
            mockResponse(200, {
                data: {
                    recordsPublicUrl,
                    urlSigningSecretKey: 'mock-signing-secret',
                    nested: { urlSigningSecretKey: 'mock-signing-secret', kept: 1 },
                    items: [{ urlSigningSecretKey: '' }],
                    authorization: `Bearer ${apifyToken}`,
                },
            }),
        );
        const context = stubToolCallContext({ path: '/v2/actor-runs/run-1/key-value-store' }, stubClient);
        context.apifyToken = apifyToken;

        const result = (await (apifyApiRead as HelperTool).call(context)) as TextToolResult;

        expect(result.structuredContent).toMatchObject({
            data: {
                data: {
                    recordsPublicUrl,
                    urlSigningSecretKey: '[REDACTED]',
                    nested: { urlSigningSecretKey: '[REDACTED]', kept: 1 },
                    items: [{ urlSigningSecretKey: '[REDACTED]' }],
                    authorization: apifyToken ? 'Bearer [REDACTED]' : 'Bearer ',
                },
            },
        });
        expect(result.content[0].text).toBe(JSON.stringify(result.structuredContent));
        expect(JSON.stringify(result)).not.toContain('mock-signing-secret');
        expect(JSON.stringify(result)).not.toContain('test-token');
    });

    it.each([
        ['objects', (inner: unknown) => ({ a: inner })],
        ['arrays', (inner: unknown) => [inner]],
    ])('redacts the URL signing key in a body of %s nested 3000 levels deep', async (_kind, wrap) => {
        // Under JSON.stringify's limit of about 4000 levels, so the tool still returns this body.
        let body: unknown = { urlSigningSecretKey: 'mock-signing-secret', n: 1 };
        let expected: unknown = { urlSigningSecretKey: '[REDACTED]', n: 1 };
        for (let level = 0; level < 3000; level++) {
            body = wrap(body);
            expected = wrap(expected);
        }
        requestMock.mockResolvedValue(mockResponse(200, body));

        const result = await callTool(apifyApiRead, { path: '/v2/key-value-stores/kv-1/records/DEEP' });

        expect((result.structuredContent as { data: unknown }).data).toEqual(expected);
        expect(result.content[0].text).not.toContain('mock-signing-secret');
    });

    it.each([
        ['a text body', '"urlSigningSecretKey": "abc123"', 'text/plain', '"urlSigningSecretKey": "abc123"'],
        ['a number', 42, 'application/json', 42],
        ['null', null, 'application/json', null],
        ['an array of primitives', [1, 'urlSigningSecretKey'], 'application/json', [1, 'urlSigningSecretKey']],
        ['an empty body', undefined, 'application/json', null],
        ['a null value', { urlSigningSecretKey: null }, 'application/json', { urlSigningSecretKey: null }],
        [
            'a number or object value',
            { urlSigningSecretKey: 1, o: { urlSigningSecretKey: { a: 'b' } } },
            'application/json',
            { urlSigningSecretKey: 1, o: { urlSigningSecretKey: { a: 'b' } } },
        ],
        [
            'the name as a value',
            { note: 'urlSigningSecretKey', fields: ['urlSigningSecretKey'] },
            'application/json',
            { note: 'urlSigningSecretKey', fields: ['urlSigningSecretKey'] },
        ],
    ])('returns %s as it is', async (_kind, body, contentType, expected) => {
        requestMock.mockResolvedValue(mockResponse(200, body, contentType));

        const result = await callTool(apifyApiRead, { path: '/v2/key-value-stores/kv-1/records/NOTE' });

        expect((result.structuredContent as { data: unknown }).data).toEqual(expected);
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
