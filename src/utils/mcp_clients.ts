import { REQUEST_ORIGIN } from '../apify_client.js';
import {
    APIFY_AI_CLIENT_NAME,
    REPORT_PROBLEM_BLOCKED_CLIENTS,
    STORE_TRACE_ID_MAX_LENGTH,
    STORE_USE_CASE_MAX_LENGTH,
} from '../const.js';
import type { McpClientContext } from '../mcp/client_context.js';
import { REDACTED } from '../resources/api_resources.js';
import { APIFY_TRACE_ID_META_KEY, APIFY_USE_CASE_META_KEY } from './mcp.js';

const APIFY_API_TOKEN_REGEX = /apify_api_[A-Za-z0-9]+/g;

function redactApifyTokens(text: string): string {
    return text.replace(APIFY_API_TOKEN_REGEX, REDACTED);
}

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

/** Trace id and use case for Store searches; `_meta` is read only for Apify AI. */
export function resolveStoreSearchTracking(
    requestOrigin: REQUEST_ORIGIN,
    meta: Record<string, unknown> | undefined,
    mcpSessionId: string | undefined,
) {
    const asString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const isApifyAi = requestOrigin === REQUEST_ORIGIN.APIFY_AI;
    const traceId = (isApifyAi && asString(meta?.[APIFY_TRACE_ID_META_KEY])) || asString(mcpSessionId);
    let useCase = isApifyAi
        ? redactApifyTokens(asString(meta?.[APIFY_USE_CASE_META_KEY])).slice(0, STORE_USE_CASE_MAX_LENGTH)
        : '';
    // Do not end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(useCase)) useCase = useCase.slice(0, -1);
    return {
        traceId: traceId && traceId.length <= STORE_TRACE_ID_MAX_LENGTH ? traceId : undefined,
        useCase: useCase || undefined,
    };
}
