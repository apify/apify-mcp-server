import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import type { ActorDefinitionWithInfo } from '../../src/types.js';

vi.mock('../../src/tools/actors/actor_definition.js', () => ({ getActorDefinition: vi.fn() }));
vi.mock('../../src/utils/userid_cache.js', () => ({ getUserInfoCached: vi.fn() }));

import { actorDefinitionCache } from '../../src/state.js';
import { getActorDefinition } from '../../src/tools/actors/actor_definition.js';
import { getActorDefinitionCached, getActorMcpUrlCached } from '../../src/utils/actor.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';

const getActorDefinitionMock = vi.mocked(getActorDefinition);
const getUserInfoCachedMock = vi.mocked(getUserInfoCached);

// Each test uses a unique Actor name, so the shared module-level cache never collides between cases.
function seedCache(
    name: string,
    isPublic: boolean,
    ownerUserId: string,
    opts: { id?: string; webServerMcpPath?: string } = {},
): ActorDefinitionWithInfo {
    const id = opts.id ?? name;
    const entry = {
        definition: {
            id,
            actorFullName: name,
            ...(opts.webServerMcpPath && { webServerMcpPath: opts.webServerMcpPath }),
        },
        info: { id, isPublic, userId: ownerUserId },
    } as unknown as ActorDefinitionWithInfo;
    actorDefinitionCache.set(name, entry);
    return entry;
}

const client = { token: 'caller-token' } as unknown as ApifyClient;

beforeEach(() => {
    getActorDefinitionMock.mockReset();
    getUserInfoCachedMock.mockReset();
});

describe('getActorDefinitionCached — tenant isolation', () => {
    it('serves a cached public Actor to any caller without an ownership check', async () => {
        const cached = seedCache('acme/public-1', true, 'owner-1');

        const result = await getActorDefinitionCached('acme/public-1', client);

        expect(result).toBe(cached);
        expect(getUserInfoCachedMock).not.toHaveBeenCalled();
        expect(getActorDefinitionMock).not.toHaveBeenCalled();
    });

    it('serves a cached private Actor to its owner', async () => {
        const cached = seedCache('acme/private-owner', false, 'owner-2');
        getUserInfoCachedMock.mockResolvedValue({ userId: 'owner-2', userPlanTier: 'FREE', isOrganization: false });

        const result = await getActorDefinitionCached('acme/private-owner', client);

        expect(result).toBe(cached);
        expect(getActorDefinitionMock).not.toHaveBeenCalled();
    });

    it('does NOT serve a cached private Actor to a non-owner — returns the re-fetched object, never the cached one', async () => {
        const cached = seedCache('acme/private-other', false, 'owner-3');
        getUserInfoCachedMock.mockResolvedValue({ userId: 'intruder', userPlanTier: 'FREE', isOrganization: false });
        const refetched = {
            definition: {},
            info: { isPublic: false, userId: 'owner-3' },
        } as unknown as ActorDefinitionWithInfo;
        getActorDefinitionMock.mockResolvedValue(refetched);

        const result = await getActorDefinitionCached('acme/private-other', client);

        expect(result).toBe(refetched);
        expect(result).not.toBe(cached);
        expect(getActorDefinitionMock).toHaveBeenCalledWith('acme/private-other', client);
    });

    it('does NOT serve a cached private Actor to an anonymous caller', async () => {
        seedCache('acme/private-anon', false, 'owner-4');
        getUserInfoCachedMock.mockResolvedValue({ userId: null, userPlanTier: 'FREE', isOrganization: false });
        getActorDefinitionMock.mockResolvedValue(null);

        const result = await getActorDefinitionCached('acme/private-anon', client);

        expect(result).toBeNull();
        expect(getActorDefinitionMock).toHaveBeenCalledWith('acme/private-anon', client);
    });
});

describe('getActorMcpUrlCached — tenant isolation', () => {
    it('derives the MCP URL from a cached Actor the caller may see', async () => {
        seedCache('acme/mcp-public', true, 'owner-6', { id: 'actorpub', webServerMcpPath: '/mcp' });

        const result = await getActorMcpUrlCached('acme/mcp-public', client);

        expect(result).toBe('https://actorpub.apify.actor/mcp');
        expect(getActorDefinitionMock).not.toHaveBeenCalled();
    });

    it('does NOT leak a cached private Actor MCP URL to a non-owner — re-fetches and returns false', async () => {
        seedCache('acme/mcp-private', false, 'owner-7', { id: 'actorpriv', webServerMcpPath: '/mcp' });
        getUserInfoCachedMock.mockResolvedValue({ userId: 'intruder', userPlanTier: 'FREE', isOrganization: false });
        getActorDefinitionMock.mockResolvedValue(null); // intruder's own fetch is unauthorized

        const result = await getActorMcpUrlCached('acme/mcp-private', client);

        expect(result).toBe(false);
        expect(getActorDefinitionMock).toHaveBeenCalledWith('acme/mcp-private', client);
    });

    it('returns false for a non-existent Actor without throwing', async () => {
        getActorDefinitionMock.mockResolvedValue(null);

        await expect(getActorMcpUrlCached('acme/missing', client)).resolves.toBe(false);
    });
});
