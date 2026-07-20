import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { REQUEST_ORIGIN } from '../apify_client.js';
import { APIFY_AI_CLIENT_NAME, REPORT_PROBLEM_BLOCKED_CLIENTS } from '../const.js';

/**
 * True when `report-problem` is blocklisted for the connecting client (see
 * {@link REPORT_PROBLEM_BLOCKED_CLIENTS}). Matches any configured client-name substring against the
 * self-reported `clientInfo.name` (lowercased), so new client builds are covered without a
 * maintained allowlist; over-matching only hides an optional tool, which is the safe failure mode.
 * An unknown or absent client is never blocked.
 */
export function isReportProblemBlockedForClient(initializeRequestData?: InitializeRequest): boolean {
    const clientName = initializeRequestData?.params?.clientInfo?.name?.toLowerCase() ?? '';
    return REPORT_PROBLEM_BLOCKED_CLIENTS.some((blocked) => clientName.includes(blocked));
}

/**
 * Maps the connecting client (self-reported `clientInfo.name`) to the request origin sent to the
 * Apify API for runs it starts. Exact match only — unlike the blocklist above, there is exactly one
 * known client to attribute ({@link APIFY_AI_CLIENT_NAME}); substring-matching here would risk
 * mislabeling other clients' stats. Anything unknown, missing, or a near-miss stays MCP, the
 * unchanged default.
 */
export function getRequestOriginForClient(initializeRequestData?: InitializeRequest): REQUEST_ORIGIN {
    const clientName = initializeRequestData?.params?.clientInfo?.name;
    return clientName === APIFY_AI_CLIENT_NAME ? REQUEST_ORIGIN.APIFY_AI : REQUEST_ORIGIN.MCP;
}
