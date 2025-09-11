import type { ApifyClientOptions } from 'apify';

import { ApifyClient, getApifyAPIBaseUrl } from './apify-client.js';

/**
 * Context passed to getApifyClient factory. Useful for per-session overrides.
 * - sessionId: a stable identifier (e.g., MCP transport session) you can use to
 *   memoize clients and avoid recreating them for every request.
 * - headers: request-scoped headers (e.g., "skyfire-pay-id") that should be
 *   propagated to the Apify API calls. If provided, resolveApifyClient prefers
 *   these over static options to prevent header leakage across sessions.
 */
export interface ResolveClientContext {
    sessionId?: string;
    headers?: Record<string, string | number | boolean | undefined>;
}

/**
 * Options for resolving an ApifyClient. You can:
 * - Inject an already constructed client via `apifyClient`.
 * - Provide a factory `getApifyClient(ctx)` to build per-session clients.
 * - Or let the helper construct a client from `token`/`baseUrl`/`skyfirePayId`.
 *
 * Precedence (highest to lowest): getApifyClient(ctx) -> apifyClient -> construct from options/env.
 *
 * Notes
 * - token: If omitted, resolveApifyClient falls back to process.env.APIFY_TOKEN.
 * - baseUrl: If omitted, uses getApifyAPIBaseUrl() which respects APIFY_API_BASE_URL
 *   and special AT_HOME handling.
 * - skyfirePayId: Forwarded to our ApifyClient wrapper which adds an interceptor to
 *   set the "skyfire-pay-id" HTTP header. When a header is present in ctx.headers,
 *   it overrides this option for the current resolution.
 */
export interface ResolveClientOptions extends Omit<ApifyClientOptions, 'token' | 'baseUrl'> {
    // Convenience auth/config
    token?: string | null | undefined;
    baseUrl?: string;
    skyfirePayId?: string;
    // Direct injection or factory
    apifyClient?: ApifyClient;
    getApifyClient?: (ctx?: ResolveClientContext) => ApifyClient;
}

/**
 * Resolve an ApifyClient instance from multiple inputs in a consistent order:
 * 1) If getApifyClient provided, call it with the context.
 * 2) Else if apifyClient provided, return it as-is.
 * 3) Else construct a new ApifyClient using provided token/baseUrl/skyfirePayId/options.
 *    - baseUrl falls back to getApifyAPIBaseUrl().
 *
 * Examples
 * --------
 * 1) Simplest: use env APIFY_TOKEN
 *    const client = resolveApifyClient();
 *
 * 2) Pass a token explicitly
 *    const client = resolveApifyClient({ token: 'apify-XXX' });
 *
 * 3) Inject a prebuilt client (useful for tests or custom interceptors)
 *    const injected = new ApifyClient({ token: 'apify-XXX' });
 *    const client = resolveApifyClient({ apifyClient: injected });
 *
 * 4) Use a factory to provide per-session clients and headers
 *    const clients = new Map<string, ApifyClient>();
 *    function getApifyClient(ctx?: ResolveClientContext) {
 *      const id = ctx?.sessionId ?? 'default';
 *      const skyfire = (ctx?.headers?.['skyfire-pay-id'] as string | undefined) ?? 'global-skyfire';
 *      let c = clients.get(id);
 *      if (!c) {
 *        c = new ApifyClient({ token: process.env.APIFY_TOKEN, skyfirePayId: skyfire });
 *        clients.set(id, c);
 *      }
 *      return c;
 *    }
 *    const client = resolveApifyClient({ getApifyClient }, { sessionId: 's1', headers: { 'skyfire-pay-id': 'per-session' } });
 *
 * 5) Change base URL (e.g., staging) and unauthenticated use
 *    const client = resolveApifyClient({ baseUrl: 'https://api.staging.apify.com', token: null });
 */
export function resolveApifyClient(options: ResolveClientOptions = {}, ctx?: ResolveClientContext): ApifyClient {
    if (typeof options.getApifyClient === 'function') {
        return options.getApifyClient(ctx);
    }
    if (options.apifyClient) {
        return options.apifyClient;
    }

    const { token, baseUrl, skyfirePayId, getApifyClient: _ignored, apifyClient: _ignored2, ...rest } = options;

    // If ctx carries a skyfire-pay-id header, prefer it over provided option to support per-session overrides
    const headerSkyfire = ctx?.headers?.['skyfire-pay-id'] as string | undefined;

    return new ApifyClient({
        ...(rest as ApifyClientOptions),
        token: token ?? process.env.APIFY_TOKEN,
        baseUrl: baseUrl ?? getApifyAPIBaseUrl(),
        // Our ApifyClient wrapper supports this custom option to inject header via interceptor
        skyfirePayId: headerSkyfire ?? skyfirePayId,
    } as unknown as ApifyClientOptions & { token?: string | null; skyfirePayId?: string });
}
