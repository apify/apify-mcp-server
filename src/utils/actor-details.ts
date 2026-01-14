import type { Actor, Build } from 'apify-client';

import type { ApifyClient } from '../apify-client.js';
import { filterSchemaProperties, shortenProperties } from '../tools/utils.js';
import type { ActorCardOptions, ActorInputSchema, StructuredActorCard } from '../types.js';
import { formatActorToActorCard, formatActorToStructuredCard } from './actor-card.js';
import { logHttpError } from './logging.js';

// Keep the type here since it is a self-contained module
export type ActorDetailsResult = {
    actorInfo: Actor;
    buildInfo: Build;
    actorCard: string;
    actorCardStructured: StructuredActorCard;
    inputSchema: ActorInputSchema;
    readme: string;
};

export async function fetchActorDetails(
    apifyClient: ApifyClient,
    actorName: string,
    cardOptions?: ActorCardOptions,
): Promise<ActorDetailsResult | null> {
    try {
        const [actorInfo, buildInfo]: [Actor | undefined, Build | undefined] = await Promise.all([
            apifyClient.actor(actorName).get(),
            apifyClient.actor(actorName).defaultBuild().then(async (build) => build.get()),
        ]);
        if (!actorInfo || !buildInfo || !buildInfo.actorDefinition) return null;
        const inputSchema = (buildInfo.actorDefinition.input || {
            type: 'object',
            properties: {},
        }) as ActorInputSchema;
        inputSchema.properties = filterSchemaProperties(inputSchema.properties);
        inputSchema.properties = shortenProperties(inputSchema.properties);
        const actorCard = formatActorToActorCard(actorInfo, cardOptions);
        const actorCardStructured = formatActorToStructuredCard(actorInfo, cardOptions);
        return {
            actorInfo,
            buildInfo,
            actorCard,
            actorCardStructured,
            inputSchema,
            readme: buildInfo.actorDefinition.readme || 'No README provided.',
        };
    } catch (error) {
        logHttpError(error, `Failed to fetch actor details for '${actorName}'`, { actorName });
        return null;
    }
}

/**
 * Process actor details for response formatting.
 * Formats README with link, builds text content, and creates structured content.
 * @param details - Raw actor details from fetchActorDetails
 * @returns Processed actor details with formatted content
 */
export function processActorDetailsForResponse(details: ActorDetailsResult) {
    const actorUrl = `https://apify.com/${details.actorInfo.username}/${details.actorInfo.name}`;
    // Add link to README title
    const formattedReadme = details.readme.replace(/^# /, `# [README](${actorUrl}/readme): `);

    const texts = [
        `# Actor information\n${details.actorCard}`,
        formattedReadme,
    ];

    // Include input schema if it has properties
    const hasInputSchema = details.inputSchema.properties && Object.keys(details.inputSchema.properties).length !== 0;
    if (hasInputSchema) {
        texts.push(`# [Input schema](${actorUrl}/input)\n\`\`\`json\n${JSON.stringify(details.inputSchema)}\n\`\`\``);
    }

    const structuredContent = {
        actorDetails: {
            actorInfo: details.actorInfo,
            actorCard: details.actorCard,
            readme: formattedReadme,
            inputSchema: details.inputSchema,
        },
    };

    return {
        actorUrl,
        texts,
        structuredContent,
        formattedReadme,
    };
}
