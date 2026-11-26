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
import { buildServerActorToolInfo } from './server_interface_details.js';
import { listCommaJoinedQueryParameters, listDocumentedOperations } from './server_interface_schema.js';

const BUILD_NUMBER_PATTERN = /^\d+\.\d+\.\d+$/;

const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
export const MAX_DATASET_FIELD_DEPTH = 8;
/**
 * Caps both full and reduced dataset schemas. The largest measured Store schema was 38 KB
 * before reduction and 4 KB after (`compass/crawler-google-places`).
 */
export const MAX_DATASET_ITEMS_SCHEMA_BYTES = 65_536;

/**
 * Follows the platform's dataset precedence. Legacy `storages.datasets` definitions without a
 * `default` alias use the first alias.
 */
export function getDeclaredDatasetItemsSchema(actorDefinition: { storages?: unknown }): DatasetItemsSchema | undefined {
    const { storages } = actorDefinition;
    if (!isRecord(storages)) return undefined;
    const datasets = isRecord(storages.datasets) ? storages.datasets : { default: storages.dataset };
    const dataset = 'default' in datasets ? datasets.default : Object.values(datasets)[0];
    const fields = isRecord(dataset) ? dataset.fields : undefined;
    if (!isRecord(fields) || !isRecord(fields.properties) || Object.keys(fields.properties).length === 0) {
        return undefined;
    }
    return fields as DatasetItemsSchema;
}

/**
 * Keeps `tools/list` small and prevents strict client validators from rejecting publisher-defined
 * keywords or types. Fields typed only through `$ref`, `anyOf`, or `oneOf` keep their names.
 */
export function reduceToFieldNamesAndTypes(
    properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    if (!properties) return undefined;
    const reduced = reduceProperties(properties, 1);
    // Measured as the schema both callers serve, so a direct Actor tool and `fetch-actor-details` cut off at the same size.
    const schemaBytes = Buffer.byteLength(JSON.stringify({ type: 'object', properties: reduced }));
    return schemaBytes > MAX_DATASET_ITEMS_SCHEMA_BYTES ? undefined : reduced;
}

function reduceProperties(properties: Record<string, unknown>, depth: number): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name, reduceFieldSchema(schema, depth)]),
    );
}

/**
 * Converts OpenAPI's `nullable` flag to a JSON Schema `null` type when the field has a recognized type.
 * At the depth limit, keep the field's type and drop its children to bound the schema sent to clients.
 */
function reduceFieldSchema(schema: unknown, depth: number): Record<string, unknown> {
    if (!isRecord(schema)) return {};
    const reduced: Record<string, unknown> = {};
    // JSON Schema requires unique entries in a type array.
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
 * Uses the default build for run inputs and the README, and the Standby build for the server interface.
 * Returns `null` for a missing Actor, a missing default build definition, or an API 400 or 404.
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
 * Returns `undefined` for an unresolved Standby build to avoid advertising the default build's
 * interface for a different server. API failures propagate.
 */
export async function resolveServerInterfaceDefinition(
    actor: Pick<Actor, 'id' | 'username' | 'name' | 'actorStandby' | 'taggedBuilds'>,
    defaultBuild: Build,
    apifyClient: ApifyClient,
): Promise<ActorDefinitionWithServerInterface | undefined> {
    if (actor.actorStandby?.isEnabled !== true) return defaultBuild.actorDefinition ?? undefined;

    // With no build named, the platform starts Standby runs on the default build.
    const reference = actor.actorStandby.build;
    if (!reference) return defaultBuild.actorDefinition ?? undefined;

    const buildId = await resolveStandbyBuildId(actor, reference, apifyClient);
    if (buildId === defaultBuild.id) return defaultBuild.actorDefinition ?? undefined;

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
 * Resolves the tag or build number accepted by Apify Console because the API has no Standby
 * equivalent to `builds/default`.
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
        (buildNumber && Object.values(taggedBuilds).find((build) => build?.buildNumber === buildNumber)?.buildId);
    if (taggedBuildId) return taggedBuildId;

    if (!buildNumber) return undefined;
    // Listing builds requires a token, so anonymous reads can only resolve tagged builds.
    if (!apifyClient.token) return undefined;
    for await (const build of apifyClient.actor(actor.id).builds().list({ desc: true })) {
        if (build.buildNumber === buildNumber) return build.id;
    }
    return undefined;
}

// Publisher schemas are unvalidated. Only object-valued operations count.
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
