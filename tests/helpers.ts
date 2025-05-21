import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect } from 'vitest';

import { HelperTools } from '../src/const.js';

export interface McpClientOptions {
    actors?: string[];
    enableAddingActors?: boolean;
}

export async function createMcpSseClient(
    serverUrl: string,
    options?: McpClientOptions,
): Promise<Client> {
    if (!process.env.APIFY_TOKEN) {
        throw new Error('APIFY_TOKEN environment variable is not set.');
    }
    const url = new URL(serverUrl);
    const { actors, enableAddingActors } = options || {};
    if (actors) {
        url.searchParams.append('actors', actors.join(','));
    }
    if (enableAddingActors) {
        url.searchParams.append('enableAddingActors', 'true');
    }

    const transport = new SSEClientTransport(
        url,
        {
            requestInit: {
                headers: {
                    authorization: `Bearer ${process.env.APIFY_TOKEN}`,
                },
            },
        },
    );

    const client = new Client({
        name: 'sse-client',
        version: '1.0.0',
    });
    await client.connect(transport);

    return client;
}

export async function createMcpStreamableClient(
    serverUrl: string,
    options?: McpClientOptions,
): Promise<Client> {
    if (!process.env.APIFY_TOKEN) {
        throw new Error('APIFY_TOKEN environment variable is not set.');
    }
    const url = new URL(serverUrl);
    const { actors, enableAddingActors } = options || {};
    if (actors) {
        url.searchParams.append('actors', actors.join(','));
    }
    if (enableAddingActors) {
        url.searchParams.append('enableAddingActors', 'true');
    }

    const transport = new StreamableHTTPClientTransport(
        url,
        {
            requestInit: {
                headers: {
                    authorization: `Bearer ${process.env.APIFY_TOKEN}`,
                },
            },
        },
    );

    const client = new Client({
        name: 'streamable-http-client',
        version: '1.0.0',
    });
    await client.connect(transport);

    return client;
}

export async function createMcpStdioClient(
    options?: McpClientOptions,
): Promise<Client> {
    if (!process.env.APIFY_TOKEN) {
        throw new Error('APIFY_TOKEN environment variable is not set.');
    }
    const { actors, enableAddingActors } = options || {};
    const args = ['dist/stdio.js'];
    if (actors) {
        args.push('--actors', actors.join(','));
    }
    if (enableAddingActors) {
        args.push('--enable-adding-actors');
    }
    const transport = new StdioClientTransport({
        command: 'node',
        args,
        env: {
            APIFY_TOKEN: process.env.APIFY_TOKEN as string,
        },
    });
    const client = new Client({
        name: 'stdio-client',
        version: '1.0.0',
    });
    await client.connect(transport);

    return client;
}

/**
 * Adds an Actor as a tool using the ADD_ACTOR helper tool.
 * @param client - MCP client instance
 * @param actorName - Name of the Actor to add
 */
export async function addActor(client: Client, actorName: string): Promise<void> {
    await client.callTool({
        name: HelperTools.ACTOR_ADD,
        arguments: {
            actorName,
        },
    });
}

/**
 * Asserts that two arrays contain the same elements, regardless of order.
 * @param array - The array to test
 * @param values - The expected values
 */
export function expectArrayWeakEquals(array: unknown[], values: unknown[]): void {
    expect(array.length).toBe(values.length);
    for (const value of values) {
        expect(array).toContainEqual(value);
    }
}
