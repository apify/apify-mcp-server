import { describe, expect, it } from 'vitest';

import { getActorDefinitionCached } from '../../src/utils/actor.js';
import {
    mockActorBuildClient,
    mockBuild,
    mockDefaultBuild,
    mockStandbyActor,
    SEARCH_SCHEMA,
    STANDBY_BUILD_ID,
} from './helpers/actor_build_client.js';

describe('standby build resolution across cached callers', () => {
    it('resolves the server build for an authenticated caller after an incomplete anonymous lookup', async () => {
        const actor = mockStandbyActor('1.2.3', { isPublic: true });
        const anonymous = mockActorBuildClient({ actor, defaultBuild: mockDefaultBuild(), hasToken: false });
        const authenticated = mockActorBuildClient({
            actor,
            defaultBuild: mockDefaultBuild(),
            buildList: [{ id: STANDBY_BUILD_ID, buildNumber: '1.2.3' }],
            builds: { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID, { webServerMcpPath: '/mcp' }) },
        });

        const incomplete = await getActorDefinitionCached('apify/anonymous-build-cache', anonymous.apifyClient);
        const resolved = await getActorDefinitionCached('apify/anonymous-build-cache', authenticated.apifyClient);

        expect(incomplete?.definition.webServerMcpPath).toBeUndefined();
        expect(anonymous.list).not.toHaveBeenCalled();
        expect(resolved?.definition.webServerMcpPath).toBe('/mcp');
        expect(authenticated.list).toHaveBeenCalledOnce();
    });

    it('reuses a complete anonymous server definition for an authenticated caller', async () => {
        const actor = mockStandbyActor('latest', {
            isPublic: true,
            taggedBuilds: { latest: { buildId: STANDBY_BUILD_ID } },
        });
        const anonymous = mockActorBuildClient({
            actor,
            defaultBuild: mockDefaultBuild(),
            hasToken: false,
            builds: { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID, { webServerSchema: SEARCH_SCHEMA }) },
        });
        const authenticated = mockActorBuildClient({ actor, defaultBuild: mockDefaultBuild() });

        const complete = await getActorDefinitionCached('apify/complete-build-cache', anonymous.apifyClient);
        const cached = await getActorDefinitionCached('apify/complete-build-cache', authenticated.apifyClient);

        expect(complete?.definition.hasWebServerSchema).toBe(true);
        expect(cached).toBe(complete);
        expect(authenticated.buildGet).not.toHaveBeenCalled();
    });
});
