import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import log from '@apify/log';

import { ApifyClient } from '../../apify_client.js';
import {
    APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED,
    APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED,
    FAILURE_CATEGORY,
    HelperTools,
    TOOL_STATUS,
} from '../../const.js';
import { connectMCPClient } from '../../mcp/client.js';
import type { PaymentProvider } from '../../payments/types.js';
import type { ApifyToken, InternalToolArgs, ToolInputSchema } from '../../types.js';
import { getActorMcpUrlCached } from '../../utils/actor.js';
import { compileSchema } from '../../utils/ajv.js';
import { getHttpStatusCode, logHttpError } from '../../utils/logging.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { classifyFailureCategory, extractAjvErrorDetails, getToolStatusFromError } from '../../utils/tool_status.js';
import { extractActorId } from '../../utils/tools.js';
import { actorNameToToolName } from '../utils.js';
import { abortRunOnSignal, buildStartRunResponse, CALL_ACTOR_WAIT_SECS_DEFAULT, fetchActorRunData } from './actor_run_response.js';
import { fixActorNameInputAndLog, getActorsAsTools } from './actor_tools_factory.js';
import { buildGetActorRunSuccessResponse } from './get_actor_run_common.js';
import { actorDefinitionCache } from '../../state.js';
import { getActorDefinition } from '../build.js';

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
2. Generic call-actor tool (${HelperTools.ACTOR_CALL}): Use this when a dedicated tool is not available or when you want to run any Actor dynamically. This tool is especially useful if you do not want to add specific tools or your client does not support dynamic tool registration.

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
    actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS;
};

const WIDGET_ADDENDUM = dedent`
    WIDGET ALTERNATIVE (apps mode):
    - If the user explicitly asks to see live progress, call ${HelperTools.ACTOR_CALL_WIDGET} instead — it renders an interactive UI that tracks the run.
    - For silent name resolution before this call, use ${HelperTools.STORE_SEARCH} (not ${HelperTools.STORE_SEARCH_WIDGET}, which renders UI).
`;

function buildCallActorDescriptionSections(includeWidget: boolean): string {
    const sections: string[] = [
        'Call any Actor from the Apify Store.',
        dedent`
            WORKFLOW:
            1. Use ${HelperTools.ACTOR_GET_DETAILS} to get the Actor's input schema
            2. Call this tool with the actor name and proper input based on the schema

            If the actor name is not in "username/name" format and ${HelperTools.STORE_SEARCH} is available in this session, use it to resolve the correct Actor first.
        `,
        CALL_ACTOR_MCP_SERVER_SECTION,
        dedent`
            IMPORTANT:
            - Waits up to waitSecs (default 30s) for completion; returns run status, storage IDs, and field metadata
            - Use ${HelperTools.DATASET_GET_ITEMS} with the datasetId to fetch results; non-terminal runs include a nextStep with polling instructions
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

export function isPermissionApprovalError(error: unknown): error is ApifyApiError {
    return error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED;
}

function isMemoryQuotaError(error: unknown): error is ApifyApiError {
    return error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED;
}

/** Exported for native actor tool error handling in server.ts — no logging, no telemetry. */
export function buildPermissionApprovalResponse(error: ApifyApiError): ReturnType<typeof buildMCPResponse> {
    const approvalUrl = typeof error.data?.approvalUrl === 'string' ? error.data.approvalUrl : undefined;
    return buildMCPResponse({
        texts: [
            error.message,
            ...(approvalUrl ? [`Approve here: ${approvalUrl}`] : []),
        ],
        isError: true,
    });
}

function buildPermissionApprovalErrorResponse(
    actorName: string,
    error: ApifyApiError,
    actorId: string | undefined,
    mcpSessionId: string | undefined,
): ReturnType<typeof buildMCPResponse> {
    logHttpError(error, 'Failed to call Actor — permission approval required', {
        actorName,
        mcpSessionId,
        failureCategory: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
    });
    return {
        ...buildPermissionApprovalResponse(error),
        toolTelemetry: {
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
            failureHttpStatus: error.statusCode,
            failureDetail: APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED,
            actorId,
        },
    };
}

export function buildCallActorErrorResponse(params: CallActorErrorResponseParams): ReturnType<typeof buildMCPResponse> {
    const {
        actorName,
        error,
        actorId,
        mcpSessionId,
        actorGetDetailsTool,
    } = params;

    if (error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED) {
        return buildPermissionApprovalErrorResponse(actorName, error, actorId, mcpSessionId);
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    const failureCategory = classifyFailureCategory(error);
    logHttpError(error, 'Failed to call Actor', {
        actorName,
        mcpSessionId,
        failureCategory,
    });

    const telemetry = {
        toolStatus: getToolStatusFromError(error, false),
        failureCategory,
        failureHttpStatus: getHttpStatusCode(error),
        failureDetail: errMsg.slice(0, 200),
        actorId,
    };

    if (isMemoryQuotaError(error)) {
        // Deliberately do NOT mention actor-runs-abort as a recovery path — nudging the LLM
        // toward "free capacity" risks aborting unrelated in-flight runs the user cares about.
        return buildMCPResponse({
            texts: [
                `Failed to call Actor '${actorName}': ${errMsg}`,
                `Account memory quota exceeded for your plan. Retry with a smaller callOptions.memory, or wait for current runs to finish before retrying.`,
            ],
            isError: true,
            telemetry: { ...telemetry, failureDetail: APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED },
        });
    }

    return buildMCPResponse({
        texts: [
            `Failed to call Actor '${actorName}': ${errMsg}`,
            `Please verify the Actor name, input parameters, and ensure the Actor exists.`,
            // "if available" — search-actors may not be loaded in apps-mode partial tool selections.
            `If ${HelperTools.STORE_SEARCH} is available in this session, you can use it to search for available Actors, or get Actor details using: ${actorGetDetailsTool}.`,
        ],
        isError: true,
        telemetry,
    });
}

export const callOptionsSchema = z.object({
    memory: z.number()
        .min(128, 'Memory must be at least 128 MB')
        .max(32768, 'Memory cannot exceed 32 GB (32768 MB)')
        .optional()
        .describe(dedent`
            Memory per run in MB. Power of 2 from 128 to 32768.
            Apify also caps total memory across all your concurrent runs (account plan limit); if a run is rejected because that quota would be exceeded, retry with a smaller value.
        `),
    timeout: z.number()
        .min(0, 'Timeout must be 0 or greater')
        .optional()
        .describe(dedent`
            Maximum runtime for the Actor in seconds. After this time elapses, the Actor will be automatically terminated.
            Use 0 for infinite timeout (no time limit).
        `),
    build: z.string()
        .optional()
        .describe('Tag or number of the Actor build to run (e.g., "latest", "beta", "1.2.345"). If omitted, the Actor\'s default build is used.'),
    maxItems: z.number()
        .int()
        .positive()
        .optional()
        .describe(dedent`
            Pay-per-result Actors only — ignored otherwise.
            Caps billed dataset items; does NOT limit production. Prefer the Actor's own input fields (e.g. maxResults) to bound work.
        `),
    maxTotalChargeUsd: z.number()
        .positive()
        .optional()
        .describe(dedent`
            Pay-per-event Actors only — ignored otherwise.
            Caps total USD billed; does NOT limit work. Prefer the Actor's own input fields to bound work.
        `),
});

/** Zod schema for call-actor arguments — shared between default and apps variants. */
export const callActorArgs = z.object({
    actor: z.string()
        .describe(dedent`
            The name of the Actor to call. Format: "username/name" (e.g., "apify/rag-web-browser").

            For MCP server Actors, use format "actorName:toolName" to call a specific tool (e.g., "apify/actors-mcp-server:fetch-apify-docs").
        `),
    input: z.object({}).passthrough()
        .describe('The input JSON to pass to the Actor. Required.'),
    waitSecs: z.number()
        .int()
        .min(0, 'waitSecs must be 0 or greater')
        .max(45, 'waitSecs cannot exceed 45')
        .default(CALL_ACTOR_WAIT_SECS_DEFAULT)
        .optional()
        .describe('Seconds to wait for completion (0–45, default 30). Returns with current run status if not terminal within waitSecs.'),
    callOptions: callOptionsSchema.optional()
        .describe('Optional run config: memory (MB), timeout (s), build, maxItems (pay-per-result cap), maxTotalChargeUsd (pay-per-event cap).'),
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
 * Uses `actorDefinitionCache` + `getActorMcpUrlCached` — cheap on a
 * warm cache, one definition fetch on a cold cache.
 */
export async function checkPaymentProviderStandbyConflict(params: {
    actorName: string;
    paymentProvider: PaymentProvider;
    apifyToken: ApifyToken;
    mcpSessionId?: string;
}): Promise<object | null> {
    const { actorName, paymentProvider, apifyToken, mcpSessionId } = params;
    const normalizedActorName = fixActorNameInputAndLog(actorName, { mcpSessionId });
    const { baseActorName } = resolveActorContext(normalizedActorName);

    // Token-based client — payment headers are only relevant for actual Actor runs.
    const apifyClientForDefinition = new ApifyClient({ token: apifyToken });
    const mcpServerUrlOrFalse = await getActorMcpUrlCached(baseActorName, apifyClientForDefinition);
    const isActorMcpServer = !!mcpServerUrlOrFalse;

    let actorDefinitionWithInfo = actorDefinitionCache.get(baseActorName);
    if (!actorDefinitionWithInfo) {
        actorDefinitionWithInfo = await getActorDefinition(baseActorName, apifyClientForDefinition);
        if (actorDefinitionWithInfo) {
            actorDefinitionCache.set(baseActorName, actorDefinitionWithInfo);
        }
    }
    const isStandbyActor = !!actorDefinitionWithInfo?.info?.actorStandby?.isEnabled;

    if (!isStandbyActor && !isActorMcpServer) {
        return null;
    }

    log.softFail('Rejecting call-actor for standby Actor under third-party payment provider', {
        actorName: baseActorName,
        paymentProviderId: paymentProvider.id,
        mcpSessionId,
        failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
    });

    return buildMCPResponse({
        texts: [dedent`
            This Actor (${normalizedActorName}) is a standby Actor and cannot be accessed using a third-party payment provider.
            To use this Actor, please provide a valid Apify token instead.
        `],
        isError: true,
        telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
    });
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
}): Promise<object | null> {
    const { baseActorName, mcpToolName, input, isActorMcpServer, mcpServerUrl, apifyToken, mcpSessionId } = params;

    if (!isActorMcpServer) {
        return buildMCPResponse({
            texts: [`Actor '${baseActorName}' is not an MCP server.`],
            isError: true,
        });
    }

    if (!input) {
        return buildMCPResponse({
            texts: [`Input is required for MCP tool '${mcpToolName}'. Please provide the input parameter based on the tool's input schema.`],
            isError: true,
        });
    }

    let client: Client | null = null;
    try {
        client = await connectMCPClient(mcpServerUrl as string, apifyToken, mcpSessionId);
        if (!client) {
            return buildMCPResponse({
                texts: [`Failed to connect to MCP server ${mcpServerUrl}`],
                isError: true,
            });
        }

        const result = await client.callTool({
            name: mcpToolName,
            arguments: input,
        });

        // `call-actor` declares `getActorRunOutputSchema`, so MCP SDK ≥ 1.11.4 rejects any response
        // without `structuredContent` (unless `isError: true`) with -32600. The pass-through has no
        // Apify run, so synthesize a sentinel `RunResponse` matching the schema's `required` keys;
        // the remote tool's payload still flows through `content`. Also forward `isError` so a
        // failing remote tool surfaces as a failure here.
        const isErrorFromRemote = result.isError === true;
        return {
            content: result.content,
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
        };
    } catch (error) {
        logHttpError(error, `Failed to call MCP tool '${mcpToolName}' on Actor '${baseActorName}'`, {
            actorName: baseActorName,
            toolName: mcpToolName,
        });
        const errMsg = error instanceof Error ? error.message : String(error);
        return buildMCPResponse({
            texts: [`Failed to call MCP tool '${mcpToolName}' on Actor '${baseActorName}': ${errMsg}. The MCP server may be temporarily unavailable.`],
            isError: true,
        });
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
}): Promise<{ error: object } | { actor: Awaited<ReturnType<typeof getActorsAsTools>>[0] }> {
    const { actorName, input, toolArgs } = params;
    const { apifyClient } = toolArgs;

    let actor: Awaited<ReturnType<typeof getActorsAsTools>>[0] | undefined;
    try {
        const [resolvedActor] = await getActorsAsTools([actorName], apifyClient, {
            mcpSessionId: toolArgs.mcpSessionId,
            throwOnError: true,
        });
        actor = resolvedActor;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes('was not found')) {
            actor = undefined;
        } else {
            throw error;
        }
    }

    if (!actor) {
        return {
            error: buildMCPResponse({
                texts: [dedent`
                    Actor '${actorName}' was not found.
                    Please verify Actor ID or name format (e.g., "username/name" like "apify/rag-web-browser") and ensure that the Actor exists.
                    You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}.
                `],
                isError: true,
                telemetry: {
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                    failureHttpStatus: 404,
                    failureDetail: `Actor '${actorName}' was not found`,
                },
            }),
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
            error: buildMCPResponse({
                texts: [
                    `Input is required for Actor '${actorName}'. Please provide the input parameter based on the Actor's input schema.`,
                    `The input schema for this Actor was retrieved and is shown below:`,
                    `\`\`\`json\n${JSON.stringify(actor.inputSchema)}\n\`\`\``,
                ],
                isError: true,
                telemetry: {
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                    actorId,
                    failureDetail: 'input is required',
                },
            }),
        };
    }

    if (!actor.ajvValidate(input)) {
        const { errors } = actor.ajvValidate;
        const ajvDetails = extractAjvErrorDetails(errors ?? null);
        const validationSummary = errors
            ?.map((e) => (e as { message?: string }).message)
            .join(', ') ?? '';

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
            `Input schema:\n\`\`\`json\n${JSON.stringify(actor.inputSchema)}\n\`\`\``,
        ];
        if (validationSummary) {
            content.push(`Validation errors: ${validationSummary}`);
        }
        return {
            error: buildMCPResponse({
                texts: content,
                isError: true,
                telemetry: {
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                    actorId,
                    failureDetail: validationSummary.slice(0, 200) || 'input validation failed',
                    ajvErrorDetails: ajvDetails,
                },
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
    | { earlyResponse: object }
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
            earlyResponse: buildMCPResponse({
                texts: [CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG],
                isError: true,
            }),
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
export async function executeCallActor(toolArgs: InternalToolArgs): Promise<object> {
    const preResult = await callActorPreExecute(toolArgs, { route: HelperTools.ACTOR_CALL });
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

        if (abortSignal?.aborted) return {};

        const actorRun = await apifyClient.actor(baseActorName).start(input, callOptions);
        log.debug('Started Actor run', { actorName: baseActorName, runId: actorRun.id, mcpSessionId: toolArgs.mcpSessionId, waitSecs });

        // Abort can arrive while start() was in flight — abort the newly created run.
        if (abortSignal?.aborted) {
            await abortRunOnSignal(actorRun.id, apifyClient);
            return {};
        }

        // waitSecs:0 means "fire and forget" — start() already returned the full run, skip re-fetch.
        if (waitSecs === 0) {
            const response = buildStartRunResponse({ actorName: baseActorName, actorRun });
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

        if ('aborted' in fetchResult) return {};
        if ('error' in fetchResult) return fetchResult.error;

        return {
            ...buildGetActorRunSuccessResponse({ ...fetchResult.result, widget: false }),
            toolTelemetry: { actorId: resolvedActorId },
        };
    } catch (error) {
        return buildCallActorErrorResponse({
            actorName: baseActorName,
            error,
            actorId: resolvedActorId,
            mcpSessionId: toolArgs.mcpSessionId,
            actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
        });
    }
}
