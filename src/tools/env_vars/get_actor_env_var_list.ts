import type { ActorEnvironmentVariable } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { getActorEnvVarListToolOutputSchema } from '../structured_output_schemas.js';
import { fetchActor, resolveVersion, respondToSourceToolError } from '../versions/source_helpers.js';

const INLINE_LIMIT_KIB = MAX_INLINE_BYTES / 1024;

const getActorEnvVarListArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to read: its ID, its name (resolved against your own Actors), or its full name as username/name or username~name.',
        ),
    // Format is not enforced by a regex: the lookup against the Actor's versions rejects anything that is not an
    // existing version with a soft fail.
    versionNumber: z
        .string()
        .optional()
        .describe(
            'Version to read in MAJOR.MINOR form, for example 0.1. Defaults to the only version when the Actor has exactly one.',
        ),
});

type EnvVarInfo = { name: string; isSecret: boolean; value?: string };

/**
 * Each variable's name and isSecret, picked field by field: the API also returns `valueHash`, and a secret's value
 * must never leave this tool even if the API returned it. A plain value is kept while the values so far fit in
 * `MAX_INLINE_BYTES`; a plain variable's value that does not fit is left out and its name goes to
 * `omittedValueNames`, and the values after it still get their turn. A variable with no name is skipped.
 */
function extractEnvVars(items: readonly ActorEnvironmentVariable[]) {
    const envVars: EnvVarInfo[] = [];
    const omittedValueNames: string[] = [];
    let remainingBytes = MAX_INLINE_BYTES;
    for (const { name, value, isSecret } of items) {
        if (name === undefined) continue;
        if (isSecret === true || value === undefined) {
            envVars.push({ name, isSecret: isSecret === true });
            continue;
        }
        const bytes = Buffer.byteLength(value);
        if (bytes > remainingBytes) {
            envVars.push({ name, isSecret: false });
            omittedValueNames.push(name);
            continue;
        }
        envVars.push({ name, isSecret: false, value });
        remainingBytes -= bytes;
    }
    return { envVars, ...(omittedValueNames.length > 0 && { omittedValueNames }) };
}

/**
 * https://docs.apify.com/api/v2/actor-get
 *  /v2/actors/{actorId}
 * https://docs.apify.com/api/v2/act-version-env-vars-get
 *  /v2/actors/{actorId}/versions/{versionNumber}/env-vars
 *
 * The Actor GET resolves the Actor and its version the way the versions tools do; the variables come from their own
 * endpoint, which returns every variable of the version in one response.
 */
export const getActorEnvVarList: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_ENV_VAR_LIST_GET,
    title: 'Get Actor environment variable list',
    description: dedent`
        List the environment variables of an Actor version: each variable's name, whether it is secret, and the value of each plain variable.
        Secret values are never returned: the platform stores them encrypted. Plain values are returned up to ${INLINE_LIMIT_KIB} KiB in total; the variables whose values were left out are named in omittedValueNames.
        Runs read the variables copied onto their build, so a variable changed after the last build reaches runs only after the next build.
        Omit versionNumber to read the only version; an Actor with several versions needs it.

        USAGE:
        - Use to check which variables and secrets an Actor version has, or what a plain variable is set to.

        USAGE EXAMPLES:
        - user_input: Which environment variables does my-actor have?
        - user_input: Is OPENAI_API_KEY set as a secret on version 0.2 of john/my-scraper?`,
    inputSchema: z.toJSONSchema(getActorEnvVarListArgs) as ToolInputSchema,
    outputSchema: getActorEnvVarListToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorEnvVarListArgs)),
    annotations: {
        title: 'Get Actor environment variable list',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getActorEnvVarListArgs.parse(args);
        try {
            const { actor, fullName } = await fetchActor(client, parsed.actor);
            const { versionNumber } = resolveVersion(actor, parsed.versionNumber, parsed.actor);
            const { items } = await client.actor(actor.id).version(versionNumber).envVars().list();
            const structuredContent = { actorId: actor.id, fullName, versionNumber, ...extractEnvVars(items) };
            const { envVars, omittedValueNames } = structuredContent;
            const secretCount = envVars.filter(({ isSecret }) => isSecret).length;
            const summary = [
                `Version ${versionNumber} of ${fullName} has ${envVars.length} environment ${
                    envVars.length === 1 ? 'variable' : 'variables'
                }, ${secretCount} secret.`,
                omittedValueNames &&
                    `Values left out over the ${INLINE_LIMIT_KIB} KiB limit: ${omittedValueNames.join(', ')}.`,
            ]
                .filter(Boolean)
                .join(' ');
            return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
        } catch (error) {
            return respondToSourceToolError(error);
        }
    },
} as const);
