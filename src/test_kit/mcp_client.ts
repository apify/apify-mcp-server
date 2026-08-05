import {
    Client as StatelessClient,
    type ClientCapabilities as StatelessClientCapabilities,
    StreamableHTTPClientTransport as StatelessStreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

import type { TelemetryEnv, ToolCategory } from '../types.js';

/**
 * Options both this repo's own suite and `apify-mcp-server-internal` build a client with —
 * published so internal can import these factories instead of maintaining its own copy (it
 * used to; that copy is gone, see apify-mcp-server-internal#<PR>). `serverMode`/`payment` are
 * plain strings rather than internal's narrower unions/booleans (`UiParam`, `skyfireMode`) —
 * one canonical field per concept, each repo's caller passes the same string the server's
 * `?ui=`/`?payment=` query params already accept.
 */
export interface SuiteClientOptions {
    actors?: string[];
    tools?: (ToolCategory | string)[];
    useEnv?: boolean; // stdio only — ignored by the streamable/stateless factories
    clientName?: string;
    telemetry?: {
        enabled?: boolean; // default: false
        env?: TelemetryEnv;
    };
    serverMode?: string; // ?ui= value, e.g. 'apps' | 'true' | the deprecated 'openai'
    payment?: string; // ?payment= value, e.g. 'x402' | 'skyfire'
    clientCapabilities?: ClientCapabilities;
    /**
     * Explicit bearer token. Omitted → reads `process.env.APIFY_TOKEN` (this repo's suite
     * default, one token for the whole run). Pass `null` to send no Authorization header at
     * all — internal's negative-auth and payment-mode tests need a client with no token
     * despite `process.env.APIFY_TOKEN` being set for everything else in the same run.
     */
    token?: string | null;
}

function resolveToken(options?: SuiteClientOptions): string | undefined {
    if (options?.token === null) return undefined;
    if (options?.token !== undefined) return options.token;
    return process.env.APIFY_TOKEN;
}

/**
 * Throws unless a token is resolvable, except when the caller explicitly asked for none
 * (`token: null`) or the request is in payment mode (production also skips token requirements
 * there — see `apify-mcp-server-internal/src/server/shared.ts:authorizeRequestMiddleware`).
 */
function checkToken(options?: SuiteClientOptions): void {
    if (options?.payment) return;
    if (options?.token === null) return;
    if (!resolveToken(options)) {
        throw new Error('No token available: pass `token`, or set APIFY_TOKEN.');
    }
}

function buildAuthHeaders(options?: SuiteClientOptions): Record<string, string> {
    if (options?.payment) return {};
    const token = resolveToken(options);
    return token ? { authorization: `Bearer ${token}` } : {};
}

function appendSearchParams(url: URL, options?: SuiteClientOptions): void {
    const { actors, tools, telemetry, serverMode, payment } = options ?? {};
    if (actors !== undefined) url.searchParams.append('actors', actors.join(','));
    if (tools !== undefined) url.searchParams.append('tools', tools.join(','));
    // Default to false for tests when not explicitly set.
    url.searchParams.append('telemetry-enabled', (telemetry?.enabled ?? false).toString());
    if (serverMode !== undefined) url.searchParams.append('ui', serverMode);
    if (payment) url.searchParams.append('payment', payment);
}

export async function createMcpStreamableClient(serverUrl: string, options?: SuiteClientOptions): Promise<Client> {
    checkToken(options);
    const url = new URL(serverUrl);
    appendSearchParams(url, options);

    const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: buildAuthHeaders(options) },
    });
    const client = new Client({ name: options?.clientName || 'streamable-http-client', version: '1.0.0' });
    if (options?.clientCapabilities) client.registerCapabilities(options.clientCapabilities);
    await client.connect(transport);
    return client;
}

/**
 * Builds a v2-SDK client for the 2026-07-28 revision. `versionNegotiation` belongs on the
 * constructor — `connect()` only takes a cached verdict — and `mode: 'auto'` probes with
 * `server/discover`, falling back to the legacy `initialize` handshake when it finds no modern
 * server. Callers that must not silently run on legacy code check `getDiscoverResult()`.
 */
export async function createMcpStatelessClient(
    serverUrl: string,
    options?: SuiteClientOptions,
): Promise<StatelessClient> {
    checkToken(options);
    const url = new URL(serverUrl);
    appendSearchParams(url, options);

    const transport = new StatelessStreamableHTTPClientTransport(url, {
        requestInit: { headers: buildAuthHeaders(options) },
    });
    const client = new StatelessClient(
        { name: options?.clientName || 'stateless-http-client', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
    );
    if (options?.clientCapabilities) {
        // The two SDK generations derive their capability types from different schemas; the
        // option shape shared with the streamable factory above is the v1 one.
        client.registerCapabilities(options.clientCapabilities as StatelessClientCapabilities);
    }
    await client.connect(transport);
    return client;
}
