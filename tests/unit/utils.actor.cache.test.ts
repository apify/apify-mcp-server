import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import type { ActorDefinitionWithInfo } from '../../src/types.js';

vi.mock('../../src/tools/build.js', () => ({ getActorDefinition: vi.fn() }));
vi.mock('../../src/utils/userid_cache.js', () => ({ getUserInfoCached: vi.fn() }));

import { actorDefinitionCache } from '../../src/state.js';
import { getActorDefinition } from '../../src/tools/build.js';
import { getActorDefinitionCached, getActorMcpUrlCached } from '../../src/utils/actor.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';

const getActorDefinitionMock = vi.mocked(getActorDefinition);
const getUserInfoCachedMock = vi.mocked(getUserInfoCached);

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

describe('getActorDefinitionCached — tenant isolation', () => {
    beforeEach(() => {
        actorDefinitionCache.clear();
        getActorDefinitionMock.mockReset();
        getUserInfoCachedMock.mockReset();
    });

    it('serves a cached public Actor to any caller without an ownership check', async () => {
        const cached = seedCache('acme/public-1', true, 'owner-1');

        const result = await getActorDefinitionCached('acme/public-1', client);

        expect(result).toBe(cached);
        expect(getUserInfoCachedMock).not.toHaveBeenCalled();
        expect(getActorDefinitionMock).not.toHaveBeenCalled();
    });

    it('serves a cached private Actor to its owner', async () => {
        const cached = seedCache('acme/private-owner', false, 'owner-2');
        getUserInfoCachedMock.mockResolvedValue({ userId: 'owner-2', userPlanTier: 'FREE' });

        const result = await getActorDefinitionCached('acme/private-owner', client);

        expect(result).toBe(cached);
        expect(getActorDefinitionMock).not.toHaveBeenCalled();
    });

    it('does NOT serve a cached private Actor to a non-owner — returns the re-fetched object, never the cached one', async () => {
        const cached = seedCache('acme/private-other', false, 'owner-3');
        getUserInfoCachedMock.mockResolvedValue({ userId: 'intruder', userPlanTier: 'FREE' });
        const refetched = seedRefetch('owner-3');
        getActorDefinitionMock.mockResolvedValue(refetched);

        const result = await getActorDefinitionCached('acme/private-other', client);

        expect(result).toBe(refetched);
        expect(result).not.toBe(cached);
        expect(getActorDefinitionMock).toHaveBeenCalledWith('acme/private-other', client);
    });

    it('does NOT serve a cached private Actor to an anonymous caller', async () => {
        seedCache('acme/private-anon', false, 'owner-4');
        getUserInfoCachedMock.mockResolvedValue({ userId: null, userPlanTier: 'FREE' });
        getActorDefinitionMock.mockResolvedValue(null);

        const result = await getActorDefinitionCached('acme/private-anon', client);

        expect(result).toBeNull();
        expect(getActorDefinitionMock).toHaveBeenCalledWith('acme/private-anon', client);
    });

    it('fails closed when the identity lookup throws (returns null userId) — re-fetches, never serves the cached entry', async () => {
        seedCache('acme/private-degraded', false, 'owner-x');
        // getUserInfoCached swallows API failures and returns { userId: null }; the gate must deny.
        getUserInfoCachedMock.mockResolvedValue({ userId: null, userPlanTier: 'FREE' });
        getActorDefinitionMock.mockResolvedValue(null);

        const result = await getActorDefinitionCached('acme/private-degraded', client);

        expect(result).toBeNull();
        expect(getActorDefinitionMock).toHaveBeenCalled();
    });

    it('a shared-access non-owner re-fetch does not corrupt ownership for the next caller', async () => {
        seedCache('acme/private-shared', false, 'owner-5');
        // Tenant C has shared access: its re-fetch returns a def whose owner is still owner-5.
        getUserInfoCachedMock.mockResolvedValue({ userId: 'shared-c', userPlanTier: 'FREE' });
        getActorDefinitionMock.mockResolvedValue(seedRefetch('owner-5'));
        await getActorDefinitionCached('acme/private-shared', client);

        // Intruder B (no access) must still be denied and forced to re-fetch under its own token.
        getUserInfoCachedMock.mockResolvedValue({ userId: 'intruder-b', userPlanTier: 'FREE' });
        getActorDefinitionMock.mockReset();
        getActorDefinitionMock.mockResolvedValue(null);

        const result = await getActorDefinitionCached('acme/private-shared', client);

        expect(result).toBeNull();
        expect(getActorDefinitionMock).toHaveBeenCalledWith('acme/private-shared', client);
    });
});

describe('getActorMcpUrlCached — tenant isolation', () => {
    beforeEach(() => {
        actorDefinitionCache.clear();
        getActorDefinitionMock.mockReset();
        getUserInfoCachedMock.mockReset();
    });

    it('derives the MCP URL from a cached Actor the caller may see', async () => {
        seedCache('acme/mcp-public', true, 'owner-6', { id: 'actorpub', webServerMcpPath: '/mcp' });

        const result = await getActorMcpUrlCached('acme/mcp-public', client);

        expect(result).toBe('https://actorpub.apify.actor/mcp');
        expect(getActorDefinitionMock).not.toHaveBeenCalled();
    });

    it('does NOT leak a cached private Actor MCP URL to a non-owner — re-fetches and returns false', async () => {
        seedCache('acme/mcp-private', false, 'owner-7', { id: 'actorpriv', webServerMcpPath: '/mcp' });
        getUserInfoCachedMock.mockResolvedValue({ userId: 'intruder', userPlanTier: 'FREE' });
        getActorDefinitionMock.mockResolvedValue(null); // intruder's own fetch is unauthorized

        const result = await getActorMcpUrlCached('acme/mcp-private', client);

        expect(result).toBe(false);
        expect(getActorDefinitionMock).toHaveBeenCalledWith('acme/mcp-private', client);
    });

    it('returns false for a non-existent Actor without throwing', async () => {
        getActorDefinitionMock.mockResolvedValue(null);

        await expect(getActorMcpUrlCached('acme/missing', client)).resolves.toBe(false);
    });

    it('returns false for an Actor that is not an MCP server', async () => {
        seedCache('acme/not-mcp', true, 'owner-8', { id: 'actorplain' });

        const result = await getActorMcpUrlCached('acme/not-mcp', client);

        expect(result).toBe(false);
    });
});

function seedRefetch(ownerUserId: string): ActorDefinitionWithInfo {
    return {
        definition: { id: 'refetched', actorFullName: 'refetched' },
        info: { id: 'refetched', isPublic: false, userId: ownerUserId },
    } as unknown as ActorDefinitionWithInfo;
}
