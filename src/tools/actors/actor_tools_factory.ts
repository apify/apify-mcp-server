import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import log from '@apify/log';

import type { ApifyClient } from '../../apify_client.js';
import {
    ACTOR_MAX_MEMORY_MBYTES,
    FAILURE_CATEGORY,
    HELPER_TOOLS,
    OFFICIAL_ACTORS_WITH_SIDE_EFFECTS,
    OFFICIAL_APIFY_USERNAMES,
} from '../../const.js';
import { ActorLoadError } from '../../errors.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../../mcp/actors.js';
import { connectMCPClient } from '../../mcp/client.js';
import { getMCPServerTools } from '../../mcp/proxy.js';
import {
    type ActorDefinitionWithInfo,
    type ActorInfo,
    type ToolDescriptionContext,
    type ToolEntry,
    type ToolInputSchema,
    ACTOR_TOOL_MODE,
    ALL_TOOLS_PRESENT,
    TOOL_TYPE,
} from '../../types.js';
import { getActorDefinitionCached } from '../../utils/actor.js';
import { fixActorNameInput } from '../../utils/actor_name_normalization.js';
import { isValidResourceId } from '../../utils/apify_resource_id.js';
import { logHttpError } from '../../utils/logging.js';
import { buildActorInputSchema, compileUntrustedSchema } from '../actor_input_schema.js';
import {
    actorNameToToolName,
    getActorToolModeFromInterfaces,
    resolveActorInterfaces,
    resolveActorTenancy,
    resolveActorToolMode,
} from '../actor_tool_naming.js';
import {
    buildEnrichedDirectActorOutputSchema,
    actorRunOutputSchema,
    serverActorRequestOutputSchema,
} from '../structured_output_schemas.js';
import { CALL_ACTOR_WAIT_SECS_DEFAULT, WAIT_SECS_MAX } from './actor_run_response.js';
import { buildDirectActorContract, getActorToolPolicy } from './actor_tool_contract.js';
import {
    buildServerActorToolSchemas,
    executeSendServerActorRequest,
    redactServerActorRequestArgs,
    SERVER_REQUEST_TRANSPORT_NOTE,
} from './send_server_actor_request.js';
import { buildServerActorToolDescription, formatTenancyBilling } from './server_interface_details.js';

// MCP reserves `waitSecs` for run wait control, even if the Actor declares the same field.
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
 * Clients such as Claude can skip confirmation for read-only tools (apify/apify-mcp-server#973).
 * Reserve the hint for Apify-maintained Actors whose writes are confined to their run storages.
 */
function isReadOnlyActor({ actor, definition }: ActorInfo): boolean {
    if (!OFFICIAL_APIFY_USERNAMES.has(actor.username)) return false;
    if (OFFICIAL_ACTORS_WITH_SIDE_EFFECTS.has(definition.actorFullName)) return false;
    if (actor.actorPermissionLevel !== 'LIMITED_PERMISSIONS') return false;

    const inputProperties = Object.values(definition.input?.properties ?? {});
    return !inputProperties.some(
        (property) =>
            property.isSecret ||
            (['dataset', 'keyValueStore', 'requestQueue'].includes(property.resourceType ?? '') &&
                property.resourcePermissions?.includes('WRITE')) ||
            property.resourceType === 'mcpConnector' ||
            property.editor === 'javascript' ||
            property.editor === 'python',
    );
}

export async function getNormalActorsAsTools(
    actorsInfo: ActorInfo[],
    options?: { mcpSessionId?: string; isDirectTool?: boolean },
): Promise<ToolEntry[]> {
    const { mcpSessionId, isDirectTool = true } = options ?? {};
    const tools: ToolEntry[] = [];

    for (const actorInfo of actorsInfo) {
        const { definition } = actorInfo;

        if (!definition) continue;

        const { actorFullName, description: actorDescription } = definition;
        const contract = isDirectTool
            ? buildDirectActorContract(actorFullName, definition.input)
            : { input: definition.input, description: '' };
        const isReadOnly = isReadOnlyActor({ ...actorInfo, definition: { ...definition, input: contract.input } });
        const { inputSchema } = buildActorInputSchema(definition.actorFullName, contract.input);

        const inputSchemaWithWaitSecs = inputSchema as { properties?: Record<string, unknown> };
        inputSchemaWithWaitSecs.properties = {
            ...(inputSchemaWithWaitSecs.properties ?? {}),
            waitSecs: WAIT_SECS_INPUT_PROPERTY,
        };

        // Capturing `contract` would retain a per-call input schema for the life of the session.
        const contractDescription = contract.description;
        const buildDescription = ({ hasTool }: ToolDescriptionContext): string => {
            let description = `This tool calls the Actor "${actorFullName}" and retrieves its output results.
${hasTool(HELPER_TOOLS.ACTOR_CALL) ? `Use this tool instead of the "${HELPER_TOOLS.ACTOR_CALL}" if user requests this specific Actor.\n` : ''}Actor description: ${actorDescription}`;
            if (contractDescription) description += `\n\n${contractDescription}`;
            return description;
        };

        const memoryMbytes = Math.min(
            definition.defaultRunOptions?.memoryMbytes || ACTOR_MAX_MEMORY_MBYTES,
            ACTOR_MAX_MEMORY_MBYTES,
        );

        let compiled;
        try {
            compiled = compileUntrustedSchema(inputSchema as ToolInputSchema, {
                actorName: definition.actorFullName,
                mcpSessionId,
            });
        } catch (e) {
            // `logHttpError` logs `SchemaTooLargeError` as a soft fail.
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
            description: buildDescription(ALL_TOOLS_PRESENT),
            buildDescription,
            // Sessions share the cached schema object.
            inputSchema: compiled.schema,
            outputSchema:
                isDirectTool && definition.datasetItemProperties
                    ? buildEnrichedDirectActorOutputSchema(definition.datasetItemProperties)
                    : actorRunOutputSchema,
            ajvValidate: compiled.validate,
            memoryMbytes,
            icons: definition.pictureUrl ? [{ src: definition.pictureUrl, mimeType: 'image/png' }] : undefined,
            annotations: {
                title: definition.actorFullName,
                readOnlyHint: isReadOnly,
                destructiveHint: !isReadOnly,
                openWorldHint: true,
            },
            execution: {
                taskSupport: 'optional',
            },
        });
    }

    return tools;
}

/** Builds a `send-server-actor-request` tool bound to each Actor. */
export function getServerActorsAsTools(actorsInfo: ActorInfo[]): ToolEntry[] {
    const tools: ToolEntry[] = [];
    for (const actorInfo of actorsInfo) {
        const { definition, actor } = actorInfo;
        const toolInfo = definition.webServerToolInfo;
        // `getActorsAsTools` reports missing tool info as a load failure.
        if (!toolInfo) continue;
        const { actorFullName, description } = definition;
        const isReadOnly = isReadOnlyActor(actorInfo);
        const costNotice = formatTenancyBilling({
            tenancy: resolveActorTenancy(actor),
            idleTimeoutSecs: actor.actorStandby?.idleTimeoutSecs,
        });
        const policy = getActorToolPolicy(actorFullName)?.serverTool;
        const schemas = buildServerActorToolSchemas(toolInfo);
        for (const [name, text] of Object.entries(policy?.inputDescriptions ?? {})) {
            const property = schemas.inputSchema.properties?.[name] as { description?: string } | undefined;
            if (property) property.description = text;
        }
        const buildDescription = (context: ToolDescriptionContext): string => {
            const { hasTool } = context;
            const about =
                policy?.buildDescription?.(context) ??
                `This tool sends one HTTP request to the server interface of the Actor "${actorFullName}" and returns the response.\nActor description: ${description}`;
            const preferThisTool = hasTool(HELPER_TOOLS.ACTOR_SERVER_REQUEST)
                ? `Use this tool instead of the "${HELPER_TOOLS.ACTOR_SERVER_REQUEST}" if user requests this specific Actor.`
                : undefined;
            const head = [about, '', costNotice, SERVER_REQUEST_TRANSPORT_NOTE, preferThisTool, '', 'Operations:', '']
                .filter((line) => line !== undefined)
                .join('\n');
            return buildServerActorToolDescription(head, toolInfo, hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS));
        };
        tools.push({
            type: TOOL_TYPE.ACTOR_SERVER,
            name: actorNameToToolName(actorFullName),
            title: actorFullName,
            actorId: definition.id,
            actorFullName,
            description: buildDescription(ALL_TOOLS_PRESENT),
            buildDescription,
            ...schemas,
            outputSchema: serverActorRequestOutputSchema,
            icons: definition.pictureUrl ? [{ src: definition.pictureUrl, mimeType: 'image/png' }] : undefined,
            annotations: {
                title: actorFullName,
                readOnlyHint: isReadOnly,
                destructiveHint: !isReadOnly,
                openWorldHint: true,
            },
            redactArgs: redactServerActorRequestArgs,
            call: async (toolArgs) =>
                executeSendServerActorRequest({ ...toolArgs, args: { ...toolArgs.args, actor: actorFullName } }),
        });
    }
    return tools;
}

export async function getMCPServersAsTools(
    actorsInfo: ActorInfo[],
    apifyClient: Pick<ApifyClient, 'token' | 'requestOrigin'>,
    mcpSessionId?: string,
): Promise<ToolEntry[]> {
    const { token, requestOrigin } = apifyClient;
    // Connecting to an Actor's Standby MCP server requires an Apify token.
    if (token === null || token === undefined) {
        return [];
    }

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
            // Resolve inside the try so an invalid MCP path cannot fail the whole batch.
            const mcpServerUrl = await getActorMCPServerURL(actorInfo.actor, actorInfo.webServerMcpPath);
            log.debug('Retrieved MCP server URL for Actor', {
                actorFullName: actorInfo.definition.actorFullName,
                actorId,
                mcpServerUrl,
                mcpSessionId,
            });

            client = await connectMCPClient(mcpServerUrl, { token, requestOrigin }, mcpSessionId);
            if (!client) {
                // `connectMCPClient` logs the failure.
                return [];
            }
            return await getMCPServerTools(actorId, client, mcpServerUrl, actorInfo.definition.actorFullName);
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

    const actorToolsArrays = await Promise.all(actorToolPromises);
    return actorToolsArrays.flat();
}

export const EMPTY_ACTOR_NAME_MESSAGE =
    '"actor" must not be empty. Give the Actor ID or its name in the "username/name" form.';

export type ActorsAsToolsResult = {
    tools: ToolEntry[];
    errors: ActorLoadError[];
};

/** Returns tools from successful loads and errors that `call-actor` can surface for a single Actor. */
export async function getActorsAsTools(
    actorIdsOrNames: string[],
    apifyClient: ApifyClient,
    options?: {
        mcpSessionId?: string;
        isDirectTool?: boolean;
    },
): Promise<ActorsAsToolsResult> {
    const { mcpSessionId, isDirectTool = true } = options ?? {};
    log.debug('Fetching Actors as tools', {
        actorCount: actorIdsOrNames.length,
        mcpSessionId,
    });

    const errors: ActorLoadError[] = [];

    const actorsInfo: (ActorInfo | null)[] = await Promise.all(
        actorIdsOrNames.map(async (actorIdOrName) => {
            const actorName = fixActorNameInput(actorIdOrName);
            // Invalid names can contain pasted credentials. Keep them out of lookups and logs.
            if (!isValidResourceId(actorName)) {
                log.softFail('Actor name is not valid', {
                    mcpSessionId,
                    statusCode: 400,
                    failureCategory: 'INVALID_INPUT',
                });
                errors.push(ActorLoadError.notFound(actorIdOrName));
                return null;
            }

            let actorDefinitionWithInfo: ActorDefinitionWithInfo | null;
            try {
                actorDefinitionWithInfo = await getActorDefinitionCached(actorName, apifyClient);
            } catch (error) {
                logHttpError(error, 'Failed to fetch Actor definition', {
                    actorName,
                    mcpSessionId,
                });
                errors.push(ActorLoadError.loadFailed(actorIdOrName));
                return null;
            }

            if (!actorDefinitionWithInfo) {
                log.softFail('Actor not found or definition is not available', {
                    actorName,
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

    const serverActorsInfo: ActorInfo[] = [];
    const actorMCPServersInfo: ActorInfo[] = [];
    const normalActorsInfo: ActorInfo[] = [];
    for (const actorInfo of nonNullActors) {
        // `call-actor` starts runs, so only an Actor's own tool takes the server interface.
        const toolMode = isDirectTool
            ? resolveActorToolMode(actorInfo)
            : getActorToolModeFromInterfaces(resolveActorInterfaces(actorInfo));
        if (toolMode === ACTOR_TOOL_MODE.SERVER_ACTOR_WITHOUT_MCP) {
            const error = ActorLoadError.serverActorWithoutMcpNotSupported(actorInfo.definition.actorFullName);
            log.softFail('Skipping server Actor with no MCP server and an empty input schema', {
                actorName: actorInfo.definition.actorFullName,
                mcpSessionId,
                actorLoadErrorKind: error.kind,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
            });
            errors.push(error);
            continue;
        }
        if (toolMode === ACTOR_TOOL_MODE.SERVER && !actorInfo.definition.webServerToolInfo) {
            // A definition built before `webServerToolInfo` existed has a server interface and no tool to serve.
            const error = ActorLoadError.loadFailed(actorInfo.definition.actorFullName);
            log.warning('Skipping Server Actor whose definition has no tool info', {
                actorName: actorInfo.definition.actorFullName,
                mcpSessionId,
                actorLoadErrorKind: error.kind,
            });
            errors.push(error);
            continue;
        }
        if (toolMode === ACTOR_TOOL_MODE.SERVER) serverActorsInfo.push(actorInfo);
        else if (toolMode === ACTOR_TOOL_MODE.MCP) actorMCPServersInfo.push(actorInfo);
        else normalActorsInfo.push(actorInfo);
    }

    const [normalTools, mcpServerTools] = await Promise.all([
        getNormalActorsAsTools(normalActorsInfo, { mcpSessionId, isDirectTool }),
        getMCPServersAsTools(actorMCPServersInfo, apifyClient, mcpSessionId),
    ]);

    return { tools: [...normalTools, ...getServerActorsAsTools(serverActorsInfo), ...mcpServerTools], errors };
}
