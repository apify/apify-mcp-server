import type { Actor, Build } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import { connectMCPClient } from '../mcp/client.js';
import { filterSchemaProperties, shortenProperties } from '../tools/utils.js';
import type { ActorCardOptions, ActorInputSchema, ExtendedActorStoreList, StructuredActorCard } from '../types.js';
import { getActorMcpUrlCached } from './actor.js';
import { formatActorDetailsForWidget, formatActorToActorCard, formatActorToStructuredCard } from './actor-card.js';
import { searchActorsByKeywords } from './actor-search.js';
import { logHttpError } from './logging.js';
import { buildMCPResponse } from './mcp.js';

/**
 * Convert a type object to TypeScript-like string representation.
 * Used for human-readable text output.
 *
 * Example:
 * Input:  { first_number: "number", tags: ["string"], user: { name: "string" } }
 * Output: "{ first_number: number, tags: string[], user: { name: string } }"
 */
function typeObjectToString(obj: Record<string, unknown>): string {
    const pairs: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value)) {
            // Array type
            const itemType = typeValueToString(value[0]);
            pairs.push(`${key}: ${itemType}[]`);
        } else if (typeof value === 'object' && value !== null) {
            // Nested object type
            const nestedStr = typeObjectToString(value as Record<string, unknown>);
            pairs.push(`${key}: ${nestedStr}`);
        } else if (typeof value === 'string') {
            // Primitive type
            pairs.push(`${key}: ${value}`);
        }
    }

    return `{ ${pairs.join(', ')} }`;
}

/**
 * Convert a single type value to string.
 */
function typeValueToString(value: unknown): string {
    if (Array.isArray(value)) {
        const itemType = typeValueToString(value[0]);
        return `${itemType}[]`;
    } if (typeof value === 'object' && value !== null) {
        return typeObjectToString(value as Record<string, unknown>);
    } if (typeof value === 'string') {
        return value;
    }
    return 'unknown';
}

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
        const [actorInfo, buildInfo, storeActors]: [Actor | undefined, Build | undefined, ExtendedActorStoreList[]] = await Promise.all([
            apifyClient.actor(actorName).get(),
            apifyClient.actor(actorName).defaultBuild().then(async (build) => build.get()),
            // Fetch from store to get the processed pictureUrl (with resizing parameters)
            searchActorsByKeywords(actorName, apifyClient.token || '', 1).catch(() => []),
        ]);
        if (!actorInfo || !buildInfo || !buildInfo.actorDefinition) return null;

        const storeActor = storeActors?.find((item: ExtendedActorStoreList) => item.id === actorInfo.id);
        const pictureUrl = storeActor?.pictureUrl;

        // @ts-expect-error - pictureUrl is present in API response but missing from type definition
        const actorInfoWithPicture = { ...actorInfo, pictureUrl: pictureUrl || actorInfo.pictureUrl } as Actor & { pictureUrl?: string };

        const inputSchema = (buildInfo.actorDefinition.input || {
            type: 'object',
            properties: {},
        }) as ActorInputSchema;
        inputSchema.properties = filterSchemaProperties(inputSchema.properties);
        inputSchema.properties = shortenProperties(inputSchema.properties);
        const actorCard = formatActorToActorCard(actorInfoWithPicture, cardOptions);
        const actorCardStructured = formatActorToStructuredCard(actorInfoWithPicture, cardOptions);
        return {
            actorInfo: actorInfoWithPicture,
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
 * @param userFullName - User's full name from profile
 * @param userPictureUrl - User's picture URL from profile
 * @returns Processed actor details with formatted content including widget data
 */
export function processActorDetailsForResponse(
    details: ActorDetailsResult,
    userFullName?: string,
    userPictureUrl?: string,
) {
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

    // Format actor for widget display (consistent with search results)
    const widgetActor = formatActorDetailsForWidget(
        details.actorInfo,
        userFullName,
        userPictureUrl,
    );

    const structuredContent = {
        actorDetails: {
            actorInfo: widgetActor, // Include all widget properties for consistent UI rendering
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

/**
 * Shared schema for actor details output options.
 * Used by both public and internal fetch-actor-details tools.
 *
 * Behavior:
 * - If output is undefined or empty object: use defaults (all true except mcpTools and outputSchema)
 * - If any property is explicitly set: only include sections with explicit true values
 */
export const actorDetailsOutputOptionsSchema = z.object({
    description: z.boolean().optional().describe('Include Actor description text only.'),
    stats: z.boolean().optional().describe('Include usage statistics (users, runs, success rate).'),
    pricing: z.boolean().optional().describe('Include pricing model and costs.'),
    rating: z.boolean().optional().describe('Include user rating (out of 5 stars).'),
    metadata: z.boolean().optional().describe('Include developer, categories, last modified date, and deprecation status.'),
    inputSchema: z.boolean().optional().describe('Include required input parameters schema.'),
    readme: z.boolean().optional().describe('Include full README documentation.'),
    outputSchema: z.boolean().optional().describe('Include inferred output schema from recent successful runs (TypeScript type).'),
    mcpTools: z.boolean().optional().describe('List available tools (only for MCP server Actors).'),
});

export const actorDetailsOutputDefaults = {
    description: true,
    stats: true,
    pricing: true,
    rating: true,
    metadata: true,
    inputSchema: true,
    readme: true,
    outputSchema: false,
    mcpTools: false,
};

/**
 * Resolve output options with smart defaults.
 * If output is undefined/empty, returns defaults.
 * If any property is explicitly set, undefined properties are treated as false.
 */
export function resolveOutputOptions(output?: z.infer<typeof actorDetailsOutputOptionsSchema>) {
    // Check if output has any explicit true/false values
    const hasExplicitOptions = output && Object.values(output).some((v) => v !== undefined);

    if (!hasExplicitOptions) {
        return actorDetailsOutputDefaults;
    }

    // Return output with undefined treated as false (explicit true required)
    return {
        description: output?.description === true,
        stats: output?.stats === true,
        pricing: output?.pricing === true,
        rating: output?.rating === true,
        metadata: output?.metadata === true,
        inputSchema: output?.inputSchema === true,
        readme: output?.readme === true,
        outputSchema: output?.outputSchema === true,
        mcpTools: output?.mcpTools === true,
    };
}

/**
 * Gets MCP tools information for an Actor.
 * Returns a message about available tools, error, or that the Actor is not an MCP server.
 */
export async function getMcpToolsMessage(
    actorName: string,
    apifyClient: ApifyClient,
    apifyToken: string,
    skyfireMode?: boolean,
): Promise<string> {
    const mcpServerUrl = await getActorMcpUrlCached(actorName, apifyClient);

    // Early return: not an MCP server
    if (!mcpServerUrl || typeof mcpServerUrl !== 'string') {
        return `Note: This Actor is not an MCP server and does not expose MCP tools.`;
    }

    // Early return: Skyfire mode restriction
    if (skyfireMode) {
        return `This Actor is an MCP server and cannot be accessed in Skyfire mode.`;
    }

    // Connect and list tools
    const client = await connectMCPClient(mcpServerUrl, apifyToken);
    if (!client) {
        return `Failed to connect to MCP server for Actor '${actorName}'.`;
    }

    try {
        const toolsResponse = await client.listTools();
        const mcpToolsInfo = toolsResponse.tools
            .map((tool) => `**${tool.name}**\n${tool.description || 'No description'}\nInput schema:\n\`\`\`json\n${JSON.stringify(tool.inputSchema)}\n\`\`\``)
            .join('\n\n');

        return `# Available MCP Tools\nThis Actor is an MCP server with ${toolsResponse.tools.length} tools.\nTo call a tool, use: "${actorName}:{toolName}"\n\n${mcpToolsInfo}`;
    } finally {
        await client.close();
    }
}

/**
 * Build card options from resolved output flags.
 * Maps boolean output flags to card rendering options (explicit true required).
 */
export function buildCardOptions(output: {
    description: boolean;
    stats: boolean;
    pricing: boolean;
    rating: boolean;
    metadata: boolean;
}): ActorCardOptions {
    return {
        includeDescription: output.description,
        includeStats: output.stats,
        includePricing: output.pricing,
        includeRating: output.rating,
        includeMetadata: output.metadata,
    };
}

/**
 * Build error response for when actor is not found.
 */
export function buildActorNotFoundResponse(actorName: string): ReturnType<typeof buildMCPResponse> {
    return buildMCPResponse({
        texts: [`Actor information for '${actorName}' was not found.
Please verify Actor ID or name format and ensure that the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}.`],
        isError: true,
        toolStatus: TOOL_STATUS.SOFT_FAIL,
    });
}

/**
 * Build text and structured response for actor details.
 * Handles all resolved output options: description, stats, readme, inputSchema, outputSchema, mcpTools.
 * All output properties should be boolean (resolved via resolveOutputOptions).
 */
export async function buildActorDetailsTextResponse(options: {
    actorName: string;
    details: ActorDetailsResult;
    output: {
        description: boolean;
        stats: boolean;
        pricing: boolean;
        rating: boolean;
        metadata: boolean;
        readme: boolean;
        inputSchema: boolean;
        outputSchema: boolean;
        mcpTools: boolean;
    };
    cardOptions: ActorCardOptions;
    apifyClient: ApifyClient;
    apifyToken: string;
    actorOutputSchema?: Record<string, unknown> | null;
    skyfireMode?: boolean;
}): Promise<{
    texts: string[];
    structuredContent: Record<string, unknown>;
}> {
    const { actorName, details, output, cardOptions, apifyClient, apifyToken, actorOutputSchema, skyfireMode } = options;

    const actorUrl = `https://apify.com/${details.actorInfo.username}/${details.actorInfo.name}`;
    const formattedReadme = details.readme.replace(/^# /, `# [README](${actorUrl}/readme): `);

    const texts: string[] = [];

    // Build actor card only if any card section is requested
    const needsCard = cardOptions.includeDescription
        || cardOptions.includeStats
        || cardOptions.includePricing
        || cardOptions.includeRating
        || cardOptions.includeMetadata;

    if (needsCard) {
        texts.push(`# Actor information\n${details.actorCard}`);
    }

    // Add README if requested
    if (output.readme) {
        texts.push(formattedReadme);
    }

    // Add input schema if requested
    if (output.inputSchema) {
        texts.push(`# [Input schema](${actorUrl}/input)\n\`\`\`json\n${JSON.stringify(details.inputSchema)}\n\`\`\``);
    }

    // Add output schema if requested
    if (output.outputSchema) {
        if (actorOutputSchema && Object.keys(actorOutputSchema).length > 0) {
            const typeString = typeObjectToString(actorOutputSchema);
            texts.push(`# Output Schema (TypeScript)\nInferred from recent successful runs:\n\`\`\`typescript\ntype ActorOutput = ${typeString}\n\`\`\``);
        } else {
            texts.push(`# Output Schema\nNo output schema available. The Actor may not have recent successful runs, or the output structure could not be determined.`);
        }
    }

    // Handle MCP tools
    if (output.mcpTools) {
        const message = await getMcpToolsMessage(actorName, apifyClient, apifyToken, skyfireMode);
        texts.push(message);
    }

    // Build structured content
    const structuredContent: Record<string, unknown> = {
        actorInfo: needsCard ? details.actorCardStructured : undefined,
        readme: output.readme ? formattedReadme : undefined,
        inputSchema: output.inputSchema ? details.inputSchema : undefined,
        outputSchema: output.outputSchema ? (actorOutputSchema ?? {}) : undefined,
    };

    return { texts, structuredContent };
}
