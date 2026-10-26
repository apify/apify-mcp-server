import Ajv from 'ajv';
import type { ActorStartOptions } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { HelperTool, InternalToolArgs, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondAborted, respondServerError, respondUserError } from '../../utils/mcp.js';
import { buildGetActorRunResponse } from '../runs/get_actor_run.js';
import { actorRunOutputSchema } from '../structured_output_schemas.js';
import { abortRunOnSignal, fetchActorRunData } from './actor_run_response.js';
import { CURATED_ACTOR_LIMITS, CURATED_ACTOR_POLICIES, type CuratedActorPolicy } from './curated_actor_catalog.js';
import {
    CURATED_ACTOR_RELEASES,
    CuratedActorReleaseValidator,
    type CuratedActorReleases,
} from './curated_actor_releases.js';

export { CURATED_ACTOR_TOOL_NAMES } from './curated_actor_catalog.js';

/** Unlike generic Actor validation, this validator rejects unknown fields without mutating the request. */
const CURATED_AJV = new Ajv({ strict: false, coerceTypes: false, removeAdditional: false });
CURATED_AJV.addFormat('date', { type: 'string', validate: (value) => z.iso.date().safeParse(value).success });

async function executeCuratedActor(
    policy: CuratedActorPolicy,
    releases: CuratedActorReleases,
    context: InternalToolArgs,
) {
    const parsed = policy.validator.safeParse(context.args);
    if (!parsed.success) {
        return respondUserError('Invalid curated Actor input. Use only the declared fields and limits.');
    }
    if (context.signal.aborted) return respondAborted();
    const releaseResult = CuratedActorReleaseValidator.safeParse(releases[policy.name]);
    if (
        !releaseResult.success ||
        !releaseResult.data.review ||
        !releaseResult.data.buildId ||
        !releaseResult.data.buildNumber ||
        releaseResult.data.actorId !== policy.actorId ||
        releaseResult.data.maintenanceEvidence !== `https://apify.com/${policy.actorName}`
    ) {
        return respondServerError(
            'This curated Actor release has no valid approval. No run was started. The server maintainer must approve the pinned build.',
        );
    }
    const release = releaseResult.data;
    const client = context.apifyClient;
    const [actor, build] = await Promise.all([
        client.actor(policy.actorId).get(),
        client.build(release.buildId!).get(),
    ]);
    if (context.signal.aborted) return respondAborted();
    if (
        !actor ||
        actor.id !== policy.actorId ||
        actor.isDeprecated ||
        actor.actorPermissionLevel !== 'LIMITED_PERMISSIONS' ||
        !build ||
        build.id !== release.buildId ||
        build.actId !== policy.actorId ||
        build.buildNumber !== release.buildNumber ||
        build.status !== 'SUCCEEDED'
    ) {
        return respondServerError(
            'The approved Actor build or its permissions could not be verified. No run was started. Contact the server maintainer.',
        );
    }
    const options: ActorStartOptions = {
        build: release.buildNumber!,
        memory: CURATED_ACTOR_LIMITS.memoryMbytes,
        timeout: CURATED_ACTOR_LIMITS.timeoutSecs,
        maxItems: CURATED_ACTOR_LIMITS.maxPaidItems,
        maxTotalChargeUsd: CURATED_ACTOR_LIMITS.maxTotalChargeUsd,
        forcePermissionLevel: 'LIMITED_PERMISSIONS',
        restartOnError: false,
    };
    const run = await client.actor(policy.actorId).start(policy.buildInput(parsed.data), options);
    if (context.signal.aborted) {
        await abortRunOnSignal(run.id, client);
        return respondAborted();
    }
    if (run.actId !== policy.actorId || run.buildId !== release.buildId) {
        await abortRunOnSignal(run.id, client);
        return respondServerError(
            'The started run did not match the approved build. An abort was requested; contact the server maintainer before retrying.',
        );
    }
    const fetched = await fetchActorRunData({
        runId: run.id,
        actorName: policy.actorName,
        client,
        waitSecs: parsed.data.waitSecs as number,
        progressTracker: context.progressTracker,
        abortSignal: context.signal,
        mcpSessionId: context.mcpSessionId,
        onAbort: abortRunOnSignal,
    });
    if ('aborted' in fetched) return respondAborted();
    if ('error' in fetched) return fetched.error;
    // Explicit-only tools can be served alone. Do not name retrieval tools absent from that session.
    if (
        Object.values(HELPER_TOOLS).some(
            (name) =>
                fetched.result.structuredContent.nextStep.includes(name) && !context.loadedToolNames.includes(name),
        )
    ) {
        fetched.result.structuredContent.nextStep = 'Inspect this run and its output in Apify Console.';
    }
    return buildGetActorRunResponse({
        ...fetched.result,
        linkContext: await getConsoleLinkContext(client.token, client),
        hasCallActorTool: false,
    });
}

/** Build the fixed tool surface. Approval configuration is copied so later mutations cannot enable a release. */
export function createCuratedActorTools(releases: CuratedActorReleases = CURATED_ACTOR_RELEASES): HelperTool[] {
    const releaseSnapshot = structuredClone(releases);
    return CURATED_ACTOR_POLICIES.map((policy): HelperTool => {
        const inputSchema = fixZodSchemaRequired(z.toJSONSchema(policy.validator)) as ToolInputSchema;
        return Object.freeze<HelperTool>({
            type: TOOL_TYPE.INTERNAL,
            name: policy.name,
            title: policy.title,
            description: dedent`
                ${policy.description}
                Starts a paid Apify Actor run with a fixed build and limited permissions, after release approval.
                The server sets a $${CURATED_ACTOR_LIMITS.maxTotalChargeUsd} run charge limit and a ${CURATED_ACTOR_LIMITS.timeoutSecs}-second timeout.
                Returns run status and output storage identifiers. Retrying starts another paid run.
            `,
            inputSchema,
            outputSchema: actorRunOutputSchema,
            ajvValidate: CURATED_AJV.compile(inputSchema),
            paymentRequired: true,
            annotations: {
                title: policy.title,
                readOnlyHint: false,
                destructiveHint: false,
                openWorldHint: true,
                idempotentHint: false,
            },
            execution: { taskSupport: 'optional' },
            // Unknown fields may contain credentials; rejection happens after the call engine logs its input.
            redactArgs: () => ({}),
            call: async (context) => await executeCuratedActor(policy, releaseSnapshot, context),
        });
    });
}

export const CURATED_ACTOR_TOOLS = createCuratedActorTools();
