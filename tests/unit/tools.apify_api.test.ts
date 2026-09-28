import { ApifyApiError } from 'apify-client';
import { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
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
import { apifyApiWrite } from '../../src/tools/api/apify_api_write.js';
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
                    refusedBodyFields: ['isPublic', 'pricingInfos', 'actorPermissionLevel', 'versions'],
                }),
            ],
        });
    });

    it('leaves the refused fields out of the body schema it returns', async () => {
        const result = await callTool(apifyApiDetails, { path: '/v2/actors/abc', method: 'PUT' });

        const [operation] = (result.structuredContent as { operations: { requestBody: { schema: unknown } }[] })
            .operations;
        expect(operation.requestBody.schema).toEqual({
            allOf: [{ type: 'object', properties: {} }],
            properties: { title: { type: 'string' } },
        });
        // The index keeps the full schema.
        expect(INDEX.get('actor_put')?.requestBody?.schema).toMatchObject({
            properties: { isPublic: { type: 'boolean' }, pricingInfos: { type: 'array' } },
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
                `Call it with ${HELPER_TOOLS.API_WRITE} and method POST.`,
        ],
        [
            '/v2/request-queues/q/requests/batch',
            'The path /v2/request-queues/q/requests/batch matches methods POST and DELETE, not GET; this tool ' +
                `sends only GET. Call it with ${HELPER_TOOLS.API_WRITE} and method POST.`,
        ],
        [
            '/v2/actor-runs/run-1/metamorph',
            'matches method POST, not GET; this tool sends only GET. The API tools do not call it. It turns the run',
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

    it('names the write tool for a path without GET only when the session has it', async () => {
        const args = { path: '/v2/actors/john~my-actor/versions/0.1' };
        const withWrite = await callTool(apifyApiRead, args);
        const withoutWrite = await callTool(apifyApiRead, args, [HELPER_TOOLS.API_READ]);

        expect(withWrite.content[0].text).toBe(
            'The path /v2/actors/john~my-actor/versions/0.1 matches methods POST and PUT, not GET; this tool ' +
                `sends only GET. Call it with ${HELPER_TOOLS.API_WRITE} and method POST or PUT.`,
        );
        expect(withoutWrite.content[0].text).not.toContain(HELPER_TOOLS.API_WRITE);
        expect(withoutWrite.content[0].text).toContain('No tool in this session has write access.');
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

describe('apify-api-write', () => {
    const REQUEST_BASE = { params: undefined, maxContentLength: MAX_INLINE_BYTES, signal: expect.any(AbortSignal) };

    it('sends one request with the body serialized as JSON and returns the response', async () => {
        const body = { data: { id: 'abc', name: 'leads-2026' } };
        requestMock.mockResolvedValue(mockResponse(200, body));

        const result = await callTool(apifyApiWrite, {
            path: '/v2/datasets/abc',
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

    it("uses the path's only method when none is given, and sends no body when none is given", async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: { id: 'run-1', status: 'ABORTING' } }));

        await callTool(apifyApiWrite, { path: '/v2/actor-runs/run-1/abort' });

        expect(requestMock).toHaveBeenCalledWith({
            ...REQUEST_BASE,
            url: `${BASE_URL}/actor-runs/run-1/abort`,
            method: 'POST',
        });
    });

    it('sends the body as application/json through the real apify-client axios instance', async () => {
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

        const results = [await call({ name: 'x' }), await call(42), await call([1, 2])];

        expect(results.map((result) => result.structuredContent)).toEqual(
            Array(3).fill(expect.objectContaining({ statusCode: 201, data: { data: {} } })),
        );
        const url = 'https://api.apify.com/v2/key-value-stores/s/records/a%2FK';
        expect(sent).toEqual([
            { url, data: '{"name":"x"}', contentType: 'application/json' },
            { url, data: '42', contentType: 'application/json' },
            { url, data: '[1,2]', contentType: 'application/json' },
        ]);
    });

    it.each([
        [
            { path: '/v2/datasets/abc', body: { name: 'x' } },
            'The path matches methods GET, PUT, and DELETE; specify which one to call the endpoint with.',
        ],
        [
            { path: '/v2/datasets/abc/items', body: [] },
            'The path matches methods GET and POST; specify which one to call the endpoint with.',
        ],
        [
            { path: '/v2/actor-runs/run-1/abort', method: 'PUT' },
            'The path /v2/actor-runs/run-1/abort has no PUT operation; it matches method POST.',
        ],
        [
            { path: '/v2/datasets/abc', method: 'DELETE' },
            'The API tools do not call DELETE /v2/datasets/abc. Deletion cannot be undone',
        ],
        [
            { path: '/v2/users/me/limits', method: 'PUT', body: {} },
            'The API tools do not call PUT /v2/users/me/limits.',
        ],
        [{ path: '/v2/actor-runs/run-1/metamorph' }, 'It turns the run into a run of another Actor'],
        [
            { path: '/v2/datasets/abc', method: 'GET' },
            `GET /v2/datasets/abc has read access; this tool has write access. Call it with ${HELPER_TOOLS.API_READ}.`,
        ],
        [{ path: '/v2/nope', body: {} }, 'No Apify API operation matches the path /v2/nope.'],
        [{ path: '/v2/datasets/../users/me/limits', body: {} }, 'The path cannot have a .. segment.'],
        [{ path: '/v2/datasets/abc', method: 'PUT' }, 'PUT /v2/datasets/{datasetId} needs a request body.'],
        [
            { path: '/v2/datasets/abc', method: 'PUT', body: null },
            'Pass the body of PUT /v2/datasets/{datasetId} as a JSON object or array, not as null.',
        ],
        [
            // A JSON-encoded string would otherwise get past the refused-field check.
            { path: '/v2/actors/john~my-actor', method: 'PUT', body: '{"isPublic":true}' },
            'Pass the body of PUT /v2/actors/{actorId} as a JSON object or array, not as a string.',
        ],
        [
            { path: '/v2/actor-runs/run-1/abort', body: { gracefully: true } },
            'POST /v2/actor-runs/{runId}/abort takes no request body.',
        ],
        [
            { path: '/v2/actors/john~my-actor', method: 'PUT', body: { title: 'T', isPublic: false } },
            'The API tools do not set isPublic, whatever the value',
        ],
        [
            { path: '/v2/actors', method: 'POST', body: { name: 'x', actorPermissionLevel: 'FULL_PERMISSIONS' } },
            'The API tools do not set actorPermissionLevel, whatever the value',
        ],
        [
            { path: '/v2/datasets/abc', method: 'PUT', body: { generalAccess: 'ANYONE_WITH_ID_CAN_READ' } },
            'The API tools do not set generalAccess',
        ],
        [
            {
                path: '/v2/actors/john~my-actor/versions/0.1',
                method: 'PUT',
                body: { envVars: [{ name: 'API_KEY', value: 'x', isSecret: true }] },
            },
            "The API tools do not set envVars: they set an Actor's source, versions, or environment variables, " +
                'which dedicated source tools or Apify Console change. To add or change one environment ' +
                'variable, call POST /v2/actors/{actorId}/versions/{versionNumber}/env-vars or PUT ' +
                '/v2/actors/{actorId}/versions/{versionNumber}/env-vars/{envVarName}; each leaves the other ' +
                'variables as they are. The PUT replaces the whole variable, so send isSecret with it. Without ' +
                'the refused fields the body sets nothing, so do not call again with it.',
        ],
        [
            { path: '/v2/actors/john~my-actor/versions/0.1', method: 'PUT', body: { sourceFiles: [] } },
            'The API tools do not set sourceFiles',
        ],
        [
            { path: '/v2/actors/john~my-actor', method: 'PUT', body: { versions: [] } },
            'The API tools do not set versions',
        ],
        [
            {
                path: '/v2/actors/john~my-actor/versions/0.1',
                method: 'POST',
                body: { buildTag: 'beta', gitHubGistUrl: 'https://gist.github.com/x' },
            },
            'The API tools do not set gitHubGistUrl',
        ],
        [
            {
                path: '/v2/actors/john~my-actor/versions',
                body: { versionNumber: '0.2', envVars: [{ name: 'API_KEY', value: 'x' }] },
            },
            "The API tools do not call POST /v2/actors/john~my-actor/versions. It sets the new version's source",
        ],
        [
            { path: '/v2/actors/john~my-actor/runs', query: { forcePermissionLevel: 'FULL_PERMISSIONS' } },
            'The API tools do not set forcePermissionLevel, whatever the value',
        ],
        [
            { path: '/v2/actors/john~my-actor/runs', query: { waitForFinish: 60 } },
            'call GET /v2/actor-runs/{runId} or GET /v2/actor-builds/{buildId} with waitForFinish; calling this ' +
                'operation again starts another one.',
        ],
    ])('refuses %j without a request', async (args, reason) => {
        const result = await callTool(apifyApiWrite, args);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain(reason);
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('lists every refused field in one refusal and says to call again when the rest of the body sets something', async () => {
        const result = await callTool(apifyApiWrite, {
            path: '/v2/actors/john~my-actor',
            method: 'PUT',
            body: { title: 'T', isPublic: true, versions: [] },
        });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            'The API tools do not set isPublic, whatever the value: publishing, pricing, permission, and sharing ' +
                "changes need a dedicated tool or Apify Console. The API tools do not set versions: they set an Actor's " +
                'source, versions, or environment variables, which dedicated source tools or Apify Console change. ' +
                'Remove the refused fields and call again.',
        );
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('does not name the read tool for a read operation when the session lacks it', async () => {
        const result = await callTool(apifyApiWrite, { path: '/v2/datasets/abc', method: 'GET' }, [
            HELPER_TOOLS.API_WRITE,
        ]);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).not.toContain(HELPER_TOOLS.API_READ);
        expect(result.content[0].text).toContain('No tool in this session has read access.');
    });

    it('uses the only method of a path whose only method is GET, and refuses it as a read', async () => {
        const result = await callTool(apifyApiWrite, { path: '/v2/users/me' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('GET /v2/users/me has read access; this tool has write access.');
    });

    it.each(['PUT', 'POST'])(
        'refuses a %s that replaces an env var without isSecret, which would store it as plain text',
        async (method) => {
            const result = await callTool(apifyApiWrite, {
                path: '/v2/actors/john~my-actor/versions/0.1/env-vars/API_KEY',
                method,
                body: { name: 'API_KEY', value: 'new-value' },
            });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(
                `${method} /v2/actors/{actorId}/versions/{versionNumber}/env-vars/{envVarName} replaces the whole ` +
                    'variable, and the API stores a variable sent without isSecret as plain text. Send isSecret: ' +
                    'true to keep a secret variable secret, or isSecret: false.',
            );
            expect(requestMock).not.toHaveBeenCalled();
        },
    );

    it('sends the single-variable env var operations the envVars refusal points to', async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: { name: 'API_KEY' } }));

        await callTool(apifyApiWrite, {
            path: '/v2/actors/john~my-actor/versions/0.1/env-vars/API_KEY',
            method: 'PUT',
            body: { name: 'API_KEY', value: 'new-value', isSecret: true },
        });
        await callTool(apifyApiWrite, {
            path: '/v2/actors/john~my-actor/versions/0.1/env-vars',
            method: 'POST',
            body: { name: 'REGION', value: 'eu' },
        });

        expect(requestMock.mock.calls.map(([config]) => `${config.method} ${config.url}`)).toEqual([
            `PUT ${BASE_URL}/actors/john~my-actor/versions/0.1/env-vars/API_KEY`,
            `POST ${BASE_URL}/actors/john~my-actor/versions/0.1/env-vars`,
        ]);
        const details = await callTool(apifyApiDetails, {
            path: '/v2/actors/john~my-actor/versions/0.1/env-vars/API_KEY',
            method: 'PUT',
        });
        expect(details.structuredContent).toMatchObject({
            operations: [{ access: 'write', refusedBodyFields: [] }],
        });
    });

    it('sends a version field that does not replace the source, such as buildTag', async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: { versionNumber: '0.1', buildTag: 'beta' } }));

        await callTool(apifyApiWrite, {
            path: '/v2/actors/john~my-actor/versions/0.1',
            method: 'PUT',
            body: { buildTag: 'beta' },
        });

        expect(requestMock).toHaveBeenCalledWith(
            expect.objectContaining({
                url: `${BASE_URL}/actors/john~my-actor/versions/0.1`,
                method: 'PUT',
                data: '{"buildTag":"beta"}',
            }),
        );
    });

    it('sends a refused field name when the body is free-form, such as a stored record', async () => {
        requestMock.mockResolvedValue(mockResponse(201, undefined, ''));

        const result = await callTool(apifyApiWrite, {
            path: '/v2/key-value-stores/store-1/records/CONFIG',
            method: 'PUT',
            body: { isPublic: true },
        });

        expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ data: '{"isPublic":true}' }));
        expect(result.structuredContent).toMatchObject({ statusCode: 201, data: null });
    });

    it('reports a write whose response is over the inline limit as done, not failed', async () => {
        const request = { res: { statusCode: 200 } };
        requestMock.mockRejectedValue(
            new AxiosError(
                `maxContentLength size of ${MAX_INLINE_BYTES} exceeded`,
                'ERR_BAD_RESPONSE',
                undefined,
                request,
            ),
        );

        const result = await callTool(apifyApiWrite, {
            path: '/v2/datasets/abc',
            method: 'PUT',
            body: { name: 'leads-2026' },
        });

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
                'it is not returned; check the result with an operation with read access.',
        );
    });

    it('reports a failed write whose error body is over the inline limit with its status', async () => {
        requestMock.mockRejectedValue(
            new AxiosError(`maxContentLength size of ${MAX_INLINE_BYTES} exceeded`, 'ERR_BAD_RESPONSE', undefined, {
                res: { statusCode: 400 },
            }),
        );

        const result = await callTool(apifyApiWrite, {
            path: '/v2/datasets/abc',
            method: 'PUT',
            body: { name: 'leads-2026' },
        });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            `PUT /v2/datasets/abc failed with HTTP 400. Its error body is larger than ${MAX_INLINE_BYTES} bytes, ` +
                'so it is not returned.',
        );
    });

    it('says the request was sent when an oversize response has no status', async () => {
        requestMock.mockRejectedValue(
            new AxiosError(`maxContentLength size of ${MAX_INLINE_BYTES} exceeded`, 'ERR_BAD_RESPONSE'),
        );

        const result = await callTool(apifyApiWrite, {
            path: '/v2/datasets/abc',
            method: 'PUT',
            body: { name: 'leads-2026' },
        });

        expect(result.content[0].text).toContain('The request itself was sent');
    });

    describe('redactArgs()', () => {
        const { redactArgs } = apifyApiWrite as HelperTool;

        it('shares the read tool redactor, so an undeclared token is redacted too', () => {
            const args = { path: '/v2/datasets/abc', method: 'PUT', query: { token: 'secret' } };

            expect(redactArgs).toBe(redactApiCallArgs);
            expect(JSON.stringify(redactArgs?.(args))).not.toContain('secret');
        });

        it('redacts the body in the logged copy without changing the arguments', () => {
            const path = '/v2/actors/john~my-actor/versions/0.1/env-vars/API_KEY';
            const args = { path, method: 'PUT', body: { value: 'secret' } };

            expect(redactArgs?.(args)).toEqual({ path, method: 'PUT', body: '[REDACTED]' });
            expect(args.body).toEqual({ value: 'secret' });
        });

        it('logs only the declared arguments, so a body under another key is left out', () => {
            const args = { path: '/v2/datasets/abc', requestBody: { value: 'secret' } };

            expect(JSON.stringify(redactArgs?.(args))).not.toContain('secret');
        });

        it('redacts the webhooks query parameter, whose webhooks carry headers', () => {
            const args = {
                path: '/v2/actors/john~my-actor/runs',
                query: { memory: 1024, webhooks: 'W3siaGVhZGVyc1RlbXBsYXRlIjoic2VjcmV0In1d' },
            };

            expect(redactArgs?.(args)).toEqual({
                path: '/v2/actors/john~my-actor/runs',
                query: { memory: 1024, webhooks: '[REDACTED]' },
            });
            expect(args.query.webhooks).not.toBe('[REDACTED]');
        });
    });
});
