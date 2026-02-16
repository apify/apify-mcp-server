import type { ApifyClient } from '../apify-client.js';
import { ACTOR_README_MAX_LENGTH } from '../const.js';
import type {
    ActorDefinitionPruned,
    ActorDefinitionWithDesc,
    ActorDefinitionWithInfo,
    SchemaProperties,
} from '../types.js';

/**
 * Get Actor input schema by Actor name.
 * First, fetch the Actor details to get the default build tag and buildId.
 * Then, fetch the build details and return actorName, description, and input schema.
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
            const actorDefinitions = buildDetails?.actorDefinition as ActorDefinitionWithDesc;
            // We set actorDefinition ID to Actor ID
            actorDefinitions.id = actor.id;
            actorDefinitions.readme = truncateActorReadme(actorDefinitions.readme || '', limit);
            actorDefinitions.readmeSummary = actor.readmeSummary;
            actorDefinitions.description = actor.description || '';
            actorDefinitions.actorFullName = `${actor.username}/${actor.name}`;
            actorDefinitions.defaultRunOptions = actor.defaultRunOptions;
            // Pass pictureUrl from actor object (untyped property but present in API response)
            (actorDefinitions as Record<string, unknown>).pictureUrl = (actor as unknown as Record<string, unknown>).pictureUrl;
            return {
                definition: pruneActorDefinition(actorDefinitions),
                info: actor,
            };
        }
        return null;
    } catch (error) {
        // Check if it's a "not found" error (404 or 400 status codes)
        const isNotFound = typeof error === 'object'
            && error !== null
            && 'statusCode' in error
            && (error.statusCode === 404 || error.statusCode === 400);

        if (isNotFound) {
            // Return null for not found - caller will log appropriately
            return null;
        }

        // For server errors, throw the original error (preserve error type)
        // Caller should catch and log
        throw error;
    }
}
function pruneActorDefinition(response: ActorDefinitionWithDesc): ActorDefinitionPruned {
    return {
        id: response.id,
        actorFullName: response.actorFullName || '',
        buildTag: response?.buildTag || '',
        readme: response?.readme || '',
        readmeSummary: response.readmeSummary,
        input: response?.input && 'type' in response.input && 'properties' in response.input
            ? {
                ...response.input,
                type: response.input.type as string,
                properties: response.input.properties as Record<string, SchemaProperties>,
            }
            : undefined,
        description: response.description,
        defaultRunOptions: response.defaultRunOptions,
        webServerMcpPath: 'webServerMcpPath' in response ? response.webServerMcpPath as string : undefined,
        pictureUrl: 'pictureUrl' in response ? response.pictureUrl as string | undefined : undefined,
    };
}
/** Prune Actor README if it is too long
 * If the README is too long
 * - We keep the README as it is up to the limit.
 * - After the limit, we keep heading only
 * - We add a note that the README was truncated because it was too long.
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
