import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import log from '@apify/log';

import { getMCPServerID } from './utils.js';

/**
 * Creates and connects a ModelContextProtocol client.
 * First tries streamable HTTP transport, then falls back to SSE transport.
 */
export async function connectMCPClient(
    url: string, token: string,
): Promise<Client> {
    try {
        return await createMCPStreamableClient(url, token);
    } catch {
        // If streamable HTTP transport fails, fall back to SSE transport
        log.debug('Streamable HTTP transport failed, falling back to SSE transport', {
            url,
        });
        return await createMCPSSEClient(url, token);
    }
}

/**
 * Creates and connects a ModelContextProtocol client.
 */
async function createMCPSSEClient(
    url: string, token: string,
): Promise<Client> {
    const transport = new SSEClientTransport(
        new URL(url),
        {
            requestInit: {
                headers: {
                    authorization: `Bearer ${token}`,
                },
            },
            eventSourceInit: {
                // The EventSource package augments EventSourceInit with a "fetch" parameter.
                // You can use this to set additional headers on the outgoing request.
                // Based on this example: https://github.com/modelcontextprotocol/typescript-sdk/issues/118
                async fetch(input: Request | URL | string, init?: RequestInit) {
                    const headers = new Headers(init?.headers || {});
                    headers.set('authorization', `Bearer ${token}`);
                    return fetch(input, { ...init, headers });
                },
            // We have to cast to "any" to use it, since it's non-standard
            } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        });

    const client = new Client({
        name: getMCPServerID(url),
        version: '1.0.0',
    });

    await client.connect(transport);

    return client;
}

/**
 * Creates and connects a ModelContextProtocol client using the streamable HTTP transport.
 */
async function createMCPStreamableClient(
    url: string, token: string,
): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
        new URL(url),
        {
            requestInit: {
                headers: {
                    authorization: `Bearer ${token}`,
                },
            },
        });

    const client = new Client({
        name: getMCPServerID(url),
        version: '1.0.0',
    });

    await client.connect(transport);

    return client;
}
