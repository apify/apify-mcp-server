import { REQUEST_ORIGIN } from '../apify_client.js';
import { APIFY_AI_CLIENT_NAME, REPORT_PROBLEM_BLOCKED_CLIENTS } from '../const.js';
import type { McpClientContext } from '../mcp/client_context.js';

/** True when `report-problem` is blocklisted for the connecting client (substring match on {@link REPORT_PROBLEM_BLOCKED_CLIENTS}). */
export function isReportProblemBlockedForClient(context: McpClientContext | undefined): boolean {
    const clientName = context?.clientInfo?.name?.toLowerCase() ?? '';
    return REPORT_PROBLEM_BLOCKED_CLIENTS.some((blocked) => clientName.includes(blocked));
}

/** Apify API request origin for this client. Exact match on {@link APIFY_AI_CLIENT_NAME}; everything else is MCP. */
export function getRequestOriginForClient(context: McpClientContext | undefined): REQUEST_ORIGIN {
    const clientName = context?.clientInfo?.name;
    return clientName === APIFY_AI_CLIENT_NAME ? REQUEST_ORIGIN.APIFY_AI : REQUEST_ORIGIN.MCP;
}
