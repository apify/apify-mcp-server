import type { Build, BuildCollectionClientListItem } from 'apify-client';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { toIsoString } from '../actors/actor_run_response.js';
import { catchNotFound } from '../storage/storage_helpers.js';
import { getActorBuildListToolOutputSchema } from '../structured_output_schemas.js';

const getActorBuildListArgs = z.object({
    actorId: z
        .string()
        .min(1)
        .optional()
        .describe('Only list builds of this Actor; accepts an Actor ID or username/name.'),
    offset: z.number().int().min(0).describe('Number of builds to skip at the start. Default: 0.').default(0),
    limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe('Maximum number of builds to return. Default and maximum: 10.')
        .default(10),
    // Newest first by default, unlike get-actor-run-list, because the build a caller looks for is
    // usually the latest one (#1407).
    desc: z
        .boolean()
        .describe('If true, the builds are sorted by startedAt, newest first; false sorts oldest first. Default: true.')
        .default(true),
});

/**
 * One build as the list endpoint returns it (OpenAPI `BuildShort`). The client's item type leaves out
 * `actId` and `buildNumber`, which the API does send.
 */
type BuildListItem = BuildCollectionClientListItem & Pick<Build, 'actId' | 'buildNumber'>;

/** Statuses of a build that ended without succeeding; the next step points at the newest one's log. */
const FAILED_BUILD_STATUSES: ReadonlySet<string> = new Set(['FAILED', 'TIMED-OUT', 'ABORTED']);

/**
 * The build subset returned per item. Allowlisted so userId, meta and usage never reach the client.
 * The same fields as `toBuildResult` in build_helpers.ts without the Console link; change both together.
 */
function toBuildListItem(build: BuildListItem) {
    return {
        id: build.id,
        actorId: build.actId,
        buildNumber: build.buildNumber,
        status: build.status,
        // Normalized because the client parses these into `Date` objects; the output schema promises strings.
        startedAt: toIsoString(build.startedAt) ?? null,
        finishedAt: toIsoString(build.finishedAt) ?? null,
    };
}

/**
 * The one next step after a page of builds. A failed build is the usual reason to list builds, so the
 * newest failed build on the page wins. Sibling tools are named only when the session was served them.
 */
function buildNextStepForBuildList(
    builds: BuildListItem[],
    desc: boolean,
    loadedToolNames: readonly string[],
): string | undefined {
    const failedBuilds = builds.filter((build) => FAILED_BUILD_STATUSES.has(build.status));
    // The API sorts by startedAt, so the newest failed build leads a descending page and ends an ascending one.
    const newestFailedBuild = desc ? failedBuilds[0] : failedBuilds.at(-1);
    if (newestFailedBuild) {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD_LOG)
            ? `Read why build ${newestFailedBuild.buildNumber} failed with ${HELPER_TOOLS.ACTOR_BUILD_LOG} using buildId ${newestFailedBuild.id}.`
            : `Read the log of build ${newestFailedBuild.buildNumber} (ID ${newestFailedBuild.id}) to see why it failed.`;
    }
    // An empty page has no build to check.
    if (builds.length > 0 && loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD_GET)) {
        return `Check a build with ${HELPER_TOOLS.ACTOR_BUILD_GET} using its buildId.`;
    }
    return undefined;
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `List the Actor builds of the account, newest first by default. Pass actorId to list only the builds of one Actor, for example to find why its latest build failed. Lists builds in every status; there is no status filter.
Read-only. Returns total, count, offset, limit, desc and items (id, actorId, buildNumber, status, startedAt, finishedAt)
and a summary with at most one next step.${
        hasTool(HELPER_TOOLS.ACTOR_BUILD_GET)
            ? ` Check a build with ${HELPER_TOOLS.ACTOR_BUILD_GET} by passing its id as buildId.`
            : ''
    }${
        hasTool(HELPER_TOOLS.ACTOR_BUILD_LOG)
            ? ` Read why a build failed with ${HELPER_TOOLS.ACTOR_BUILD_LOG} by passing its id as buildId.`
            : ''
    }

USAGE:
- Use to find the ID of a build that failed or that no run references.
- Use to see recent builds and their statuses, of one Actor or across the account.

USAGE EXAMPLES:
- user_input: Why did the last build of my-actor fail?
- user_input: List the builds of john/my-actor`;
}

/**
 * https://docs.apify.com/api/v2/actor-builds-get (all builds of the user)
 * https://docs.apify.com/api/v2/act-builds-get (builds of one Actor, when `actorId` is given)
 *
 * Mirrors get-actor-run-list: `actorId` is an optional filter, not a required argument.
 */
export const getActorBuildList: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_BUILD_LIST_GET,
    title: 'Get Actor build list',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // `fixZodSchemaRequired` strips `offset`, `limit` and `desc` from `required` because they have defaults; no field is required.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(getActorBuildListArgs)) as ToolInputSchema,
    outputSchema: getActorBuildListToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorBuildListArgs)),
    annotations: {
        title: 'Get Actor build list',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, loadedToolNames } = toolArgs;
        const parsed = getActorBuildListArgs.parse(args);
        const listOptions = { offset: parsed.offset, limit: parsed.limit, desc: parsed.desc };
        const builds = parsed.actorId
            ? await catchNotFound(client.actor(parsed.actorId).builds().list(listOptions))
            : await client.builds().list(listOptions);
        if (!builds) {
            return respondUserError(`Actor '${parsed.actorId}' not found.`);
        }
        // Cast because the client's item type omits fields the API returns (see `BuildListItem`).
        const items = builds.items as BuildListItem[];
        const structuredContent = {
            total: builds.total,
            count: builds.count,
            offset: builds.offset,
            limit: builds.limit,
            desc: builds.desc,
            items: items.map(toBuildListItem),
        };
        const owner = parsed.actorId ? `Actor ${parsed.actorId}` : 'Your account';
        const summary = `${owner} has ${builds.total} builds; showing ${builds.count} from offset ${builds.offset}.`;
        const nextStep = buildNextStepForBuildList(items, builds.desc, loadedToolNames);
        return respondOk([JSON.stringify(structuredContent), nextStep ? `${summary}\n${nextStep}` : summary], {
            structuredContent,
        });
    },
} as const);
