import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { ABORT, WAIT_SECS_MAX } from '../../src/tools/actors/actor_run_response.js';
import { buildNextStepForBuild, listVersionNumbers, startBuild } from '../../src/tools/deploy/build_helpers.js';
import type { InternalToolArgs } from '../../src/types.js';

// Cast because the client's `Build.status` type lists only terminal statuses; the API also returns RUNNING.
const runningBuild = { id: 'build-1', buildNumber: '0.0.3', status: 'RUNNING' } as unknown as Parameters<
    typeof buildNextStepForBuild
>[0];

describe('buildNextStepForBuild', () => {
    it('points a still-running build at get-actor-build by default when that tool is loaded', () => {
        expect(buildNextStepForBuild(runningBuild, { loadedToolNames: [HELPER_TOOLS.ACTOR_BUILD_GET] })).toBe(
            `Check progress with ${HELPER_TOOLS.ACTOR_BUILD_GET} using buildId build-1 (it waits up to ${WAIT_SECS_MAX} seconds per call).`,
        );
    });

    it('names no tool for a still-running build by default when get-actor-build is not loaded', () => {
        const nextStep = buildNextStepForBuild(runningBuild, { loadedToolNames: [HELPER_TOOLS.ACTOR_BUILD] });

        expect(nextStep).toBe('The build is still running; check its status again in a few seconds.');
        expect(nextStep).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
    });

    it('uses the caller-supplied text for a still-running build instead of the default', () => {
        const nextStep = buildNextStepForBuild(runningBuild, {
            loadedToolNames: [HELPER_TOOLS.ACTOR_BUILD_GET],
            nonTerminalNextStep: 'Call this tool again.',
        });

        expect(nextStep).toBe('Call this tool again.');
    });

    it('ignores the caller-supplied text once the build is terminal', () => {
        const nextStep = buildNextStepForBuild(
            { ...runningBuild, status: 'SUCCEEDED' },
            { loadedToolNames: [], nonTerminalNextStep: 'Call this tool again.' },
        );

        expect(nextStep).toBe('The build is ready to run.');
    });
});

describe('startBuild', () => {
    it('returns ABORT when the request signal is already aborted', async () => {
        const buildMock = vi.fn().mockResolvedValue({ id: 'build-1', status: 'SUCCEEDED' });
        const client = { actor: () => ({ build: buildMock }) } as unknown as InternalToolArgs['apifyClient'];
        const controller = new AbortController();
        controller.abort();

        const result = await startBuild(client, 'actor-1', '0.1', {
            useCache: true,
            waitSecs: WAIT_SECS_MAX,
            signal: controller.signal,
        });

        // The build was started, but the aborted signal wins the race even though the call resolved.
        expect(result).toBe(ABORT);
        expect(buildMock).toHaveBeenCalledWith('0.1', { useCache: true, waitForFinish: WAIT_SECS_MAX });
    });
});

describe('listVersionNumbers', () => {
    it('returns the version numbers in order and skips versions without one', () => {
        const actor = { versions: [{ versionNumber: '0.1' }, {}, { versionNumber: '0.2' }] } as Parameters<
            typeof listVersionNumbers
        >[0];

        expect(listVersionNumbers(actor)).toEqual(['0.1', '0.2']);
    });
});
