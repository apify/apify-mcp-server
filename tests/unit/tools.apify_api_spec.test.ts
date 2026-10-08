import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import type { ApiBlockRule } from '../../src/tools/api/apify_api_blocklist.js';
import {
    APIFY_API_OPENAPI_URL,
    buildApiOperationIndex,
    searchApiOperations,
} from '../../src/tools/api/apify_api_spec.js';
import { API_SPEC_FIXTURE } from './helpers/apify_api_spec_fixture.js';

describe('buildApiOperationIndex()', () => {
    const index = buildApiOperationIndex(API_SPEC_FIXTURE);

    it('leaves out deprecated operations, HEAD operations, paths outside /v2/ and entries without an ID', () => {
        expect(index.has('actors_run_get')).toBe(false);
        expect(index.has('dataset_items_head')).toBe(false);
        expect(index.has('outside_get')).toBe(false);
        expect([...index.values()].every((operation) => operation.operationId)).toBe(true);
        expect(index.size).toBe(38);
    });

    it('leaves out the operations a rule names', () => {
        const rules: ApiBlockRule[] = [
            { operation: { methods: ['GET'], path: '/v2/datasets/{datasetId}' }, reason: 'No.' },
            { operation: { methods: ['DELETE'], path: '/v2/actors/{actorId}' }, reason: 'No.' },
            // A literal segment matches only itself, not a parameter of the spec.
            { operation: { methods: ['GET'], path: '/v2/users/me' }, reason: 'No.' },
        ];

        const blockedIndex = buildApiOperationIndex(API_SPEC_FIXTURE, rules);

        expect([...index.keys()].filter((operationId) => !blockedIndex.has(operationId))).toEqual([
            'dataset_get',
            'actor_delete',
            'users_me_get',
        ]);
    });

    it('drops a query parameter only from the operations of the tools its rule names', () => {
        const rules: ApiBlockRule[] = [
            { queryParam: 'limit', toolNames: [HELPER_TOOLS.API_WRITE], reason: 'Refused.' },
        ];
        const parameters = [{ name: 'limit', in: 'query' }];
        const spec = {
            paths: {
                '/v2/things': {
                    get: { operationId: 'things_get', parameters },
                    post: { operationId: 'things_post', parameters },
                },
            },
        };

        const thingIndex = buildApiOperationIndex(spec, rules);

        expect(thingIndex.get('things_get')?.parameters.map(({ name }) => name)).toEqual(['limit']);
        expect(thingIndex.get('things_post')?.parameters).toEqual([]);
    });

    it('indexes a PATCH operation, which the published spec does not have yet', () => {
        const spec = {
            paths: { '/v2/things/{thingId}': { patch: { operationId: 'thing_patch', summary: 'Patch thing' } } },
        };

        expect(buildApiOperationIndex(spec).get('thing_patch')?.method).toBe('PATCH');
    });

    it('resolves parameter references and keeps only path and query parameters', () => {
        expect(index.get('dataset_items_get')?.parameters).toEqual([
            {
                name: 'datasetId',
                in: 'path',
                isRequired: true,
                description: 'Dataset ID or username~dataset-name.',
                schema: { type: 'string' },
            },
            { name: 'limit', in: 'query', isRequired: false, schema: { type: 'integer' } },
            { name: 'format', in: 'query', isRequired: true, schema: { type: 'string' } },
        ]);
    });

    it('resolves the body schema, dropping examples but keeping a property named example', () => {
        const body = index.get('dataset_put')?.requestBody;
        expect(body?.isRequired).toBe(true);
        expect(body?.schema).toEqual(API_SPEC_FIXTURE.components.schemas.UpdateDatasetRequest);
        expect(index.get('keyValueStore_record_put')?.requestBody).toEqual({
            isRequired: true,
            schema: { type: 'object', additionalProperties: true },
        });
        expect(index.get('actorRun_abort_post')?.requestBody).toBeUndefined();
    });

    it('links each operation to its page in the API reference, at the operation ID in kebab case', () => {
        expect(index.get('actorRun_abort_post')?.docsUrl).toBe('https://docs.apify.com/api/v2/actor-run-abort-post');
        expect(index.get('keyValueStore_record_put')?.docsUrl).toBe(
            'https://docs.apify.com/api/v2/key-value-store-record-put',
        );
    });

    it('throws for a document without /v2/ operations', () => {
        expect(() => buildApiOperationIndex({})).toThrow('the spec lists no /v2/ operations.');
        expect(() => buildApiOperationIndex('not a spec')).toThrow('the spec lists no /v2/ operations.');
    });
});

describe('searchApiOperations()', () => {
    const index = buildApiOperationIndex(API_SPEC_FIXTURE);

    it('ranks summary matches first and breaks ties by the shorter path', () => {
        const ids = searchApiOperations(index, 'update dataset', 10).map((operation) => operation.operationId);
        expect(ids.slice(0, 2)).toEqual(['dataset_put', 'actorRun_dataset_put']);
    });

    function searchIds(query: string): string[] {
        return searchApiOperations(index, query, 10).map((operation) => operation.operationId);
    }

    it('matches word prefixes and ignores stop words', () => {
        // Without the stop words, "with" would also match "Run Actor synchronously without input".
        expect(searchIds('webhook with')).toEqual(['webhooks_get', 'webhooks_post', 'actor_webhooks_get']);
    });

    it('matches a plural to its singular and drops one-letter terms', () => {
        // No word starts with "aborts"; only the plural rule matches it to "abort".
        expect(searchIds('aborts')).toEqual(['actorRun_abort_post']);
        expect(searchIds("dataset's")).toEqual(searchIds('dataset'));
    });

    it("counts a verb for the operation's method, but not on its own", () => {
        expect(searchIds('rename dataset')[0]).toBe('dataset_put');
        expect(searchIds('rename')).toEqual([]);
    });

    it("ranks a storage's own operation above a run's copy of it and above a synchronous run", () => {
        // Both competitors name the dataset in their summary; the storage's own operation does not.
        const ids = searchIds('add items to a dataset');
        expect(ids[0]).toBe('dataset_items_post');
        expect(ids.indexOf('actor_runs_last_dataset_items_post')).toBeGreaterThan(0);
        expect(ids.indexOf('actor_runSyncGetDatasetItems_post')).toBeGreaterThan(0);
    });

    it("keeps a run's copy first when the query is about runs", () => {
        expect(searchIds("store items in last run's dataset")[0]).toBe('actor_runs_last_dataset_items_post');
    });

    it('finds an operation by keywords only its description has, and leaves a keyword a name has to the names', () => {
        // No name has client, ip, address, or headers; the request queue summaries have request.
        expect(searchIds('client ip address request headers')[0]).toBe('tools_browser_info_get');
        // The description of browser info says request too, but there it does not count.
        expect(searchIds('request')).toEqual([
            'requestQueue_requests_batch_post',
            'requestQueue_requests_batch_delete',
            'requestQueue_request_get',
            'requestQueue_request_put',
            'requestQueue_request_delete',
        ]);
    });

    it('needs two description keywords, each a whole word', () => {
        expect(searchIds('client')).toEqual([]);
        // The description has endpoint, which starts with end.
        expect(searchIds('ip end')).toEqual([]);
    });

    it('ignores question words, which no name has but most descriptions do', () => {
        // The description of browser info has both is and this.
        expect(searchIds('what is this')).toEqual([]);
    });

    it('caps the results at the limit', () => {
        expect(searchApiOperations(index, 'dataset', 2)).toHaveLength(2);
    });

    it('returns nothing when no keyword matches', () => {
        expect(searchApiOperations(index, 'zebra', 10)).toEqual([]);
    });
});

describe('fetchApiOperationIndex()', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        // A fresh module graph per test, so the cache in state.ts starts empty.
        vi.resetModules();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function importFetchApiOperationIndex() {
        const module = await import('../../src/tools/api/apify_api_spec.js');
        return module.fetchApiOperationIndex;
    }

    it('downloads the published spec once and serves later calls from the cache', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify(API_SPEC_FIXTURE)));
        const fetchApiOperationIndex = await importFetchApiOperationIndex();

        const [first, second] = await Promise.all([fetchApiOperationIndex(), fetchApiOperationIndex()]);
        const third = await fetchApiOperationIndex();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(APIFY_API_OPENAPI_URL, { signal: expect.any(AbortSignal) });
        expect(first.has('dataset_get')).toBe(true);
        expect(second).toBe(first);
        expect(third).toBe(first);
    });

    it('throws on a failed download and tries again on the next call', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(API_SPEC_FIXTURE)));
        const fetchApiOperationIndex = await importFetchApiOperationIndex();

        await expect(fetchApiOperationIndex()).rejects.toThrow('HTTP 503');
        await expect(fetchApiOperationIndex()).resolves.toSatisfy((index: Map<string, unknown>) =>
            index.has('dataset_get'),
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['a body that is not JSON', '<html>', 'the response is not JSON.'],
        ['a spec without /v2/ operations', JSON.stringify({ openapi: '3.1.2' }), 'the spec lists no /v2/ operations.'],
    ])('throws on %s, does not cache it, and tries again on the next call', async (_name, body, reason) => {
        fetchMock
            .mockResolvedValueOnce(new Response(body))
            .mockResolvedValueOnce(new Response(JSON.stringify(API_SPEC_FIXTURE)));
        const fetchApiOperationIndex = await importFetchApiOperationIndex();

        await expect(fetchApiOperationIndex()).rejects.toThrow(
            `Failed to load the Apify API operations from ${APIFY_API_OPENAPI_URL}: ${reason}`,
        );
        await expect(fetchApiOperationIndex()).resolves.toSatisfy((index: Map<string, unknown>) =>
            index.has('dataset_get'),
        );
    });
});
