import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { ConsoleLinkContext, HelperTool, InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import {
    type ActorDetailsResult,
    buildCardOptions,
    fetchActorDetails as fetchActorDetailsFromApi,
    getMcpToolsMessage,
    resolveReadmeContent,
    typeObjectToString,
} from '../../utils/actor_details.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleActorUrl, getConsoleLinkContext, VERBATIM_LINKS_NUDGE } from '../../utils/console_link.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { respondOk, respondUserError, type ToolResponse } from '../../utils/mcp.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import { actorDetailsOutputSchema } from '../structured_output_schemas.js';
import { fixActorNameInputAndLog } from './actor_tools_factory.js';

/**
 * Shared schema for actor details output options.
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
    metadata: z
        .boolean()
        .optional()
        .describe('Include developer, categories, last modified date, and deprecation status.'),
    inputSchema: z.boolean().optional().describe('Include required input parameters schema.'),
    readme: z
        .boolean()
        .optional()
        .describe('Include Actor README documentation (summary when available, full otherwise).'),
    outputSchema: z
        .boolean()
        .optional()
        .describe('Include inferred output schema from recent successful runs (TypeScript type).'),
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

export type ResolvedOutputOptions = typeof actorDetailsOutputDefaults;

/**
 * Resolve output options with smart defaults.
 * If output is undefined/empty, returns defaults.
 * If any property is explicitly set, undefined properties are treated as false.
 */
export function resolveOutputOptions(output?: z.infer<typeof actorDetailsOutputOptionsSchema>): ResolvedOutputOptions {
    const hasExplicitOptions = output && Object.values(output).some((v) => v !== undefined);

    if (!hasExplicitOptions) {
        return actorDetailsOutputDefaults;
    }

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
 * Zod schema for fetch-actor-details arguments — used by the mode-independent
 * base tool. The `-widget` sibling has its own `actor`-only schema in
 * `src/tools/widgets/fetch_actor_details_widget.ts`.
 */
export const fetchActorDetailsToolArgsSchema = z.object({
    actor: z
        .string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
    output: actorDetailsOutputOptionsSchema
        .optional()
        .describe('Specify which information to include in the response to save tokens.'),
});

const FETCH_ACTOR_DETAILS_DESCRIPTION = `Get detailed information about an Actor by its ID or full name (format: "username/name", e.g., "apify/rag-web-browser").

Use 'output' parameter with boolean flags to control returned information:
- Default: All fields true except mcpTools
- Selective: Set desired fields to true (e.g., output: { inputSchema: true })
- Common patterns: inputSchema only, description + readme, mcpTools for MCP Actors

The 'readme' field returns the summary when available, full README otherwise.
Use when querying Actor details, documentation, input requirements, or MCP tools.

EXAMPLES:
- What does apify/rag-web-browser do?
- What is the input schema for apify/web-scraper?
- What tools does apify/actors-mcp-server provide?`;

/**
 * Tool metadata for the mode-independent `fetch-actor-details` — everything
 * except the `call` handler. No widget `_meta`; the `-widget` sibling (apps-only)
 * carries its own widget metadata.
 */
export const fetchActorDetailsMetadata: Omit<HelperTool, 'call'> = {
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_GET_DETAILS,
    title: 'Fetch Actor details',
    description: FETCH_ACTOR_DETAILS_DESCRIPTION,
    inputSchema: z.toJSONSchema(fetchActorDetailsToolArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorDetailsToolArgsSchema)),
    annotations: {
        title: 'Fetch Actor details',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
};

/**
 * Build error response for when actor is not found.
 */
export function buildActorNotFoundResponse(actorName: string): ToolResponse {
    return respondUserError(dedent`
        Actor information for '${actorName}' was not found.
        Please verify Actor ID or name format and ensure that the Actor exists.
        You can search for available Actors using the tool: ${HELPER_TOOLS.STORE_SEARCH}.
    `);
}

/**
 * Build text and structured response for actor details.
 * Pure/sync: the caller pre-resolves `mcpToolsMessage` when `output.mcpTools` is true.
 */
export function buildActorDetailsTextResponse(options: {
    details: ActorDetailsResult;
    output: ResolvedOutputOptions;
    actorOutputSchema?: Record<string, unknown> | null;
    mcpToolsMessage?: string;
    linkContext?: ConsoleLinkContext;
}): {
    texts: string[];
    structuredContent: Record<string, unknown>;
} {
    const { details, output, actorOutputSchema, mcpToolsMessage, linkContext } = options;

    const actorUrl =
        buildConsoleActorUrl(linkContext, details.actorInfo.id) ??
        `https://apify.com/${details.actorInfo.username}/${details.actorInfo.name}`;

    const texts: string[] = [];

    const needsCard = output.description || output.stats || output.pricing || output.rating || output.metadata;

    if (needsCard) {
        texts.push(`# Actor information\n${details.actorCard}`);
    }

    const resolvedReadme = output.readme ? resolveReadmeContent(details) : undefined;
    if (resolvedReadme) {
        texts.push(`${resolvedReadme.heading}\n${resolvedReadme.content}`);
    }

    if (output.inputSchema) {
        // Console has no /input sub-page — link to the Actor detail page instead.
        const inputSchemaUrl = linkContext ? actorUrl : `${actorUrl}/input`;
        texts.push(`# [Input schema](${inputSchemaUrl})\n${wrapJsonText(details.inputSchema)}`);
    }

    if (output.outputSchema) {
        if (actorOutputSchema && Object.keys(actorOutputSchema).length > 0) {
            const typeString = typeObjectToString(actorOutputSchema);
            texts.push(dedent`
                # Output Schema (TypeScript)
                Inferred from recent successful runs:
                \`\`\`typescript
                type ActorOutput = ${typeString}
                \`\`\`
            `);
        } else {
            texts.push(dedent`
                # Output Schema
                No output schema available. The Actor may not have recent successful runs, or the output structure could not be determined.
            `);
        }
    }

    if (mcpToolsMessage) {
        texts.push(mcpToolsMessage);
    }

    if (linkContext) {
        texts.push(VERBATIM_LINKS_NUDGE);
    }

    const structuredContent: Record<string, unknown> = {
        actorInfo: needsCard ? details.actorCardStructured : undefined,
        readme: resolvedReadme?.content,
        inputSchema: output.inputSchema ? details.inputSchema : undefined,
        outputSchema: output.outputSchema ? (actorOutputSchema ?? {}) : undefined,
        mcpTools: output.mcpTools && mcpToolsMessage ? mcpToolsMessage : undefined,
    };

    return { texts, structuredContent };
}

/**
 * Shared handler for the base fetch-actor-details tool.
 * Returns the same text + structured response in both modes.
 */
export async function buildFetchActorDetailsResult(toolArgs: InternalToolArgs): Promise<ToolResponse> {
    const { args, apifyToken, apifyClient, apifyMcpServer, mcpSessionId } = toolArgs;
    const parsed = fetchActorDetailsToolArgsSchema.parse(args);
    const actorName = fixActorNameInputAndLog(parsed.actor, { mcpSessionId, route: HELPER_TOOLS.ACTOR_GET_DETAILS });

    const resolvedOutput = resolveOutputOptions(parsed.output);
    // Skip the /users/me round-trip when pricing isn't rendered (e.g. inputSchema-only
    // or mcpTools-only requests). In that case `userTier` is only used to fill the
    // placeholder `{ model: 'FREE', userTier }` in the structured card, where it's never
    // read, so defaulting to 'FREE' is safe and saves a request.
    const userPlanTier = resolvedOutput.pricing
        ? (await getUserInfoCached(apifyToken, apifyClient)).userPlanTier
        : 'FREE';
    // Console UI tokens hit the same cached users/me lookup; non-UI tokens short-circuit.
    const linkContext = await getConsoleLinkContext(apifyToken, apifyClient);
    const cardOptions = { ...buildCardOptions(resolvedOutput), userTier: userPlanTier, linkContext };
    const details = await fetchActorDetailsFromApi(apifyClient, actorName, cardOptions);
    if (!details) {
        return buildActorNotFoundResponse(actorName);
    }

    let actorOutputSchema: Record<string, unknown> | null | undefined;
    if (resolvedOutput.outputSchema) {
        actorOutputSchema = apifyMcpServer.actorStore
            ? await apifyMcpServer.actorStore.getActorOutputSchemaAsTypeObject(actorName).catch(() => null)
            : null;
    }
    const mcpToolsMessage = resolvedOutput.mcpTools
        ? await getMcpToolsMessage(
              actorName,
              apifyClient,
              apifyToken,
              apifyMcpServer?.options.paymentProvider,
              mcpSessionId,
          )
        : undefined;

    // NOTE: Data duplication between texts and structuredContent is intentional and required.
    // Some MCP clients only read text content, while others only read structured content.
    const { texts, structuredContent } = buildActorDetailsTextResponse({
        details,
        output: resolvedOutput,
        actorOutputSchema,
        mcpToolsMessage,
        linkContext,
    });

    return respondOk(texts, { structuredContent });
}

/**
 * Default mode fetch-actor-details tool.
 * Returns full text response with output schema fetch.
 */
export const fetchActorDetails: ToolEntry = Object.freeze({
    ...fetchActorDetailsMetadata,
    call: async (toolArgs) => buildFetchActorDetailsResult(toolArgs),
} as const);
