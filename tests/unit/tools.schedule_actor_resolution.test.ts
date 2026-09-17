/**
 * Actor resolution for schedule actions, against the REAL `actorDefinitionCache` and the real
 * ownership gate. `tools.schedule_crud.test.ts` mocks `getActorDefinitionCached`, so it cannot see
 * a cache-keying defect; this file exists to cover exactly that.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/tools/actors/actor_definition.js', () => ({ getActorDefinition: vi.fn() }));

import type { ApifyClient } from '../../src/apify_client.js';
import { getActorDefinition } from '../../src/tools/actors/actor_definition.js';
import { buildApiActions } from '../../src/tools/schedules/schedule_helpers.js';
import type { ActorDefinitionWithInfo } from '../../src/types.js';

const getActorDefinitionMock = vi.mocked(getActorDefinition);

/** A tenant's client: `actor(id).get()` answers only for the Actors that tenant owns or can see. */
function tenantClient(actorsById: Record<string, { id: string }>): ApifyClient {
    return {
        token: `token-${Object.keys(actorsById).join('-')}`,
        actor: (id: string) => ({ get: async () => actorsById[id] }),
    } as unknown as ApifyClient;
}

function actorDefinition(id: string, ownerUserId: string): ActorDefinitionWithInfo {
    return {
        definition: { id, actorFullName: `${ownerUserId}/shared` },
        info: { id, isPublic: true, userId: ownerUserId },
    } as unknown as ActorDefinitionWithInfo;
}

beforeEach(() => {
    getActorDefinitionMock.mockReset();
});

describe('buildApiActions() Actor resolution', () => {
    // A bare name is caller-relative ("my Actor called X"), so it must never be answered from a
    // process-wide cache keyed on that name: two tenants can each own a public Actor called X.
    it('resolves the same bare Actor name to each tenant own Actor', async () => {
        const name = `shared-${Math.random().toString(36).slice(2, 10)}`;
        getActorDefinitionMock.mockResolvedValue(actorDefinition('ACTOR000000000001', 'tenant-a'));
        const tenantA = tenantClient({ [`~${name}`]: { id: 'ACTOR000000000001' } });
        const tenantB = tenantClient({ [`~${name}`]: { id: 'ACTOR000000000002' } });

        const first = await buildApiActions(tenantA, [{ actorId: name }]);
        getActorDefinitionMock.mockResolvedValue(actorDefinition('ACTOR000000000002', 'tenant-b'));
        const second = await buildApiActions(tenantB, [{ actorId: name }]);

        expect(first).toEqual({ actions: [{ type: 'RUN_ACTOR', actorId: 'ACTOR000000000001' }] });
        expect(second).toEqual({ actions: [{ type: 'RUN_ACTOR', actorId: 'ACTOR000000000002' }] });
    });

    it('reports a bare name the caller does not own as not found, even after another tenant used it', async () => {
        const name = `orphan-${Math.random().toString(36).slice(2, 10)}`;
        getActorDefinitionMock.mockResolvedValue(actorDefinition('ACTOR000000000003', 'tenant-a'));
        const owner = tenantClient({ [`~${name}`]: { id: 'ACTOR000000000003' } });
        const stranger = tenantClient({});

        await buildApiActions(owner, [{ actorId: name }]);
        const result = await buildApiActions(stranger, [{ actorId: name }]);

        expect(result).toEqual({ error: `Actor ${name} was not found.` });
    });

    it('resolves a qualified name through the caller own client', async () => {
        const client = tenantClient({ 'apify/hello-world': { id: 'ACTOR000000000004' } });

        const result = await buildApiActions(client, [{ actorId: 'apify/hello-world' }]);

        expect(result).toEqual({ actions: [{ type: 'RUN_ACTOR', actorId: 'ACTOR000000000004' }] });
    });
});
