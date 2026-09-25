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

/** The schema itself does not compile, so the input was never checked against it. */
const INVALID_INPUT_SCHEMA_ERROR_TYPE = 'invalid-input-schema';

/** The build has not succeeded: it is still running, or it failed. */
const INVALID_BUILD_ERROR_TYPE = 'invalid-build';

/** 400 types that are the check's answer: the input fails the schema, or the schema itself is not valid. */
const REJECTED_INPUT_ERROR_TYPES: ReadonlySet<string | undefined> = new Set([
    APIFY_ERROR_TYPE_INVALID_INPUT,
    INVALID_INPUT_SCHEMA_ERROR_TYPE,
]);

/** 403 types for a build the schema cannot be read from: an unknown tag or number, a build that did not succeed, or one too old. */
const UNUSABLE_BUILD_ERROR_TYPES: ReadonlySet<string | undefined> = new Set([
    'unknown-build-tag',
    'build-not-found',
    INVALID_BUILD_ERROR_TYPE,
    'build-outdated',
]);

const validateActorInputArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to check against: its ID, or its full name as username/name or username~name. A name without the username is not enough.',
        ),
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

/**
 * "update the source and build the Actor again, then check again", naming build-actor only where
 * `hasTool` reports it. No tool is named for the source change: it may be pushed files, a Git commit or the
 * CLI. The check waits for that build to succeed and names it by number: the latest tag moves only on
 * success, so an earlier check without build reads the previous build's schema.
 */
function formatRebuildAndRecheckStep(hasTool: (name: string) => boolean): string {
    const buildWith = hasTool(HELPER_TOOLS.ACTOR_BUILD) ? ` with ${HELPER_TOOLS.ACTOR_BUILD}` : '';
    return `update the Actor's source and build it again${buildWith}, then check again once that build has succeeded, passing its build number as build`;
}

/** The next step after the schema rejected the input, naming build-actor only when the session has it. */
function formatRejectedInputNextStep(errorType: string | undefined, loadedToolNames: readonly string[]): string {
    const recheckStep = formatRebuildAndRecheckStep((name) => loadedToolNames.includes(name));
    if (errorType === INVALID_INPUT_SCHEMA_ERROR_TYPE) {
        return `Fix the input schema in .actor/input_schema.json, ${recheckStep}.`;
    }
    return `Fix the input, or fix the input schema in .actor/input_schema.json, ${recheckStep}.`;
}

/** The next step after the API refused the build, naming get-actor-build or build-actor only when the session has it. */
function formatUnusableBuildNextStep(errorType: string | undefined, loadedToolNames: readonly string[]): string {
    // A build still running gets this type too; building again would start a second one.
    if (errorType === INVALID_BUILD_ERROR_TYPE) {
        const waitWith = loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD_GET)
            ? ` with ${HELPER_TOOLS.ACTOR_BUILD_GET}`
            : '';
        return `Wait for the build to finish${waitWith}, or pass a build that succeeded, then check again.`;
    }
    return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `Build the Actor with ${HELPER_TOOLS.ACTOR_BUILD}, or pass a build that finished successfully, then check again.`
        : 'Build the Actor, or pass a build that finished successfully, then check again.';
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Check an input against the input schema of an Actor build without running the Actor.
Read-only. Returns valid true, or valid false with the API's validation message.
Schema defaults are applied before the check; a build without an input schema accepts any input.
Without build, the input is checked against the build tagged latest, not the Actor's default build.
The schema is read from the build, so after editing .actor/input_schema.json, ${formatRebuildAndRecheckStep(hasTool)}.

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
                        `${error.message}\n${formatRejectedInputNextStep(error.type, loadedToolNames)}`,
                    ],
                    { structuredContent },
                );
            }
            if (error.statusCode === 403 && UNUSABLE_BUILD_ERROR_TYPES.has(error.type)) {
                return respondUserError([error.message, formatUnusableBuildNextStep(error.type, loadedToolNames)], {
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
