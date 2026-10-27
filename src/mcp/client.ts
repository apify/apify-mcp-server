import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import log from '@apify/log';

import { REQUEST_ORIGIN, REQUEST_ORIGIN_HEADER } from '../apify_client.js';
import { TimeoutError } from '../errors.js';
import { getHttpStatusCode, sanitizeMezmoMessage } from '../utils/logging.js';
import { ACTORIZED_MCP_CONNECTION_TIMEOUT_MSEC } from './const.js';
import { getMCPServerID } from './proxy.js';

export type McpConnectionOptions = { token: string; requestOrigin?: REQUEST_ORIGIN };

/**
 * Creates and connects a ModelContextProtocol client.
 * First tries streamable HTTP transport, then falls back to SSE transport.
 */
export async function connectMCPClient(
    url: string,
    options: McpConnectionOptions,
    mcpSessionId?: string,
): Promise<Client | null> {
    try {
        return await createMCPStreamableClient(url, options);
    } catch (error) {
        // If streamable HTTP transport fails on not timeout error, continue with SSE transport
        if (error instanceof TimeoutError) {
            log.warning('Connection to MCP server using streamable HTTP transport timed out', { url, mcpSessionId });
            return null;
        }
        // If streamable HTTP transport fails, fall back to SSE transport
        log.debug('Streamable HTTP transport failed, falling back to SSE transport', {
            url,
            mcpSessionId,
            statusCode: getHttpStatusCode(error),
            errMessage: error instanceof Error ? error.message : String(error),
        });
    }

    try {
        return await createMCPSSEClient(url, options);
    } catch (error) {
        if (error instanceof TimeoutError) {
            log.warning('Connection to MCP server using SSE transport timed out', { url, mcpSessionId });
            return null;
        }
        // External MCP server unavailability is operational, not a bug.
        // Mezmo (logDNA) promotes log entries to errors when the message contains "error"
        // Sanitize the error message to preserve the soft-fail log level.
        const errMessage = sanitizeMezmoMessage(error instanceof Error ? error.message : String(error));
        log.softFail('MCP server unreachable', {
            url,
            mcpSessionId,
            statusCode: getHttpStatusCode(error),
            errMessage,
        });
        return null;
    }
}

async function withTimeout<T>(millis: number, promise: Promise<T>): Promise<T> {
    let timeoutPid: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutPid = setTimeout(() => reject(new TimeoutError(`Timed out after ${millis} ms.`)), millis);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutPid));
}

async function connectWithTransport(
    url: string,
    transport: SSEClientTransport | StreamableHTTPClientTransport,
): Promise<Client> {
    const client = new Client({
        name: getMCPServerID(url),
        version: '1.0.0',
    });
    await withTimeout(ACTORIZED_MCP_CONNECTION_TIMEOUT_MSEC, client.connect(transport));
    return client;
}

/** Headers on every request to an Actor's MCP server; the request origin is the one the session's API calls carry. */
function buildMCPRequestHeaders({ token, requestOrigin }: McpConnectionOptions): Record<string, string> {
    return { authorization: `Bearer ${token}`, [REQUEST_ORIGIN_HEADER]: requestOrigin ?? REQUEST_ORIGIN.MCP };
}

/**
 * Creates and connects a ModelContextProtocol client using the SSE transport.
 */
async function createMCPSSEClient(url: string, options: McpConnectionOptions): Promise<Client> {
    const transport = new SSEClientTransport(new URL(url), {
        requestInit: {
            headers: buildMCPRequestHeaders(options),
        },
        eventSourceInit: {
            // The EventSource package augments EventSourceInit with a "fetch" parameter.
            // You can use this to set additional headers on the outgoing request.
            // Based on this example: https://github.com/modelcontextprotocol/typescript-sdk/issues/118
            async fetch(input: Request | URL | string, init?: RequestInit) {
                const headers = new Headers(init?.headers || {});
                for (const [name, value] of Object.entries(buildMCPRequestHeaders(options))) {
                    headers.set(name, value);
                }
                return fetch(input, { ...init, headers });
            },
            // We have to cast to "any" to use it, since it's non-standard
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    return await connectWithTransport(url, transport);
}

/**
 * Creates and connects a ModelContextProtocol client using the streamable HTTP transport.
 */
async function createMCPStreamableClient(url: string, options: McpConnectionOptions): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
            headers: buildMCPRequestHeaders(options),
        },
    });

    return await connectWithTransport(url, transport);
}
