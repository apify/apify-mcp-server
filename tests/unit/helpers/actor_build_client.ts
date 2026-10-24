import type { Build } from 'apify-client';
import { vi } from 'vitest';

import type { ApifyClient } from '../../../src/apify_client.js';
import type { Actor, ActorDefinitionWithServerInterface } from '../../../src/types.js';
import { mockApifyClient } from './tool_context.js';

export const DEFAULT_BUILD_ID = 'build-default';
export const STANDBY_BUILD_ID = 'build-standby';

/** The default build's input schema; both readers must keep serving it whatever the standby build resolves to. */
export const DEFAULT_INPUT = {
    type: 'object',
    properties: { query: { type: 'string', title: 'Query', description: 'Search query' } },
};

/** An OpenAPI document with one operation. */
export const SEARCH_SCHEMA = { paths: { '/search': { post: { summary: 'Search' } } } };

export function mockActor(overrides: Partial<Actor> = {}): Actor {
    return {
        id: 'actor-id',
        userId: 'user-id',
        username: 'acme',
        name: 'mcp-server',
        isPublic: false,
        createdAt: new Date(0),
        modifiedAt: new Date(0),
        stats: {
            totalBuilds: 1,
            totalRuns: 0,
            totalUsers: 0,
            totalUsers7Days: 0,
            totalUsers30Days: 0,
            totalUsers90Days: 0,
            totalMetamorphs: 0,
            lastRunStartedAt: new Date(0),
        },
        versions: [],
        defaultRunOptions: { build: 'latest', memoryMbytes: 256, timeoutSecs: 300 },
        deploymentKey: 'test-deployment-key',
        actorPermissionLevel: 'LIMITED_PERMISSIONS',
        ...overrides,
    };
}

/** Standby enabled and bound to the build `reference` names (a tag or a build number). */
export function mockStandbyActor(reference: string | undefined, overrides: Partial<Actor> = {}): Actor {
    return mockActor({ actorStandby: { isEnabled: true, build: reference }, ...overrides });
}

export function mockBuild(id: string, actorDefinition?: Partial<ActorDefinitionWithServerInterface>): Build {
    return {
        id,
        actId: 'actor-id',
        userId: 'user-id',
        startedAt: new Date(0),
        status: 'SUCCEEDED',
        meta: { origin: 'WEB', clientIp: '127.0.0.1', userAgent: 'test' },
        buildNumber: '1.0.0',
        actorDefinition: actorDefinition && {
            actorSpecification: 1,
            name: 'mcp-server',
            version: '1.0',
            ...actorDefinition,
        },
    };
}

/**
 * The default build, seeded with server fields that conflict with every standby build in these tests:
 * a reader that leaks them serves a stale MCP path and HTTP schema.
 */
export function mockDefaultBuild(definitionOverrides: Partial<ActorDefinitionWithServerInterface> = {}): Build {
    return mockBuild(DEFAULT_BUILD_ID, {
        readme: '# Default build README',
        // `fetchActorDetails` rewrites the input's properties in place, so each build gets its own copy.
        input: structuredClone(DEFAULT_INPUT),
        webServerMcpPath: '/stale-mcp',
        webServerSchema: { paths: { '/stale': { get: {} } } },
        ...definitionOverrides,
    });
}

export type BuildListItem = { id: string; buildNumber: string };

/**
 * Fake ApifyClient covering what the two definition readers call: `actor().get/defaultBuild/builds().list()`
 * and `build().get()`. `builds` maps a build ID to what `build(id).get()` resolves (`undefined` reads as a
 * deleted build, like apify-client's 404 handling). `buildList` is what `builds().list()` iterates, newest
 * first; `pulledBuildIds` records how far a consumer scanned it. `buildListFailure` makes that read fail the
 * way apify-client's paginated iterator does: on the first item, not on the `list()` call.
 */
export function mockActorBuildClient({
    actor,
    defaultBuild,
    builds = {},
    buildList = [],
    buildListFailure,
    hasToken = true,
}: {
    actor: Actor;
    defaultBuild: Build;
    builds?: Record<string, Build | undefined>;
    buildList?: BuildListItem[];
    buildListFailure?: unknown;
    /** `false` is a token-less (payment provider) session. */
    hasToken?: boolean;
}) {
    const pulledBuildIds: string[] = [];
    const buildGet = vi.fn(async (buildId: string) => builds[buildId]);
    const list = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
            if (buildListFailure) throw buildListFailure;
            for (const item of buildList) {
                pulledBuildIds.push(item.id);
                yield item;
            }
        },
    }));
    const apifyClient: ApifyClient = mockApifyClient({
        token: hasToken ? 'test-token' : undefined,
        actor: () => ({
            get: async () => actor,
            defaultBuild: async () => ({ get: async () => defaultBuild }),
            builds: () => ({ list }),
        }),
        build: (buildId: string) => ({ get: () => buildGet(buildId) }),
    });
    return { apifyClient, buildGet, list, pulledBuildIds };
}
