import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondAborted, respondOk } from '../../utils/mcp.js';
import { deleteActorEnvVarToolOutputSchema } from '../structured_output_schemas.js';
import {
    buildRebuildNote,
    envVarTargetArgs,
    fetchEnvVarTarget,
    getEnvVarClient,
    respondToEnvVarWriteError,
    validateEnvVarName,
} from './env_var_helpers.js';

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const buildTool = hasTool(HELPER_TOOLS.ACTOR_BUILD) ? ` with ${HELPER_TOOLS.ACTOR_BUILD}` : '';
    return `Delete one environment variable of an Actor version. A deleted secret's value cannot be recovered: the platform never returns secret values.
Runs read the variables copied onto their build, so runs keep the variable until the version is rebuilt${buildTool}.
Omit versionNumber to change the only version; an Actor with several versions needs it.

USAGE:
- Use only when the user explicitly wants the variable removed.

USAGE EXAMPLES:
- user_input: Remove the DEBUG variable from version 0.2 of my-actor`;
}

/**
 * https://docs.apify.com/api/v2/act-version-env-vars-get
 *  /v2/actors/{actorId}/versions/{versionNumber}/env-vars
 * https://docs.apify.com/api/v2/act-version-env-var-delete
 *  /v2/actors/{actorId}/versions/{versionNumber}/env-vars/{envVarName}
 *
 * The variables are read first: apify-client swallows a 404 on delete, so a missing variable would otherwise look
 * deleted.
 */
export const deleteActorEnvVar: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_ENV_VAR_DELETE,
    title: 'Delete Actor environment variable',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(envVarTargetArgs) as ToolInputSchema,
    outputSchema: deleteActorEnvVarToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(envVarTargetArgs)),
    annotations: {
        title: 'Delete Actor environment variable',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, signal, loadedToolNames } = toolArgs;
        const parsed = envVarTargetArgs.parse(args);
        const { name } = parsed;
        try {
            validateEnvVarName(name);
            const { actorId, fullName, versionNumber, versionClient, envVars } = await fetchEnvVarTarget(
                client,
                parsed.actor,
                parsed.versionNumber,
            );
            if (!envVars.some((envVar) => envVar.name === name)) {
                const names = envVars.map((envVar) => envVar.name);
                const present = names.length > 0 ? `its variables are ${names.join(', ')}` : 'it has no variables';
                throw new UserInputError(
                    `Nothing was deleted: version ${versionNumber} of ${fullName} has no environment variable ${name}; ${present}.`,
                );
            }
            // A cancel before the DELETE deletes nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            await getEnvVarClient(versionClient, name).delete();
            const structuredContent = { actorId, fullName, versionNumber, name, deleted: true };
            const summary = `Deleted the environment variable ${name} from version ${versionNumber} of ${fullName}.`;
            return respondOk(
                [JSON.stringify(structuredContent), `${summary}\n${buildRebuildNote(versionNumber, loadedToolNames)}`],
                { structuredContent },
            );
        } catch (error) {
            return respondToEnvVarWriteError(error);
        }
    },
} as const);
