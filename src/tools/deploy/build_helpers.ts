import type { Build } from 'apify-client';

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
 * The one next step after a build reaches `status`, shared by every deploy tool that reports a build.
 * Sibling tools are named only when the session was served them (`loadedToolNames`), and each hint
 * keeps a fallback so the text is never a dead end. `nonTerminalNextStep` comes from the caller
 * because only the calling tool may name itself ("call this tool again").
 */
export function buildNextStepForBuild(
    build: Pick<Build, 'id' | 'buildNumber' | 'status'>,
    options: { loadedToolNames: readonly string[]; nonTerminalNextStep: string },
): string {
    const { loadedToolNames, nonTerminalNextStep } = options;
    if (build.status === 'SUCCEEDED') {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)
            ? `Run the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to ${build.buildNumber}.`
            : 'The build is ready to run.';
    }
    if (TERMINAL_RUN_STATUSES.has(build.status)) {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD_LOG)
            ? `Read the build log with ${HELPER_TOOLS.ACTOR_BUILD_LOG} using buildId ${build.id}; pass lines 0 for the whole log.`
            : 'Read the build log for the error, fix the source, and build again.';
    }
    return nonTerminalNextStep;
}
