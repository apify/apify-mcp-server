import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import { TOOL_STATUS } from '../const.js';
import { trackToolCall } from '../telemetry.js';
import type {
    ActorMcpTool,
    ActorTool,
    HelperTool,
    TelemetryEnv,
    ToolCallTelemetryProperties,
    ToolStatus,
} from '../types.js';
import { getUserIdFromTokenCached } from '../utils/userid-cache.js';
import { getPackageVersion } from '../utils/version.js';

type PrepareTelemetryDataParams = {
    telemetryEnabled: boolean | null;
    tool: HelperTool | ActorTool | ActorMcpTool;
    mcpSessionId: string | undefined;
    apifyToken: string;
    initializeRequestData?: InitializeRequest;
    transportType?: 'stdio' | 'http' | 'sse';
};

type FinalizeAndTrackTelemetryParams = {
    telemetryData: ToolCallTelemetryProperties | null;
    userId: string | null;
    startTime: number;
    toolStatus: ToolStatus;
    telemetryEnv: TelemetryEnv;
};

/**
 * Creates telemetry data for a tool call.
 */
export async function prepareTelemetryData({
    telemetryEnabled,
    tool,
    mcpSessionId,
    apifyToken,
    initializeRequestData,
    transportType,
}: PrepareTelemetryDataParams): Promise<{ telemetryData: ToolCallTelemetryProperties | null; userId: string | null }> {
    if (!telemetryEnabled) {
        return { telemetryData: null, userId: null };
    }

    const toolFullName = tool.type === 'actor' ? tool.actorFullName : tool.name;

    // Get userId from cache or fetch from API
    let userId: string | null = null;
    if (apifyToken) {
        const apifyClient = new ApifyClient({ token: apifyToken });
        userId = await getUserIdFromTokenCached(apifyToken, apifyClient);
        log.debug('Telemetry: fetched userId', { userId, mcpSessionId });
    }
    const capabilities = initializeRequestData?.params?.capabilities;
    const params = initializeRequestData?.params as InitializeRequest['params'];
    const telemetryData: ToolCallTelemetryProperties = {
        app: 'mcp',
        app_version: getPackageVersion() || '',
        mcp_client_name: params?.clientInfo?.name || '',
        mcp_client_version: params?.clientInfo?.version || '',
        mcp_protocol_version: params?.protocolVersion || '',
        mcp_client_capabilities: capabilities || null,
        mcp_session_id: mcpSessionId || '',
        transport_type: transportType || '',
        tool_name: toolFullName,
        tool_status: TOOL_STATUS.SUCCEEDED, // Will be updated in finally
        tool_exec_time_ms: 0, // Will be calculated in finally
    };

    return { telemetryData, userId };
}

/**
 * Finalizes and tracks telemetry for a tool call.
 */
export function finalizeAndTrackTelemetry({
    telemetryData,
    userId,
    startTime,
    toolStatus,
    telemetryEnv,
}: FinalizeAndTrackTelemetryParams): void {
    if (!telemetryData) {
        return;
    }

    const execTime = Date.now() - startTime;
    const finalizedTelemetryData: ToolCallTelemetryProperties = {
        ...telemetryData,
        tool_status: toolStatus,
        tool_exec_time_ms: execTime,
    };
    trackToolCall(userId, telemetryEnv, finalizedTelemetryData);
}
