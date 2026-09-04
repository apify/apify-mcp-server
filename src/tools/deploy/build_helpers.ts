import type { ActorBuildOptions, Build } from 'apify-client';

import type { ApifyClient } from '../../apify_client.js';
import type { ConsoleLinkContext } from '../../types.js';
import { buildConsoleBuildUrl } from '../../utils/console_link.js';
import { toIsoString } from '../actors/actor_run_response.js';

/**
 * The build subset returned by the deploy tools. Allowlisted so internal fields on the API
 * document (userId, meta, options, inspectorId) never reach the client.
 * `apifyConsoleUrl` is set only for Console UI token sessions (see `getConsoleLinkContext`).
 */
export function toBuildResult(build: Build, linkContext: ConsoleLinkContext | undefined) {
    return {
        id: build.id,
        actorId: build.actId,
        buildNumber: build.buildNumber,
        status: build.status,
        // Normalized because the client parses these into `Date` objects; the output schema promises strings.
        startedAt: toIsoString(build.startedAt) ?? null,
        finishedAt: toIsoString(build.finishedAt) ?? null,
        apifyConsoleUrl: buildConsoleBuildUrl(linkContext, build.actId, build.id),
    };
}

/** Starts a build of an Actor version and waits up to `waitSecs` for it to finish. */
export async function startBuild(
    client: ApifyClient,
    actorId: string,
    versionNumber: string,
    options: { tag?: string; useCache: boolean; waitSecs: number },
): Promise<Build> {
    const { tag, useCache, waitSecs } = options;
    return await client.actor(actorId).build(versionNumber, {
        ...(tag !== undefined && { tag }),
        useCache,
        waitForFinish: waitSecs,
    } satisfies ActorBuildOptions);
}
