import type { Build } from 'apify-client';

import log from '@apify/log';

import type { ApifyClient } from '../../apify_client.js';
import { ACTOR_README_MAX_LENGTH, FAILURE_CATEGORY } from '../../const.js';
import type {
    Actor,
    ActorDefinitionPruned,
    ActorDefinitionWithDesc,
    ActorDefinitionWithInfo,
    ActorDefinitionWithServerInterface,
    SchemaProperties,
} from '../../types.js';
import { getHttpStatusCode } from '../../utils/logging.js';
import { isRecord, resolveRef } from '../api/apify_api_spec.js';
import type { BuildListItem } from '../builds/get_actor_build_list.js';

const BUILD_NUMBER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Get an Actor's pruned definition by Actor ID or name.
 * Fetches the Actor and its default build (input schema, README, description), then resolves the build the
 * server interface runs (`resolveServerInterfaceDefinition`) for `webServerMcpPath` and `hasWebServerSchema`.
 * @param {string} actorIdOrName - Actor ID or Actor full name.
 * @param {ApifyClient} apifyClient - The Apify client instance.
 * @param {number} limit - Truncate the README to this limit.
 * @returns {Promise<ActorDefinitionWithInfo | null>} - The Actor definition with info or null if not found.
 */
export async function getActorDefinition(
    actorIdOrName: string,
    apifyClient: ApifyClient,
    limit: number = ACTOR_README_MAX_LENGTH,
): Promise<ActorDefinitionWithInfo | null> {
    const actorClient = apifyClient.actor(actorIdOrName);
    try {
        // Fetch Actor details
        const actor = await actorClient.get();
        if (!actor) {
            return null;
        }

        const defaultBuildClient = await actorClient.defaultBuild();
        const buildDetails = await defaultBuildClient.get();

        if (buildDetails?.actorDefinition) {
            const serverDefinition = await resolveServerInterfaceDefinition(actor, buildDetails, apifyClient);
            const actorDefinitions = buildDetails?.actorDefinition as ActorDefinitionWithDesc;
            // We set actorDefinition ID to Actor ID
            actorDefinitions.id = actor.id;
            actorDefinitions.readme = truncateActorReadme(actorDefinitions.readme || '', limit);
            actorDefinitions.readmeSummary = actor.readmeSummary;
            actorDefinitions.description = actor.description || '';
            actorDefinitions.actorFullName = `${actor.username}/${actor.name}`;
            actorDefinitions.defaultRunOptions = actor.defaultRunOptions;
            // Pass pictureUrl from actor object (untyped property but present in API response)
            (actorDefinitions as Record<string, unknown>).pictureUrl = (
                actor as unknown as Record<string, unknown>
            ).pictureUrl;
            return {
                definition: pruneActorDefinition(actorDefinitions, serverDefinition),
                info: actor,
            };
        }
        return null;
    } catch (error) {
        // Check if it's a "not found" error (404 or 400 status codes)
        const statusCode = getHttpStatusCode(error);
        if (statusCode === 404 || statusCode === 400) {
            // Return null for not found - caller will log appropriately
            return null;
        }

        // For server errors, throw the original error (preserve error type)
        // Caller should catch and log
        throw error;
    }
}

/**
 * The definition the server-interface fields (`webServerMcpPath`, `webServerSchema`) are read from. In standby
 * mode the Actor serves the build `actorStandby.build` names, which can differ from the default build the input
 * schema and README come from. The reference is a build tag (looked up in `taggedBuilds`) or a `MAJOR.MINOR.BUILD`
 * number (matched against the tagged builds' numbers, else found by scanning the build list newest first, since
 * the API has no lookup by build number).
 *
 * Returns `undefined` when standby is on but the build cannot be resolved — an unknown reference, a deleted
 * build, or a build without a definition — so the readers report no server interface rather than the default
 * build's. Authentication, permission and service failures propagate.
 */
export async function resolveServerInterfaceDefinition(
    actor: Pick<Actor, 'id' | 'username' | 'name' | 'actorStandby' | 'taggedBuilds'>,
    defaultBuild: Build,
    apifyClient: ApifyClient,
): Promise<ActorDefinitionWithServerInterface | undefined> {
    if (actor.actorStandby?.isEnabled !== true) return defaultBuild.actorDefinition;

    // Standby with no build named starts the run without a build option, which the platform resolves to the
    // Actor's default build.
    const reference = actor.actorStandby.build;
    if (!reference) return defaultBuild.actorDefinition;

    const buildId = await resolveStandbyBuildId(actor, reference, apifyClient);
    if (buildId === defaultBuild.id) return defaultBuild.actorDefinition;

    const build = buildId === undefined ? undefined : await apifyClient.build(buildId).get();
    if (build?.actorDefinition) return build.actorDefinition;

    log.softFail('Standby build of the Actor could not be resolved, serving no server interface for it', {
        actorFullName: `${actor.username}/${actor.name}`,
        standbyBuild: reference,
        failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
    });
    return undefined;
}

async function resolveStandbyBuildId(
    actor: Pick<Actor, 'id' | 'taggedBuilds'>,
    reference: string,
    apifyClient: ApifyClient,
): Promise<string | undefined> {
    const taggedBuilds = actor.taggedBuilds ?? {};
    const taggedBuildId =
        taggedBuilds[reference]?.buildId ??
        Object.values(taggedBuilds).find((build) => build.buildNumber === reference)?.buildId;
    if (taggedBuildId) return taggedBuildId;

    if (!BUILD_NUMBER_PATTERN.test(reference)) return undefined;
    // Listing builds needs a token, unlike the Actor and build reads, so a token-less session (payment
    // provider) leaves an untagged build number unresolved instead of failing the whole read with a 401.
    if (!apifyClient.token) return undefined;
    for await (const build of apifyClient.actor(actor.id).builds().list({ desc: true })) {
        if ((build as BuildListItem).buildNumber === reference) return build.id;
    }
    return undefined;
}

/** The HTTP methods an OpenAPI path item may hold an operation under. */
const OPENAPI_OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export type ServerOperation = { method: string; path: string; operation: Record<string, unknown> };

/**
 * The operations an OpenAPI document declares, in document order, with the method upper-cased as the agent writes
 * it; none for an absent or empty schema, which `hasWebServerSchema` reads as no HTTP interface. The path item's
 * parameters, which apply to every operation under the path, come before the operation's own, and an operation's
 * parameter replaces the path item's with the same name and location.
 */
export function listServerOperations(schema: unknown): ServerOperation[] {
    if (!isRecord(schema) || !isRecord(schema.paths)) return [];
    // A parameter's location and name, through a local `$ref`; a parameter without a name stands for itself.
    const keyOf = (parameter: unknown): unknown => {
        const resolved = resolveRef(parameter, schema);
        return isRecord(resolved) && typeof resolved.name === 'string'
            ? JSON.stringify([resolved.in, resolved.name])
            : parameter;
    };
    return Object.entries(schema.paths).flatMap(([path, pathItem]) =>
        isRecord(pathItem)
            ? OPENAPI_OPERATION_METHODS.filter((method) => isRecord(pathItem[method])).map((method) => {
                  const operation = pathItem[method] as Record<string, unknown>;
                  const parameters = [
                      ...new Map(
                          [pathItem.parameters, operation.parameters]
                              .filter(Array.isArray)
                              .flat()
                              .map((parameter): [unknown, unknown] => [keyOf(parameter), parameter]),
                      ).values(),
                  ];
                  return {
                      method: method.toUpperCase(),
                      path,
                      operation: parameters.length > 0 ? { ...operation, parameters } : operation,
                  };
              })
            : [],
    );
}

function pruneActorDefinition(
    response: ActorDefinitionWithDesc,
    serverDefinition: ActorDefinitionWithServerInterface | undefined,
): ActorDefinitionPruned {
    return {
        id: response.id,
        actorFullName: response.actorFullName || '',
        buildTag: response?.buildTag || '',
        readme: response?.readme || '',
        readmeSummary: response.readmeSummary,
        input:
            response?.input && 'type' in response.input && 'properties' in response.input
                ? {
                      ...response.input,
                      type: response.input.type as string,
                      properties: response.input.properties as Record<string, SchemaProperties>,
                  }
                : undefined,
        description: response.description,
        defaultRunOptions: response.defaultRunOptions,
        webServerMcpPath: serverDefinition?.webServerMcpPath,
        hasWebServerSchema: listServerOperations(serverDefinition?.webServerSchema).length > 0,
        pictureUrl: 'pictureUrl' in response ? (response.pictureUrl as string | undefined) : undefined,
    };
}
/**
 * Prune Actor README if it exceeds `limit`: keep it as-is up to the limit, keep only headings
 * after that, and append a note that the README was truncated.
 */
function truncateActorReadme(readme: string, limit = ACTOR_README_MAX_LENGTH): string {
    if (readme.length <= limit) {
        return readme;
    }
    const readmeFirst = readme.slice(0, limit);
    const readmeRest = readme.slice(limit);
    const lines = readmeRest.split('\n');
    const prunedReadme = lines.filter((line) => line.startsWith('#'));
    return `${readmeFirst}\n\nREADME was truncated because it was too long. Remaining headers:\n${prunedReadme.join(', ')}`;
}
