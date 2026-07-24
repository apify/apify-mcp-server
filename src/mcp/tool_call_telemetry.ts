import log from '@apify/log';

import { ApifyClient } from '../apify_client.js';
import { HELPER_TOOLS, TOOL_STATUS } from '../const.js';
import { buildReportedProblemProperties, trackReportedProblem, trackToolCall } from '../telemetry.js';
import type {
    CallDiagnostics,
    TelemetryEnv,
    ToolCallTelemetryProperties,
    ToolStatus,
    TransportType,
} from '../types.js';
import { computeToolResponseBytes } from '../utils/mcp.js';
import { getRequestOriginForClient } from '../utils/mcp_clients.js';
import { deriveResourceIds } from '../utils/tool_status.js';
import { getUserInfoCached } from '../utils/userid_cache.js';
import { getPackageVersion } from '../utils/version.js';
import type { McpClientContext } from './client_context.js';

type PrepareTelemetryDataParams = {
    toolName: string;
    mcpSessionId: string | undefined;
    apifyToken: string;
    telemetryEnabled: boolean;
    transportType?: TransportType;
    clientContext: McpClientContext | undefined;
};

/**
 * Creates telemetry data for a tool call.
 */
export async function prepareTelemetryData(
    params: PrepareTelemetryDataParams,
): Promise<{ telemetryData: ToolCallTelemetryProperties | null; userId: string | null }> {
    const { toolName, mcpSessionId, apifyToken, telemetryEnabled, transportType, clientContext } = params;
    if (!telemetryEnabled) {
        return { telemetryData: null, userId: null };
    }

    // Get userId from cache or fetch from API
    let userId: string | null = null;
    if (apifyToken) {
        const requestOrigin = getRequestOriginForClient(clientContext);
        const apifyClient = new ApifyClient({ token: apifyToken, requestOrigin });
        ({ userId } = await getUserInfoCached(apifyToken, apifyClient));
        log.debug('Telemetry: fetched userId', { userId, mcpSessionId });
    }
    const telemetryData: ToolCallTelemetryProperties = {
        app: 'mcp',
        app_version: getPackageVersion() || '',
        mcp_client_name: clientContext?.clientInfo?.name || '',
        mcp_client_version: clientContext?.clientInfo?.version || '',
        mcp_protocol_version: clientContext?.protocolVersion || '',
        mcp_client_capabilities: clientContext?.capabilities || null,
        mcp_session_id: mcpSessionId || '',
        transport_type: transportType || '',
        tool_name: toolName,
        tool_status: TOOL_STATUS.SUCCEEDED, // Will be updated in finally
        tool_exec_time_ms: 0, // Will be calculated in finally
    };

    return { telemetryData, userId };
}

/**
 * Logs tool call completion at INFO level and tracks telemetry.
 * Computes duration once so both the log line and telemetry event use the same value.
 * Response bytes and resource ids are derived here from the raw `result` (+ `args`) so every
 * call site stays a plain hand-off — no path can forget to compute or strip them.
 */
type LogToolCallAndTelemetryParams = {
    toolName: string;
    mcpSessionId: string | undefined;
    toolStatus: ToolStatus;
    startTime: number;
    taskId?: string;
    telemetryData: ToolCallTelemetryProperties | null;
    userId: string | null;
    callDiagnostics?: CallDiagnostics;
    args?: Record<string, unknown>;
    result?: unknown;
    telemetryEnv: TelemetryEnv;
};

export function logToolCallAndTelemetry(params: LogToolCallAndTelemetryParams): void {
    const durationMs = Date.now() - params.startTime;
    // `result` is undefined only on short-circuit paths that never produced a payload (e.g. a
    // cancelled task); skip byte accounting there. `null`/`{}` still measure as zero bytes.
    const responseBytes = params.result === undefined ? undefined : computeToolResponseBytes(params.result);

    log.info('Tool call completed', {
        toolName: params.toolName,
        mcpSessionId: params.mcpSessionId,
        toolStatus: params.toolStatus,
        durationMs,
        ...(responseBytes !== undefined && {
            responseContentBytes: responseBytes.contentBytes,
            responseStructuredContentBytes: responseBytes.structuredContentBytes,
            responseFileBytes: responseBytes.fileBytes,
        }),
        ...(params.taskId !== undefined && { taskId: params.taskId }),
    });

    if (params.telemetryData) {
        const finalizedTelemetryData: ToolCallTelemetryProperties = {
            ...params.telemetryData,
            tool_status: params.toolStatus,
            tool_exec_time_ms: durationMs,
            ...(responseBytes && {
                tool_response_content_bytes: responseBytes.contentBytes,
                tool_response_structured_content_bytes: responseBytes.structuredContentBytes,
                tool_response_file_bytes: responseBytes.fileBytes,
            }),
            // Always include actor_name/actor_id; failure-specific fields are only present when callDiagnostics has them.
            ...params.callDiagnostics,
            // Resource ids are read once here from the args + the tool's public output; no tool
            // threads them back. Applied uniformly, last. See deriveResourceIds.
            ...deriveResourceIds(params.args, params.result),
        };
        trackToolCall(params.userId, params.telemetryEnv, finalizedTelemetryData);

        // A successful report-problem call also emits a dedicated feedback event carrying the
        // submission. A downstream Segment destination fans it out to Slack/GitHub.
        if (
            params.toolName === HELPER_TOOLS.PROBLEM_REPORT &&
            params.toolStatus === TOOL_STATUS.SUCCEEDED &&
            params.args
        ) {
            trackReportedProblem(
                params.userId,
                params.telemetryEnv,
                buildReportedProblemProperties(finalizedTelemetryData, params.args),
            );
        }
    }
}
