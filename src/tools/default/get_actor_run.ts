import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { logHttpError } from '../../utils/logging.js';
import {
    buildGetActorRunError,
    buildGetActorRunSuccessResponse,
    fetchActorRunData,
    getActorRunArgs,
    getActorRunMetadata,
} from '../core/get_actor_run_common.js';

/**
 * Default mode `get-actor-run` — returns the canonical v4 shape with no widget metadata.
 */
export const defaultGetActorRun: ToolEntry = Object.freeze({
    ...getActorRunMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, progressTracker, mcpSessionId } = toolArgs;
        const parsed = getActorRunArgs.parse(args);

        try {
            const fetchResult = await fetchActorRunData({
                runId: parsed.runId,
                waitSecs: parsed.waitSecs,
                client,
                progressTracker,
                mcpSessionId,
            });

            if ('error' in fetchResult) {
                return fetchResult.error;
            }

            return buildGetActorRunSuccessResponse({ ...fetchResult.result, widget: false });
        } catch (error) {
            logHttpError(error, 'Failed to get Actor run', { runId: parsed.runId });
            return buildGetActorRunError(parsed.runId, error);
        }
    },
} as const);
