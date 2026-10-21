import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS, MAX_LIMIT_WITH_INPUT_SCHEMA } from '../../const.js';
import type {
    ActorStoreList,
    ConsoleLinkContext,
    HelperTool,
    InternalToolArgs,
    StructuredActorCard,
    ToolDescriptionContext,
    ToolEntry,
    ToolInputSchema,
} from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { DEFAULT_CARD_OPTIONS, formatActorToActorCard, formatActorToStructuredCard } from '../../utils/actor_card.js';
import { searchAgentSafeActors } from '../../utils/actor_search.js';
import { compileSchema } from '../../utils/ajv.js';
import { getConsoleLinkContext, VERBATIM_LINKS_NUDGE } from '../../utils/console_link.js';
import { respondOk } from '../../utils/mcp.js';
import type { PricingTier } from '../../utils/pricing_info.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import { canRunActor, canRunAnyActor, getActorCallabilityCaveat } from '../actor_tool_naming.js';
import { actorSearchOutputSchema } from '../structured_output_schemas.js';

/**
 * Shared schema for search-actors arguments. Used by both the default and
 * widget variants — the widget variant calls `.strict()` on it.
 */
export const searchActorsBaseArgsSchema = z.object({
    keywords: z.string().default('').describe(dedent`
            Space-separated keywords used to search pre-built solutions (Actors) in the Apify Store.
            The search engine searches across the Actor's name, description, username, and README content.

            Pass empty string ("") whenever the user has NOT named a specific platform
            (Instagram, Amazon, Google Maps) or a specific data type (posts, products,
            weather, news). Empty keywords return Actors in the Apify Store's default
            sort order, which is popularity in practice (most-used Actors first). Do NOT
            use ranking words ("top", "best", "popular") or bare task words ("scraper",
            "crawler", "extractor") as keyword values — they are not Actor names and
            produce noisy matches against README content.

            Otherwise, follow these rules:
            - Use 1-3 simple keyword terms maximum (e.g., "Instagram posts", "Twitter", "Amazon products")
            - Actors are named using platform or service name together with the type of data or task they perform
            - The most effective keywords are specific platform names (Instagram, Twitter, TikTok) and specific data types (posts, products, profiles, weather, news, reviews, comments)
            - If a user asks about "fetching Instagram posts", use "Instagram posts" as keywords
            - The goal is to find Actors that specifically handle the platform and data type the user mentioned

            Examples:
            ✅ "Instagram posts", "Twitter", "Amazon products", "TikTok comments"
            ✅ "" (empty) — returns the most popular Actors store-wide
            ❌ "Instagram posts profiles comments hashtags reels stories followers..." (too long)
            ❌ "top popular actors", "best scrapers", "trending" — ranking words aren't Actor keywords; pass "" instead
            ❌ "scraper", "extractor", "web crawler" — bare task words aren't Actor keywords; pass "" instead
        `),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT_WITH_INPUT_SCHEMA)
        .default(5)
        .describe(`The maximum number of Actors to return (max = ${MAX_LIMIT_WITH_INPUT_SCHEMA}, default = 5).`),
    offset: z.number().int().min(0).default(0).describe('The number of elements to skip from the start (default = 0)'),
});

function buildDescription({ hasTool, clientParam }: ToolDescriptionContext): string {
    const runLimitationLine = canRunAnyActor(hasTool) ? '' : `${getActorCallabilityCaveat(clientParam)}\n`;
    return `Search the Apify Store to FIND and DISCOVER what scraping tools/Actors exist for specific platforms or use cases.
This tool provides INFORMATION about available Actors - it does NOT retrieve actual data or run any scraping tasks.

Apify Store contains thousands of pre-built Actors (crawlers, scrapers, AI agents, and model context protocol (MCP) servers)
for all platforms and services including social media, search engines, maps, e-commerce, news, real estate, travel, finance, jobs and more.
Apify Store lists Actors published by Apify and by independent developers.

Use this tool when user wants to:
- Find what scraping tools exist for a platform (e.g., "What tools can scrape Instagram?")
- Discover available Actors for a use case (e.g., "Find an Actor for Amazon products")
- Browse existing solutions (e.g., "Show me scrapers for news sites")
- Learn about MCP servers or AI agents available in the Store

This tool discovers Actors; it does not retrieve their output.
IMPORTANT: When the user wants detailed data from a specific platform or is looking for scraping tools, prefer searching the Store first — a relevant Actor often already exists. When the user names a specific Actor, look up that Actor directly instead of searching.
${hasTool(HELPER_TOOLS.ACTOR_LIST_GET) ? `Do NOT use this tool to find the user's own Actors (e.g., "find my weather scraper", "run my Actor"): the Store never returns private Actors. Use ${HELPER_TOOLS.ACTOR_LIST_GET} for those.\n` : ''}
Usage:
- Use 1-3 simple terms from the platform and/or data type the user named (e.g. "Instagram posts", "Twitter", "Amazon products"). With neither named, empty keywords return the Store's default ordering. A platform-only query is an option if more specific results do not fit.

Important limitations: This tool does not return full Actor documentation or detailed usage instructions - only summary information.
Each result lists the Actor's input fields with their types (e.g. \`url: string, maxResults?: number\`) so you can ${canRunAnyActor(hasTool) ? 'construct an Actor call directly without another tool call' : 'see what input an Actor needs'}.
${runLimitationLine}${hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS) ? `For complete Actor details (per-field descriptions, defaults, README), use the ${HELPER_TOOLS.ACTOR_GET_DETAILS} tool.\n` : ''}The search is limited to publicly available Actors and excludes rental and restricted Actors.

Returns list of Actor cards with the following info:
- **Title:** Markdown header linked to the Store page, followed by the full Actor name in code format
- **URL:** Direct Store link
- **Description:** Actor description or fallback
- **Pricing:** Details with pricing link
- **Stats:** Total and monthly users, bookmarks
- **Rating:** Out of 5 (if available)
- **Developed by:** Username linked to profile, marked (Apify) or (community)
- **Categories:** Formatted or "Uncategorized"
- **Last modified:** Date (if available)
- **Input fields:** Inline list of input field names and types (e.g. \`url: string, maxResults?: number\`); \`?\` marks optional fields, \`... (+N more)\` marks a truncated list`;
}

export type SearchActorsResult = {
    actorCardText: string;
    actorCardStructured: StructuredActorCard[];
};

export function buildSearchActorsResult(
    actors: ActorStoreList[],
    userTier: PricingTier,
    linkContext?: ConsoleLinkContext,
): SearchActorsResult {
    const options = { ...DEFAULT_CARD_OPTIONS, userTier, simplifyPricingForUserTier: true, linkContext };
    return {
        actorCardText: actors.map((actor) => formatActorToActorCard(actor, options)).join('\n\n'),
        actorCardStructured: actors.map((actor) => formatActorToStructuredCard(actor, options)),
    };
}

/**
 * Builds the empty-results guidance message for when no Actors are found.
 * Past offset 0 the query may have matched, so keyword guidance does not apply (see apify/apify-mcp-server#1276).
 * The text does not say the results ended: the Store filters results after paging, so an empty page can come
 * before non-empty ones (see apify/apify-mcp-server#1593).
 */
export function buildNoActorsFoundInstructions(keywords: string, offset: number): string {
    if (offset > 0) return `No Actors returned at offset ${offset} for the search query "${keywords}".`;
    return dedent`
        No Actors were found for the search query "${keywords}".
        Keywords can include the named platform and/or data type (e.g. "TikTok posts").
        A platform-only query such as "TikTok" is an option if more specific results do not fit.
    `;
}

/** Caveat for the whole result list — appended only when at least one result lacks a run path. */
export function buildActorCallabilityCaveat(
    actorIds: readonly string[],
    loadedToolNames: readonly string[],
    loadedActorIds: ReadonlySet<string>,
): string {
    const canRunAllActors = actorIds.every((id) => canRunActor(id, loadedToolNames, loadedActorIds));
    return canRunAllActors ? '' : getActorCallabilityCaveat();
}

/** Footer line pointing to fetch-actor-details; added only when the session serves that tool. */
export const ACTOR_DETAILS_HINT = `If you need more detailed information about any of these Actors, including their input
schemas and usage instructions, use the ${HELPER_TOOLS.ACTOR_GET_DETAILS} tool with the
specific Actor name.`;

/**
 * Builds the footer/instructions guidance for successful search results.
 * Joins the details hint, the verbatim links nudge (`''` outside Console sessions) and the
 * callability caveat, each on its own line. Returns `''` when none of them applies.
 *
 * The ACTOR_GET_DETAILS sentence is named only when the session was served that tool: this is
 * result text, which no `hasTool` gate reaches, so a `?tools=search-actors` session would
 * otherwise be told to call a tool absent from its own `tools/list`.
 * See apify/apify-mcp-server#1296.
 */
export function buildSearchActorsFooter(
    verbatimLinksNudge: string,
    actorIds: readonly string[],
    loadedToolNames: readonly string[],
    loadedActorIds: ReadonlySet<string>,
): string {
    const detailsHint = loadedToolNames.includes(HELPER_TOOLS.ACTOR_GET_DETAILS) ? ACTOR_DETAILS_HINT : '';
    const callabilityCaveat = buildActorCallabilityCaveat(actorIds, loadedToolNames, loadedActorIds);
    return [detailsHint, verbatimLinksNudge, callabilityCaveat].filter(Boolean).join('\n');
}

/**
 * Default mode search-actors tool.
 * Returns text-based Actor cards without widget metadata.
 */
export const searchActors: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.STORE_SEARCH,
    title: 'Search Actors',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(searchActorsBaseArgsSchema) as ToolInputSchema,
    outputSchema: actorSearchOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(searchActorsBaseArgsSchema)),
    annotations: {
        title: 'Search Actors',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyClient, paymentProvider, loadedToolNames, loadedActorIds } = toolArgs;
        const parsed = searchActorsBaseArgsSchema.parse(args);
        // Actor search and user-info fetch are independent; run in parallel to avoid a
        // sequential round-trip on cache miss.
        const [actors, { userPlanTier }] = await Promise.all([
            searchAgentSafeActors({
                keywords: parsed.keywords,
                apifyClient,
                limit: parsed.limit,
                offset: parsed.offset,
                paymentProvider,
            }),
            getUserInfoCached(apifyToken, apifyClient),
        ]);

        if (actors.length === 0) {
            const instructions = buildNoActorsFoundInstructions(parsed.keywords, parsed.offset);
            return respondOk(instructions, {
                structuredContent: { actors: [], query: parsed.keywords, count: 0, instructions },
            });
        }

        // Cache hit — the Promise.all above already resolved users/me for this token.
        const linkContext = await getConsoleLinkContext(apifyToken, apifyClient);
        const { actorCardText, actorCardStructured } = buildSearchActorsResult(actors, userPlanTier, linkContext);
        const verbatimLinksNudge = linkContext ? VERBATIM_LINKS_NUDGE : '';
        const actorIds = actors.map((actor) => actor.id);
        const footer = buildSearchActorsFooter(verbatimLinksNudge, actorIds, loadedToolNames, loadedActorIds);
        const structuredContent = {
            actors: actorCardStructured,
            query: parsed.keywords,
            count: actors.length,
            userTier: userPlanTier,
            ...(footer && { instructions: footer }),
        };

        // The header is built with `dedent`; `actorCardText` is joined after it, not interpolated.
        // Card lines can be indented (two spaces for pay-per-event pricing), which would corrupt
        // `dedent`'s indent detection if interpolated into the template.
        const header = dedent`
            # Search results:
            - **Search query:** ${parsed.keywords}
            - **Number of Actors found:** ${actors.length}

            # Actors:
        `;
        return respondOk([header, actorCardText, footer].filter(Boolean).join('\n\n'), { structuredContent });
    },
} as const satisfies HelperTool);
