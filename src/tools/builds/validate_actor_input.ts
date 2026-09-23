import { ApifyApiError } from 'apify-client';
import { z } from 'zod';

import { APIFY_ERROR_TYPE_INVALID_INPUT, HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { validateActorInputToolOutputSchema } from '../structured_output_schemas.js';

/**
 * The API checks against this tag when no build is given, not against the Actor's default build as the
 * client's `validateInput` docs say (see the `build` parameter at the endpoint link below).
 */
const DEFAULT_VALIDATION_BUILD = 'latest';

/** 400 types that are the check's answer: the input fails the schema, or the schema itself is not valid. */
const REJECTED_INPUT_ERROR_TYPES: ReadonlySet<string | undefined> = new Set([
    APIFY_ERROR_TYPE_INVALID_INPUT,
    'invalid-input-schema',
]);

/** 403 types for a build the schema cannot be read from: an unknown tag or number, a build that did not succeed, or one too old. */
const UNUSABLE_BUILD_ERROR_TYPES: ReadonlySet<string | undefined> = new Set([
    'unknown-build-tag',
    'build-not-found',
    'invalid-build',
    'build-outdated',
]);

const validateActorInputArgs = z.object({
    actor: z.string().min(1).describe('Actor ID or username/name'),
    input: z.object({}).passthrough().describe('The input JSON to check against the input schema. Required.'),
    // Non-empty so the reported build is the one checked: the API treats an empty build as latest.
    build: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Build tag or number to check against, for example latest or 0.1.3. If omitted, the build tagged latest is used, not the Actor's default build.",
        ),
});

/** "push the change and build the Actor", naming push-actor and build-actor only where `hasTool` reports them. */
function formatPushAndBuildStep(hasTool: (name: string) => boolean): string {
    const pushWith = hasTool(HELPER_TOOLS.ACTOR_PUSH) ? ` with ${HELPER_TOOLS.ACTOR_PUSH}` : '';
    const buildWith = hasTool(HELPER_TOOLS.ACTOR_BUILD) ? ` with ${HELPER_TOOLS.ACTOR_BUILD}` : '';
    return `push the change${pushWith} and build the Actor${buildWith}`;
}

/** The next step after the schema rejected the input, naming push-actor and build-actor only when the session has them. */
function formatRejectedInputNextStep(loadedToolNames: readonly string[]): string {
    const pushAndBuildStep = formatPushAndBuildStep((name) => loadedToolNames.includes(name));
    return `Fix the input, or fix the input schema in .actor/input_schema.json, ${pushAndBuildStep}, then check again.`;
}

/** The next step after the API refused the build, naming build-actor only when the session has it. */
function formatUnusableBuildNextStep(loadedToolNames: readonly string[]): string {
    return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `Build the Actor with ${HELPER_TOOLS.ACTOR_BUILD}, or pass a build that finished successfully, then check again.`
        : 'Build the Actor, or pass a build that finished successfully, then check again.';
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Check an input against the input schema of an Actor build without running the Actor.
Read-only. Returns valid true, or valid false with the API's validation message.
Schema defaults are applied before the check; a build without an input schema accepts any input.
Without build, the input is checked against the build tagged latest, not the Actor's default build.
The schema is read from the build, so after editing .actor/input_schema.json, ${formatPushAndBuildStep(hasTool)} before checking again.

USAGE:
- Use while developing an Actor to test .actor/input_schema.json and example inputs.
- Use to check an input before running an Actor.

USAGE EXAMPLES:
- user_input: Is {"url": "https://example.com"} a valid input for john/my-actor?
- user_input: Check my example input against build 0.1.3 of my-actor`;
}

/**
 * https://docs.apify.com/api/v2/act-validate-input-post
 *  /v2/actors/{actorId}/validate-input
 *
 * An input the schema rejects is the answer to the call, not a tool failure, so it is returned as a
 * normal result with `valid: false`. Resolves apify/apify-mcp-server#1428.
 */
export const validateActorInput: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_INPUT_VALIDATE,
    title: 'Validate Actor input',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(validateActorInputArgs) as ToolInputSchema,
    outputSchema: validateActorInputToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(validateActorInputArgs)),
    annotations: {
        title: 'Validate Actor input',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, loadedToolNames } = toolArgs;
        const parsed = validateActorInputArgs.parse(args);
        const build = parsed.build ?? DEFAULT_VALIDATION_BUILD;
        try {
            // The API answers 200 only with `valid: true`; an input the schema rejects is a 400, caught below.
            await client
                .actor(parsed.actor)
                .validateInput(parsed.input, parsed.build === undefined ? undefined : { build: parsed.build });
        } catch (error) {
            if (!(error instanceof ApifyApiError)) throw error;
            if (error.statusCode === 400 && REJECTED_INPUT_ERROR_TYPES.has(error.type)) {
                const structuredContent = { valid: false, actor: parsed.actor, build, message: error.message };
                return respondOk(
                    [
                        JSON.stringify(structuredContent),
                        `${error.message}\n${formatRejectedInputNextStep(loadedToolNames)}`,
                    ],
                    { structuredContent },
                );
            }
            if (error.statusCode === 403 && UNUSABLE_BUILD_ERROR_TYPES.has(error.type)) {
                return respondUserError([error.message, formatUnusableBuildNextStep(loadedToolNames)], {
                    httpStatus: 403,
                    detail: error.type,
                });
            }
            if (error.statusCode === 404) {
                return respondUserError(`Actor '${parsed.actor}' not found.`, { httpStatus: 404 });
            }
            throw error;
        }
        const structuredContent = { valid: true, actor: parsed.actor, build };
        return respondOk(
            [JSON.stringify(structuredContent), `The input is valid for build ${build} of Actor ${parsed.actor}.`],
            { structuredContent },
        );
    },
} as const);
