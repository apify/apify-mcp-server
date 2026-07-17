import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { REPORT_PROBLEM_BLOCKED_CLIENTS } from '../const.js';

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
