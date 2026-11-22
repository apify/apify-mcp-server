import type { ActorEnvironmentVariable, ActorVersionClient } from 'apify-client';
import { ApifyApiError } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { getHttpErrorHint, respondUserError } from '../../utils/mcp.js';
import { classifyFailureCategory } from '../../utils/tool_status.js';
import { fetchActor, resolveVersion, respondToSourceToolError } from '../versions/source_helpers.js';

/**
 * The platform's limit of variables per version. The per-variable create does not check it, so `set-actor-env-var`
 * does, and a version already over it keeps its variables updatable and removable.
 */
export const ENV_VARS_MAX_COUNT = 100;

/** The API answers a create of a name the version already has with a 403 of this type. */
const APIFY_ERROR_TYPE_ENV_VAR_ALREADY_EXISTS = 'env-var-already-exists';

export const envVarTargetArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor: its ID, its name (resolved against your own Actors), or its full name as username/name or username~name.',
        ),
    // Format is not enforced by a regex: the lookup against the Actor's versions rejects anything that is not an
    // existing version with a soft fail.
    versionNumber: z
        .string()
        .optional()
        .describe(
            'Version in MAJOR.MINOR form, for example 0.1. Defaults to the only version when the Actor has exactly one.',
        ),
    name: z.string().min(1).describe('Variable name, for example OPENAI_API_KEY.'),
});

/**
 * Throws `UserInputError` for `.` and `..`: the name goes into the variable's route, and a URL parser resolves those
 * segments away, so a write or delete of `..` would reach the version itself.
 */
export function validateEnvVarName(name: string): void {
    if (name !== '.' && name !== '..') return;
    throw new UserInputError(
        `Environment variable name '${name}' cannot be used: the API cannot address a variable named '.' or '..'.`,
    );
}

/**
 * The client of one variable. apify-client puts the name into the URL path unencoded, so a `#`, `?` or `/` in it would
 * address another route.
 */
export function getEnvVarClient(versionClient: ActorVersionClient, name: string) {
    return versionClient.envVar(encodeURIComponent(name));
}

/**
 * The Actor, its resolved version, and the version's variables. Throws `UserInputError` for a missing Actor or version.
 * The variables carry the values of plain ones; callers read only names and isSecret from them.
 */
export async function fetchEnvVarTarget(client: ApifyClient, actorSelector: string, versionNumber?: string) {
    const { actor, fullName } = await fetchActor(client, actorSelector);
    const version = resolveVersion(actor, versionNumber, actorSelector);
    const versionClient = client.actor(actor.id).version(version.versionNumber);
    const { items } = await versionClient.envVars().list();
    const envVars = items.filter(
        (item): item is ActorEnvironmentVariable & { name: string } => item.name !== undefined,
    );
    return { actorId: actor.id, fullName, versionNumber: version.versionNumber, versionClient, envVars };
}

/** The result line that says runs see the change only after a rebuild, naming `build-actor` only when it is loaded. */
export function buildRebuildNote(versionNumber: string, loadedToolNames: readonly string[]): string {
    const how = loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `; ${HELPER_TOOLS.ACTOR_BUILD} builds it`
        : ', for example in Apify Console';
    return `Runs read environment variables copied onto their build, so they see this change only after version ${versionNumber} is rebuilt${how}.`;
}

/**
 * The response to an error of an env-vars write tool. A 4xx from the API is answered here: a 401 or 403 as an auth
 * failure with the token hint, except a duplicate create, which the API also answers with 403 and which, on a retried
 * attempt, may be this call's own earlier attempt. The API's message is
 * left out when it contains `secretValue`, so the value never reaches the result. Anything else goes to
 * `respondToSourceToolError`, which answers a `UserInputError` and rethrows the rest; a rethrown error whose message
 * contains `secretValue` is replaced by one without it.
 */
export function respondToEnvVarWriteError(error: unknown, secretValue?: string): ToolResponse {
    const containsValue = (text: string) =>
        secretValue !== undefined && secretValue !== '' && text.includes(secretValue);
    if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
        const isAuthFailure =
            classifyFailureCategory(error) === FAILURE_CATEGORY.AUTH &&
            error.type !== APIFY_ERROR_TYPE_ENV_VAR_ALREADY_EXISTS;
        const message = containsValue(error.message)
            ? 'The API refused the variable; its message is left out because it contained the value'
            : error.message.replace(/\.$/, '');
        const typeNote = error.type ? ` (API error type: ${error.type})` : '';
        // apify-client retries a create after a network error, a timeout, a 429, or a 5xx: an attempt the platform
        // saved but did not answer makes the retry look like a duplicate.
        const retryNote =
            error.type === APIFY_ERROR_TYPE_ENV_VAR_ALREADY_EXISTS && error.attempt > 1
                ? ' The request was retried, so an earlier attempt of this call may have created the variable; calling again replaces it.'
                : '';
        const hint = isAuthFailure ? ` ${getHttpErrorHint(error.statusCode)}` : '';
        return respondUserError(`${message}${typeNote}.${retryNote}${hint}`, {
            category: isAuthFailure ? FAILURE_CATEGORY.AUTH : FAILURE_CATEGORY.INVALID_INPUT,
            httpStatus: error.statusCode,
        });
    }
    if (error instanceof Error && containsValue(error.message)) {
        throw new Error(`${error.name} while writing the environment variable; its message contained the value.`);
    }
    return respondToSourceToolError(error);
}
