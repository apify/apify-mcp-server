import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    API_ACCESS,
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
        expect(index.size).toBe(13);
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

    it('gives GET read access and POST and PUT write access', () => {
        expect(index.get('dataset_get')?.access).toBe(API_ACCESS.READ);
        expect(index.get('dataset_put')?.access).toBe(API_ACCESS.WRITE);
        expect(index.get('actorRun_abort_post')?.access).toBe(API_ACCESS.WRITE);
    });

    it.each([
        ['dataset_delete', 'Deletion cannot be undone'],
        ['actor_runSync_get', 'waits up to 300 seconds'],
        ['users_me_limits_put', 'spending limits'],
    ])('makes %s unavailable with the reason', (operationId, reason) => {
        const operation = index.get(operationId);
        expect(operation?.access).toBe(API_ACCESS.UNAVAILABLE);
        expect(operation?.unavailableReason).toContain(reason);
    });

    it('refuses publishing, pricing, permission and sharing fields only where the body schema declares them', () => {
        expect(index.get('actor_put')?.refusedBodyFields).toEqual(['isPublic', 'pricingInfos', 'actorPermissionLevel']);
        expect(index.get('dataset_put')?.refusedBodyFields).toEqual(['generalAccess']);
        // A record body is free-form: a record may hold an isPublic key as plain data.
        expect(index.get('keyValueStore_record_put')?.refusedBodyFields).toEqual([]);
    });

    it('returns an empty index for a document without paths', () => {
        expect(buildApiOperationIndex({}).size).toBe(0);
        expect(buildApiOperationIndex('not a spec').size).toBe(0);
    });
});

describe('searchApiOperations()', () => {
    const index = buildApiOperationIndex(API_SPEC_FIXTURE);

    it('ranks summary matches first and breaks ties by the shorter path', () => {
        const ids = searchApiOperations(index, 'update dataset', 10).map((operation) => operation.operationId);
        expect(ids.slice(0, 2)).toEqual(['dataset_put', 'actorRun_dataset_put']);
    });

    it('matches word forms either way and ignores stop words', () => {
        const ids = searchApiOperations(index, 'list all of the webhooks', 10).map(
            (operation) => operation.operationId,
        );
        expect(ids).toEqual(['webhooks_get', 'actor_webhooks_get']);
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
        expect(fetchMock).toHaveBeenCalledWith(APIFY_API_OPENAPI_URL);
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
});
