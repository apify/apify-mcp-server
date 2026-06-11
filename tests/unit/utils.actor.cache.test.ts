import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import type { ActorDefinitionWithInfo } from '../../src/types.js';

vi.mock('../../src/tools/build.js', () => ({ getActorDefinition: vi.fn() }));
vi.mock('../../src/utils/userid_cache.js', () => ({ getUserInfoCached: vi.fn() }));

import { actorDefinitionCache } from '../../src/state.js';
import { getActorDefinition } from '../../src/tools/build.js';
import { getActorDefinitionCached } from '../../src/utils/actor.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';

const getActorDefinitionMock = vi.mocked(getActorDefinition);
const getUserInfoCachedMock = vi.mocked(getUserInfoCached);

function seedCache(name: string, isPublic: boolean, ownerUserId: string): ActorDefinitionWithInfo {
    const entry = {
        definition: { id: name, actorFullName: name },
        info: { id: name, isPublic, userId: ownerUserId },
    } as unknown as ActorDefinitionWithInfo;
    actorDefinitionCache.set(name, entry);
    return entry;
}

const client = { token: 'caller-token' } as unknown as ApifyClient;

describe('getActorDefinitionCached — tenant isolation', () => {
    beforeEach(() => {
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

    it('does NOT serve a cached private Actor to a non-owner — re-fetches under the caller token', async () => {
        seedCache('acme/private-other', false, 'owner-3');
        getUserInfoCachedMock.mockResolvedValue({ userId: 'intruder', userPlanTier: 'FREE' });
        getActorDefinitionMock.mockResolvedValue(null);

        const result = await getActorDefinitionCached('acme/private-other', client);

        expect(result).toBeNull();
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
});
