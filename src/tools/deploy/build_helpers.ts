import type { ActorBuildOptions, Build } from 'apify-client';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS } from '../../const.js';
import type { ConsoleLinkContext } from '../../types.js';
import { buildConsoleBuildUrl } from '../../utils/console_link.js';
import { TERMINAL_RUN_STATUSES } from '../../utils/progress.js';
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

/**
 * The one next step after a build was started, by build status. Tool names appear only when the
 * session loaded them; `tag` is what `callOptions.build` should be set to once the build succeeded.
 */
export function buildNextStepForBuild(build: Build, tag: string | undefined, loadedToolNames: readonly string[]): string {
    if (build.status === 'SUCCEEDED') {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)
            ? `Run the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to ${tag ?? build.buildNumber}.`
            : 'The build is ready to run.';
    }
    const hasGetBuild = loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD_GET);
    if (TERMINAL_RUN_STATUSES.has(build.status)) {
        return hasGetBuild
            ? `Fetch the build log with ${HELPER_TOOLS.ACTOR_BUILD_GET} (buildId ${build.id}, lines 50) to see the error.`
            : 'Inspect the build log for the error, fix the source, and build again.';
    }
    return hasGetBuild
        ? `Check progress with ${HELPER_TOOLS.ACTOR_BUILD_GET} using buildId ${build.id}.`
        : 'The build is still running; check its status again in a few seconds.';
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
