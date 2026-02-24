import { createApifyClientWithSkyfireSupport } from '../../apify-client.js';
import { TOOL_STATUS } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { logHttpError } from '../../utils/logging.js';
import { buildMCPResponse, buildUsageMeta } from '../../utils/mcp.js';
import {
    fetchActorRunData,
    getActorRunArgs,
    getActorRunMetadata,
} from '../core/get-actor-run-common.js';

/**
 * Default mode get-actor-run tool.
 * Returns full JSON dump of the run without widget metadata.
 */
export const defaultGetActorRun: ToolEntry = Object.freeze({
    ...getActorRunMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer, mcpSessionId } = toolArgs;
        const parsed = getActorRunArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);

        try {
            const fetchResult = await fetchActorRunData({
                runId: parsed.runId,
                client,
                mcpSessionId,
            });

            if ('error' in fetchResult) {
                return fetchResult.error;
            }

            const { run, structuredContent } = fetchResult.result;

            const texts = [
                `# Actor Run Information\n\`\`\`json\n${JSON.stringify(run, null, 2)}\n\`\`\``,
            ];

            return buildMCPResponse({
                texts,
                structuredContent,
                _meta: buildUsageMeta(run),
            });
        } catch (error) {
            logHttpError(error, 'Failed to get Actor run', { runId: parsed.runId });
            return buildMCPResponse({
                texts: [`Failed to get Actor run '${parsed.runId}': ${error instanceof Error ? error.message : String(error)}.
Please verify the run ID and ensure that the run exists.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }
    },
} as const);
