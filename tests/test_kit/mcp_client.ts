import {
    Client as StatelessClient,
    type ClientCapabilities as StatelessClientCapabilities,
    StreamableHTTPClientTransport as StatelessStreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

import type { TelemetryEnv, ToolCategory } from '../../src/types.js';

/** Options for the published test-kit client factories. */
export interface SuiteClientOptions {
    actors?: string[];
    tools?: (ToolCategory | string)[];
    useEnv?: boolean; // stdio only
    clientName?: string;
    telemetry?: {
        enabled?: boolean; // default false
        env?: TelemetryEnv;
    };
    serverMode?: string; // ?ui=
    payment?: string; // ?payment=
    clientCapabilities?: ClientCapabilities;
    /** Bearer token. Omitted → `APIFY_TOKEN`. `null` → no Authorization header. */
    token?: string | null;
}

function resolveToken(options?: SuiteClientOptions): string | undefined {
    if (options?.token === null) return undefined;
    if (options?.token !== undefined) return options.token;
    return process.env.APIFY_TOKEN;
}

/** Require a token unless `token: null` or payment mode. */
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
 * v2 SDK client (2026-07-28). `versionNegotiation: auto` probes via `server/discover`.
 * Callers that must not fall back to legacy check `getDiscoverResult()`.
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
        // Shared option shape is v1; cast for v2 schema.
        client.registerCapabilities(options.clientCapabilities as StatelessClientCapabilities);
    }
    await client.connect(transport);
    return client;
}
