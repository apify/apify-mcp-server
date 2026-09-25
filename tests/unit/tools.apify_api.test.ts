import { ApifyApiError } from 'apify-client';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { buildRequestPath, validateQueryParams } from '../../src/tools/api/apify_api_request.js';
import type * as ApifyApiSpecModule from '../../src/tools/api/apify_api_spec.js';
import { buildApiOperationIndex } from '../../src/tools/api/apify_api_spec.js';
import { fetchApifyApiOperation } from '../../src/tools/api/fetch_apify_api_operation.js';
import { readApifyApi } from '../../src/tools/api/read_apify_api.js';
import { searchApifyApi } from '../../src/tools/api/search_apify_api.js';
import { writeApifyApi } from '../../src/tools/api/write_apify_api.js';
import {
    apifyApiCallOutputSchema,
    apifyApiOperationOutputSchema,
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

describe('buildRequestPath()', () => {
    const datasetItems = INDEX.get('dataset_items_get')!;

    it('fills and encodes the path parameters, turning username/name into username~name', () => {
        expect(buildRequestPath(datasetItems, { datasetId: 'john/my data' })).toEqual({
            path: '/v2/datasets/john~my%20data/items',
        });
        expect(buildRequestPath(INDEX.get('webhooks_get')!)).toEqual({ path: '/v2/webhooks' });
    });

    it.each([
        [{}, 'Missing path parameter datasetId'],
        [{ datasetId: '' }, 'Missing path parameter datasetId'],
        [{ datasetId: 'abc', runId: 'x' }, 'has no path parameter runId'],
        [{ datasetId: '..' }, 'cannot be ".."'],
        [{ datasetId: '.' }, 'cannot be "."'],
    ])('refuses %j', (pathParams, reason) => {
        const result = buildRequestPath(datasetItems, pathParams);
        expect('error' in result && result.error).toContain(reason);
    });
});

describe('validateQueryParams()', () => {
    it('accepts declared parameters', () => {
        expect(validateQueryParams(INDEX.get('dataset_items_get')!, { format: 'json', limit: 5 })).toBeUndefined();
    });

    it('refuses a parameter the operation does not declare, such as a token', () => {
        expect(validateQueryParams(INDEX.get('dataset_items_get')!, { format: 'json', token: 'secret' })).toBe(
            'dataset_items_get does not take the query parameter token. It takes: limit, format.',
        );
    });

    it('refuses a call without a required parameter', () => {
        expect(validateQueryParams(INDEX.get('dataset_items_get')!, { limit: 5 })).toBe(
            'Missing required query parameter format.',
        );
    });

    it('caps waitForFinish below the tool-call timeout', () => {
        expect(validateQueryParams(INDEX.get('actorRun_get')!, { waitForFinish: 45 })).toBeUndefined();
        expect(validateQueryParams(INDEX.get('actorRun_get')!, { waitForFinish: 60 })).toContain('at most 45 seconds');
    });
});

describe('search-apify-api', () => {
    it('returns the matching operations with their access', async () => {
        const result = await callTool(searchApifyApi, { query: 'delete dataset', limit: 1 });

        expectSchemaConformingStructuredContent(result, apifyApiSearchOutputSchema);
        expect(result.structuredContent).toEqual({
            operations: [
                {
                    operationId: 'dataset_delete',
                    method: 'DELETE',
                    path: '/v2/datasets/{datasetId}',
                    summary: 'Delete dataset',
                    access: 'unavailable',
                    unavailableReason: expect.stringContaining('Deletion cannot be undone'),
                },
            ],
        });
    });

    it('says so when nothing matches', async () => {
        const result = await callTool(searchApifyApi, { query: 'zebra' });

        expect(result.structuredContent).toEqual({ operations: [] });
        expect(result.content[1].text).toBe('No API operation matches "zebra". Try other keywords.');
    });
});

describe('fetch-apify-api-operation', () => {
    it('returns the parameters, body schema and refused fields', async () => {
        const result = await callTool(fetchApifyApiOperation, { operationId: 'actor_put' });

        expectSchemaConformingStructuredContent(result, apifyApiOperationOutputSchema);
        expect(result.structuredContent).toMatchObject({
            operationId: 'actor_put',
            method: 'PUT',
            path: '/v2/actors/{actorId}',
            access: 'write',
            parameters: [{ name: 'actorId', in: 'path', isRequired: true }],
            requestBody: { isRequired: false },
            refusedBodyFields: ['isPublic', 'pricingInfos', 'actorPermissionLevel'],
        });
    });

    it('names the search tool on an unknown operation only when the session has it', async () => {
        const withSearch = await callTool(fetchApifyApiOperation, { operationId: 'nope' });
        const withoutSearch = await callTool(fetchApifyApiOperation, { operationId: 'nope' }, [
            HELPER_TOOLS.API_OPERATION_FETCH,
        ]);

        expectSoftFailInvalidInput(withSearch);
        expect(withSearch.content[0].text).toBe(
            `API operation nope not found. Find it with ${HELPER_TOOLS.API_SEARCH}.`,
        );
        expect(withoutSearch.content[0].text).toBe('API operation nope not found.');
    });
});

describe('read-apify-api', () => {
    it('sends one GET to the filled-in path and returns the body as the API sends it', async () => {
        const body = { data: { total: 1, items: [{ id: 'abc' }] } };
        requestMock.mockResolvedValue(mockResponse(200, body));

        const result = await callTool(readApifyApi, {
            operationId: 'dataset_items_get',
            pathParams: { datasetId: 'abc' },
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
            operationId: 'dataset_items_get',
            method: 'GET',
            path: '/v2/datasets/abc/items',
            statusCode: 200,
            contentType: 'application/json; charset=utf-8',
            data: body,
        });
        expect(result.content[1].text).toBe('GET /v2/datasets/abc/items returned HTTP 200.');
    });

    it.each([
        ['dataset_put', 'dataset_put is a PUT operation with write access; this tool has read access.'],
        ['actor_runSync_get', 'The API tools do not call actor_runSync_get. It waits up to 300 seconds'],
        ['nope', 'API operation nope not found.'],
    ])('refuses %s without a request', async (operationId, reason) => {
        const result = await callTool(readApifyApi, { operationId, pathParams: { datasetId: 'abc', actorId: 'a' } });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain(reason);
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('names the write tool for a write operation only when the session has it', async () => {
        const args = { operationId: 'dataset_put', pathParams: { datasetId: 'abc' } };
        const withWrite = await callTool(readApifyApi, args);
        const withoutWrite = await callTool(readApifyApi, args, [HELPER_TOOLS.API_READ]);

        expect(withWrite.content[0].text).toContain(`Call it with ${HELPER_TOOLS.API_WRITE}.`);
        expect(withoutWrite.content[0].text).not.toContain(HELPER_TOOLS.API_WRITE);
    });

    it('refuses bad path or query parameters without a request', async () => {
        const badPath = await callTool(readApifyApi, { operationId: 'dataset_get', pathParams: { datasetId: '..' } });
        const badQuery = await callTool(readApifyApi, {
            operationId: 'dataset_get',
            pathParams: { datasetId: 'abc' },
            query: { token: 'secret' },
        });

        expectSoftFailInvalidInput(badPath);
        expectSoftFailInvalidInput(badQuery);
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('throws a non-2xx response as the ApifyApiError apify-client builds', async () => {
        requestMock.mockResolvedValue(
            mockResponse(404, { error: { type: 'record-not-found', message: 'Dataset was not found' } }),
        );

        const call = callTool(readApifyApi, { operationId: 'dataset_get', pathParams: { datasetId: 'abc' } });

        await expect(call).rejects.toBeInstanceOf(ApifyApiError);
        await expect(call).rejects.toMatchObject({
            statusCode: 404,
            type: 'record-not-found',
            message: 'Dataset was not found',
        });
    });

    it('does not return a body over the inline limit', async () => {
        requestMock.mockRejectedValue(
            new AxiosError(`maxContentLength size of ${MAX_INLINE_BYTES} exceeded`, 'ERR_BAD_RESPONSE'),
        );

        const result = await callTool(readApifyApi, {
            operationId: 'dataset_items_get',
            pathParams: { datasetId: 'abc' },
            query: { format: 'json' },
        });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain(`larger than ${MAX_INLINE_BYTES} bytes`);
        expect(result.content[0].text).toContain('limit, offset, or fields');
    });

    it('rethrows any other request failure', async () => {
        requestMock.mockRejectedValue(new AxiosError('socket hang up', 'ECONNRESET'));

        await expect(
            callTool(readApifyApi, { operationId: 'dataset_get', pathParams: { datasetId: 'abc' } }),
        ).rejects.toThrow('socket hang up');
    });

    it('describes a binary body instead of returning it', async () => {
        requestMock.mockResolvedValue(mockResponse(200, Buffer.from([1, 2, 3]), 'application/zip'));

        const result = await callTool(readApifyApi, { operationId: 'dataset_get', pathParams: { datasetId: 'abc' } });

        expectSchemaConformingStructuredContent(result, apifyApiCallOutputSchema);
        expect(result.structuredContent).toMatchObject({ contentType: 'application/zip', data: null });
        expect(result.content[1].text).toBe(
            'GET /v2/datasets/abc returned HTTP 200 with a binary body (application/zip, 3 bytes), which is not shown.',
        );
    });
});

describe('write-apify-api', () => {
    it('sends one request with the JSON body and returns the response', async () => {
        const body = { data: { id: 'abc', name: 'leads-2026' } };
        requestMock.mockResolvedValue(mockResponse(200, body));

        const result = await callTool(writeApifyApi, {
            operationId: 'dataset_put',
            pathParams: { datasetId: 'abc' },
            body: { name: 'leads-2026' },
        });

        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(requestMock).toHaveBeenCalledWith({
            url: `${BASE_URL}/datasets/abc`,
            method: 'PUT',
            params: undefined,
            data: { name: 'leads-2026' },
            maxContentLength: MAX_INLINE_BYTES,
            signal: expect.any(AbortSignal),
        });
        expectSchemaConformingStructuredContent(result, apifyApiCallOutputSchema);
        expect(result.structuredContent).toMatchObject({ method: 'PUT', path: '/v2/datasets/abc', data: body });
    });

    it('sends an operation without a body when none is given', async () => {
        requestMock.mockResolvedValue(mockResponse(200, { data: { id: 'run-1', status: 'ABORTING' } }));

        await callTool(writeApifyApi, { operationId: 'actorRun_abort_post', pathParams: { runId: 'run-1' } });

        expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', data: undefined }));
    });

    it.each([
        [{ operationId: 'dataset_delete', pathParams: { datasetId: 'abc' } }, 'Deletion cannot be undone'],
        [{ operationId: 'users_me_limits_put', body: {} }, 'spending limits'],
        [
            { operationId: 'dataset_get', pathParams: { datasetId: 'abc' } },
            `dataset_get is a GET operation with read access; this tool has write access. Call it with ${HELPER_TOOLS.API_READ}.`,
        ],
        [{ operationId: 'dataset_put', pathParams: { datasetId: 'abc' } }, 'dataset_put needs a request body.'],
        [
            { operationId: 'actorRun_abort_post', pathParams: { runId: 'run-1' }, body: { gracefully: true } },
            'actorRun_abort_post takes no request body.',
        ],
        [
            {
                operationId: 'actor_put',
                pathParams: { actorId: 'john~my-actor' },
                body: { title: 'T', isPublic: false },
            },
            'The API tools do not set isPublic, whatever the value',
        ],
        [
            {
                operationId: 'dataset_put',
                pathParams: { datasetId: 'abc' },
                body: { generalAccess: 'ANYONE_WITH_ID_CAN_READ' },
            },
            'The API tools do not set generalAccess',
        ],
    ])('refuses %j without a request', async (args, reason) => {
        const result = await callTool(writeApifyApi, args);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain(reason);
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('sends a refused field name when the body is free-form, such as a stored record', async () => {
        requestMock.mockResolvedValue(mockResponse(201, undefined, ''));

        const result = await callTool(writeApifyApi, {
            operationId: 'keyValueStore_record_put',
            pathParams: { storeId: 'store-1', recordKey: 'CONFIG' },
            body: { isPublic: true },
        });

        expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ data: { isPublic: true } }));
        expect(result.structuredContent).toMatchObject({ statusCode: 201, data: null });
    });

    it('says the request was sent when the response is over the inline limit', async () => {
        requestMock.mockRejectedValue(
            new AxiosError(`maxContentLength size of ${MAX_INLINE_BYTES} exceeded`, 'ERR_BAD_RESPONSE'),
        );

        const result = await callTool(writeApifyApi, {
            operationId: 'dataset_put',
            pathParams: { datasetId: 'abc' },
            body: { name: 'leads-2026' },
        });

        expect(result.content[0].text).toContain('The request itself was sent');
    });

    describe('redactArgs()', () => {
        const { redactArgs } = writeApifyApi as HelperTool;

        it('redacts the body in the logged copy without changing the arguments', () => {
            const args = { operationId: 'actor_version_envVar_put', body: { value: 'secret' } };

            expect(redactArgs?.(args)).toEqual({ operationId: 'actor_version_envVar_put', body: '[REDACTED]' });
            expect(args.body).toEqual({ value: 'secret' });
        });

        it('leaves arguments without a body as they are', () => {
            const args = { operationId: 'actorRun_abort_post' };

            expect(redactArgs?.(args)).toBe(args);
        });
    });
});
