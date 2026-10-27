import { type ApifyClient, REQUEST_ORIGIN } from '../apify_client.js';
import {
    APIFY_AI_CLIENT_NAME,
    ANTHROPIC_CLIENT_NAMES,
    STORE_TRACE_ID_MAX_LENGTH,
    STORE_USE_CASE_MAX_LENGTH,
} from '../const.js';
import type { McpClientContext } from '../mcp/client_context.js';
import { APIFY_TRACE_ID_META_KEY } from './mcp.js';

const APIFY_API_TOKEN_REGEX = /apify_api_[A-Za-z0-9]+/g;

/** True when `report-problem` is blocklisted for the connecting client (substring match on {@link ANTHROPIC_CLIENT_NAMES}). */
export function isReportProblemBlockedForClient(context: McpClientContext | undefined): boolean {
    const clientName = context?.clientInfo?.name?.toLowerCase() ?? '';
    return ANTHROPIC_CLIENT_NAMES.some((blocked) => clientName.includes(blocked));
}

/** Apify API request origin for this client. Exact match on {@link APIFY_AI_CLIENT_NAME}; everything else is MCP. */
export function getRequestOriginForClient(context: McpClientContext | undefined): REQUEST_ORIGIN {
    const clientName = context?.clientInfo?.name;
    return clientName === APIFY_AI_CLIENT_NAME ? REQUEST_ORIGIN.APIFY_AI : REQUEST_ORIGIN.MCP;
}

/** Whether `search-actors` takes a `useCase` for this client: a declared name, and neither it nor `?client=` on {@link ANTHROPIC_CLIENT_NAMES}. */
export function isStoreUseCaseServable(
    context: McpClientContext | undefined,
    clientParam: string | undefined,
): boolean {
    const name = context?.clientInfo?.name?.trim().toLowerCase();
    const blocked = (value: string) => ANTHROPIC_CLIENT_NAMES.some((entry) => value.includes(entry));
    return !!name && !blocked(name) && !blocked((clientParam ?? '').toLowerCase());
}

/** Trace id of a call: Apify AI's `_meta` thread id, else the MCP session id; omitted over the API limit. */
export function resolveStoreSearchTracking(
    requestOrigin: REQUEST_ORIGIN,
    meta: Record<string, unknown> | undefined,
    mcpSessionId: string | undefined,
): NonNullable<ApifyClient['storeSearchTracking']> {
    const asString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const traceId =
        (requestOrigin === REQUEST_ORIGIN.APIFY_AI && asString(meta?.[APIFY_TRACE_ID_META_KEY])) ||
        asString(mcpSessionId);
    return { traceId: traceId && traceId.length <= STORE_TRACE_ID_MAX_LENGTH ? traceId : undefined };
}

/** Trimmed, API tokens redacted, cut to the API limit (not mid surrogate pair). */
export function sanitizeUseCase(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    let useCase = value.trim().replace(APIFY_API_TOKEN_REGEX, 'apify_api_***').slice(0, STORE_USE_CASE_MAX_LENGTH);
    if (/[\uD800-\uDBFF]$/.test(useCase)) useCase = useCase.slice(0, -1);
    return useCase || undefined;
}
