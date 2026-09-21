import type { Actor, ActorBuildOptions, Build } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS } from '../../const.js';
import type { ConsoleLinkContext } from '../../types.js';
import { buildConsoleBuildUrl } from '../../utils/console_link.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondOk } from '../../utils/mcp.js';
import { TERMINAL_RUN_STATUSES } from '../../utils/progress.js';
import { type ABORT, raceAbort, toIsoString, WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import { apifyConsoleLinkText } from '../storage/storage_helpers.js';

/** The MAJOR.MINOR numbers of the Actor's versions; a version document without one is skipped. */
export function listVersionNumbers(actor: Pick<Actor, 'versions'>): string[] {
    return actor.versions.flatMap((version) => version.versionNumber ?? []);
}

/** The deploy tools wait this long by default, the same as `get-actor-run` and `call-actor`, so a loop of build and run calls behaves alike. */
export const BUILD_WAIT_SECS_DEFAULT = 30;

/**
 * The `waitSecs` field shared by the deploy tools that report a build, so they agree on the cap and the
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
        apifyConsoleUrl: buildConsoleBuildUrl(linkContext, build.actId, build.buildNumber),
    };
}

/**
 * Starts a build of an Actor version and waits up to `waitSecs` for it to finish.
 * The wait is raced against `signal`, so a cancelled request resolves to {@link ABORT} instead of blocking.
 */
export async function startBuild(
    client: ApifyClient,
    actorId: string,
    versionNumber: string,
    options: { tag?: string; useCache: boolean; waitSecs: number; signal?: AbortSignal },
): Promise<Build | typeof ABORT> {
    const { tag, useCache, waitSecs, signal } = options;
    return await raceAbort(
        client.actor(actorId).build(versionNumber, {
            ...(tag !== undefined && { tag }),
            useCache,
            waitForFinish: waitSecs,
        } satisfies ActorBuildOptions),
        signal,
    );
}

/**
 * The one next step after a build reaches `status`, shared by every deploy tool that reports a build.
 * Sibling tools are named only when the session was served them (`loadedToolNames`), and each hint
 * keeps a fallback so the text is never a dead end. A still-running build points at get-actor-build;
 * only get-actor-build itself passes `nonTerminalNextStep`, because only the calling tool may name
 * itself ("call this tool again").
 */
export function buildNextStepForBuild(
    build: Pick<Build, 'id' | 'buildNumber' | 'status'>,
    options: { loadedToolNames: readonly string[]; nonTerminalNextStep?: string },
): string {
    const { loadedToolNames } = options;
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
    if (options.nonTerminalNextStep !== undefined) return options.nonTerminalNextStep;
    return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD_GET)
        ? `Check progress with ${HELPER_TOOLS.ACTOR_BUILD_GET} using buildId ${build.id} (it waits up to ${WAIT_SECS_MAX} seconds per call).`
        : 'The build is still running; check its status again in a few seconds.';
}

/**
 * The response every deploy tool that reports a build returns: the JSON first, then the summary with
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
