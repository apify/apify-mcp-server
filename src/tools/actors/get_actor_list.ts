import type { ActorCollectionListItem } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { actorListOutputSchema } from '../structured_output_schemas.js';
import { toIsoString } from './actor_run_response.js';

const getActorListArgs = z.object({
    offset: z
        .number()
        .int()
        .min(0)
        .describe('Number of Actors to skip at the start of the list. Default is 0.')
        .default(0),
    // min(1): the API reads limit=0 as "no limit" and returns up to 1,000 Actors.
    limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .describe('Maximum number of Actors to return. Default is 10. Maximum is 20.')
        .default(10),
    desc: z
        .boolean()
        .describe(
            'If true, the Actors are sorted by createdAt, newest first. Default is true; false lists oldest first.',
        )
        .default(true),
});

/**
 * An item of `GET /v2/acts`. The API returns `title` and `stats` too, which apify-client's
 * `ActorCollectionListItem` does not declare.
 */
type ActorListApiItem = ActorCollectionListItem & {
    title?: string | null;
    stats?: { lastRunStartedAt?: Date | string | null };
};

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return dedent`
        List the Actors of the authenticated account: the ones it owns and the ones shared with it, private ones included.
        Returns summaries only (id, fullName, title, dates)${hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS) ? ` — use ${HELPER_TOOLS.ACTOR_GET_DETAILS} with a fullName from the list for the input schema and README` : ''}.${hasTool(HELPER_TOOLS.STORE_SEARCH) ? ` ${HELPER_TOOLS.STORE_SEARCH} searches Apify Store instead and never returns private Actors.` : ''}
        Sorted by createdAt (newest first by default); use limit (max 20), offset, and desc to paginate and sort.

        USAGE:
        - Use when you need to know which Actors the account has, for example to find the name of one to run or inspect.

        USAGE EXAMPLES:
        - user_input: List my Actors
        - user_input: Which Actors did I create most recently?
        - user_input: Show my oldest Actors`;
}

/** Points at the next page while one remains; otherwise at an Actor's details, gated on that tool being loaded. */
function buildNextStep(
    page: { total: number; count: number; offset: number },
    loadedToolNames: readonly string[],
): string {
    const { total, count, offset } = page;
    if (offset + count < total) {
        return `Call this tool again with offset=${offset + count} to fetch the next page.`;
    }
    if (count > 0 && loadedToolNames.includes(HELPER_TOOLS.ACTOR_GET_DETAILS)) {
        return `Use ${HELPER_TOOLS.ACTOR_GET_DETAILS} with an Actor's fullName to see its input schema and README.`;
    }
    return 'No more pages.';
}

/**
 * https://docs.apify.com/api/v2/acts-get
 */
export const getActorList: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_LIST_GET,
    title: 'Get user Actors list',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // `fixZodSchemaRequired` strips fields with a real `default` from `required` so MCP clients
    // that read `tools/list` see every field as optional (matching its runtime behavior).
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(getActorListArgs)) as ToolInputSchema,
    outputSchema: actorListOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorListArgs)),
    annotations: {
        title: 'Get user Actors list',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, loadedToolNames } = toolArgs;
        const parsed = getActorListArgs.parse(args);
        // `sortBy` is not passed: with `my`, the API ignores it and always sorts by createdAt.
        const list = await client.actors().list({
            my: true,
            offset: parsed.offset,
            limit: parsed.limit,
            desc: parsed.desc,
        });
        const items = (list.items as ActorListApiItem[]).map((actor) => ({
            id: actor.id,
            name: actor.name,
            fullName: `${actor.username}/${actor.name}`,
            title: actor.title ?? null,
            createdAt: toIsoString(actor.createdAt) ?? null,
            modifiedAt: toIsoString(actor.modifiedAt) ?? null,
            lastRunStartedAt: toIsoString(actor.stats?.lastRunStartedAt) ?? null,
        }));
        const structuredContent = {
            total: list.total,
            count: items.length,
            offset: list.offset,
            limit: list.limit,
            desc: list.desc,
            items,
        };
        const noun = list.total === 1 ? 'Actor' : 'Actors';
        const summary = `Your account has ${list.total} ${noun}; showing ${items.length} from offset ${list.offset}.`;
        const nextStep = buildNextStep(
            { total: list.total, count: items.length, offset: list.offset },
            loadedToolNames,
        );
        return respondOk([JSON.stringify(structuredContent), `${summary}\n${nextStep}`], { structuredContent });
    },
} as const);
