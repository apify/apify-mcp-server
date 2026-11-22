import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import { maskLoggedValues, pickLoggedValues } from '../../resources/api_resources.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondAborted, respondOk } from '../../utils/mcp.js';
import { setActorEnvVarToolOutputSchema } from '../structured_output_schemas.js';
import {
    buildRebuildNote,
    ENV_VARS_MAX_COUNT,
    envVarTargetArgs,
    fetchEnvVarTarget,
    getEnvVarClient,
    respondToEnvVarWriteError,
    validateEnvVarName,
} from './env_var_helpers.js';

const setActorEnvVarArgs = envVarTargetArgs.extend({
    value: z.string().describe('The value to store. It is never returned, and it is redacted from logs.'),
    // `.optional()` instead of `.default(false)`: an omitted isSecret keeps a replaced variable's setting.
    isSecret: z
        .boolean()
        .optional()
        .describe(
            'Store the value encrypted; a secret value can never be read back. When omitted, a new variable is plain and a replaced variable keeps its current setting.',
        ),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const buildTool = hasTool(HELPER_TOOLS.ACTOR_BUILD) ? ` with ${HELPER_TOOLS.ACTOR_BUILD}` : '';
    return `Create or update one environment variable of an Actor version, a secret included.
The call creates the variable when the version has none of that name, and otherwise replaces its value. A secret is stored encrypted and can never be read back, so replacing one loses its old value.
The value is never returned. Runs read the variables copied onto their build, so runs see the change only after the version is rebuilt${buildTool}.
Omit versionNumber to change the only version; an Actor with several versions needs it. A version holds at most ${ENV_VARS_MAX_COUNT} variables.
A value passed here travels through the conversation.

USAGE:
- Use to give an Actor an API key or a setting it reads from its environment, or to change one.

USAGE EXAMPLES:
- user_input: Add my OpenAI key as the secret OPENAI_API_KEY to my-actor
- user_input: Set MODE to production on version 0.2 of john/my-scraper`;
}

/**
 * https://docs.apify.com/api/v2/act-version-env-vars-get
 * https://docs.apify.com/api/v2/act-version-env-vars-post
 *  /v2/actors/{actorId}/versions/{versionNumber}/env-vars
 * https://docs.apify.com/api/v2/act-version-env-var-put
 *  /v2/actors/{actorId}/versions/{versionNumber}/env-vars/{envVarName}
 *
 * The version's variables are read first: they decide between create and update, give a replaced variable's isSecret,
 * and count the variables against the limit. The write goes through the variable's own route, so the version's other
 * variables are not touched.
 */
export const setActorEnvVar: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_ENV_VAR_SET,
    title: 'Set Actor environment variable',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(setActorEnvVarArgs) as ToolInputSchema,
    outputSchema: setActorEnvVarToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(setActorEnvVarArgs)),
    // The first tool that takes a secret value as input: every key but `value` is logged, `value` as REDACTED.
    redactArgs: (args: Record<string, unknown>) => ({
        ...pickLoggedValues(args, ['actor', 'versionNumber', 'name', 'isSecret']),
        ...maskLoggedValues(args, ['value']),
    }),
    annotations: {
        title: 'Set Actor environment variable',
        readOnlyHint: false,
        // Replacing a secret loses its value for good: the platform never returns a secret value.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, signal, loadedToolNames } = toolArgs;
        const parsed = setActorEnvVarArgs.parse(args);
        const { name, value } = parsed;
        try {
            validateEnvVarName(name);
            const { actorId, fullName, versionNumber, versionClient, envVars } = await fetchEnvVarTarget(
                client,
                parsed.actor,
                parsed.versionNumber,
            );
            const existing = envVars.find((envVar) => envVar.name === name);
            // Refused only for a create: a version already over the limit keeps its variables updatable.
            if (!existing && envVars.length >= ENV_VARS_MAX_COUNT) {
                throw new UserInputError(
                    `Version ${versionNumber} of ${fullName} already has ${envVars.length} environment variables; the platform allows at most ${ENV_VARS_MAX_COUNT}.`,
                );
            }
            // An omitted isSecret keeps a replaced variable's setting: the PUT replaces the whole variable, and
            // defaulting to false would turn a secret into a plain variable readable in Console.
            const isSecret = parsed.isSecret ?? existing?.isSecret === true;
            // A cancel before the write changes nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            if (existing) {
                await getEnvVarClient(versionClient, name).update({ name, value, isSecret });
            } else {
                await versionClient.envVars().create({ name, value, isSecret });
            }
            const created = !existing;
            // Picked field by field: the API's response carries the value of a plain variable.
            const structuredContent = { actorId, fullName, versionNumber, name, isSecret, created };
            const kind = isSecret ? 'secret' : 'plain';
            const summary = `${created ? 'Created' : 'Updated'} the ${kind} environment variable ${name} on version ${versionNumber} of ${fullName}.`;
            return respondOk(
                [JSON.stringify(structuredContent), `${summary}\n${buildRebuildNote(versionNumber, loadedToolNames)}`],
                { structuredContent },
            );
        } catch (error) {
            return respondToEnvVarWriteError(error, value);
        }
    },
} as const);
