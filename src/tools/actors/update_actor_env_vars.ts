import type { ActorVersionClient } from 'apify-client';
import { ApifyApiError } from 'apify-client';
import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { REDACTED_VALUE } from '../../utils/logging.js';
import { getHttpErrorHint, respondOk, respondUserError } from '../../utils/mcp.js';
import { classifyFailureCategory } from '../../utils/tool_status.js';
import { listVersionNumbers } from '../builds/build_helpers.js';
import { updateActorEnvVarsToolOutputSchema } from '../structured_output_schemas.js';
import { formatActorFullName, resolveActorNameInput, resolveTargetActor } from './actor_helpers.js';

// The platform's own limits: the variable schema (name and value length) and the version schema
// (variables per version). The per-variable create call does not check the count, so this tool does.
const ENV_VAR_NAME_MAX_LENGTH = 100;
const ENV_VAR_VALUE_MAX_LENGTH = 50_000;
const ENV_VARS_MAX_COUNT = 100;

const APIFY_ERROR_TYPE_ENV_VAR_ALREADY_EXISTS = 'env-var-already-exists';

const updateActorEnvVarsArgs = z.object({
    actor: z.string().min(1).describe('Actor ID or name; your own account only'),
    // Checked against the Actor's versions instead of a regex, the same as build-actor.
    versionNumber: z
        .string()
        .optional()
        .describe(
            'Version whose variables to change, in MAJOR.MINOR form; defaults to the only version when the Actor has exactly one',
        ),
    set: z
        .array(
            z.object({
                name: z
                    .string()
                    .min(1)
                    .max(ENV_VAR_NAME_MAX_LENGTH)
                    .describe(`Variable name, 1 to ${ENV_VAR_NAME_MAX_LENGTH} characters, without =`),
                value: z
                    .string()
                    .max(ENV_VAR_VALUE_MAX_LENGTH)
                    .describe(`Variable value, at most ${ENV_VAR_VALUE_MAX_LENGTH} characters`),
                // `.optional()` instead of `.default(false)`: `fixZodSchemaRequired` only fixes top-level
                // fields, so a nested default would stay in the item's `required` list.
                isSecret: z
                    .boolean()
                    .optional()
                    .describe(
                        'Store the value encrypted; it can never be read back. When omitted, a new variable is plain and a replaced variable keeps its current setting, so a secret stays secret',
                    ),
            }),
        )
        .max(ENV_VARS_MAX_COUNT)
        .optional()
        .describe('Variables to create, or to replace when the version already has one of that name'),
    delete: z
        .array(z.string().min(1).max(ENV_VAR_NAME_MAX_LENGTH))
        .optional()
        .describe('Names of the variables to delete'),
});

type EnvVarInput = NonNullable<z.infer<typeof updateActorEnvVarsArgs>['set']>[number];

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Set or delete the environment variables, secrets included, of a version of an Actor in your own account.
Each variable in set is created, or replaced when the version has one of that name: value and isSecret are both overwritten. Each name in delete is removed; a name the version does not have is reported in notPresent.
Returns the Actor ID and full name, the version, the names created, updated, deleted and not present, and the version's variables as name and isSecret. Values are never returned: secret values are encrypted and cannot be read back, so replacing or deleting a secret loses its old value.
Runs read environment variables from their build, so a change applies to runs of the next build${
        hasTool(HELPER_TOOLS.ACTOR_BUILD)
            ? `; rebuild the version with ${HELPER_TOOLS.ACTOR_BUILD}`
            : '; rebuild the version, for example in Apify Console'
    }. A version holds at most ${ENV_VARS_MAX_COUNT} variables.
A secret value passed here travels through the conversation. Prefer secrets the platform already holds, for example an existing secret variable or APIFY_TOKEN, which every run gets automatically.
Tasks have no environment variables: a task runs the Actor's build and inherits its variables. A secret that differs per task goes into the task input, through a field marked isSecret in the Actor's input schema, which the platform stores encrypted.

USAGE:
- Use to give an Actor an API key or setting it reads from its environment, to rotate one, or to remove one.

USAGE EXAMPLES:
- user_input: Add my OpenAI key as the secret OPENAI_API_KEY to my-actor
- user_input: Remove the DEBUG variable from version 0.2 of my-actor`;
}

const UNREDACTED_ARG_KEYS = new Set(['actor', 'versionNumber', 'delete']);

function redactEnvVarEntry(entry: unknown): unknown {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return REDACTED_VALUE;
    const { name, isSecret } = entry as Record<string, unknown>;
    return { name, isSecret, ...('value' in entry && { value: REDACTED_VALUE }) };
}

/**
 * The logged copy of the arguments, built as an allowlist: it runs before AJV validation, which strips
 * undeclared keys only from the copy the tool gets, so a value sent under a wrong key, for example a
 * top-level `envVars`, would reach the log. Each `set` entry keeps only its name and isSecret; every key
 * other than `actor`, `versionNumber` and `delete` is replaced whole, `set` too when it is not an array.
 */
function redactEnvVarValues(args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(args).map(([key, value]) => {
            if (UNREDACTED_ARG_KEYS.has(key)) return [key, value];
            if (key === 'set' && Array.isArray(value)) return [key, value.map(redactEnvVarEntry)];
            return [key, REDACTED_VALUE];
        }),
    );
}

function findDuplicate(names: readonly string[]): string | undefined {
    return names.find((name, index) => names.indexOf(name) !== index);
}

/** The rules AJV cannot express, checked before any API call; throws `UserInputError` for the first problem. */
function validateChanges(set: readonly EnvVarInput[], deleteNames: readonly string[]): void {
    if (set.length === 0 && deleteNames.length === 0) {
        throw new UserInputError('Pass at least one variable in set or one name in delete.');
    }
    // The platform rejects '=' in a name; the AJV here drops `pattern`, so it is checked in code.
    const nameWithEquals = set.find(({ name }) => name.includes('='));
    if (nameWithEquals) {
        throw new UserInputError(`Environment variable name '${nameWithEquals.name}' must not contain '='.`);
    }
    const setNames = set.map(({ name }) => name);
    // The name is encoded into the variable's route, which still leaves '.' and '..' as path segments:
    // an update or delete of '..' would hit the version itself.
    const dotSegmentName = [...setNames, ...deleteNames].find((name) => name === '.' || name === '..');
    if (dotSegmentName !== undefined) {
        throw new UserInputError(
            `Environment variable name '${dotSegmentName}' cannot be used: the API cannot address a variable named '.' or '..'.`,
        );
    }
    const duplicateInSet = findDuplicate(setNames);
    if (duplicateInSet !== undefined) {
        throw new UserInputError(`Environment variable '${duplicateInSet}' appears more than once in set.`);
    }
    const duplicateInDelete = findDuplicate(deleteNames);
    if (duplicateInDelete !== undefined) {
        throw new UserInputError(`Environment variable '${duplicateInDelete}' appears more than once in delete.`);
    }
    const nameInBoth = deleteNames.find((name) => setNames.includes(name));
    if (nameInBoth !== undefined) {
        throw new UserInputError(`Environment variable '${nameInBoth}' is in both set and delete; keep it in one.`);
    }
}

/** The requested version, or the only one; mirrors build-actor. Throws `UserInputError` listing the versions otherwise. */
function resolveVersionNumber(
    actorLabel: string,
    versionNumbers: readonly string[],
    requestedVersionNumber: string | undefined,
): string {
    if (versionNumbers.length === 0) throw new UserInputError(`Actor '${actorLabel}' has no versions.`);
    if (requestedVersionNumber !== undefined && !versionNumbers.includes(requestedVersionNumber)) {
        throw new UserInputError(
            `Actor '${actorLabel}' has no version ${requestedVersionNumber}; available versions: ${versionNumbers.join(', ')}.`,
        );
    }
    if (requestedVersionNumber === undefined && versionNumbers.length !== 1) {
        throw new UserInputError(`Specify versionNumber; this Actor has versions: ${versionNumbers.join(', ')}.`);
    }
    return requestedVersionNumber ?? versionNumbers[0];
}

/** The version's variables, name to whether it is secret. */
async function fetchEnvVarSecrecy(versionClient: ActorVersionClient): Promise<Map<string, boolean>> {
    const { items } = await versionClient.envVars().list();
    return new Map(items.flatMap(({ name, isSecret }) => (name === undefined ? [] : [[name, isSecret === true]])));
}

type AppliedChanges = { created: string[]; updated: string[]; deleted: string[] };

/**
 * Writes one variable at a time: each write is checked against the Actor's modification time, so
 * parallel writes to one Actor fail as concurrent updates. Pushes each name into `applied` as its
 * write lands, so the caller can report the writes made before a failure.
 */
async function applyChanges(
    versionClient: ActorVersionClient,
    changes: { set: readonly EnvVarInput[]; deleteNames: readonly string[]; existing: ReadonlyMap<string, boolean> },
    applied: AppliedChanges,
): Promise<void> {
    const { set, deleteNames, existing } = changes;
    // apify-client puts the name into the URL path unencoded, so a '#', '?' or '/' in it would address another route.
    const envVarClient = (name: string) => versionClient.envVar(encodeURIComponent(name));
    for (const { name, value, isSecret: requestedIsSecret } of set) {
        // An omitted isSecret keeps a replaced variable's setting: the PUT replaces the whole variable, and
        // defaulting to false would turn a secret into a plain variable readable in Console.
        const isSecret = requestedIsSecret ?? existing.get(name) ?? false;
        if (existing.has(name)) {
            await envVarClient(name).update({ name, value, isSecret });
            applied.updated.push(name);
            continue;
        }
        await versionClient.envVars().create({ name, value, isSecret });
        applied.created.push(name);
    }
    for (const name of deleteNames) {
        await envVarClient(name).delete();
        applied.deleted.push(name);
    }
}

/** The API's own message, then the writes of this call that landed before the failure. */
function formatWriteFailure(errMessage: string, applied: AppliedChanges): string {
    const landed = [
        applied.created.length > 0 ? `created ${applied.created.join(', ')}` : '',
        applied.updated.length > 0 ? `updated ${applied.updated.join(', ')}` : '',
        applied.deleted.length > 0 ? `deleted ${applied.deleted.join(', ')}` : '',
    ].filter(Boolean);
    if (landed.length === 0) return errMessage;
    // API messages rarely end with a period; give the message its own sentence so the list does not run into it.
    return `${errMessage.replace(/\.?$/, '.')} Before the failure this call ${landed.join('; ')}.`;
}

function buildNextStep(versionNumber: string, hasChanged: boolean, loadedToolNames: readonly string[]): string {
    if (!hasChanged) return 'Nothing changed, so no rebuild is needed.';
    const rebuild = loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `Rebuild version ${versionNumber} with ${HELPER_TOOLS.ACTOR_BUILD}.`
        : `Rebuild version ${versionNumber}, for example in Apify Console, for the change to take effect.`;
    return `The change applies to runs of the next build. ${rebuild}`;
}

/**
 * https://docs.apify.com/api/v2/act-version-env-vars-get
 * https://docs.apify.com/api/v2/act-version-env-vars-post
 *  /v2/acts/{actorId}/versions/{versionNumber}/env-vars
 * https://docs.apify.com/api/v2/act-version-env-var-put
 * https://docs.apify.com/api/v2/act-version-env-var-delete
 *  /v2/acts/{actorId}/versions/{versionNumber}/env-vars/{envVarName}
 *
 * Writes each variable through its own route, so the version's other variables are not touched.
 * Resolves apify/apify-mcp-server#1416.
 */
export const updateActorEnvVars: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_ENV_VARS_UPDATE,
    title: 'Update Actor environment variables',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(updateActorEnvVarsArgs) as ToolInputSchema,
    outputSchema: updateActorEnvVarsToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(updateActorEnvVarsArgs)),
    redactArgs: redactEnvVarValues,
    annotations: {
        title: 'Update Actor environment variables',
        readOnlyHint: false,
        // Replacing or deleting a secret loses its value for good: the platform never returns a
        // secret value, so there is no copy to restore it from.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, loadedToolNames } = toolArgs;
        const parsed = updateActorEnvVarsArgs.parse(args);
        const set = parsed.set ?? [];
        const deleteNames = parsed.delete ?? [];
        const applied: AppliedChanges = { created: [], updated: [], deleted: [] };
        try {
            validateChanges(set, deleteNames);
            const { username, bareName, actor } = await resolveTargetActor(client, resolveActorNameInput(parsed.actor));
            if (!actor) return respondUserError(`Actor '${parsed.actor}' not found.`);
            const versionNumber = resolveVersionNumber(parsed.actor, listVersionNumbers(actor), parsed.versionNumber);
            const versionClient = client.actor(actor.id).version(versionNumber);

            const existing = await fetchEnvVarSecrecy(versionClient);
            const presentDeleteNames = deleteNames.filter((name) => existing.has(name));
            const createCount = set.filter(({ name }) => !existing.has(name)).length;
            const countAfter = existing.size + createCount - presentDeleteNames.length;
            // Refused only when the call adds variables: the per-variable create does not check the limit,
            // so a version may already be over it, and its variables must stay updatable and removable.
            if (createCount > presentDeleteNames.length && countAfter > ENV_VARS_MAX_COUNT) {
                throw new UserInputError(
                    `Version ${versionNumber} would have ${countAfter} environment variables; the platform allows at most ${ENV_VARS_MAX_COUNT}.`,
                );
            }

            await applyChanges(versionClient, { set, deleteNames: presentDeleteNames, existing }, applied);

            const { items } = await versionClient.envVars().list();
            const fullName = formatActorFullName(username, bareName);
            // Allowlisted: the list returns the values of plain variables, which never leave this tool.
            const structuredContent = {
                actorId: actor.id,
                fullName,
                versionNumber,
                created: applied.created,
                updated: applied.updated,
                deleted: applied.deleted,
                notPresent: deleteNames.filter((name) => !existing.has(name)),
                envVars: items.flatMap(({ name, isSecret }) =>
                    name === undefined ? [] : [{ name, isSecret: isSecret === true }],
                ),
            };
            const notPresentNote =
                structuredContent.notPresent.length > 0
                    ? ` Not present, so not deleted: ${structuredContent.notPresent.join(', ')}.`
                    : '';
            const summary = `Updated the environment variables of ${fullName} version ${versionNumber}: ${applied.created.length} created, ${applied.updated.length} updated, ${applied.deleted.length} deleted.${notPresentNote}`;
            const hasChanged = set.length > 0 || presentDeleteNames.length > 0;
            const nextStep = buildNextStep(versionNumber, hasChanged, loadedToolNames);
            return respondOk([JSON.stringify(structuredContent), `${summary}\n${nextStep}`], { structuredContent });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
                // Classified the way the engine would a thrown error, except that a duplicate create is a 403 too.
                const isAuthFailure =
                    classifyFailureCategory(error) === FAILURE_CATEGORY.AUTH &&
                    error.type !== APIFY_ERROR_TYPE_ENV_VAR_ALREADY_EXISTS;
                const apiMessage = error.type ? `${error.message} (API error type: ${error.type})` : error.message;
                return respondUserError(
                    formatWriteFailure(
                        isAuthFailure ? `${apiMessage}. ${getHttpErrorHint(error.statusCode)}` : apiMessage,
                        applied,
                    ),
                    {
                        category: isAuthFailure ? FAILURE_CATEGORY.AUTH : FAILURE_CATEGORY.INVALID_INPUT,
                        httpStatus: error.statusCode,
                    },
                );
            }
            throw error;
        }
    },
} as const);
