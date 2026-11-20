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
    DatasetItemsSchema,
    SchemaProperties,
} from '../../types.js';
import { getHttpStatusCode } from '../../utils/logging.js';
import { API_METHODS, isRecord } from '../api/apify_api_spec.js';
import type { BuildListItem } from '../builds/get_actor_build_list.js';
import { buildServerActorToolInfo } from './server_interface_details.js';
import { listCommaJoinedQueryParameters, listDocumentedOperations } from './server_interface_schema.js';

const BUILD_NUMBER_PATTERN = /^\d+\.\d+\.\d+$/;

const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
/** Nesting of declared dataset fields kept by `reduceToFieldNamesAndTypes`; a deeper field keeps no shape. */
export const MAX_DATASET_FIELD_DEPTH = 8;
/**
 * Serialized size above which a declared dataset schema is not served. `fetch-actor-details` then falls back from
 * the full schema to `reduceToFieldNamesAndTypes`, which itself returns nothing above the limit. The largest
 * schema seen on the Store, `compass/crawler-google-places`, has 38 KB in full and 4 KB reduced; an Actor can
 * declare one of any size.
 */
export const MAX_DATASET_ITEMS_SCHEMA_BYTES = 65_536;

/**
 * Returns the JSON Schema an Actor declares for the items of its default dataset: the `fields` of its dataset
 * schema. `undefined` when the Actor declares no fields.
 *
 * An Actor with several datasets declares them under `storages.datasets.<alias>`, any other under
 * `storages.dataset`. The platform reads `storages.datasets` first and treats `storages.dataset` as the `default`
 * alias, so `storages.dataset` is not read when `storages.datasets` exists.
 */
export function getDeclaredDatasetItemsSchema(actorDefinition: unknown): DatasetItemsSchema | undefined {
    const storages = isRecord(actorDefinition) ? actorDefinition.storages : undefined;
    if (!isRecord(storages)) return undefined;
    const dataset = isRecord(storages.datasets) ? storages.datasets.default : storages.dataset;
    const fields = isRecord(dataset) ? dataset.fields : undefined;
    if (!isRecord(fields) || !isRecord(fields.properties) || Object.keys(fields.properties).length === 0) {
        return undefined;
    }
    return fields as DatasetItemsSchema;
}

/**
 * Reduces the `properties` of a declared dataset schema to field names and types: per field only `type`, and
 * recursively `properties` and `items`. Returns `undefined` for no properties.
 *
 * The result goes into `tools/list` for every selected Actor, where descriptions and examples would multiply its
 * size (38 KB against 4 KB for `compass/crawler-google-places`). The schema is written by the Actor's creator, so
 * any other keyword is dropped as well, and a type name JSON Schema does not define with it: a client that compiles
 * the tool's `outputSchema` rejects the tool on a keyword or type its validator does not know. A field typed only
 * through `$ref`, `anyOf` or `oneOf` therefore keeps its name and no type. OpenAPI's `nullable: true` is kept as
 * the `null` type. Nesting stops at `MAX_DATASET_FIELD_DEPTH`, and a result over
 * `MAX_DATASET_ITEMS_SCHEMA_BYTES` is not returned. The full schema is served by `fetch-actor-details`.
 */
export function reduceToFieldNamesAndTypes(
    properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    if (!properties) return undefined;
    const reduced = reduceProperties(properties, 1);
    return Buffer.byteLength(JSON.stringify(reduced)) > MAX_DATASET_ITEMS_SCHEMA_BYTES ? undefined : reduced;
}

function reduceProperties(properties: Record<string, unknown>, depth: number): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name, reduceFieldSchema(schema, depth)]),
    );
}

function reduceFieldSchema(schema: unknown, depth: number): Record<string, unknown> {
    if (!isRecord(schema)) return {};
    const reduced: Record<string, unknown> = {};
    // A `Set`, because a validator also rejects a type list that names a type twice.
    const types = [...new Set<unknown>(Array.isArray(schema.type) ? schema.type : [schema.type])].filter(
        (type): type is string => typeof type === 'string' && JSON_SCHEMA_TYPES.has(type),
    );
    if (schema.nullable === true && types.length > 0 && !types.includes('null')) types.push('null');
    if (types.length > 0) reduced.type = types.length > 1 || Array.isArray(schema.type) ? types : types[0];
    if (depth >= MAX_DATASET_FIELD_DEPTH) return reduced;
    if (isRecord(schema.properties)) reduced.properties = reduceProperties(schema.properties, depth + 1);
    if (isRecord(schema.items)) reduced.items = reduceFieldSchema(schema.items, depth + 1);
    return reduced;
}

/**
 * Get an Actor's pruned definition by Actor ID or name.
 * Input schema and README come from the default build; `webServerMcpPath`, `hasWebServerSchema` and
 * `webServerOperations` come from the build Actor Standby runs, which can be a different one (see
 * `resolveServerInterfaceDefinition`).
 * @param {string} actorIdOrName - Actor ID or Actor full name.
 * @param {ApifyClient} apifyClient - The Apify client instance.
 * @param {number} limit - Truncate the README to this limit.
 * @returns {Promise<ActorDefinitionWithInfo | null>} - null when the Actor is not found (API 404 or 400, or a name
 * the client refuses) or its default build has no definition. Other API failures, including 401 and 403, are thrown;
 * the caller logs them.
 */
export async function getActorDefinition(
    actorIdOrName: string,
    apifyClient: ApifyClient,
    limit: number = ACTOR_README_MAX_LENGTH,
): Promise<ActorDefinitionWithInfo | null> {
    try {
        const actorClient = apifyClient.actor(actorIdOrName);
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
    // Unlike the Actor and build reads, listing builds needs a token. Without one (a session with no token),
    // leave an untagged build number unresolved rather than fail the whole read with a 401.
    if (!apifyClient.token) return undefined;
    for await (const build of apifyClient.actor(actor.id).builds().list({ desc: true })) {
        if ((build as BuildListItem).buildNumber === buildNumber) return build.id;
    }
    return undefined;
}

/**
 * True when the schema declares an operation the send tool can call: an object under a lowercase `API_METHODS` key.
 * The schema is publisher-written and unvalidated, so any level that is not an object counts as absent.
 */
function hasWebServerSchemaOperations(schema: unknown): boolean {
    if (!isRecord(schema) || !isRecord(schema.paths)) return false;
    return Object.values(schema.paths).some(
        (pathItem) => isRecord(pathItem) && API_METHODS.some((method) => isRecord(pathItem[method.toLowerCase()])),
    );
}

function pruneActorDefinition(
    response: ActorDefinitionWithDesc,
    serverDefinition: ActorDefinitionWithServerInterface | undefined,
): ActorDefinitionPruned {
    const commaJoinedQueryParameters = listCommaJoinedQueryParameters(serverDefinition?.webServerSchema);
    const datasetItemProperties = reduceToFieldNamesAndTypes(getDeclaredDatasetItemsSchema(response)?.properties);
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
        webServerOperations: listDocumentedOperations(serverDefinition?.webServerSchema),
        ...(Object.keys(commaJoinedQueryParameters).length > 0 && {
            webServerCommaJoinedQueryParameters: commaJoinedQueryParameters,
        }),
        webServerToolInfo: buildServerActorToolInfo(serverDefinition?.webServerSchema, response.actorFullName || ''),
        pictureUrl: 'pictureUrl' in response ? (response.pictureUrl as string | undefined) : undefined,
        ...(datasetItemProperties && { datasetItemProperties }),
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
