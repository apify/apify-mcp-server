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
import type { PaymentProvider } from '../../payments/types.js';
import type { ApifyToken, InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ACTOR_TOOL_MODE, ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { getActorDefinitionCached, getActorToolResolutionCached } from '../../utils/actor.js';
import { compileSchema } from '../../utils/ajv.js';
import {
    ACTOR_RUN_LIMIT_MESSAGE,
    isActorInputValidationError,
    isActorRunLimitError,
    isMemoryQuotaError,
    isPermissionApprovalError,
} from '../../utils/apify_errors.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { logHttpError } from '../../utils/logging.js';
import {
    buildInvalidInputTexts,
    respondAborted,
    respondServerError,
    respondUserError,
    type ToolResponse,
} from '../../utils/mcp.js';
import { buildPermissionApprovalTexts } from '../../utils/payment_errors.js';
import { classifyFailureCategory, extractAjvErrorDetails } from '../../utils/tool_status.js';
import { extractActorId } from '../../utils/tools.js';
import { getOwnServerRemedy, isActorBlockedUnderPaymentProvider } from '../actor_tool_naming.js';
import { buildGetActorRunResponse } from '../runs/get_actor_run.js';
import { actorRunOutputSchema, anyJsonObjectSchema } from '../structured_output_schemas.js';
import {
    abortRunOnSignal,
    buildStartRunResponse,
    CALL_ACTOR_WAIT_SECS_DEFAULT,
    fetchActorRunData,
} from './actor_run_response.js';
import { fixActorNameInputAndLog, getActorsAsTools, MCP_TOOL_NAME_SUFFIX } from './actor_tools_factory.js';

// ---------------------------------------------------------------------------
// Shared call-actor description building blocks
// ---------------------------------------------------------------------------

/** Points at the Actor Server for results that do not need a batch run. */
function buildCallActorServerActorSection({ hasTool }: ToolDescriptionContext): string {
    const operations = hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS)
        ? `\n- ${HELPER_TOOLS.ACTOR_GET_DETAILS} with output={ serverInterface: true } lists its HTTP operations`
        : '';
    return `For Server Actors (Actors with an HTTP API):
- This tool starts a batch run and stores the results in a dataset; use it when you need batch results
- For one or a few results, ${HELPER_TOOLS.ACTOR_SERVER_REQUEST} returns them in the HTTP response, without a batch run${operations}`;
}

/** Shared "two ways to run" + USAGE section — identical in both modes. */
function buildCallActorUsageSection(): string {
    return `There are two ways to run Actors:
1. Dedicated Actor tools: These are pre-configured tools, offering a simpler and more direct experience.
2. Generic call-actor tool (${HELPER_TOOLS.ACTOR_CALL}): Use this when a dedicated tool is not available or when you want to run any Actor dynamically. This tool is especially useful if you do not want to add specific tools or your client does not support dynamic tool registration.

USAGE:
- Always use dedicated tools when available
- Use the generic call-actor tool only if a dedicated tool does not exist for your Actor.`;
}

/** Shared examples section — identical in both modes. */
export const CALL_ACTOR_EXAMPLES_SECTION = `EXAMPLES:
- user_input: Get instagram posts using apify/instagram-scraper`;

type CallActorErrorResponseParams = {
    actorName: string;
    error: unknown;
    actorId?: string;
    mcpSessionId?: string;
    /** Names of all currently loaded tools — gates which recovery tools this error may name. */
    loadedToolNames: readonly string[];
    /** Actor's input schema, echoed back only on a confirmed platform input-validation error. */
    inputSchema?: ToolInputSchema;
};

/**
 * Recovery offers for a failed call, naming only the tools actually loaded in this session —
 * omits the sentence if none are. Not for the not-found branch of `resolveAndValidateActor`:
 * there the Actor does not exist, so the detail-lookup offer is a dead end.
 */
function buildCallFailureRecoveryHint(loadedToolNames: readonly string[]): string {
    const hints = [
        loadedToolNames.includes(HELPER_TOOLS.STORE_SEARCH)
            ? `search for available Actors using ${HELPER_TOOLS.STORE_SEARCH}`
            : '',
        loadedToolNames.includes(HELPER_TOOLS.ACTOR_GET_DETAILS)
            ? `get Actor details using ${HELPER_TOOLS.ACTOR_GET_DETAILS}`
            : '',
    ].filter(Boolean);
    return hints.length ? `You can ${hints.join(', or ')}.` : '';
}

// call-actor-widget is not auto-paired (see WIDGET_BY_BASE_TOOL) but stays directly selectable via
// ?tools=call-actor-widget — gate strictly on its own presence, never on apps mode alone.
function buildWidgetAddendum({ hasTool }: ToolDescriptionContext): string {
    // Requires both search-actors and its widget — avoids naming the widget off the base tool alone.
    const hasSearchPair = hasTool(HELPER_TOOLS.STORE_SEARCH) && hasTool(HELPER_TOOLS.STORE_SEARCH_WIDGET);
    return dedent`
        WIDGET ALTERNATIVE (apps mode):
        - If the user explicitly asks to see live progress, call ${HELPER_TOOLS.ACTOR_CALL_WIDGET} instead — it renders an interactive UI that tracks the run.
        ${hasSearchPair ? `- For silent name resolution before this call, use ${HELPER_TOOLS.STORE_SEARCH} (not ${HELPER_TOOLS.STORE_SEARCH_WIDGET}, which renders UI).` : ''}
    `;
}

export function buildCallActorDescription(ctx: ToolDescriptionContext = ALL_TOOLS_PRESENT): string {
    const { hasTool } = ctx;
    const workflowSection = [
        'WORKFLOW:',
        ...(hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS)
            ? [
                  `1. Use ${HELPER_TOOLS.ACTOR_GET_DETAILS} to get the Actor's input schema`,
                  '2. Call this tool with the actor name and proper input based on the schema',
              ]
            : ['Call this tool with the actor name and proper input matching the Actor input schema.']),
        ...(hasTool(HELPER_TOOLS.STORE_SEARCH)
            ? [
                  '',
                  `If the actor name is not in "username/name" format, use ${HELPER_TOOLS.STORE_SEARCH} to resolve the correct Actor first.`,
              ]
            : []),
    ].join('\n');
    const sections: string[] = [
        'Call any Actor from the Apify Store.',
        workflowSection,
        `MCP server Actors are not run here${hasTool(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL) ? `; ${HELPER_TOOLS.ACTOR_MCP_TOOL_CALL} calls their MCP tools` : ''}.`,
        ...(hasTool(HELPER_TOOLS.ACTOR_SERVER_REQUEST) ? [buildCallActorServerActorSection(ctx)] : []),
        dedent`
            IMPORTANT:
            - Waits up to waitSecs (default 30s) for completion; returns run status and storage IDs, and with waitSecs > 0 also reports dataset field metadata
            - Use ${HELPER_TOOLS.DATASET_GET_ITEMS} with the datasetId to fetch results; non-terminal runs include a nextStep with polling instructions
            - Use dedicated Actor tools when available for better experience
        `,
        buildCallActorUsageSection(),
        dedent`
            - Use \`waitSecs\` (0–45) to control how long to wait. Default 30s returns results for fast actors. Use \`waitSecs: 0\` to start and return immediately for long-running actors.
        `,
        CALL_ACTOR_EXAMPLES_SECTION,
    ];

    if (hasTool(HELPER_TOOLS.ACTOR_CALL_WIDGET)) sections.push(buildWidgetAddendum(ctx));

    return sections.join('\n\n');
}

/**
 * Rejection for an Actor whose standby configuration `call-actor` cannot serve. softFail, not
 * logHttpError: the caller asked for an Actor we cannot expose, so this is a client fault and
 * must not raise an error-level alert.
 */
function respondStandbyRejection(
    error: ActorLoadError,
    opts: { mcpSessionId?: string; actorId?: string; paymentProviderId?: string },
): ToolResponse {
    log.softFail('Rejecting a tool call for an unsupported standby Actor', {
        // The error's canonical Actor name, not the caller's identifier, which may be an Actor ID.
        // `actorLoadErrorKind` distinguishes which cell rejected it.
        actorName: error.actorName,
        mcpSessionId: opts.mcpSessionId,
        paymentProviderId: opts.paymentProviderId,
        actorLoadErrorKind: error.kind,
        failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
    });
    return respondUserError(error.message, { actorId: opts.actorId, detail: error.kind });
}

/** Canonical "Actor not found" answer for the run path. */
function respondActorNotFound(actorName: string, loadedToolNames: readonly string[]): ToolResponse {
    // See apify/apify-mcp-server#1296.
    // Only search-actors: the Actor does not exist, so buildCallFailureRecoveryHint's second
    // offer (get Actor details) would send the model to a lookup that fails the same way.
    const recovery = loadedToolNames.includes(HELPER_TOOLS.STORE_SEARCH)
        ? `\nYou can search for available Actors using the tool: ${HELPER_TOOLS.STORE_SEARCH}.`
        : '';
    return respondUserError(
        dedent`
            Actor '${actorName}' was not found.
            Please verify Actor ID or name format ("username/name") and ensure that the Actor exists.
        ` + recovery,
        { httpStatus: 404, detail: `Actor '${actorName}' was not found` },
    );
}

export function buildCallActorErrorResponse(params: CallActorErrorResponseParams): ToolResponse {
    const { actorName, error, actorId, mcpSessionId, loadedToolNames, inputSchema } = params;

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

    // These two kinds (a server Actor without MCP, and a standby Actor under a payment provider) are sanitized,
    // user-facing reasons: forward them verbatim instead of wrapping them in the generic server-error text.
    // LOAD_FAILED masks a backend fault and stays below.
    if (
        error instanceof ActorLoadError &&
        (error.kind === ACTOR_LOAD_ERROR_KIND.SERVER_ACTOR_WITHOUT_MCP_NOT_SUPPORTED ||
            error.kind === ACTOR_LOAD_ERROR_KIND.STANDBY_PAYMENT_NOT_SUPPORTED)
    ) {
        return respondStandbyRejection(error, { mcpSessionId, actorId });
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
                `Account memory quota exceeded for your plan. A smaller callOptions.memory may fit the remaining quota; memory is freed when current runs finish.`,
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

    // Checked before the generic fallback below: the Actor was found fine, only its input wasn't.
    if (isActorInputValidationError(error)) {
        return respondUserError(buildInvalidInputTexts(actorName, errMsg, inputSchema), {
            actorId,
            detail: errMsg.slice(0, 200),
        });
    }

    return respondServerError(
        [
            `Failed to call Actor '${actorName}': ${errMsg}`,
            `Please verify the Actor name, input parameters, and ensure the Actor exists.`,
            buildCallFailureRecoveryHint(loadedToolNames),
        ].filter(Boolean),
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
            Apify also caps total memory across all your concurrent runs (account plan limit); a run that would exceed that quota is rejected.
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
    actor: z.string().describe('The Actor to call: its ID, or its name in the "username/name" form.'),
    input: anyJsonObjectSchema.describe('The input JSON to pass to the Actor. Required.'),
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
    tool: ToolEntry;
    args: Record<string, unknown>;
    paymentProvider: PaymentProvider | undefined;
    apifyToken: ApifyToken;
    mcpSessionId?: string;
}): Promise<Record<string, unknown> | null> {
    const { tool, args, paymentProvider, apifyToken, mcpSessionId } = params;
    if (!paymentProvider || !tool.hasPaymentProviderStandbyCheck) return null;
    const actorName = args.actor;
    if (typeof actorName !== 'string' || !actorName) return null;

    const normalizedActorName = fixActorNameInputAndLog(actorName, { mcpSessionId });

    // Token-based client — payment headers are only relevant for actual Actor runs.
    const apifyClientForDefinition = new ApifyClient({ token: apifyToken });
    const actorDefinitionWithInfo = await getActorDefinitionCached(normalizedActorName, apifyClientForDefinition);
    if (!actorDefinitionWithInfo) {
        return null;
    }

    if (!isActorBlockedUnderPaymentProvider(actorDefinitionWithInfo.info)) {
        return null;
    }

    // Canonical name, not the caller's identifier, which may be an Actor ID.
    const error = ActorLoadError.standbyPaymentNotSupported(actorDefinitionWithInfo.definition.actorFullName);
    return respondStandbyRejection(error, { mcpSessionId, paymentProviderId: paymentProvider.id });
}

/** Rejection for an Actor that is an MCP server: its input interface is unused, so a run of it is a mistake. */
function respondMcpServerActor(actorFullName: string, route: string, loadedToolNames: readonly string[]): ToolResponse {
    const replacement = loadedToolNames.includes(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL)
        ? ` Its MCP tools can be called with ${HELPER_TOOLS.ACTOR_MCP_TOOL_CALL}.`
        : ` Its MCP tools cannot be called in this configuration. To use them, ${getOwnServerRemedy()}`;
    return respondUserError(`Actor '${actorFullName}' is an MCP server, which ${route} does not run.${replacement}`, {
        detail: 'MCP server Actor',
    });
}

/** Rejects removed MCP call syntax before Actor or payment metadata is fetched. */
export function buildLegacyMcpSyntaxRejection(
    toolName: string,
    actor: unknown,
    loadedToolNames: readonly string[],
): ToolResponse | null {
    if (toolName !== HELPER_TOOLS.ACTOR_CALL && toolName !== HELPER_TOOLS.ACTOR_CALL_WIDGET) return null;
    if (typeof actor !== 'string' || !MCP_TOOL_NAME_SUFFIX.test(actor)) return null;
    const replacement = loadedToolNames.includes(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL)
        ? ` Use ${HELPER_TOOLS.ACTOR_MCP_TOOL_CALL} with separate actor and tool arguments.`
        : ` MCP tools cannot be called in this configuration. To use them, ${getOwnServerRemedy()}`;
    return respondUserError(`The "actor:tool" syntax is no longer supported by ${toolName}.${replacement}`, {
        detail: 'legacy MCP call syntax',
    });
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
    const { apifyClient, loadedToolNames } = toolArgs;

    const { tools, errors } = await getActorsAsTools([actorName], apifyClient, {
        mcpSessionId: toolArgs.mcpSessionId,
        isDirectTool: false,
    });

    // NOT_FOUND falls through to the structured "Actor not found" response below.
    // Any other error (LOAD_FAILED / STANDBY_PAYMENT_NOT_SUPPORTED /
    // SERVER_ACTOR_WITHOUT_MCP_NOT_SUPPORTED) is rethrown so the outer call-actor handler reports it.
    // STANDBY_PAYMENT_NOT_SUPPORTED cannot actually appear here: the call above passes no
    // `paymentProvider`, so `getActorsAsTools`' payment gate never fires. Kept in the list because
    // the rethrow is keyed on "not NOT_FOUND", not on an enumeration of kinds.
    if (errors[0] && errors[0].kind !== ACTOR_LOAD_ERROR_KIND.NOT_FOUND) {
        throw errors[0];
    }
    const actor = tools[0];

    if (!actor) {
        return { error: respondActorNotFound(actorName, loadedToolNames) };
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
 * Performs the pre-execution checks common to both modes: parses args and rejects an Actor that `call-actor`
 * cannot run (a standby Actor with neither an MCP server nor an input schema, or an MCP server).
 *
 * Applies the same `actor` string normalization as `getActorsAsTools` **before** routing so clients cannot pass a
 * clean-enough id for definition fetch but a dirty id to `apifyClient.actor()` (see Mezmo: e.g. trailing `` ` ``
 * on `apify/rag-web-browser`).
 */
export async function callActorPreExecute(
    toolArgs: InternalToolArgs,
    options: { route: string },
): Promise<{ earlyResponse: ToolResponse } | { parsed: CallActorParsedArgs }> {
    const { args, apifyToken, mcpSessionId, loadedToolNames } = toolArgs;
    const parsedArgs = callActorArgs.parse(args);
    const legacyRejection = buildLegacyMcpSyntaxRejection(options.route, parsedArgs.actor, loadedToolNames);
    if (legacyRejection) return { earlyResponse: legacyRejection };
    const actorName = fixActorNameInputAndLog(parsedArgs.actor, { mcpSessionId, route: options.route });

    // For definition resolution we always use a token-based client; payment provider is only for actual Actor runs.
    // Standby/MCP-server Actors under a third-party payment provider are rejected upstream by
    // `checkPaymentProviderStandbyConflict` — see src/mcp/tool_call_engine.ts.
    const apifyClientForDefinition = new ApifyClient({ token: apifyToken });
    const resolution = await getActorToolResolutionCached(actorName, apifyClientForDefinition);

    if (resolution?.toolMode === ACTOR_TOOL_MODE.SERVER_ACTOR_WITHOUT_MCP) {
        const error = ActorLoadError.serverActorWithoutMcpNotSupported(resolution.actorFullName);
        if (resolution.interfaces.server && loadedToolNames.includes(HELPER_TOOLS.ACTOR_SERVER_REQUEST)) {
            error.message += ` Its HTTP API is available through ${HELPER_TOOLS.ACTOR_SERVER_REQUEST}.`;
        }
        return {
            earlyResponse: respondStandbyRejection(error, { mcpSessionId }),
        };
    }
    if (resolution?.toolMode === ACTOR_TOOL_MODE.MCP) {
        return { earlyResponse: respondMcpServerActor(resolution.actorFullName, options.route, loadedToolNames) };
    }
    return { parsed: { ...parsedArgs, actor: actorName } };
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

    const { parsed } = preResult;
    const { actor: actorName, input, callOptions } = parsed;
    // Task mode waits until terminal (waitSecs=undefined uses SDK default ~999999s); caller's waitSecs is ignored.
    // Non-task mode: pass waitSecs so the SDK blocks up to that many seconds before returning.
    const waitSecs = toolArgs.taskMode ? undefined : parsed.waitSecs;

    let resolvedActorId: string | undefined;
    let resolvedInputSchema: ToolInputSchema | undefined;
    try {
        const resolution = await resolveAndValidateActor({
            actorName,
            input: input as Record<string, unknown>,
            toolArgs,
        });
        if ('error' in resolution) {
            return resolution.error;
        }

        resolvedActorId = extractActorId(resolution.actor);
        resolvedInputSchema = resolution.actor.inputSchema;
        const { apifyClient } = toolArgs;
        const abortSignal = toolArgs.signal;

        if (abortSignal?.aborted) return respondAborted();

        const actorRun = await apifyClient.actor(actorName).start(input, callOptions);
        log.debug('Started Actor run', {
            actorName,
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
            const response = buildStartRunResponse({ actorName, actorRun, linkContext });
            return { ...response, toolTelemetry: { actorId: resolvedActorId } };
        }

        const fetchResult = await fetchActorRunData({
            runId: actorRun.id,
            waitSecs,
            actorName,
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
            actorName,
            error,
            actorId: resolvedActorId,
            mcpSessionId: toolArgs.mcpSessionId,
            loadedToolNames: toolArgs.loadedToolNames,
            inputSchema: resolvedInputSchema,
        });
    }
}

/** Mode-agnostic — the widget addendum renders only when call-actor-widget is actually in this session (`hasTool`), not from a mode check. */
export const callActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_CALL,
    title: 'Call Actor',
    description: buildCallActorDescription(ALL_TOOLS_PRESENT),
    buildDescription: buildCallActorDescription,
    inputSchema: callActorInputSchema,
    outputSchema: actorRunOutputSchema,
    ajvValidate: callActorAjvValidate,
    paymentRequired: true,
    hasPaymentProviderStandbyCheck: true,
    annotations: {
        title: 'Call Actor',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    execution: {
        taskSupport: 'optional',
    },
    call: async (toolArgs: InternalToolArgs) => executeCallActor(toolArgs),
} as const);
