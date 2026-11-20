import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import type { ApifyClient } from '../../src/apify_client.js';
import {
    getActorDefinition,
    getDeclaredDatasetItemsSchema,
    MAX_DATASET_FIELD_DEPTH,
    MAX_DATASET_ITEMS_SCHEMA_BYTES,
    reduceToFieldNamesAndTypes,
} from '../../src/tools/actors/actor_definition.js';
import {
    DEFAULT_BUILD_ID,
    DEFAULT_INPUT,
    mockActor,
    mockActorBuildClient,
    mockBuild,
    mockDefaultBuild,
    mockStandbyActor,
    SEARCH_SCHEMA,
    STANDBY_BUILD_ID,
} from './helpers/actor_build_client.js';
import { mockApifyClient } from './helpers/tool_context.js';

function apifyApiError(status: number, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: message, message } }, status } as AxiosResponse, 1);
}

/** `actor().get()` finds the Actor; `defaultBuild()` throws `error`, the call that reaches the catch block. */
function stubDefaultBuildFailure(error: unknown): ApifyClient {
    return mockApifyClient({
        actor: () => ({
            get: async () => ({ id: 'actor-id', username: 'apify', name: 'some-actor' }),
            defaultBuild: async () => Promise.reject(error),
        }),
    });
}

describe('getActorDefinition()', () => {
    it('returns null when the default build fetch fails with 404', async () => {
        const client = stubDefaultBuildFailure(apifyApiError(404, 'Build was not found'));

        expect(await getActorDefinition('apify/some-actor', client)).toBeNull();
    });

    it('returns null when the default build fetch fails with 400', async () => {
        const client = stubDefaultBuildFailure(apifyApiError(400, 'Invalid Actor ID'));

        expect(await getActorDefinition('apify/some-actor', client)).toBeNull();
    });

    it('rethrows a 403 instead of reporting not-found', async () => {
        const client = stubDefaultBuildFailure(apifyApiError(403, 'Insufficient permissions'));

        await expect(getActorDefinition('apify/some-actor', client)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rethrows an error that carries no HTTP status', async () => {
        const error = new Error('socket hang up');
        const client = stubDefaultBuildFailure(error);

        await expect(getActorDefinition('apify/some-actor', client)).rejects.toBe(error);
    });

    it('returns null for a 404 carried on `code` instead of `statusCode`', async () => {
        const client = stubDefaultBuildFailure(Object.assign(new Error('Not found'), { code: 404 }));

        expect(await getActorDefinition('apify/some-actor', client)).toBeNull();
    });
});

describe('getActorDefinition() reads the server interface from the standby build', () => {
    const STANDBY_DEFINITION = {
        actorSpecification: 1,
        name: 'mcp-server',
        version: '2.0',
        input: { type: 'object', properties: { url: { type: 'string' } } },
        webServerMcpPath: '/mcp',
        webServerSchema: SEARCH_SCHEMA,
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps the default build's server fields when standby is off", async () => {
        const { apifyClient, buildGet, list } = mockActorBuildClient({
            actor: mockActor(),
            defaultBuild: mockDefaultBuild({ webServerMcpPath: '/mcp', webServerSchema: SEARCH_SCHEMA }),
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition).toMatchObject({ webServerMcpPath: '/mcp', hasWebServerSchema: true });
        expect(result?.definition).not.toHaveProperty('webServerSchema');
        expect(buildGet).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
    });

    it('takes the server fields from the tagged standby build and the input schema from the default build', async () => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            defaultBuild: mockDefaultBuild(),
            builds: { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID, STANDBY_DEFINITION) },
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition).toMatchObject({
            webServerMcpPath: '/mcp',
            hasWebServerSchema: true,
            input: DEFAULT_INPUT,
            readme: '# Default build README',
        });
    });

    it('reuses the default build without a second fetch when the tag names it', async () => {
        const { apifyClient, buildGet } = mockActorBuildClient({
            actor: mockStandbyActor('latest', { taggedBuilds: { latest: { buildId: DEFAULT_BUILD_ID } } }),
            defaultBuild: mockDefaultBuild({ webServerMcpPath: '/mcp' }),
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition.webServerMcpPath).toBe('/mcp');
        expect(buildGet).not.toHaveBeenCalled();
    });

    it('reuses the default build without a second fetch when the standby configuration names no build', async () => {
        const { apifyClient, buildGet, list } = mockActorBuildClient({
            actor: mockStandbyActor(undefined),
            defaultBuild: mockDefaultBuild({ webServerMcpPath: '/mcp' }),
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition.webServerMcpPath).toBe('/mcp');
        expect(buildGet).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
    });

    it('finds a build-number reference by scanning the build list newest first and stops at the match', async () => {
        const { apifyClient, buildGet, list, pulledBuildIds } = mockActorBuildClient({
            actor: mockStandbyActor('1.2.3'),
            defaultBuild: mockDefaultBuild(),
            builds: { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID, STANDBY_DEFINITION) },
            buildList: [
                { id: 'build-newer', buildNumber: '1.2.4' },
                { id: STANDBY_BUILD_ID, buildNumber: '1.2.3' },
                { id: 'build-older', buildNumber: '1.2.2' },
            ],
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition.webServerMcpPath).toBe('/mcp');
        expect(list).toHaveBeenCalledWith({ desc: true });
        expect(buildGet).toHaveBeenCalledWith(STANDBY_BUILD_ID);
        expect(pulledBuildIds).not.toContain('build-older');
    });

    it('resolves a build number through the tagged builds without listing them', async () => {
        const { apifyClient, list } = mockActorBuildClient({
            actor: mockStandbyActor('1.2.3', {
                taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID, buildNumber: '1.2.3' } },
            }),
            defaultBuild: mockDefaultBuild(),
            builds: { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID, STANDBY_DEFINITION) },
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition.webServerMcpPath).toBe('/mcp');
        expect(list).not.toHaveBeenCalled();
    });

    // The platform parses the reference to integers, so a zero-padded number runs the build the API lists unpadded.
    it.each([
        ['the tagged builds', { beta: { buildId: STANDBY_BUILD_ID, buildNumber: '1.2.3' } }, []],
        ['the build list', {}, [{ id: STANDBY_BUILD_ID, buildNumber: '1.2.3' }]],
    ])('matches a zero-padded build number through %s', async (_label, taggedBuilds, buildList) => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockStandbyActor('01.2.03', { taggedBuilds }),
            defaultBuild: mockDefaultBuild(),
            builds: { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID, STANDBY_DEFINITION) },
            buildList,
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition.webServerMcpPath).toBe('/mcp');
    });

    it('leaves an untagged build number unresolved without a token instead of listing the builds', async () => {
        const { apifyClient, list } = mockActorBuildClient({
            actor: mockStandbyActor('1.2.3'),
            defaultBuild: mockDefaultBuild(),
            buildList: [{ id: STANDBY_BUILD_ID, buildNumber: '1.2.3' }],
            hasToken: false,
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition).toMatchObject({ webServerMcpPath: undefined, input: DEFAULT_INPUT });
        expect(list).not.toHaveBeenCalled();
    });

    it.each([
        ['a tag with no tagged build', mockStandbyActor('beta', { taggedBuilds: {} }), {}, false],
        ['a build number no listed build has', mockStandbyActor('9.9.9'), {}, true],
        [
            'a deleted build',
            mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            { [STANDBY_BUILD_ID]: undefined },
            false,
        ],
        [
            'a build without a definition',
            mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID) },
            false,
        ],
    ])("serves no server fields, not the default build's, for %s", async (_label, actor, builds, shouldListBuilds) => {
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const { apifyClient, list } = mockActorBuildClient({
            actor,
            defaultBuild: mockDefaultBuild(),
            builds,
            buildList: [{ id: 'build-newer', buildNumber: '1.2.4' }],
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition).toMatchObject({
            webServerMcpPath: undefined,
            hasWebServerSchema: false,
            input: DEFAULT_INPUT,
        });
        expect(result?.definition).not.toHaveProperty('webServerSchema');
        expect(softFail).toHaveBeenCalledTimes(1);
        expect(list).toHaveBeenCalledTimes(shouldListBuilds ? 1 : 0);
    });

    it('rethrows a 403 from the standby build read instead of reporting not-found', async () => {
        const { apifyClient, buildGet } = mockActorBuildClient({
            actor: mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            defaultBuild: mockDefaultBuild(),
        });
        buildGet.mockRejectedValue(apifyApiError(403, 'Insufficient permissions'));

        await expect(getActorDefinition('acme/mcp-server', apifyClient)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rethrows a 500 from the build list', async () => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockStandbyActor('1.2.3'),
            defaultBuild: mockDefaultBuild(),
            buildListFailure: apifyApiError(500, 'Internal server error'),
        });

        await expect(getActorDefinition('acme/mcp-server', apifyClient)).rejects.toMatchObject({ statusCode: 500 });
    });
});

describe('hasWebServerSchema on the pruned definition', () => {
    it.each([
        ['an absent schema', undefined],
        ['an empty schema', {}],
        ['a path item with no operation', { paths: { '/search': {} } }],
        ['a path item that is not an object', { paths: { '/search': 'get' } }],
        ['an operation that is not an object', { paths: { '/search': { get: null } } }],
        ['a path item with only unsupported methods', { paths: { '/search': { head: {}, options: {} } } }],
    ])('is false for %s', async (_label, webServerSchema) => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockActor(),
            defaultBuild: mockDefaultBuild({ webServerSchema }),
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition.hasWebServerSchema).toBe(false);
    });
});

describe('documented operations on the pruned definition', () => {
    it('lists each operation with its required inputs', async () => {
        const webServerSchema = {
            paths: {
                '/': {
                    get: { parameters: [{ name: 'query', in: 'query', required: true }] },
                    post: { requestBody: { required: true } },
                },
                '/status': { get: {} },
            },
        };
        const { apifyClient } = mockActorBuildClient({
            actor: mockActor(),
            defaultBuild: mockDefaultBuild({ webServerSchema }),
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition.webServerOperations).toEqual([
            'GET / (required: query)',
            'POST / (required: request body)',
            'GET /status',
        ]);
    });
});

/** `fields` of a dataset schema as a creator writes it, shaped like `apify/instagram-profile-scraper`'s. */
const PROFILE_FIELDS = {
    type: 'object',
    properties: {
        username: { type: ['string', 'null'], examples: ['humansofny'], description: 'Instagram username' },
        followersCount: { type: 'number', description: 'Number of followers' },
    },
};

describe('the dataset schema an Actor declares for its default dataset', () => {
    it('is read from `storages.dataset` of a single-dataset Actor', () => {
        expect(getDeclaredDatasetItemsSchema({ storages: { dataset: { fields: PROFILE_FIELDS } } })).toBe(
            PROFILE_FIELDS,
        );
    });

    it('is read from the `default` alias of a multi-dataset Actor, not from another alias', () => {
        const errorFields = { type: 'object', properties: { errorMessage: { type: 'string' } } };
        const storages = { datasets: { errors: { fields: errorFields }, default: { fields: PROFILE_FIELDS } } };

        expect(getDeclaredDatasetItemsSchema({ storages })).toBe(PROFILE_FIELDS);
    });

    // The platform ignores `storages.dataset` once `storages.datasets` exists, so its fields describe no dataset.
    it('ignores `storages.dataset` when `storages.datasets` declares no default fields', () => {
        const storages = { dataset: { fields: PROFILE_FIELDS }, datasets: { default: { fields: {} } } };

        expect(getDeclaredDatasetItemsSchema({ storages })).toBeUndefined();
    });

    it('is absent when the dataset schema declares no fields', () => {
        expect(getDeclaredDatasetItemsSchema({ storages: { dataset: { views: {} } } })).toBeUndefined();
    });

    it('is absent when a multi-dataset Actor declares no `default` alias', () => {
        const storages = { datasets: { errors: { fields: PROFILE_FIELDS } } };

        expect(getDeclaredDatasetItemsSchema({ storages })).toBeUndefined();
    });

    it('is absent when the declared properties are not an object', () => {
        const fields = { type: 'object', properties: ['username', 'followersCount'] };

        expect(getDeclaredDatasetItemsSchema({ storages: { dataset: { fields } } })).toBeUndefined();
    });

    it('is absent when the declared fields have no properties', () => {
        const fields = { type: 'object', properties: {} };

        expect(getDeclaredDatasetItemsSchema({ storages: { dataset: { fields } } })).toBeUndefined();
    });

    it('is absent when the definition has no storages', () => {
        expect(getDeclaredDatasetItemsSchema({ input: DEFAULT_INPUT })).toBeUndefined();
    });
});

describe('reducing declared dataset fields to names and types', () => {
    it('keeps the type and drops descriptions, examples and other keywords', () => {
        const reduced = reduceToFieldNamesAndTypes({
            username: { type: ['string', 'null'], examples: ['humansofny'], description: 'Instagram username' },
            followersCount: { type: 'number', minimum: 0, $ref: '#/definitions/count' },
        });

        expect(reduced).toEqual({ username: { type: ['string', 'null'] }, followersCount: { type: 'number' } });
    });

    it('keeps nested object properties and array items, reduced the same way', () => {
        const reduced = reduceToFieldNamesAndTypes({
            owner: { type: 'object', properties: { id: { type: 'string', description: 'Owner ID' } } },
            latestPosts: {
                type: 'array',
                items: { type: 'object', additionalProperties: {}, properties: { likesCount: { type: 'number' } } },
            },
        });

        expect(reduced).toEqual({
            owner: { type: 'object', properties: { id: { type: 'string' } } },
            latestPosts: { type: 'array', items: { type: 'object', properties: { likesCount: { type: 'number' } } } },
        });
    });

    // `description` and `items` here are field names, not schema keywords.
    it('keeps a field whose name is a schema keyword', () => {
        const reduced = reduceToFieldNamesAndTypes({ description: { type: 'string' }, items: { type: 'array' } });

        expect(reduced).toEqual({ description: { type: 'string' }, items: { type: 'array' } });
    });

    // A client's validator rejects a tool whose `outputSchema` carries an unknown type name.
    it('drops a type name that JSON Schema does not define', () => {
        const reduced = reduceToFieldNamesAndTypes({
            scrapedAt: { type: 'date' },
            price: { type: ['number', 'money'] },
            rating: { type: ['stars', 'score'] },
            anything: 'not a schema',
        });

        // Strict: `type: undefined` or `type: []` would not be a field without a type.
        expect(reduced).toStrictEqual({ scrapedAt: {}, price: { type: ['number'] }, rating: {}, anything: {} });
    });

    it('lists a type name the declaration repeats once', () => {
        const reduced = reduceToFieldNamesAndTypes({ price: { type: ['number', 'number', 'null'] } });

        expect(reduced).toEqual({ price: { type: ['number', 'null'] } });
    });

    // tiktok-scraper declares nullability this way, 136 times.
    it('lists the null type for a field marked `nullable: true`', () => {
        const reduced = reduceToFieldNamesAndTypes({
            text: { type: 'string', nullable: true },
            diggCount: { type: ['integer', 'null'], nullable: true },
            createTime: { type: 'integer', nullable: false },
        });

        expect(reduced).toEqual({
            text: { type: ['string', 'null'] },
            diggCount: { type: ['integer', 'null'] },
            createTime: { type: 'integer' },
        });
    });

    // A creator's schema can nest without end; the reduction must stay bounded.
    it('keeps the type of a deeply nested field and drops what lies below it', () => {
        // Nests through `properties` and `items` in turn: both count as a level.
        let deepest: Record<string, unknown> = { type: 'string' };
        for (let level = 0; level < 50; level++) {
            deepest =
                level % 2 === 0
                    ? { type: 'array', items: deepest }
                    : { type: 'object', properties: { child: deepest } };
        }

        let node = reduceToFieldNamesAndTypes({ root: deepest })?.root as Record<string, unknown>;
        let depth = 1;
        while (node.properties || node.items) {
            node = (node.items ?? (node.properties as Record<string, unknown>).child) as Record<string, unknown>;
            depth++;
        }

        expect(depth).toBe(MAX_DATASET_FIELD_DEPTH);
        expect(Object.keys(node)).toEqual(['type']);
    });

    it('returns nothing when the reduced fields exceed the size limit', () => {
        const fieldCount = MAX_DATASET_ITEMS_SCHEMA_BYTES / 10;
        const properties = Object.fromEntries(
            Array.from({ length: fieldCount }, (_, index) => [`field${index}`, { type: 'string' }]),
        );

        expect(reduceToFieldNamesAndTypes(properties)).toBeUndefined();
    });
});

describe('declared dataset fields on the pruned definition', () => {
    const getDefinition = async (storages: unknown) => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockActor(),
            defaultBuild: mockDefaultBuild({ storages } as Parameters<typeof mockDefaultBuild>[0]),
        });
        return (await getActorDefinition('acme/mcp-server', apifyClient))?.definition;
    };

    it('carries the field names and types without descriptions and examples', async () => {
        const definition = await getDefinition({ dataset: { fields: PROFILE_FIELDS } });

        expect(definition?.datasetItemProperties).toEqual({
            username: { type: ['string', 'null'] },
            followersCount: { type: 'number' },
        });
    });

    it('carries none when the Actor declares no dataset fields', async () => {
        const definition = await getDefinition({ dataset: { views: {} } });

        expect(definition).toBeDefined();
        expect(definition).not.toHaveProperty('datasetItemProperties');
    });
});
