import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { CODE_RUNTIME_ACTOR_NAME } from '../../src/const.js';
import { actorDefinitionCache } from '../../src/state.js';
import type { ActorDefinitionWithInfo, ActorStore } from '../../src/types.js';
import {
    fetchActorDetails,
    getMcpToolsMessage,
    resolveReadmeContent,
    typeObjectToString,
} from '../../src/utils/actor_details.js';
import { searchActorsByKeywords } from '../../src/utils/actor_search.js';
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

vi.mock('../../src/utils/actor_search.js', () => ({
    searchActorsByKeywords: vi.fn().mockResolvedValue([]),
}));

function apifyApiError(status: number, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: message, message } }, status } as AxiosResponse, 1);
}

function stubApifyClient(getActor: () => Promise<unknown>, getBuild = getActor): ApifyClient {
    return mockApifyClient({
        token: 'test-token',
        actor: () => ({
            get: getActor,
            defaultBuild: async () => ({ get: getBuild }),
        }),
    });
}

const OTHER_ACTOR = { username: 'someone', name: 'some-other-actor' };
const [CODE_RUNTIME_USERNAME, CODE_RUNTIME_NAME] = CODE_RUNTIME_ACTOR_NAME.split('/');
const CODE_RUNTIME_ACTOR = { username: CODE_RUNTIME_USERNAME, name: CODE_RUNTIME_NAME };

describe('resolveReadmeContent()', () => {
    it('prefers the summary when present for a regular Actor', () => {
        const result = resolveReadmeContent({
            actorInfo: OTHER_ACTOR,
            readme: '# Full',
            readmeSummary: 'Short summary.',
        });
        expect(result).toEqual({ content: 'Short summary.', heading: '# README summary' });
    });

    it('falls back to the full readme when there is no summary', () => {
        const result = resolveReadmeContent({ actorInfo: OTHER_ACTOR, readme: '# Full' });
        expect(result).toEqual({ content: '# Full', heading: '# README' });
    });

    it('always returns the full readme for apify/code-runtime, even with a summary present', () => {
        const result = resolveReadmeContent({
            actorInfo: CODE_RUNTIME_ACTOR,
            readme: '# Full',
            readmeSummary: 'Short summary.',
        });
        expect(result).toEqual({ content: '# Full', heading: '# README' });
    });

    it('ignores a blank summary the same way for a regular Actor or code-runtime', () => {
        expect(resolveReadmeContent({ actorInfo: OTHER_ACTOR, readme: '# Full', readmeSummary: '   ' })).toEqual({
            content: '# Full',
            heading: '# README',
        });
        expect(resolveReadmeContent({ actorInfo: CODE_RUNTIME_ACTOR, readme: '# Full', readmeSummary: '   ' })).toEqual(
            {
                content: '# Full',
                heading: '# README',
            },
        );
    });
});

describe('typeObjectToString', () => {
    it('formats a flat object of string-typed fields', () => {
        expect(typeObjectToString({ name: 'string', age: 'number' })).toBe('{ name: string, age: number }');
    });

    it('formats an array of primitives', () => {
        expect(typeObjectToString({ tags: ['string'] })).toBe('{ tags: string[] }');
    });

    it('formats an array of objects', () => {
        expect(typeObjectToString({ users: [{ name: 'string' }] })).toBe('{ users: { name: string }[] }');
    });

    it('formats a nested object', () => {
        expect(typeObjectToString({ profile: { name: 'string', age: 'number' } })).toBe(
            '{ profile: { name: string, age: number } }',
        );
    });

    it('formats deep nesting through arrays and objects', () => {
        expect(typeObjectToString({ a: [{ b: ['string'] }] })).toBe('{ a: { b: string[] }[] }');
    });

    it('returns empty braces for an empty object', () => {
        expect(typeObjectToString({})).toBe('{  }');
    });

    it('returns "unknown[]" for an empty array', () => {
        expect(typeObjectToString({ tags: [] })).toBe('{ tags: unknown[] }');
    });

    it('skips fields with null / number / boolean / undefined values at top level', () => {
        expect(
            typeObjectToString({
                a: null,
                b: 42,
                c: true,
                d: undefined,
                keep: 'string',
            }),
        ).toBe('{ keep: string }');
    });

    it('emits "unknown" for non-string primitives nested inside arrays', () => {
        expect(typeObjectToString({ nums: [42] })).toBe('{ nums: unknown[] }');
    });

    it('formats nested arrays', () => {
        expect(typeObjectToString({ matrix: [['string']] })).toBe('{ matrix: string[][] }');
    });

    it('emits "unknown" for null nested inside an array', () => {
        expect(typeObjectToString({ a: [null] })).toBe('{ a: unknown[] }');
    });

    it('mixes kept string/object/array fields with skipped primitives in one object', () => {
        expect(
            typeObjectToString({
                name: 'string',
                count: 5,
                tags: ['string'],
                meta: { id: 'string' },
                flag: false,
            }),
        ).toBe('{ name: string, tags: string[], meta: { id: string } }');
    });

    it('emits "unknown" for function / symbol nested inside an array', () => {
        expect(typeObjectToString({ fns: [() => 1] as unknown[] })).toBe('{ fns: unknown[] }');
        expect(typeObjectToString({ syms: [Symbol('x')] as unknown[] })).toBe('{ syms: unknown[] }');
    });

    it('formats triple-nested arrays', () => {
        expect(typeObjectToString({ cube: [[['string']]] })).toBe('{ cube: string[][][] }');
    });

    it('formats an array whose element is an empty object', () => {
        expect(typeObjectToString({ items: [{}] })).toBe('{ items: {  }[] }');
    });

    it('recurses through a nested object containing mixed skipped values', () => {
        expect(
            typeObjectToString({
                outer: {
                    keep: 'string',
                    skip: 42,
                    tags: ['string'],
                },
            }),
        ).toBe('{ outer: { keep: string, tags: string[] } }');
    });
});

describe('fetchActorDetails()', () => {
    const RAW_PICTURE_URL = 'https://bucket.s3.amazonaws.com/picture.png';
    const stubActorWithPicture = () =>
        stubApifyClient(
            async () => ({ id: 'actor-id', pictureUrl: RAW_PICTURE_URL }),
            async () => ({ actorDefinition: { input: { type: 'object', properties: {} } } }),
        );

    it('uses the picture URL proxied by the Actor store and skips the Store search', async () => {
        vi.mocked(searchActorsByKeywords).mockClear();
        const actorStore: ActorStore = {
            getActorOutputSchema: vi.fn(),
            getActorOutputSchemaAsTypeObject: vi.fn(),
            getProxiedPictureUrl: (url) => `https://proxy.example.com/${url}`,
        };

        const result = await fetchActorDetails(stubActorWithPicture(), 'apify/web-scraper', { actorStore });

        expect(result?.actorInfo.pictureUrl).toBe(`https://proxy.example.com/${RAW_PICTURE_URL}`);
        expect(searchActorsByKeywords).not.toHaveBeenCalled();
    });

    it('falls back to the Store search picture URL when the Actor store cannot proxy pictures', async () => {
        vi.mocked(searchActorsByKeywords).mockResolvedValueOnce([
            { id: 'actor-id', pictureUrl: 'https://images.example.com/store-picture.webp' },
        ] as Awaited<ReturnType<typeof searchActorsByKeywords>>);

        const result = await fetchActorDetails(stubActorWithPicture(), 'apify/web-scraper');

        expect(result?.actorInfo.pictureUrl).toBe('https://images.example.com/store-picture.webp');
    });

    it('returns null on a genuine 404 (Actor does not exist)', async () => {
        const client = stubApifyClient(() => Promise.reject(apifyApiError(404, 'Actor was not found')));

        const result = await fetchActorDetails(client, 'apify/no-such-actor');

        expect(result).toBeNull();
    });

    it('propagates a 401 (invalid/expired token) instead of reporting not-found', async () => {
        const client = stubApifyClient(() => Promise.reject(apifyApiError(401, 'Authentication token is not valid')));

        await expect(fetchActorDetails(client, 'apify/instagram-scraper')).rejects.toMatchObject({ statusCode: 401 });
    });
});

describe('fetchActorDetails() reads the server interface from the standby build', () => {
    const STANDBY_DEFINITION = {
        actorSpecification: 1,
        name: 'mcp-server',
        version: '2.0',
        readme: '# Standby build README',
        input: { type: 'object', properties: { url: { type: 'string' } } },
        webServerMcpPath: '/mcp',
        webServerSchema: SEARCH_SCHEMA,
    };

    it("keeps the default build's server fields when standby is off", async () => {
        const { apifyClient, buildGet, list } = mockActorBuildClient({
            actor: mockActor(),
            defaultBuild: mockDefaultBuild({ webServerMcpPath: '/mcp', webServerSchema: SEARCH_SCHEMA }),
        });

        const result = await fetchActorDetails(apifyClient, 'acme/mcp-server');

        expect(result).toMatchObject({ webServerMcpPath: '/mcp', webServerSchema: SEARCH_SCHEMA });
        expect(buildGet).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
    });

    it('takes the server fields from the tagged standby build and the input schema and README from the default build', async () => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            defaultBuild: mockDefaultBuild(),
            builds: { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID, STANDBY_DEFINITION) },
        });

        const result = await fetchActorDetails(apifyClient, 'acme/mcp-server');

        expect(result).toMatchObject({
            webServerMcpPath: '/mcp',
            webServerSchema: SEARCH_SCHEMA,
            inputSchema: DEFAULT_INPUT,
            readme: '# Default build README',
        });
    });

    it('reuses the default build without a second fetch when the tag names it', async () => {
        const { apifyClient, buildGet } = mockActorBuildClient({
            actor: mockStandbyActor('latest', { taggedBuilds: { latest: { buildId: DEFAULT_BUILD_ID } } }),
            defaultBuild: mockDefaultBuild({ webServerMcpPath: '/mcp' }),
        });

        const result = await fetchActorDetails(apifyClient, 'acme/mcp-server');

        expect(result?.webServerMcpPath).toBe('/mcp');
        expect(buildGet).not.toHaveBeenCalled();
    });

    it('finds a build-number reference by scanning the build list newest first', async () => {
        const { apifyClient, buildGet, list } = mockActorBuildClient({
            actor: mockStandbyActor('1.2.3'),
            defaultBuild: mockDefaultBuild(),
            builds: { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID, STANDBY_DEFINITION) },
            buildList: [
                { id: 'build-newer', buildNumber: '1.2.4' },
                { id: STANDBY_BUILD_ID, buildNumber: '1.2.3' },
            ],
        });

        const result = await fetchActorDetails(apifyClient, 'acme/mcp-server');

        expect(result?.webServerMcpPath).toBe('/mcp');
        expect(list).toHaveBeenCalledWith({ desc: true });
        expect(buildGet).toHaveBeenCalledWith(STANDBY_BUILD_ID);
    });

    it.each([
        ['an unset build reference', mockStandbyActor(undefined), {}],
        ['a tag with no tagged build', mockStandbyActor('beta', { taggedBuilds: {} }), {}],
        ['a build number no listed build has', mockStandbyActor('9.9.9'), {}],
        [
            'a deleted build',
            mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            { [STANDBY_BUILD_ID]: undefined },
        ],
        [
            'a build without a definition',
            mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID) },
        ],
    ])("serves no server fields, not the default build's, for %s", async (_label, actor, builds) => {
        const { apifyClient } = mockActorBuildClient({
            actor,
            defaultBuild: mockDefaultBuild(),
            builds,
            buildList: [{ id: 'build-newer', buildNumber: '1.2.4' }],
        });

        const result = await fetchActorDetails(apifyClient, 'acme/mcp-server');

        expect(result).toMatchObject({ inputSchema: DEFAULT_INPUT, readme: '# Default build README' });
        expect(result?.webServerMcpPath).toBeUndefined();
        expect(result?.webServerSchema).toBeUndefined();
    });

    it('propagates a 403 from the standby build read instead of reporting not-found', async () => {
        const { apifyClient, buildGet } = mockActorBuildClient({
            actor: mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            defaultBuild: mockDefaultBuild(),
        });
        buildGet.mockRejectedValue(apifyApiError(403, 'Insufficient permissions'));

        await expect(fetchActorDetails(apifyClient, 'acme/mcp-server')).rejects.toMatchObject({ statusCode: 403 });
    });

    it('propagates a 500 from the build list', async () => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockStandbyActor('1.2.3'),
            defaultBuild: mockDefaultBuild(),
            buildListFailure: apifyApiError(500, 'Internal server error'),
        });

        await expect(fetchActorDetails(apifyClient, 'acme/mcp-server')).rejects.toMatchObject({ statusCode: 500 });
    });
});

describe('getMcpToolsMessage()', () => {
    it('reports a run-only Actor with a leftover webServerMcpPath as not an MCP server', async () => {
        const actorName = 'acme/stale-mcp-path';
        actorDefinitionCache.set(actorName, {
            definition: { id: 'staleactor', actorFullName: actorName, webServerMcpPath: '/mcp' },
            info: { id: 'staleactor', isPublic: true, userId: 'owner' },
        } as unknown as ActorDefinitionWithInfo);

        const message = await getMcpToolsMessage(
            actorName,
            stubApifyClient(async () => ({})),
            'token',
        );

        expect(message).toBe('Note: This Actor is not an MCP server and does not expose MCP tools.');
    });

    it("reports the canonical standby-without-MCP message, matching call-actor's rejection", async () => {
        const actorName = 'acme/standby-empty';
        actorDefinitionCache.set(actorName, {
            definition: { id: 'standbyempty', actorFullName: actorName },
            info: { id: 'standbyempty', isPublic: true, userId: 'owner', actorStandby: { isEnabled: true } },
        } as unknown as ActorDefinitionWithInfo);

        const message = await getMcpToolsMessage(
            actorName,
            stubApifyClient(async () => ({})),
            'token',
        );

        expect(message).toBe(
            'Actor "acme/standby-empty" runs in standby mode without an MCP server and has an empty input schema,' +
                ' which is not supported yet.',
        );
    });
});
