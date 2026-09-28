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
        expect(index.size).toBe(52);
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
        ['actorTask_runSyncGetDatasetItems_get', 'waits up to 300 seconds'],
        ['users_me_limits_put', 'spending limits'],
        ['PostChargeRun', 'Only the Actor itself charges'],
        ['actorRun_metamorph_post', 'cannot be undone'],
        ['actor_runs_last_metamorph_post', 'cannot be undone'],
        ['actorTask_runs_last_metamorph_post', 'cannot be undone'],
        ['actor_runSyncGetDatasetItems_post', 'waits up to 300 seconds'],
        ['actor_versions_post', "sets the new version's source and environment variables"],
        ['actor_runSync_post', 'waits up to 300 seconds'],
        ['tools_browser_info_get', 'the API token'],
        ['tools_browser_info_post', 'the API token'],
        ['tools_browser_info_put', 'the API token'],
    ])('makes %s unavailable with the reason', (operationId, reason) => {
        const operation = index.get(operationId);
        expect(operation?.access).toBe(API_ACCESS.UNAVAILABLE);
        expect(operation?.unavailableReason).toContain(reason);
    });

    it('refuses publishing, pricing, permission, sharing, and source fields where the body takes them', () => {
        expect(index.get('actor_put')?.refusedBodyFields).toEqual([
            'isPublic',
            'pricingInfos',
            'actorPermissionLevel',
            'versions',
        ]);
        expect(index.get('dataset_put')?.refusedBodyFields).toEqual(['generalAccess']);
        // The API takes these on create, although the create schema does not declare them.
        expect(index.get('actors_post')?.refusedBodyFields).toEqual([
            'isPublic',
            'pricingInfos',
            'actorPermissionLevel',
            'versions',
        ]);
        // buildTag is not a source field and stays settable.
        const versionSourceFields = [
            'sourceType',
            'sourceFiles',
            'tarballUrl',
            'gitRepoUrl',
            'gitHubGistUrl',
            'envVars',
        ];
        expect(index.get('actor_version_put')?.refusedBodyFields).toEqual(versionSourceFields);
        expect(index.get('actor_version_post')?.refusedBodyFields).toEqual(versionSourceFields);
        // A record body is free-form: a record may hold an isPublic key as plain data.
        expect(index.get('keyValueStore_record_put')?.refusedBodyFields).toEqual([]);
    });

    it('links each operation to its page in the API reference, at the operation ID in kebab case', () => {
        expect(index.get('actorRun_abort_post')?.docsUrl).toBe('https://docs.apify.com/api/v2/actor-run-abort-post');
        expect(index.get('PostChargeRun')?.docsUrl).toBe('https://docs.apify.com/api/v2/post-charge-run');
        expect(index.get('keyValueStore_record_put')?.docsUrl).toBe(
            'https://docs.apify.com/api/v2/key-value-store-record-put',
        );
    });

    it('throws for a document without /v2/ operations', () => {
        expect(() => buildApiOperationIndex({})).toThrow('the spec lists no /v2/ operations.');
        expect(() => buildApiOperationIndex('not a spec')).toThrow('the spec lists no /v2/ operations.');
    });

    /** The fixture with the operation at the path and method replaced. */
    function withOperation(path: string, method: string, operation: Record<string, unknown> | undefined) {
        const paths: Record<string, Record<string, unknown>> = structuredClone(API_SPEC_FIXTURE.paths);
        paths[path] = { ...paths[path], [method]: operation };
        return { ...API_SPEC_FIXTURE, paths };
    }

    it('keys the refusals by method and path, not by the operation ID or the parameter names', () => {
        const renamed = buildApiOperationIndex(
            withOperation('/v2/actor-runs/{runId}/charge', 'post', {
                operationId: 'actorRun_charge_post',
                summary: 'Charge events in run',
            }),
        );
        expect(renamed.get('actorRun_charge_post')?.access).toBe(API_ACCESS.UNAVAILABLE);

        const paths: Record<string, unknown> = structuredClone(API_SPEC_FIXTURE.paths);
        paths['/v2/actor-runs/{id}/metamorph'] = paths['/v2/actor-runs/{runId}/metamorph'];
        delete paths['/v2/actor-runs/{runId}/metamorph'];
        const reparameterized = buildApiOperationIndex({ ...API_SPEC_FIXTURE, paths });
        expect(reparameterized.get('actorRun_metamorph_post')?.access).toBe(API_ACCESS.UNAVAILABLE);

        const createActor = withOperation('/v2/actors', 'post', {
            ...API_SPEC_FIXTURE.paths['/v2/actors'].post,
            operationId: 'actor_create',
        });
        expect(buildApiOperationIndex(createActor).get('actor_create')?.refusedBodyFields).toEqual([
            'isPublic',
            'pricingInfos',
            'actorPermissionLevel',
            'versions',
        ]);

        const updateVersion = withOperation('/v2/actors/{actorId}/versions/{versionNumber}', 'put', {
            ...API_SPEC_FIXTURE.paths['/v2/actors/{actorId}/versions/{versionNumber}'].put,
            operationId: 'actorVersion_update',
        });
        expect(buildApiOperationIndex(updateVersion).get('actorVersion_update')?.refusedBodyFields).toContain(
            'envVars',
        );
        const createVersion = withOperation('/v2/actors/{actorId}/versions', 'post', {
            ...API_SPEC_FIXTURE.paths['/v2/actors/{actorId}/versions'].post,
            operationId: 'actorVersion_create',
        });
        expect(buildApiOperationIndex(createVersion).get('actorVersion_create')?.access).toBe(API_ACCESS.UNAVAILABLE);
    });

    it('refuses the source fields even where the schema does not declare them', () => {
        const withoutEnvVars = withOperation('/v2/actors/{actorId}/versions/{versionNumber}', 'put', {
            ...API_SPEC_FIXTURE.paths['/v2/actors/{actorId}/versions/{versionNumber}'].put,
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {} } } } },
        });

        expect(buildApiOperationIndex(withoutEnvVars).get('actor_version_put')?.refusedBodyFields).toEqual([
            'sourceType',
            'sourceFiles',
            'tarballUrl',
            'gitRepoUrl',
            'gitHubGistUrl',
            'envVars',
        ]);
    });

    it('throws when an operation a rule is about is missing, rather than lift the rule', () => {
        const moved = withOperation('/v2/users/me/limits', 'put', undefined);

        expect(() => buildApiOperationIndex(moved)).toThrow(
            'the spec no longer lists PUT /v2/users/me/limits, which the API tools have rules for.',
        );
    });

    it('checks the rules against a deprecated operation too', () => {
        const deprecated = withOperation('/v2/users/me/limits', 'put', {
            ...API_SPEC_FIXTURE.paths['/v2/users/me/limits'].put,
            deprecated: true,
        });

        expect(buildApiOperationIndex(deprecated).has('users_me_limits_put')).toBe(false);
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

    it("ranks a storage's own operation above a run's copy of it and above an unavailable one", () => {
        // Both competitors name the dataset in their summary; the storage's own operation does not.
        const ids = searchIds('add items to a dataset');
        expect(ids[0]).toBe('dataset_items_post');
        expect(ids.indexOf('actor_runs_last_dataset_items_post')).toBeGreaterThan(0);
        expect(ids.indexOf('actor_runSyncGetDatasetItems_post')).toBeGreaterThan(0);
    });

    it("keeps a run's copy first when the query is about runs", () => {
        expect(searchIds("store items in last run's dataset")[0]).toBe('actor_runs_last_dataset_items_post');
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
