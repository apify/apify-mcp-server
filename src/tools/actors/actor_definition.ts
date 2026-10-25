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
import { isRecord } from '../api/apify_api_spec.js';
import type { BuildListItem } from '../builds/get_actor_build_list.js';

const BUILD_NUMBER_PATTERN = /^\d+\.\d+\.\d+$/;

/** OpenAPI path-item keys that hold an operation; the other keys (`parameters`, `servers`, `summary`, `$ref`) don't. */
const OPENAPI_OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Get an Actor's pruned definition by Actor ID or name.
 * Input schema and README come from the default build; `webServerMcpPath` and `hasWebServerSchema` come from
 * the build Actor Standby runs, which can be a different one (see `resolveServerInterfaceDefinition`).
 * @param {string} actorIdOrName - Actor ID or Actor full name.
 * @param {ApifyClient} apifyClient - The Apify client instance.
 * @param {number} limit - Truncate the README to this limit.
 * @returns {Promise<ActorDefinitionWithInfo | null>} - null when the Actor is not found (API 404 or 400) or its
 * default build has no definition. Other API failures, including 401 and 403, are thrown; the caller logs them.
 */
export async function getActorDefinition(
    actorIdOrName: string,
    apifyClient: ApifyClient,
    limit: number = ACTOR_README_MAX_LENGTH,
): Promise<ActorDefinitionWithInfo | null> {
    const actorClient = apifyClient.actor(actorIdOrName);
    try {
        const actor = await actorClient.get();
        if (!actor) {
            return null;
        }

        const defaultBuildClient = await actorClient.defaultBuild();
        const buildDetails = await defaultBuildClient.get();

        if (buildDetails?.actorDefinition) {
            const serverDefinition = await resolveServerInterfaceDefinition(actor, buildDetails, apifyClient);
            const actorDefinitions = buildDetails?.actorDefinition as ActorDefinitionWithDesc;
            actorDefinitions.id = actor.id;
            actorDefinitions.readme = truncateActorReadme(actorDefinitions.readme || '', limit);
            actorDefinitions.readmeSummary = actor.readmeSummary;
            actorDefinitions.description = actor.description || '';
            actorDefinitions.actorFullName = `${actor.username}/${actor.name}`;
            actorDefinitions.defaultRunOptions = actor.defaultRunOptions;
            // The API returns `pictureUrl`, but apify-client's `Actor` type lacks it.
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
        const statusCode = getHttpStatusCode(error);
        if (statusCode === 404 || statusCode === 400) {
            return null;
        }
        throw error;
    }
}

/**
 * Returns the definition to read `webServerMcpPath` and `webServerSchema` from: the build named by
 * `actorStandby.build` when Actor Standby is on, otherwise the default build.
 *
 * Returns `undefined` when the Standby build cannot be resolved (unknown reference, deleted build, build without
 * a definition). Falling back to the default build would advertise an interface the running server may not have.
 * Authentication, permission and service failures propagate.
 */
export async function resolveServerInterfaceDefinition(
    actor: Pick<Actor, 'id' | 'username' | 'name' | 'actorStandby' | 'taggedBuilds'>,
    defaultBuild: Build,
    apifyClient: ApifyClient,
): Promise<ActorDefinitionWithServerInterface | undefined> {
    if (actor.actorStandby?.isEnabled !== true) return defaultBuild.actorDefinition;

    // With no build named, the platform starts Standby runs on the default build.
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

/**
 * Turns `actorStandby.build` into a build ID, the only key the API reads a build (and its definition) by.
 * The API resolves the default build's tag or number itself (`builds/default`) but has no equivalent for the
 * Standby build, so this repeats the platform's lookup. `reference` is a build tag or a `MAJOR.MINOR.BUILD`
 * number; Console accepts both. A number is first matched against the tagged builds, then searched for in the
 * build list newest first, because the API has no lookup by build number.
 */
async function resolveStandbyBuildId(
    actor: Pick<Actor, 'id' | 'taggedBuilds'>,
    reference: string,
    apifyClient: ApifyClient,
): Promise<string | undefined> {
    // The platform reads a number as integers, so `0.1.05` runs build `0.1.5`, the form the API lists.
    const buildNumber = BUILD_NUMBER_PATTERN.test(reference) ? reference.split('.').map(Number).join('.') : undefined;
    const taggedBuilds = actor.taggedBuilds ?? {};
    const taggedBuildId =
        taggedBuilds[reference]?.buildId ??
        (buildNumber && Object.values(taggedBuilds).find((build) => build.buildNumber === buildNumber)?.buildId);
    if (taggedBuildId) return taggedBuildId;

    if (!buildNumber) return undefined;
    // Unlike the Actor and build reads, listing builds needs a token. Without one (payment-provider sessions),
    // leave an untagged build number unresolved rather than fail the whole read with a 401.
    if (!apifyClient.token) return undefined;
    for await (const build of apifyClient.actor(actor.id).builds().list({ desc: true })) {
        if ((build as BuildListItem).buildNumber === buildNumber) return build.id;
    }
    return undefined;
}

/**
 * True when the schema declares at least one operation, an object under a method key of a path item.
 * The schema is publisher-written and unvalidated, so any level that is not an object counts as absent.
 */
function hasWebServerSchemaOperations(schema: unknown): boolean {
    if (!isRecord(schema) || !isRecord(schema.paths)) return false;
    return Object.values(schema.paths).some(
        (pathItem) => isRecord(pathItem) && OPENAPI_OPERATION_METHODS.some((method) => isRecord(pathItem[method])),
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
        hasWebServerSchema: hasWebServerSchemaOperations(serverDefinition?.webServerSchema),
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
