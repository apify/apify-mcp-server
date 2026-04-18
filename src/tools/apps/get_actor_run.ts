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
 * Apps mode get-actor-run tool.
 * Returns abbreviated text with widget metadata for interactive progress display.
 */
export const appsGetActorRun: ToolEntry = Object.freeze({
    ...getActorRunMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, mcpSessionId } = toolArgs;
        const parsed = getActorRunArgs.parse(args);

        try {
            const fetchResult = await fetchActorRunData({
                runId: parsed.runId,
                client,
                mcpSessionId,
            });

            if ('error' in fetchResult) {
                return fetchResult.error;
            }

            return buildGetActorRunSuccessResponse({ ...fetchResult.result, widget: true });
        } catch (error) {
            logHttpError(error, 'Failed to get Actor run', { runId: parsed.runId });
            return buildGetActorRunError(parsed.runId, error);
        }
    },
} as const);
