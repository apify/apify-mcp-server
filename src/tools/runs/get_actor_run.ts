import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { logHttpError } from '../../utils/logging.js';
import { fetchActorRunData } from '../actors/actor_run_response.js';
import {
    buildGetActorRunError,
    buildGetActorRunSuccessResponse,
    getActorRunArgs,
    getActorRunMetadata,
} from './get_actor_run_common.js';

/**
 * Default mode `get-actor-run` — returns without any widget metadata.
 */
export const defaultGetActorRun: ToolEntry = Object.freeze({
    ...getActorRunMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, progressTracker, mcpSessionId, extra } = toolArgs;
        const parsed = getActorRunArgs.parse(args);

        try {
            const fetchResult = await fetchActorRunData({
                runId: parsed.runId,
                waitSecs: parsed.waitSecs,
                client,
                progressTracker,
                abortSignal: extra?.signal,
                mcpSessionId,
            });

            // Per MCP spec, receivers SHOULD NOT send a response for a cancelled request:
            // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation
            if ('aborted' in fetchResult) return {};
            if ('error' in fetchResult) return fetchResult.error;

            return buildGetActorRunSuccessResponse({
                ...fetchResult.result,
                widget: false,
                linkContext: await getConsoleLinkContext(apifyToken, client),
            });
        } catch (error) {
            logHttpError(error, 'Failed to get Actor run', { runId: parsed.runId });
            return buildGetActorRunError(parsed.runId, error);
        }
    },
} as const);
