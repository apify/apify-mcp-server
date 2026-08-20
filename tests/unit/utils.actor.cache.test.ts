import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import type { ActorDefinitionWithInfo } from '../../src/types.js';

vi.mock('../../src/tools/actors/actor_definition.js', () => ({ getActorDefinition: vi.fn() }));
vi.mock('../../src/utils/userid_cache.js', () => ({ getUserInfoCached: vi.fn() }));

import { actorDefinitionCache } from '../../src/state.js';
import { getActorDefinition } from '../../src/tools/actors/actor_definition.js';
import { TOOL_TYPE } from '../../src/types.js';
import { getActorDefinitionCached, getActorMcpUrlCached, getActorToolResolutionCached } from '../../src/utils/actor.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';

const getActorDefinitionMock = vi.mocked(getActorDefinition);
const getUserInfoCachedMock = vi.mocked(getUserInfoCached);

// Each test uses a unique Actor name, so the shared module-level cache never collides between cases.
function seedCache(
    name: string,
    isPublic: boolean,
    ownerUserId: string,
    opts: { id?: string; webServerMcpPath?: string; isStandbyEnabled?: boolean; input?: unknown } = {},
): ActorDefinitionWithInfo {
    const id = opts.id ?? name;
    const entry = {
        definition: {
            id,
            actorFullName: name,
            ...(opts.webServerMcpPath && { webServerMcpPath: opts.webServerMcpPath }),
            ...(opts.input !== undefined && { input: opts.input }),
        },
        info: {
            id,
            isPublic,
            userId: ownerUserId,
            ...(opts.isStandbyEnabled && { actorStandby: { isEnabled: true } }),
        },
    } as unknown as ActorDefinitionWithInfo;
    actorDefinitionCache.set(name, entry);
    return entry;
}

const NON_EMPTY_INPUT = { type: 'object', properties: { url: { type: 'string' } } };

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
        seedCache('acme/mcp-public', true, 'owner-6', {
            id: 'actorpub',
            webServerMcpPath: '/mcp',
            isStandbyEnabled: true,
        });

        const result = await getActorMcpUrlCached('acme/mcp-public', client);

        expect(result).toBe('https://actorpub.apify.actor/mcp');
        expect(getActorDefinitionMock).not.toHaveBeenCalled();
    });

    it('does NOT leak a cached private Actor MCP URL to a non-owner — re-fetches and returns false', async () => {
        seedCache('acme/mcp-private', false, 'owner-7', {
            id: 'actorpriv',
            webServerMcpPath: '/mcp',
            isStandbyEnabled: true,
        });
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

describe('getActorMcpUrlCached — tool-type rule', () => {
    it('returns false when standby is disabled despite a leftover webServerMcpPath', async () => {
        seedCache('acme/stale-path', true, 'owner-8', { id: 'actorstale', webServerMcpPath: '/mcp' });

        await expect(getActorMcpUrlCached('acme/stale-path', client)).resolves.toBe(false);
    });

    it('returns false for a standby Actor with no MCP server and an empty input schema', async () => {
        seedCache('acme/standby-empty-url', true, 'owner-9', { id: 'actorsbe', isStandbyEnabled: true });

        await expect(getActorMcpUrlCached('acme/standby-empty-url', client)).resolves.toBe(false);
    });
});

describe('getActorToolResolutionCached()', () => {
    it('resolves a run-only Actor to ACTOR with no MCP URL', async () => {
        seedCache('acme/run-only', true, 'owner-10', { input: NON_EMPTY_INPUT });

        await expect(getActorToolResolutionCached('acme/run-only', client)).resolves.toEqual({
            toolType: TOOL_TYPE.ACTOR,
            mcpServerUrl: null,
            actorFullName: 'acme/run-only',
        });
    });

    it('resolves a run-only Actor with a leftover webServerMcpPath to ACTOR with no MCP URL', async () => {
        seedCache('acme/run-only-stale', true, 'owner-11', {
            id: 'actorstale2',
            webServerMcpPath: '/mcp',
            input: NON_EMPTY_INPUT,
        });

        await expect(getActorToolResolutionCached('acme/run-only-stale', client)).resolves.toEqual({
            toolType: TOOL_TYPE.ACTOR,
            mcpServerUrl: null,
            actorFullName: 'acme/run-only-stale',
        });
    });

    it('resolves a standby Actor with an MCP path to ACTOR_MCP and its URL', async () => {
        seedCache('acme/standby-mcp', true, 'owner-12', {
            id: 'actormcp',
            webServerMcpPath: '/mcp',
            isStandbyEnabled: true,
        });

        await expect(getActorToolResolutionCached('acme/standby-mcp', client)).resolves.toEqual({
            toolType: TOOL_TYPE.ACTOR_MCP,
            mcpServerUrl: 'https://actormcp.apify.actor/mcp',
            actorFullName: 'acme/standby-mcp',
        });
    });

    it('resolves a standby Actor without an MCP path but with a non-empty input schema to ACTOR', async () => {
        seedCache('acme/standby-input', true, 'owner-13', { isStandbyEnabled: true, input: NON_EMPTY_INPUT });

        await expect(getActorToolResolutionCached('acme/standby-input', client)).resolves.toEqual({
            toolType: TOOL_TYPE.ACTOR,
            mcpServerUrl: null,
            actorFullName: 'acme/standby-input',
        });
    });

    it('resolves a standby Actor without an MCP path and an empty input schema to no tool type', async () => {
        seedCache('acme/standby-empty', true, 'owner-14', { isStandbyEnabled: true });

        await expect(getActorToolResolutionCached('acme/standby-empty', client)).resolves.toEqual({
            toolType: null,
            mcpServerUrl: null,
            actorFullName: 'acme/standby-empty',
        });
    });

    it('reports the canonical Actor full name when the Actor is addressed by its ID', async () => {
        const entry = seedCache('acme/standby-empty-by-id', true, 'owner-15', { isStandbyEnabled: true });
        actorDefinitionCache.set('aBcD1234', entry);

        await expect(getActorToolResolutionCached('aBcD1234', client)).resolves.toEqual({
            toolType: null,
            mcpServerUrl: null,
            actorFullName: 'acme/standby-empty-by-id',
        });
    });

    it('returns null for an Actor with no cached or fetchable definition', async () => {
        getActorDefinitionMock.mockResolvedValue(null);

        await expect(getActorToolResolutionCached('acme/missing-resolution', client)).resolves.toBeNull();
    });
});
