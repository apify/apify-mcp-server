import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import { z } from 'zod';

import log from '@apify/log';

import { ApifyClient } from '../../apify_client.js';
import {
    APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS,
    APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED,
    APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED,
    FAILURE_CATEGORY,
    HELPER_TOOLS,
} from '../../const.js';
import { ACTOR_LOAD_ERROR_KIND, ActorLoadError } from '../../errors.js';
import { connectMCPClient } from '../../mcp/client.js';
import type { PaymentProvider } from '../../payments/types.js';
import type { ActorInfo, ApifyToken, InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { getActorDefinitionCached, getActorMcpUrlCached } from '../../utils/actor.js';
import { compileSchema } from '../../utils/ajv.js';
import {
    ACTOR_RUN_LIMIT_MESSAGE,
    isActorRunLimitError,
    isMemoryQuotaError,
    isPermissionApprovalError,
    remoteMcpFailureDetail,
} from '../../utils/apify_errors.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { logHttpError } from '../../utils/logging.js';
import {
    respondAborted,
    respondRaw,
    respondServerError,
    respondUserError,
    type ToolResponse,
} from '../../utils/mcp.js';
import { buildPermissionApprovalTexts } from '../../utils/payment_errors.js';
import { classifyFailureCategory, extractAjvErrorDetails } from '../../utils/tool_status.js';
import { extractActorId } from '../../utils/tools.js';
import { actorNameToToolName, isActorBlockedUnderPaymentProvider } from '../actor_tool_naming.js';
import { buildGetActorRunResponse } from '../runs/get_actor_run.js';
import { actorRunOutputSchema } from '../structured_output_schemas.js';
import {
    abortRunOnSignal,
    buildStartRunResponse,
    CALL_ACTOR_WAIT_SECS_DEFAULT,
    fetchActorRunData,
} from './actor_run_response.js';
import { fixActorNameInputAndLog, getActorsAsTools } from './actor_tools_factory.js';

// ---------------------------------------------------------------------------
// Shared call-actor description building blocks
// ---------------------------------------------------------------------------

const RAG_WEB_BROWSER_TOOL = actorNameToToolName('apify/rag-web-browser');

export const CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG = `When calling an MCP server Actor, you must specify the tool name in the actor parameter as "{actorName}:{toolName}" in the "actor" input property.`;

/** Shared MCP server instructions — identical in both modes. */
export const CALL_ACTOR_MCP_SERVER_SECTION = `For MCP server Actors:
- Use fetch-actor-details with output={ mcpTools: true } to list available tools
- Call using format: "actorName:toolName" (e.g., "apify/actors-mcp-server:fetch-apify-docs")`;

/** Shared "two ways to run" + USAGE section — identical in both modes. */
export const CALL_ACTOR_USAGE_SECTION = `There are two ways to run Actors:
1. Dedicated Actor tools (e.g., ${RAG_WEB_BROWSER_TOOL}): These are pre-configured tools, offering a simpler and more direct experience.
2. Generic call-actor tool (${HELPER_TOOLS.ACTOR_CALL}): Use this when a dedicated tool is not available or when you want to run any Actor dynamically. This tool is especially useful if you do not want to add specific tools or your client does not support dynamic tool registration.

USAGE:
- Always use dedicated tools when available (e.g., ${RAG_WEB_BROWSER_TOOL})
- Use the generic call-actor tool only if a dedicated tool does not exist for your Actor.`;

/** Shared examples section — identical in both modes. */
export const CALL_ACTOR_EXAMPLES_SECTION = `EXAMPLES:
- user_input: Get instagram posts using apify/instagram-scraper`;

type CallActorErrorResponseParams = {
    actorName: string;
    error: unknown;
    actorId?: string;
    mcpSessionId?: string;
    actorGetDetailsTool: typeof HELPER_TOOLS.ACTOR_GET_DETAILS;
};

const WIDGET_ADDENDUM = dedent`
    WIDGET ALTERNATIVE (apps mode):
    - If the user explicitly asks to see live progress, call ${HELPER_TOOLS.ACTOR_CALL_WIDGET} instead — it renders an interactive UI that tracks the run.
    - For silent name resolution before this call, use ${HELPER_TOOLS.STORE_SEARCH} (not ${HELPER_TOOLS.STORE_SEARCH_WIDGET}, which renders UI).
`;

function buildCallActorDescriptionSections(includeWidget: boolean): string {
    const sections: string[] = [
        'Call any Actor from the Apify Store.',
        dedent`
            WORKFLOW:
            1. Use ${HELPER_TOOLS.ACTOR_GET_DETAILS} to get the Actor's input schema
            2. Call this tool with the actor name and proper input based on the schema

            If the actor name is not in "username/name" format and ${HELPER_TOOLS.STORE_SEARCH} is available in this session, use it to resolve the correct Actor first.
        `,
        CALL_ACTOR_MCP_SERVER_SECTION,
        dedent`
            IMPORTANT:
            - Waits up to waitSecs (default 30s) for completion; returns run status, storage IDs, and field metadata
            - Use ${HELPER_TOOLS.DATASET_GET_ITEMS} with the datasetId to fetch results; non-terminal runs include a nextStep with polling instructions
            - Use dedicated Actor tools when available for better experience
        `,
        CALL_ACTOR_USAGE_SECTION,
        dedent`
            - Use \`waitSecs\` (0–45) to control how long to wait. Default 30s returns results for fast actors. Use \`waitSecs: 0\` to start and return immediately for long-running actors.
        `,
        CALL_ACTOR_EXAMPLES_SECTION,
    ];

    if (includeWidget) sections.push(WIDGET_ADDENDUM);

    return sections.join('\n\n');
}

export function buildCallActorDescription(): string {
    return buildCallActorDescriptionSections(false);
}

export function buildCallActorAppsDescription(): string {
    return buildCallActorDescriptionSections(true);
}

export function buildCallActorErrorResponse(params: CallActorErrorResponseParams): ToolResponse {
    const { actorName, error, actorId, mcpSessionId, actorGetDetailsTool } = params;

    if (isPermissionApprovalError(error)) {
        logHttpError(error, 'Failed to call Actor — permission approval required', {
            actorName,
            mcpSessionId,
            failureCategory: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
        });
        return respondUserError(buildPermissionApprovalTexts(error), {
            category: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
            httpStatus: error.statusCode,
            detail: APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED,
            actorId,
        });
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    logHttpError(error, 'Failed to call Actor', {
        actorName,
        mcpSessionId,
        failureCategory: classifyFailureCategory(error),
    });

    if (isMemoryQuotaError(error)) {
        // Deliberately do NOT mention actor-runs-abort as a recovery path — nudging the LLM
        // toward "free capacity" risks aborting unrelated in-flight runs the user cares about.
        return respondServerError(
            [
                `Failed to call Actor '${actorName}': ${errMsg}`,
                `Account memory quota exceeded for your plan. Retry with a smaller callOptions.memory, or wait for current runs to finish before retrying.`,
            ],
            { error, detail: APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED, actorId },
        );
    }

    if (isActorRunLimitError(error)) {
        return respondServerError([`Failed to call Actor '${actorName}': ${errMsg}`, ACTOR_RUN_LIMIT_MESSAGE], {
            error,
            detail: APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS,
            actorId,
        });
    }

    return respondServerError(
        [
            `Failed to call Actor '${actorName}': ${errMsg}`,
            `Please verify the Actor name, input parameters, and ensure the Actor exists.`,
            // "if available" — search-actors may not be loaded in apps-mode partial tool selections.
            `If ${HELPER_TOOLS.STORE_SEARCH} is available in this session, you can use it to search for available Actors, or get Actor details using: ${actorGetDetailsTool}.`,
        ],
        { error, detail: errMsg.slice(0, 200), actorId },
    );
}

export const callOptionsSchema = z.object({
    memory: z
        .number()
        .min(128, 'Memory must be at least 128 MB')
        .max(32768, 'Memory cannot exceed 32 GB (32768 MB)')
        .optional().describe(dedent`
            Memory per run in MB. Power of 2 from 128 to 32768.
            Apify also caps total memory across all your concurrent runs (account plan limit); if a run is rejected because that quota would be exceeded, retry with a smaller value.
        `),
    timeout: z.number().min(0, 'Timeout must be 0 or greater').optional().describe(dedent`
            Maximum runtime for the Actor in seconds. After this time elapses, the Actor will be automatically terminated.
            Use 0 for infinite timeout (no time limit).
        `),
    build: z
        .string()
        .optional()
        .describe(
            'Tag or number of the Actor build to run (e.g., "latest", "beta", "1.2.345"). If omitted, the Actor\'s default build is used.',
        ),
    maxItems: z.number().int().positive().optional().describe(dedent`
            Pay-per-result Actors only — ignored otherwise.
            Caps billed dataset items; does NOT limit production. Prefer the Actor's own input fields (e.g. maxResults) to bound work.
        `),
    maxTotalChargeUsd: z.number().positive().optional().describe(dedent`
            Pay-per-event Actors only — ignored otherwise.
            Caps total USD billed; does NOT limit work. Prefer the Actor's own input fields to bound work.
        `),
});

/** Zod schema for call-actor arguments — shared between default and apps variants. */
export const callActorArgs = z.object({
    actor: z.string().describe(dedent`
            The name of the Actor to call. Format: "username/name" (e.g., "apify/rag-web-browser").

            For MCP server Actors, use format "actorName:toolName" to call a specific tool (e.g., "apify/actors-mcp-server:fetch-apify-docs").
        `),
    input: z.object({}).passthrough().describe('The input JSON to pass to the Actor. Required.'),
    waitSecs: z
        .number()
        .int()
        .min(0, 'waitSecs must be 0 or greater')
        .max(45, 'waitSecs cannot exceed 45')
        .default(CALL_ACTOR_WAIT_SECS_DEFAULT)
        .optional()
        .describe(
            'Seconds to wait for completion (0–45, default 30). Returns with current run status if not terminal within waitSecs.',
        ),
    callOptions: callOptionsSchema
        .optional()
        .describe(
            'Optional run config: memory (MB), timeout (s), build, maxItems (pay-per-result cap), maxTotalChargeUsd (pay-per-event cap).',
        ),
});

export const callActorInputSchema = z.toJSONSchema(callActorArgs) as ToolInputSchema;
export const callActorAjvValidate = compileSchema({ ...z.toJSONSchema(callActorArgs), additionalProperties: true });

/**
 * Parsed call-actor arguments.
 */
export type CallActorParsedArgs = z.infer<typeof callActorArgs>;

/**
 * Returns a rejection MCP response when the requested Actor is a standby
 * (or MCP-server) Actor AND the session uses a third-party payment provider.
 * Otherwise returns `null`.
 *
 * Standby Actors cannot be paid for via x402 / Skyfire — calling them in
 * payment mode is a hard input error, so this guard must run BEFORE the
 * generic payment-required short-circuit in the tool-call handler so the
 * agent receives the precise reason instead of a generic 402.
 *
 * Uses `actorDefinitionCache` — one definition fetch on a cold cache.
 */
export async function checkPaymentProviderStandbyConflict(params: {
    actorName: string;
    paymentProvider: PaymentProvider;
    apifyToken: ApifyToken;
    mcpSessionId?: string;
}): Promise<Record<string, unknown> | null> {
    const { actorName, paymentProvider, apifyToken, mcpSessionId } = params;
    const normalizedActorName = fixActorNameInputAndLog(actorName, { mcpSessionId });
    const { baseActorName } = resolveActorContext(normalizedActorName);

    // Token-based client — payment headers are only relevant for actual Actor runs.
    const apifyClientForDefinition = new ApifyClient({ token: apifyToken });
    const actorDefinitionWithInfo = await getActorDefinitionCached(baseActorName, apifyClientForDefinition);
    if (!actorDefinitionWithInfo) {
        return null;
    }

    const actorInfo: ActorInfo = {
        definition: actorDefinitionWithInfo.definition,
        actor: actorDefinitionWithInfo.info,
        webServerMcpPath: null,
    };

    if (!isActorBlockedUnderPaymentProvider(actorInfo)) {
        return null;
    }

    log.softFail('Rejecting call-actor for standby Actor under third-party payment provider', {
        actorName: baseActorName,
        paymentProviderId: paymentProvider.id,
        mcpSessionId,
        failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
    });

    return respondUserError(ActorLoadError.standbyPaymentNotSupported(normalizedActorName).message);
}

/**
 * Resolves MCP URL and parses the "actor:tool" format.
 * Shared pre-processing step used by both default and apps variants.
 */
export function resolveActorContext(actorName: string): {
    baseActorName: string;
    mcpToolName: string | undefined;
} {
    const mcpToolMatch = actorName.match(/^(.+):(.+)$/);
    if (mcpToolMatch) {
        return {
            baseActorName: mcpToolMatch[1],
            mcpToolName: mcpToolMatch[2],
        };
    }
    return { baseActorName: actorName, mcpToolName: undefined };
}

/**
 * Handles the MCP tool call flow (when actorName contains ":toolName").
 * Returns a response if handled, or null if this is not an MCP tool call.
 */
export async function handleMcpToolCall(params: {
    baseActorName: string;
    mcpToolName: string;
    input: Record<string, unknown>;
    isActorMcpServer: boolean;
    mcpServerUrl: string | false;
    apifyToken: string;
    mcpSessionId?: string;
}): Promise<ToolResponse | null> {
    const { baseActorName, mcpToolName, input, isActorMcpServer, mcpServerUrl, apifyToken, mcpSessionId } = params;

    if (!isActorMcpServer) {
        return respondServerError(`Actor '${baseActorName}' is not an MCP server.`);
    }

    if (!input) {
        return respondServerError(
            `Input is required for MCP tool '${mcpToolName}'. Please provide the input parameter based on the tool's input schema.`,
        );
    }

    let client: Client | null = null;
    try {
        client = await connectMCPClient(mcpServerUrl as string, apifyToken, mcpSessionId);
        if (!client) {
            return respondServerError(`Failed to connect to MCP server ${mcpServerUrl}`);
        }

        const result = await client.callTool({
            name: mcpToolName,
            arguments: input,
        });

        // `call-actor` declares `actorRunOutputSchema`, so MCP SDK ≥ 1.11.4 rejects any response
        // without `structuredContent` (unless `isError: true`) with -32600. The pass-through has no
        // Apify run, so synthesize a sentinel `RunResponse` matching the schema's `required` keys;
        // the remote tool's payload still flows through `content`. Also forward `isError` so a
        // failing remote tool surfaces as a failure here.
        const isErrorFromRemote = result.isError === true;
        return respondRaw({
            content: result.content as ContentBlock[],
            isError: isErrorFromRemote,
            structuredContent: {
                runId: 'mcp-passthrough',
                actorId: baseActorName,
                actorName: baseActorName,
                status: isErrorFromRemote ? 'FAILED' : 'SUCCEEDED',
                storages: {},
                summary: `Called MCP tool '${mcpToolName}' on '${baseActorName}'.`,
                nextStep: 'Response content carries the remote MCP tool result; no Apify run was started.',
            },
        });
    } catch (error) {
        logHttpError(error, `Failed to call MCP tool '${mcpToolName}' on Actor '${baseActorName}'`, {
            actorName: baseActorName,
            toolName: mcpToolName,
        });
        return respondServerError(
            `Failed to call MCP tool '${mcpToolName}' on Actor '${baseActorName}': ${remoteMcpFailureDetail(error)}`,
        );
    } finally {
        if (client) await client.close();
    }
}

/**
 * Validates the actor and its input, returning the resolved actor tool or an error response.
 * Shared validation logic used by both default and openai execution paths.
 */
export async function resolveAndValidateActor(params: {
    actorName: string;
    input: Record<string, unknown>;
    toolArgs: InternalToolArgs;
}): Promise<{ error: ToolResponse } | { actor: ToolEntry }> {
    const { actorName, input, toolArgs } = params;
    const { apifyClient } = toolArgs;

    const { tools, errors } = await getActorsAsTools([actorName], apifyClient, {
        mcpSessionId: toolArgs.mcpSessionId,
    });

    // NOT_FOUND falls through to the structured "Actor not found" response below.
    // Any other error (LOAD_FAILED / STANDBY_PAYMENT_NOT_SUPPORTED) is rethrown so the
    // outer call-actor handler reports it; STANDBY is also caught upstream by the
    // call-time guard in server.ts, so it's a defensive fallback here.
    if (errors[0] && errors[0].kind !== ACTOR_LOAD_ERROR_KIND.NOT_FOUND) {
        throw errors[0];
    }
    const actor = tools[0];

    if (!actor) {
        return {
            error: respondUserError(
                dedent`
                    Actor '${actorName}' was not found.
                    Please verify Actor ID or name format (e.g., "username/name" like "apify/rag-web-browser") and ensure that the Actor exists.
                    You can search for available Actors using the tool: ${HELPER_TOOLS.STORE_SEARCH}.
                `,
                { httpStatus: 404, detail: `Actor '${actorName}' was not found` },
            ),
        };
    }

    const actorId = extractActorId(actor);

    if (!input) {
        log.softFail('Input is required for Actor', {
            actorName,
            mcpSessionId: toolArgs.mcpSessionId,
            failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
        });
        return {
            error: respondUserError(
                [
                    `Input is required for Actor '${actorName}'. Please provide the input parameter based on the Actor's input schema.`,
                    `The input schema for this Actor was retrieved and is shown below:`,
                    wrapJsonText(actor.inputSchema),
                ],
                { actorId, detail: 'input is required' },
            ),
        };
    }

    if (!actor.ajvValidate(input)) {
        const { errors } = actor.ajvValidate;
        const ajvDetails = extractAjvErrorDetails(errors ?? null);
        const validationSummary = errors?.map((e) => (e as { message?: string }).message).join(', ') ?? '';

        log.softFail('Input validation failed for Actor', {
            actorName,
            mcpSessionId: toolArgs.mcpSessionId,
            failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
            validationKeyword: ajvDetails.validation_keyword,
            validationPath: ajvDetails.validation_path,
            validationMissingProperty: ajvDetails.validation_missing_property,
        });

        const content = [
            `Input validation failed for Actor '${actorName}'. Please ensure your input matches the Actor's input schema.`,
            `Input schema:\n${wrapJsonText(actor.inputSchema)}`,
        ];
        if (validationSummary) {
            content.push(`Validation errors: ${validationSummary}`);
        }
        return {
            error: respondUserError(content, {
                actorId,
                detail: validationSummary.slice(0, 200) || 'input validation failed',
                ajvErrorDetails: ajvDetails,
            }),
        };
    }

    return { actor };
}

/**
 * Performs the pre-execution checks common to both modes:
 * - Parses args
 * - Resolves actor/MCP context
 * - Handles payment provider restrictions
 * - Handles MCP tool calls
 *
 * Returns either an early response (error or MCP tool result) or the parsed context for mode-specific execution.
 *
 * Applies the same `actor` string normalization as `getActorsAsTools` **before** MCP URL lookup and routing so
 * clients cannot pass a clean-enough id for definition fetch but a dirty id to `apifyClient.actor()` (see Mezmo:
 * e.g. trailing `` ` `` on `apify/rag-web-browser`).
 */
export async function callActorPreExecute(
    toolArgs: InternalToolArgs,
    options: { route: string },
): Promise<
    | { earlyResponse: ToolResponse }
    | {
          parsed: CallActorParsedArgs;
          baseActorName: string;
          mcpToolName: string | undefined;
      }
> {
    const { args, apifyToken, mcpSessionId } = toolArgs;
    const parsedArgs = callActorArgs.parse(args);
    const actorName = fixActorNameInputAndLog(parsedArgs.actor, { mcpSessionId, route: options.route });
    const parsed: CallActorParsedArgs = { ...parsedArgs, actor: actorName };

    const { baseActorName, mcpToolName } = resolveActorContext(parsed.actor);

    // For definition resolution we always use a token-based client; payment provider is only for actual Actor runs.
    // Standby/MCP-server Actors under a third-party payment provider are rejected upstream by
    // `checkPaymentProviderStandbyConflict` in the generic tool-call handler — see src/mcp/server.ts.
    const apifyClientForDefinition = new ApifyClient({ token: apifyToken });
    const mcpServerUrlOrFalse = await getActorMcpUrlCached(baseActorName, apifyClientForDefinition);
    const isActorMcpServer = !!mcpServerUrlOrFalse;

    // Handle the case where LLM does not respect instructions when calling MCP server Actors
    // and does not provide the tool name.
    const isMcpToolNameInvalid = mcpToolName === undefined || mcpToolName.trim().length === 0;
    if (isActorMcpServer && isMcpToolNameInvalid) {
        return {
            earlyResponse: respondServerError(CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG),
        };
    }

    // Handle MCP tool calls
    if (mcpToolName) {
        const mcpResult = await handleMcpToolCall({
            baseActorName,
            mcpToolName,
            input: parsed.input as Record<string, unknown>,
            isActorMcpServer,
            mcpServerUrl: mcpServerUrlOrFalse,
            apifyToken,
            mcpSessionId,
        });
        if (mcpResult) {
            return { earlyResponse: mcpResult };
        }
    }

    return { parsed, baseActorName, mcpToolName };
}

/**
 * Shared start-then-wait flow for call-actor variants (default + apps).
 * `taskMode` is honored — when true, `waitSecs` is ignored and the SDK waits until terminal.
 */
export async function executeCallActor(toolArgs: InternalToolArgs): Promise<ToolResponse> {
    const preResult = await callActorPreExecute(toolArgs, { route: HELPER_TOOLS.ACTOR_CALL });
    if ('earlyResponse' in preResult) {
        return preResult.earlyResponse;
    }

    const { parsed, baseActorName } = preResult;
    const { input, callOptions } = parsed;
    // Task mode waits until terminal (waitSecs=undefined uses SDK default ~999999s); caller's waitSecs is ignored.
    // Non-task mode: pass waitSecs so the SDK blocks up to that many seconds before returning.
    const waitSecs = toolArgs.taskMode ? undefined : parsed.waitSecs;

    let resolvedActorId: string | undefined;
    try {
        const resolution = await resolveAndValidateActor({
            actorName: baseActorName,
            input: input as Record<string, unknown>,
            toolArgs,
        });
        if ('error' in resolution) {
            return resolution.error;
        }

        resolvedActorId = extractActorId(resolution.actor);
        const { apifyClient } = toolArgs;
        const abortSignal = toolArgs.extra.signal;

        if (abortSignal?.aborted) return respondAborted();

        const actorRun = await apifyClient.actor(baseActorName).start(input, callOptions);
        log.debug('Started Actor run', {
            actorName: baseActorName,
            runId: actorRun.id,
            mcpSessionId: toolArgs.mcpSessionId,
            waitSecs,
        });

        // Abort can arrive while start() was in flight — abort the newly created run.
        if (abortSignal?.aborted) {
            await abortRunOnSignal(actorRun.id, apifyClient);
            return respondAborted();
        }

        const linkContext = await getConsoleLinkContext(toolArgs.apifyToken, apifyClient);

        // waitSecs:0 means "fire and forget" — start() already returned the full run, skip re-fetch.
        if (waitSecs === 0) {
            const response = buildStartRunResponse({ actorName: baseActorName, actorRun, linkContext });
            return { ...response, toolTelemetry: { actorId: resolvedActorId } };
        }

        const fetchResult = await fetchActorRunData({
            runId: actorRun.id,
            waitSecs,
            actorName: baseActorName,
            client: apifyClient,
            progressTracker: toolArgs.progressTracker,
            abortSignal,
            mcpSessionId: toolArgs.mcpSessionId,
            onAbort: abortRunOnSignal,
        });

        if ('aborted' in fetchResult) return respondAborted();
        if ('error' in fetchResult) return fetchResult.error;

        return {
            ...buildGetActorRunResponse({ ...fetchResult.result, linkContext }),
            toolTelemetry: { actorId: resolvedActorId },
        };
    } catch (error) {
        return buildCallActorErrorResponse({
            actorName: baseActorName,
            error,
            actorId: resolvedActorId,
            mcpSessionId: toolArgs.mcpSessionId,
            actorGetDetailsTool: HELPER_TOOLS.ACTOR_GET_DETAILS,
        });
    }
}

/**
 * Single call-actor definition shared by both modes — only the description differs
 * (apps mode appends a widget addendum).
 */
function createCallActorTool(description: string): ToolEntry {
    return Object.freeze({
        type: TOOL_TYPE.INTERNAL,
        name: HELPER_TOOLS.ACTOR_CALL,
        title: 'Call Actor',
        description,
        inputSchema: callActorInputSchema,
        outputSchema: actorRunOutputSchema,
        ajvValidate: callActorAjvValidate,
        paymentRequired: true,
        annotations: {
            title: 'Call Actor',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
        execution: {
            // Support long-running tasks
            taskSupport: 'optional',
        },
        call: async (toolArgs: InternalToolArgs) => executeCallActor(toolArgs),
    } as const);
}

/** Default mode call-actor tool. */
export const callActorDefault: ToolEntry = createCallActorTool(buildCallActorDescription());

/**
 * Apps mode call-actor tool.
 * Renders no widget; for a live progress UI, use the call-actor-widget sibling.
 */
export const callActorApps: ToolEntry = createCallActorTool(buildCallActorAppsDescription());
