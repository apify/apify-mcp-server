import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import log from '@apify/log';

import type { ApifyClient } from '../../apify_client.js';
import {
    ACTOR_MAX_MEMORY_MBYTES,
    HELPER_TOOLS,
    RAG_WEB_BROWSER,
    RAG_WEB_BROWSER_ADDITIONAL_DESC,
} from '../../const.js';
import { ActorLoadError } from '../../errors.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../../mcp/actors.js';
import { connectMCPClient } from '../../mcp/client.js';
import { getMCPServerTools } from '../../mcp/proxy.js';
import type { PaymentProvider } from '../../payments/types.js';
import {
    type ActorDefinitionWithInfo,
    type ActorInfo,
    type ActorStore,
    type ActorTool,
    type ApifyToken,
    type ToolEntry,
    type ToolInputSchema,
    TOOL_TYPE,
} from '../../types.js';
import { getActorDefinitionCached } from '../../utils/actor.js';
import { ajv } from '../../utils/ajv.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { logHttpError } from '../../utils/logging.js';
import { buildActorInputSchema, fixedAjvCompile } from '../actor_input_schema.js';
import { actorNameToToolName, isActorBlockedUnderPaymentProvider, isActorInfoMcpServer } from '../actor_tool_naming.js';
import { buildEnrichedDirectActorOutputSchema, actorRunOutputSchema } from '../structured_output_schemas.js';
import { CALL_ACTOR_WAIT_SECS_DEFAULT, WAIT_SECS_MAX } from './actor_run_response.js';

/**
 * MCP-only opt-in injected next to the Actor's own input fields. Same contract as `call-actor`'s
 * `waitSecs`: default 30, max 45. If the Actor's own input schema happens to declare `waitSecs`,
 * this property overrides it — the field is reserved for the MCP server's wait control.
 */
const WAIT_SECS_INPUT_PROPERTY = {
    type: 'integer',
    minimum: 0,
    maximum: WAIT_SECS_MAX,
    default: CALL_ACTOR_WAIT_SECS_DEFAULT,
    description:
        `Max seconds (0–45, default ${CALL_ACTOR_WAIT_SECS_DEFAULT}) to cap the wait for the Actor run to reach terminal state. ` +
        'For long-running Actors the response returns at the cap with the current run status; ' +
        `follow \`nextStep\` to poll via ${HELPER_TOOLS.ACTOR_RUNS_GET}. Set to 0 to fire-and-forget.`,
} as const;

/**
 * For each direct actor tool with a known historical item schema, replaces the generic
 * `actorRunOutputSchema` with a per-tool variant that declares
 * `storages.datasets.default.itemsSchema` — letting an LLM plan field projection from
 * `tools/list` alone, before any call.
 *
 * Uses `Promise.allSettled` so a single store failure doesn't block other tools. Individual
 * misses (null / empty properties / thrown errors) leave the tool on the generic schema.
 */
export async function enrichActorToolOutputSchemas(tools: ToolEntry[], actorStore: ActorStore): Promise<void> {
    const enrichPromises = tools
        .filter((tool): tool is ActorTool => tool.type === TOOL_TYPE.ACTOR)
        .map(async (tool) => {
            try {
                const itemProperties = await actorStore.getActorOutputSchema(tool.actorFullName);
                if (itemProperties && Object.keys(itemProperties).length > 0) {
                    // eslint-disable-next-line no-param-reassign
                    tool.outputSchema = buildEnrichedDirectActorOutputSchema(itemProperties);
                    // Stash the raw properties so the executor can mirror them into
                    // `structuredContent.storages.datasets.default.itemsSchema` at runtime.
                    // eslint-disable-next-line no-param-reassign
                    tool.datasetItemsSchema = itemProperties;
                }
            } catch (error) {
                log.debug('Failed to enrich output schema for Actor', {
                    actorName: tool.actorFullName,
                    errMessage: error instanceof Error ? error.message : String(error),
                });
            }
        });

    await Promise.allSettled(enrichPromises);
}

/**
 * This function is used to fetch normal non-MCP server Actors as a tool.
 *
 * Fetches Actor input schemas by Actor IDs or Actor full names and creates MCP tools.
 *
 * This function retrieves the input schemas for the specified Actors and compiles them into MCP tools.
 * It uses the AJV library to validate the input schemas.
 *
 * Tool name can't contain /, so it is replaced with _
 *
 * The input schema processing workflow:
 * 1. Properties are marked as required using markInputPropertiesAsRequired() to add "REQUIRED" prefix to descriptions
 * 2. Nested properties are built by analyzing editor type (proxy, requestListSources) using buildNestedProperties()
 * 3. Properties are filtered using filterSchemaProperties()
 * 4. Properties are shortened using shortenProperties()
 * 5. Enums are added to descriptions with examples using addEnumsToDescriptionsWithExamples()
 *
 * @param {ActorInfo[]} actorsInfo - An array of ActorInfo objects with webServerMcpPath, definition, and Actor.
 * @param options - Optional settings: mcpSessionId for telemetry correlation, actorStore for per-Actor itemsSchema enrichment.
 * @returns {Promise<ToolEntry[]>} - A promise that resolves to an array of MCP tools.
 */
export async function getNormalActorsAsTools(
    actorsInfo: ActorInfo[],
    options?: { mcpSessionId?: string; actorStore?: ActorStore },
): Promise<ToolEntry[]> {
    const { mcpSessionId, actorStore } = options ?? {};
    const tools: ToolEntry[] = [];

    for (const actorInfo of actorsInfo) {
        const { definition } = actorInfo;

        if (!definition) continue;

        const isRag = definition.actorFullName === RAG_WEB_BROWSER;
        const { inputSchema } = buildActorInputSchema(definition.actorFullName, definition.input, isRag);

        // Inject the MCP-only `waitSecs` opt-in before AJV compile so the LLM can cap the wait.
        const inputSchemaWithWaitSecs = inputSchema as { properties?: Record<string, unknown> };
        inputSchemaWithWaitSecs.properties = {
            ...(inputSchemaWithWaitSecs.properties ?? {}),
            waitSecs: WAIT_SECS_INPUT_PROPERTY,
        };

        let description = `This tool calls the Actor "${definition.actorFullName}" and retrieves its output results.
Use this tool instead of the "${HELPER_TOOLS.ACTOR_CALL}" if user requests this specific Actor.
Actor description: ${definition.description}`;
        if (isRag) {
            description += RAG_WEB_BROWSER_ADDITIONAL_DESC;
        }

        const memoryMbytes = Math.min(
            definition.defaultRunOptions?.memoryMbytes || ACTOR_MAX_MEMORY_MBYTES,
            ACTOR_MAX_MEMORY_MBYTES,
        );

        let ajvValidate;
        try {
            // Unknown properties are silently stripped by AJV's removeAdditional option.
            // Dynamic Actor input fields are part of the Actor's own inputSchema, so they
            // are declared properties and won't be stripped.
            ajvValidate = fixedAjvCompile(ajv, inputSchema);
        } catch (e) {
            // SchemaTooLargeError logs as a soft fail; a genuine AJV compile error stays an error.
            logHttpError(e, 'Failed to compile schema', {
                actorName: definition.actorFullName,
                mcpSessionId,
            });
            continue;
        }

        tools.push({
            type: TOOL_TYPE.ACTOR,
            name: actorNameToToolName(definition.actorFullName),
            title: definition.actorFullName,
            actorId: definition.id,
            actorFullName: definition.actorFullName,
            description,
            inputSchema: inputSchema as ToolInputSchema,
            // Canonical RunResponse shape — same as call-actor and get-actor-run.
            outputSchema: actorRunOutputSchema,
            ajvValidate,
            paymentRequired: true,
            memoryMbytes,
            icons: definition.pictureUrl ? [{ src: definition.pictureUrl, mimeType: 'image/png' }] : undefined,
            annotations: {
                title: definition.actorFullName,
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
            },
            // Allow long-running tasks for Actor tools, make it optional for now
            execution: {
                taskSupport: 'optional',
            },
        });
    }

    if (actorStore) {
        await enrichActorToolOutputSchemas(tools, actorStore);
    }

    return tools;
}

export async function getMCPServersAsTools(
    actorsInfo: ActorInfo[],
    apifyToken: ApifyToken,
    mcpSessionId?: string,
): Promise<ToolEntry[]> {
    /**
     * This is case for the payment provider request without any Apify token, we do not support
     * standby Actors in this case, so we can skip MCP servers since they would fail anyway (they are standby Actors).
     */
    if (apifyToken === null || apifyToken === undefined) {
        return [];
    }

    // Process all actors in parallel
    const actorToolPromises = actorsInfo.map(async (actorInfo) => {
        const actorId = actorInfo.definition.id;
        if (!actorInfo.webServerMcpPath) {
            log.warning('Actor does not have a web server MCP path, skipping', {
                actorFullName: actorInfo.definition.actorFullName,
                actorId,
                mcpSessionId,
            });
            return [];
        }

        let client: Client | null = null;
        try {
            // getActorMCPServerURL rejects a webServerMcpPath that escapes the Actor's standby origin.
            // Resolve it inside the try so one Actor's bad path skips only that Actor, not the whole batch.
            const mcpServerUrl = await getActorMCPServerURL(
                actorInfo.definition.id, // Real ID of the Actor
                actorInfo.webServerMcpPath,
            );
            log.debug('Retrieved MCP server URL for Actor', {
                actorFullName: actorInfo.definition.actorFullName,
                actorId,
                mcpServerUrl,
                mcpSessionId,
            });

            client = await connectMCPClient(mcpServerUrl, apifyToken, mcpSessionId);
            if (!client) {
                // Skip this Actor, connectMCPClient will log the error
                return [];
            }
            return await getMCPServerTools(actorId, client, mcpServerUrl);
        } catch (error) {
            logHttpError(error, 'Failed to load tools from MCP server', {
                actorFullName: actorInfo.definition.actorFullName,
                actorId,
                mcpSessionId,
            });
            return [];
        } finally {
            if (client) await client.close();
        }
    });

    // Wait for all actors to be processed in parallel
    const actorToolsArrays = await Promise.all(actorToolPromises);
    return actorToolsArrays.flat();
}

/**
 * Fixes an Actor name input from LLM and logs at INFO when the input differed from the fixed version.
 * Single entry point for fix+log — avoids duplicating the pattern at every call site.
 */
export function fixActorNameInputAndLog(actorName: string, extra?: Record<string, unknown>): string {
    const fixed = fixActorNameInput(actorName);
    if (fixed !== actorName) {
        log.info('Actor name input required normalization before lookup (quotes, spacing, or slash padding)', {
            actorNameInput: actorName,
            actorNameFixed: fixed,
            ...extra,
        });
    }
    return fixed;
}

/**
 * Fixes Actor name strings (`username/name`) before cache + Apify API lookup.
 *
 * LLMs often wrap values in markdown quotes or smart quotes and insert spaces around `/`.
 * The Apify API treats those as distinct strings → avoidable 404 SOFT_FAIL. This only trims
 * and strips common wrappers / spacing noise; valid names pass through unchanged.
 */
export function fixActorNameInput(actorName: string): string {
    const s = stripQuoteWrappers(actorName).replace(/\s*\/\s*/g, '/');
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Result type for {@link getActorsAsTools}: every requested name produces
 * either a successful load (contributing to `tools` — a single Actor can fan
 * out into multiple tools for MCP-server Actors) or an `ActorLoadError`
 * describing why the load failed.
 *
 * Bulk callers (`getActors`, server load-helpers) typically only read
 * `tools`. Single-Actor callers (`add-actor`, `call-actor`) read `errors[0]`
 * to surface the precise reason back to the agent.
 */
export type ActorsAsToolsResult = {
    tools: ToolEntry[];
    errors: ActorLoadError[];
};

/**
 * Loads Actor metadata + builds MCP tool entries for the requested Actor
 * names. Returns both successful tools and `ActorLoadError` entries so
 * callers can surface precise reasons when needed (single-Actor flows like
 * `add-actor` / `call-actor`) or just ignore failures (bulk session-boot
 * flows that build the initial tool surface).
 *
 * When `paymentProvider` is set, standby and MCP-server Actors are reported
 * as `STANDBY_PAYMENT_NOT_SUPPORTED` errors instead of contributing tools.
 * External payment providers (x402, Skyfire) cannot pay for standby Actor
 * runs — the call-time guard in `call_actor.ts` rejects any such
 * tool call. Filtering at list time keeps the advertised tool surface
 * honest so agents never discover a tool that can only fail later.
 */
export async function getActorsAsTools(
    actorIdsOrNames: string[],
    apifyClient: ApifyClient,
    options?: {
        mcpSessionId?: string;
        actorStore?: ActorStore;
        paymentProvider?: PaymentProvider;
    },
): Promise<ActorsAsToolsResult> {
    const { mcpSessionId, actorStore, paymentProvider } = options ?? {};
    log.debug('Fetching Actors as tools', {
        actorNames: actorIdsOrNames,
        mcpSessionId,
        paymentProviderId: paymentProvider?.id,
    });

    const errors: ActorLoadError[] = [];

    const actorsInfo: (ActorInfo | null)[] = await Promise.all(
        actorIdsOrNames.map(async (actorIdOrName) => {
            const actorName = fixActorNameInputAndLog(actorIdOrName, { mcpSessionId });

            let actorDefinitionWithInfo: ActorDefinitionWithInfo | null;
            try {
                actorDefinitionWithInfo = await getActorDefinitionCached(actorName, apifyClient);
            } catch (error) {
                logHttpError(error, 'Failed to fetch Actor definition', {
                    actorName,
                    ...(actorName !== actorIdOrName && { actorNameInput: actorIdOrName }),
                    mcpSessionId,
                });
                errors.push(ActorLoadError.loadFailed(actorIdOrName));
                return null;
            }

            if (!actorDefinitionWithInfo) {
                log.softFail('Actor not found or definition is not available', {
                    actorName,
                    ...(actorName !== actorIdOrName && { actorNameInput: actorIdOrName }),
                    mcpSessionId,
                    statusCode: 404,
                    failureCategory: 'INVALID_INPUT',
                });
                errors.push(ActorLoadError.notFound(actorIdOrName));
                return null;
            }

            return {
                definition: actorDefinitionWithInfo.definition,
                actor: actorDefinitionWithInfo.info,
                webServerMcpPath: getActorMCPServerPath(actorDefinitionWithInfo.definition),
            } as ActorInfo;
        }),
    );

    const clonedActors = structuredClone(actorsInfo);
    const nonNullActors = clonedActors.filter((actorInfo): actorInfo is ActorInfo => Boolean(actorInfo));

    // Split MCP-server vs normal Actors. Under `paymentProvider`, standby/MCP-server
    // Actors are reported as STANDBY_PAYMENT_NOT_SUPPORTED errors instead of contributing
    // tools — the platform API hard-rejects standby runs under third-party providers.
    const actorMCPServersInfo: ActorInfo[] = [];
    const normalActorsInfo: ActorInfo[] = [];
    for (const actorInfo of nonNullActors) {
        const isMcpServer = isActorInfoMcpServer(actorInfo);
        if (paymentProvider && isActorBlockedUnderPaymentProvider(actorInfo)) {
            errors.push(ActorLoadError.standbyPaymentNotSupported(actorInfo.definition.actorFullName));
            continue;
        }
        if (isMcpServer) actorMCPServersInfo.push(actorInfo);
        else normalActorsInfo.push(actorInfo);
    }

    const [normalTools, mcpServerTools] = await Promise.all([
        getNormalActorsAsTools(normalActorsInfo, { mcpSessionId, actorStore }),
        getMCPServersAsTools(actorMCPServersInfo, apifyClient.token, mcpSessionId),
    ]);

    return { tools: [...normalTools, ...mcpServerTools], errors };
}
