import { ApifyApiError } from 'apify-client';
import { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { apifyApiDetails } from '../../src/tools/api/apify_api_details.js';
import { apifyApiRead } from '../../src/tools/api/apify_api_read.js';
import {
    parseApiPath,
    redactApiCallArgs,
    resolvePathOperations,
    validateQueryParams,
} from '../../src/tools/api/apify_api_request.js';
import { apifyApiSearch } from '../../src/tools/api/apify_api_search.js';
import type * as ApifyApiSpecModule from '../../src/tools/api/apify_api_spec.js';
import type { ApiOperation } from '../../src/tools/api/apify_api_spec.js';
import { buildApiOperationIndex } from '../../src/tools/api/apify_api_spec.js';
import {
    apifyApiCallOutputSchema,
    apifyApiDetailsOutputSchema,
    apifyApiSearchOutputSchema,
} from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { API_SPEC_FIXTURE } from './helpers/apify_api_spec_fixture.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
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
    requestMock.mockReset();
});

describe('parseApiPath()', () => {
    it.each([
        ['/v2/datasets/john~my data/items', ['datasets', 'john~my%20data', 'items']],
        ['/v2/datasets/john~my%20data/items', ['datasets', 'john~my%20data', 'items']],
        ['/v2/datasets/john%7Emy-data', ['datasets', 'john~my-data']],
        ['/v2/key-value-stores/store-1/records/a%2Fb', ['key-value-stores', 'store-1', 'records', 'a%2Fb']],
        ['/v2/actor-runs/%3F', ['actor-runs', '%3F']],
    ])('normalizes %s, so a value works encoded or not', (path, segments) => {
        expect(parseApiPath(path)).toEqual({ segments });
    });

    it.each([
        ['/datasets/abc', 'The path must start with /v2/'],
        ['https://api.apify.com/v2/datasets', 'The path must start with /v2/'],
        ['/v2/datasets?limit=1', 'The path cannot hold ? or #. Pass query parameters in query.'],
        ['/v2/datasets#items', 'The path cannot hold ? or #.'],
        ['/v2/datasets/', 'The path /v2/datasets/ has an empty segment.'],
        ['/v2//datasets', 'has an empty segment'],
        ['/v2/datasets/../users/me', 'The path cannot have a .. segment.'],
        ['/v2/datasets/%2E%2E/users/me', 'The path cannot have a .. segment.'],
        ['/v2/datasets/./items', 'The path cannot have a . segment.'],
        ['/v2/datasets/%2e/items', 'The path cannot have a . segment.'],
        ['/v2/datasets/100%', 'The path segment 100% is not valid URL encoding.'],
        ['/v2/datasets/{datasetId}/items', 'Replace {datasetId} in the path with its value.'],
        ['/v2/datasets/%7BdatasetId%7D/items', 'Replace {datasetId} in the path with its value.'],
        ['/v2/datasets/\ud800', 'The path segment \ud800 is not valid URL encoding.'],
    ])('refuses %s', (path, reason) => {
        const result = parseApiPath(path);
        expect('error' in result && result.error).toContain(reason);
    });

    it('takes a template only when asked to, and keeps its placeholders as they are', () => {
        expect(parseApiPath('/v2/datasets/{datasetId}', true)).toEqual({ segments: ['datasets', '{datasetId}'] });
        expect(parseApiPath('/v2/datasets/%7BdatasetId%7D', true)).toEqual({ segments: ['datasets', '{datasetId}'] });
        const withQuery = parseApiPath('/v2/datasets/{datasetId}?limit=1', true);
        expect('error' in withQuery && withQuery.error).toBe('The path cannot hold ? or #. Remove the query.');
    });
});

describe('resolvePathOperations()', () => {
    function resolveIds(path: string): string[] {
        const result = resolvePathOperations({ index: INDEX, path, loadedToolNames: [] });
        return 'error' in result ? [] : result.operations.map((operation) => operation.operationId);
    }

    it('returns every method on the matched template, with the path as it is sent', () => {
        const result = resolvePathOperations({ index: INDEX, path: '/v2/datasets/my data', loadedToolNames: [] });

        expect(result).toEqual({
            path: '/v2/datasets/my%20data',
            operations: [INDEX.get('dataset_get'), INDEX.get('dataset_put'), INDEX.get('dataset_delete')],
        });
    });

    it('matches a literal segment only to itself and prefers the template with more literal segments', () => {
        expect(resolveIds('/v2/users/me')).toEqual(['users_me_get']);
        expect(resolveIds('/v2/users/abc')).toEqual(['user_get']);
        expect(resolveIds('/v2/request-queues/q/requests/batch')).toEqual([
            'requestQueue_requests_batch_post',
            'requestQueue_requests_batch_delete',
        ]);
        expect(resolveIds('/v2/request-queues/q/requests/r-1')).toEqual([
            'requestQueue_request_get',
            'requestQueue_request_put',
            'requestQueue_request_delete',
        ]);
        expect(resolveIds('/v2/actors/abc/runs/last')).toEqual(['actor_runs_last_get']);
        expect(resolveIds('/v2/actors/abc/runs/run-1')).toEqual([]);
    });

    it('matches a concrete path built from each template back to its own operation', () => {
        for (const operation of INDEX.values()) {
            const path = operation.path.replace(/\{[^}]+\}/g, 'value-1');
            const result = resolvePathOperations({ index: INDEX, path, loadedToolNames: [] });

            const { operations } = result as { operations: ApiOperation[] };
            expect(operations).toContainEqual(operation);
            expect(operations.filter((matched) => matched.path !== operation.path)).toEqual([]);
        }
    });

    it('explains username~name on no match and names the search tool only when the session has it', () => {
        const path = '/v2/actors/john/my-actor';
        const withSearch = resolvePathOperations({ index: INDEX, path, loadedToolNames: [HELPER_TOOLS.API_SEARCH] });
        const withoutSearch = resolvePathOperations({ index: INDEX, path, loadedToolNames: [] });

        const message =
            'No Apify API operation matches the path /v2/actors/john/my-actor. Write the path with its values ' +
            'in it; a name is written username~name, as in /v2/actors/john~my-actor.';
        expect(withSearch).toEqual({ error: `${message} Find the path with ${HELPER_TOOLS.API_SEARCH}.` });
        expect(withoutSearch).toEqual({ error: message });
    });

    it('echoes a template as it was written and does not ask a template for its values', () => {
        const result = resolvePathOperations({
            index: INDEX,
            path: '/v2/datasets/{datasetId}/nothing',
            loadedToolNames: [],
            canBeTemplate: true,
        });

        expect(result).toEqual({
            error:
                'No Apify API operation matches the path /v2/datasets/{datasetId}/nothing. A name is written ' +
                'username~name, as in /v2/actors/john~my-actor.',
        });
    });
});

describe('validateQueryParams()', () => {
    it('accepts declared parameters', () => {
        expect(validateQueryParams(INDEX.get('dataset_items_get')!, { format: 'json', limit: 5 })).toBeUndefined();
    });

    it('refuses a parameter the operation does not declare, such as a token', () => {
        expect(validateQueryParams(INDEX.get('dataset_items_get')!, { format: 'json', token: 'secret' })).toBe(
            'GET /v2/datasets/{datasetId}/items does not take the query parameter token. It takes: limit, format.',
        );
    });

    it('refuses a call without a required parameter', () => {
        expect(validateQueryParams(INDEX.get('dataset_items_get')!, { limit: 5 })).toBe(
            'Missing required query parameter format.',
        );
    });

    it('caps waitForFinish below the tool-call timeout, reading it as the API does', () => {
        const actorRunGet = INDEX.get('actorRun_get')!;
        expect(validateQueryParams(actorRunGet, { waitForFinish: 45 })).toBeUndefined();
        expect(validateQueryParams(actorRunGet, { waitForFinish: 60 })).toContain('at most 45 seconds');
        expect(validateQueryParams(actorRunGet, { waitForFinish: '60s' })).toContain('at most 45 seconds');
    });

    it.each([true, 'true', '1', 1])('refuses stream %j, which keeps the log request open', (stream) => {
        expect(validateQueryParams(INDEX.get('actorRun_log_get')!, { stream })).toContain(
            'Call again without stream to get the log so far.',
        );
    });

    it('accepts a false stream', () => {
        expect(validateQueryParams(INDEX.get('actorRun_log_get')!, { stream: false })).toBeUndefined();
    });
});

describe('apify-api-search', () => {
    it('returns the matching operations by method and path, with their access and docs page', async () => {
        const result = await callTool(apifyApiSearch, { query: 'delete dataset', limit: 1 });

        expectSchemaConformingStructuredContent(result, apifyApiSearchOutputSchema);
        expect(result.structuredContent).toEqual({
            operations: [
                {
                    method: 'DELETE',
                    path: '/v2/datasets/{datasetId}',
                    summary: 'Delete dataset',
                    access: 'unavailable',
                    unavailableReason: expect.stringContaining('Deletion cannot be undone'),
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
    it('returns every operation on a real path when no method is given', async () => {
        const result = await callTool(apifyApiDetails, { path: '/v2/datasets/abc' });

        expectSchemaConformingStructuredContent(result, apifyApiDetailsOutputSchema);
        const { operations } = result.structuredContent as { operations: { method: string; path: string }[] };
        expect(operations.map(({ method, path }) => `${method} ${path}`)).toEqual([
            'GET /v2/datasets/{datasetId}',
            'PUT /v2/datasets/{datasetId}',
            'DELETE /v2/datasets/{datasetId}',
        ]);
        expect(result.content[1].text).toBe('/v2/datasets/{datasetId}: GET (read), PUT (write), DELETE (unavailable).');
    });

    it('returns only the operation with the method, for a path template too', async () => {
        const result = await callTool(apifyApiDetails, { path: '/v2/actors/{actorId}', method: 'PUT' });

        expectSchemaConformingStructuredContent(result, apifyApiDetailsOutputSchema);
        expect(result.structuredContent).toEqual({
            operations: [
                expect.objectContaining({
                    method: 'PUT',
                    path: '/v2/actors/{actorId}',
                    access: 'write',
                    parameters: [expect.objectContaining({ name: 'actorId', in: 'path', isRequired: true })],
                    requestBody: expect.objectContaining({ isRequired: false }),
                    refusedBodyFields: ['isPublic', 'pricingInfos', 'actorPermissionLevel'],
                }),
            ],
        });
    });

    it('refuses a method the path does not have and lists the ones it has', async () => {
        const result = await callTool(apifyApiDetails, { path: '/v2/actor-runs/abc/abort', method: 'GET' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            'The path /v2/actor-runs/abc/abort has no GET operation; it matches method POST.',
        );
    });

    it('echoes a template path with its braces in a refusal', async () => {
        const result = await callTool(apifyApiDetails, { path: '/v2/actor-runs/{runId}/abort', method: 'GET' });

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
    });

    it('names the search tool on an unknown path only when the session has it', async () => {
        const withSearch = await callTool(apifyApiDetails, { path: '/v2/nope' });
        const withoutSearch = await callTool(apifyApiDetails, { path: '/v2/nope' }, [HELPER_TOOLS.API_DETAILS]);

        expectSoftFailInvalidInput(withSearch);
        expect(withSearch.content[0].text).toContain(`Find the path with ${HELPER_TOOLS.API_SEARCH}.`);
        expect(withoutSearch.content[0].text).not.toContain(HELPER_TOOLS.API_SEARCH);
    });
});

describe('apify-api-read', () => {
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

    it('sends a value with a space encoded and keeps ~ as it is', async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: {} }));

        const result = await callTool(apifyApiRead, { path: '/v2/datasets/john~my data' });

        expect(requestMock).toHaveBeenCalledWith(
            expect.objectContaining({ url: `${BASE_URL}/datasets/john~my%20data` }),
        );
        expect(result.structuredContent).toMatchObject({ path: '/v2/datasets/john~my%20data' });
    });

    it.each([
        [
            '/v2/actor-runs/run-1/abort',
            'The path /v2/actor-runs/run-1/abort matches method POST, not GET; this tool sends only GET. ' +
                'No tool in this session has write access.',
        ],
        [
            '/v2/actors/abc/run-sync',
            'The API tools do not call GET /v2/actors/abc/run-sync. It waits up to 300 seconds',
        ],
        [
            '/v2/browser-info',
            'The API tools do not call GET /v2/browser-info. It returns the request headers, and with them the API token',
        ],
        ['/v2/nope', 'No Apify API operation matches the path /v2/nope.'],
        ['/v2/datasets/{datasetId}', 'Replace {datasetId} in the path with its value.'],
        ['/v2/datasets/abc?limit=1', 'Pass query parameters in query.'],
    ])('refuses %s without a request', async (path, reason) => {
        const result = await callTool(apifyApiRead, { path });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain(reason);
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('refuses an undeclared query parameter without a request', async () => {
        const result = await callTool(apifyApiRead, { path: '/v2/datasets/abc', query: { token: 'secret' } });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            'GET /v2/datasets/{datasetId} does not take the query parameter token. It takes: none.',
        );
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('throws a non-2xx response as the ApifyApiError apify-client builds', async () => {
        requestMock.mockResolvedValue(
            mockResponse(404, { error: { type: 'record-not-found', message: 'Dataset was not found' } }),
        );

        const call = callTool(apifyApiRead, { path: '/v2/datasets/abc' });

        await expect(call).rejects.toBeInstanceOf(ApifyApiError);
        await expect(call).rejects.toMatchObject({
            statusCode: 404,
            type: 'record-not-found',
            message: 'Dataset was not found',
        });
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
        expect(withoutLogTool.content[0].text).toContain(
            'The operation has no query parameter that narrows it, so the API tools cannot return it.',
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

    it('logs a storage signature, webhooks, or an undeclared token only as redacted', () => {
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

    it('logs a query written into the path only as redacted', () => {
        for (const path of ['/v2/datasets/abc/items?signature=sig-secret', '/v2/datasets/abc?token=token-secret#x']) {
            const logged = redactApiCallArgs({ path });

            expect(logged.path).toBe(`${path.slice(0, path.indexOf('?'))}?[REDACTED]`);
            expect(JSON.stringify(logged)).not.toContain('secret');
        }
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
