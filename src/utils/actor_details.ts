import type { Build } from 'apify-client';

import type { ApifyClient } from '../apify_client.js';
import { connectMCPClient } from '../mcp/client.js';
import type { PaymentProvider } from '../payments/types.js';
import { filterSchemaProperties, shortenProperties } from '../tools/utils.js';
import type { Actor, ActorCardOptions, ActorInputSchema, ActorStoreList, StructuredActorCard } from '../types.js';
import { getActorMcpUrlCached } from './actor.js';
import { formatActorForWidget, formatActorToActorCard, formatActorToStructuredCard } from './actor_card.js';
import { searchActorsByKeywords } from './actor_search.js';
import { logHttpError } from './logging.js';
import type { PricingTier } from './pricing_info.js';

const ACTOR_DETAILS_PICTURE_SEARCH_LIMIT = 5;

/**
 * Convert a type object to TypeScript-like string representation.
 * Used for human-readable text output.
 *
 * Example:
 * Input:  { first_number: "number", tags: ["string"], user: { name: "string" } }
 * Output: "{ first_number: number, tags: string[], user: { name: string } }"
 *
 * Values that are not string / object / array are skipped (not rendered) at every nesting level.
 */
export function typeObjectToString(obj: Record<string, unknown>): string {
    const pairs = Object.entries(obj)
        .filter(([, v]) => Array.isArray(v) || (v !== null && typeof v === 'object') || typeof v === 'string')
        .map(([k, v]) => `${k}: ${typeValueToString(v)}`);
    return `{ ${pairs.join(', ')} }`;
}

function typeValueToString(value: unknown): string {
    if (Array.isArray(value)) return `${typeValueToString(value[0])}[]`;
    if (value !== null && typeof value === 'object') return typeObjectToString(value as Record<string, unknown>);
    if (typeof value === 'string') return value;
    return 'unknown';
}

/**
 * Resolve README content with fallback: prefer readmeSummary, fall back to full readme.
 * Returns the content string and appropriate heading for text output.
 */
export function resolveReadmeContent(details: { readmeSummary?: string; readme: string }): {
    content: string;
    heading: string;
} {
    if (details.readmeSummary?.trim()) {
        return { content: details.readmeSummary, heading: '# README summary' };
    }
    return { content: details.readme, heading: '# README' };
}

// Keep the type here since it is a self-contained module
export type ActorDetailsResult = {
    actorInfo: Actor;
    buildInfo: Build;
    actorCard: string;
    actorCardStructured: StructuredActorCard;
    inputSchema: ActorInputSchema;
    readme: string;
    readmeSummary?: string;
};

export async function fetchActorDetails(
    apifyClient: ApifyClient,
    actorName: string,
    cardOptions?: ActorCardOptions,
): Promise<ActorDetailsResult | null> {
    try {
        // Use only the actor name part (after '/') for better keyword search relevance —
        // "apify/instagram-scraper" returns unrelated results, while "instagram-scraper" finds the correct actor.
        const actorSlug = actorName.split('/').pop() || actorName;
        const actor = apifyClient.actor(actorName);
        const [actorInfo, buildInfo, storeActors]: [Actor | undefined, Build | undefined, ActorStoreList[]] = await Promise.all([
            actor.get(),
            actor.defaultBuild().then(async (build) => build.get()),
            searchActorsByKeywords(actorSlug, apifyClient.token || '', ACTOR_DETAILS_PICTURE_SEARCH_LIMIT).catch(() => []),
        ]);
        if (!actorInfo || !buildInfo || !buildInfo.actorDefinition) return null;

        const storeActor = storeActors?.find((item) => item.id === actorInfo.id);
        const pictureUrl = storeActor?.pictureUrl;
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
            readmeSummary: actorInfo.readmeSummary,
        };
    } catch (error) {
        logHttpError(error, `Failed to fetch actor details for '${actorName}'`, { actorName });
        return null;
    }
}

/**
 * Build the widget actor-details payload for the apps variant.
 * Returns the Actor URL and the structured `actorDetails` object.
 */
export function buildActorDetailsForWidget(details: ActorDetailsResult, userTier: PricingTier) {
    const actorUrl = `https://apify.com/${details.actorInfo.username}/${details.actorInfo.name}`;
    const formattedReadme = details.readme.replace(/^# /, `# [README](${actorUrl}/readme): `);
    return {
        actorUrl,
        actorDetails: {
            actorInfo: formatActorForWidget(details.actorInfo, userTier),
            actorCard: details.actorCard,
            readme: formattedReadme,
            inputSchema: details.inputSchema,
        },
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
    paymentProvider?: PaymentProvider,
    mcpSessionId?: string,
): Promise<string> {
    const mcpServerUrl = await getActorMcpUrlCached(actorName, apifyClient);

    // Early return: not an MCP server
    if (!mcpServerUrl || typeof mcpServerUrl !== 'string') {
        return `Note: This Actor is not an MCP server and does not expose MCP tools.`;
    }

    // Early return: Payment provider restriction
    if (paymentProvider) {
        return `This Actor is an MCP server and cannot be accessed using a third-party payment provider.`;
    }

    // Connect and list tools
    const client = await connectMCPClient(mcpServerUrl, apifyToken, mcpSessionId);
    if (!client) {
        return `Failed to connect to MCP server for Actor '${actorName}'.`;
    }

    try {
        const toolsResponse = await client.listTools();
        const mcpToolsInfo = toolsResponse.tools
            .map((tool) => [
                `**${tool.name}**`,
                tool.description || 'No description',
                'Input schema:',
                '```json',
                JSON.stringify(tool.inputSchema),
                '```',
            ].join('\n'))
            .join('\n\n');

        return [
            '# Available MCP Tools',
            `This Actor is an MCP server with ${toolsResponse.tools.length} tools.`,
            `To call a tool, use: "${actorName}:{toolName}"`,
            '',
            mcpToolsInfo,
        ].join('\n');
    } catch (error) {
        logHttpError(error, `Failed to list MCP tools for Actor '${actorName}'`, { actorName });
        return `Failed to retrieve MCP tools for Actor '${actorName}'. The MCP server may be temporarily unavailable.`;
    } finally {
        await client.close();
    }
}

/**
 * Build card options from resolved output flags.
 * Maps boolean output flags to card rendering options (explicit true required).
 * Caller adds `userTier` if needed — this helper stays focused on flags.
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
