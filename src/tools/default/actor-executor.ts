import type { ActorExecutionParams, ActorExecutionResult, ActorExecutor } from '../../types.js';
import { buildUsageMeta } from '../../utils/mcp.js';
import { callActorGetDataset } from '../core/actor-execution.js';
import { buildActorResponseContent } from '../core/actor-response.js';

/**
 * Default actor executor for normal (non-UI) mode.
 * Runs actors synchronously — waits for completion, returns dataset results.
 */
export const defaultActorExecutor: ActorExecutor = {
    async executeActorTool(params: ActorExecutionParams): Promise<ActorExecutionResult> {
        const callResult = await callActorGetDataset({
            actorName: params.actorFullName,
            input: params.input,
            apifyClient: params.apifyClient,
            callOptions: params.callOptions,
            progressTracker: params.progressTracker,
            abortSignal: params.abortSignal,
            mcpSessionId: params.mcpSessionId,
        });

        if (!callResult) {
            return null;
        }

        const { content, structuredContent } = buildActorResponseContent(params.actorFullName, callResult);
        const _meta = buildUsageMeta(callResult);
        return {
            content,
            structuredContent,
            ...(_meta && { _meta }),
        };
    },
};
