import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import type { ApifyClient } from '../../src/apify_client.js';
import { getActorDefinition } from '../../src/tools/actors/actor_definition.js';
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

    it('does not scan the build list for a reference that is not a build number', async () => {
        const { apifyClient, list } = mockActorBuildClient({
            actor: mockStandbyActor('beta'),
            defaultBuild: mockDefaultBuild(),
        });

        await getActorDefinition('acme/mcp-server', apifyClient);

        expect(list).not.toHaveBeenCalled();
    });

    it.each([
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
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const { apifyClient } = mockActorBuildClient({
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
    ])('is false for %s', async (_label, webServerSchema) => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockActor(),
            defaultBuild: mockDefaultBuild({ webServerSchema }),
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition.hasWebServerSchema).toBe(false);
    });

    it('is true for a schema with one operation', async () => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockActor(),
            defaultBuild: mockDefaultBuild({ webServerSchema: SEARCH_SCHEMA }),
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition.hasWebServerSchema).toBe(true);
    });

    it('keeps the schema itself off the pruned definition', async () => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockActor(),
            defaultBuild: mockDefaultBuild({ webServerSchema: SEARCH_SCHEMA }),
        });

        const result = await getActorDefinition('acme/mcp-server', apifyClient);

        expect(result?.definition).not.toHaveProperty('webServerSchema');
    });
});
