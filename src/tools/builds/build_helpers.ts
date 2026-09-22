import type { Build } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS } from '../../const.js';
import type { ConsoleLinkContext } from '../../types.js';
import { buildConsoleBuildUrl } from '../../utils/console_link.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondOk } from '../../utils/mcp.js';
import type { ProgressTracker } from '../../utils/progress.js';
import { formatBuildStatusMessage, TERMINAL_RUN_STATUSES } from '../../utils/progress.js';
import { ABORT, raceAbort, toIsoString, WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import { apifyConsoleLinkText } from '../storage/storage_helpers.js';

/** The build tools wait this long by default, the same as `get-actor-run` and `call-actor`, so a loop of build and run calls behaves alike. */
export const BUILD_WAIT_SECS_DEFAULT = 30;

/**
 * The `waitSecs` field shared by the tools that report a build, so they agree on the cap and the
 * default. `zeroMeans` says what a caller gets back with 0: the current status, or a build just started.
 */
export function buildWaitSecsField(zeroMeans: string) {
    return z
        .number()
        .int()
        .min(0)
        .max(WAIT_SECS_MAX)
        .optional()
        .default(BUILD_WAIT_SECS_DEFAULT)
        .describe(
            `Maximum seconds to wait for the build to reach a terminal state (SUCCEEDED, FAILED, ABORTED, TIMED-OUT). ${zeroMeans} Cap: ${WAIT_SECS_MAX}. Default: ${BUILD_WAIT_SECS_DEFAULT}.`,
        );
}

/**
 * The build subset returned by the build tools. Allowlisted so internal fields on the API
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
        apifyConsoleUrl: buildConsoleBuildUrl(linkContext, build.actId, build.buildNumber),
    };
}

/**
 * The one next step after a build reaches `status`, shared by every tool that reports a build.
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
            : `The Actor is ready to run with build ${build.buildNumber}.`;
    }
    if (TERMINAL_RUN_STATUSES.has(build.status)) {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD_LOG)
            ? `Read the build log with ${HELPER_TOOLS.ACTOR_BUILD_LOG} using buildId ${build.id}; pass lines 0 for the whole log.`
            : 'Read the build log for the error, fix the source, and build again.';
    }
    return nonTerminalNextStep;
}

/**
 * The response every tool that reports a build returns: the JSON first, then the summary with
 * its one next step, then the Console link when the session has one. Shared so the tools cannot drift
 * in ordering or in how they treat the link.
 */
export function respondWithBuild(params: {
    structuredContent: Record<string, unknown> & { build?: { apifyConsoleUrl?: string } };
    summary: string;
    nextStep: string;
}): ToolResponse {
    const { structuredContent, summary, nextStep } = params;
    const consoleLinkText = apifyConsoleLinkText(structuredContent.build?.apifyConsoleUrl);
    return respondOk(
        [JSON.stringify(structuredContent), `${summary}\n${nextStep}`, ...(consoleLinkText ? [consoleLinkText] : [])],
        { structuredContent },
    );
}

/** The subject the progress notifications lead with, the same one the summary lines use. */
function formatBuildLabel(build: Pick<Build, 'buildNumber' | 'actId'>): string {
    return `Build ${build.buildNumber} of Actor ${build.actId}`;
}

/**
 * Waits up to `waitSecs` for an unfinished build, emitting its status changes as progress notifications
 * while it does, the way the run tools do; the wait is raced against `signal`. Returns the build as it
 * stands when the wait ends, or {@link ABORT} when the request was cancelled.
 */
export async function waitForBuild(
    client: ApifyClient,
    build: Build,
    options: { waitSecs: number; signal?: AbortSignal; progressTracker?: ProgressTracker | null },
): Promise<Build | typeof ABORT> {
    const { waitSecs, signal, progressTracker } = options;
    const label = formatBuildLabel(build);
    if (progressTracker) {
        await progressTracker.updateProgress(formatBuildStatusMessage(label, build));
        progressTracker.startActorBuildUpdates(build.id, client, label, build);
    }
    try {
        const finished = await raceAbort(client.build(build.id).get({ waitForFinish: waitSecs }), signal);
        if (finished === ABORT) return ABORT;
        // `get()` is undefined only for a build that does not exist; this one was just fetched.
        const current = finished ?? build;
        await progressTracker?.updateProgress(formatBuildStatusMessage(label, current));
        return current;
    } finally {
        progressTracker?.stop();
    }
}
