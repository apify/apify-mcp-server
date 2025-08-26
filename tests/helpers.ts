import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect } from 'vitest';

import { HelperTools } from '../src/const.js';
import type { ToolCategory } from '../src/types.js';

export interface McpClientOptions {
    actors?: string[];
    enableAddingActors?: boolean;
    tools?: (ToolCategory | string)[]; // Tool categories, specific tool or Actor names to include
    useEnv?: boolean; // Use environment variables instead of command line arguments (stdio only)
}

export async function createMcpSseClient(
    serverUrl: string,
    options?: McpClientOptions,
): Promise<Client> {
    if (!process.env.APIFY_TOKEN) {
        throw new Error('APIFY_TOKEN environment variable is not set.');
    }
    const url = new URL(serverUrl);
    const { actors, enableAddingActors, tools } = options || {};
    if (actors !== undefined) {
        url.searchParams.append('actors', actors.join(','));
    }
    if (enableAddingActors !== undefined) {
        url.searchParams.append('enableAddingActors', enableAddingActors.toString());
    }
    if (tools !== undefined) {
        url.searchParams.append('tools', tools.join(','));
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
    const { actors, enableAddingActors, tools } = options || {};
    if (actors !== undefined) {
        url.searchParams.append('actors', actors.join(','));
    }
    if (enableAddingActors !== undefined) {
        url.searchParams.append('enableAddingActors', enableAddingActors.toString());
    }
    if (tools !== undefined) {
        url.searchParams.append('tools', tools.join(','));
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
    const { actors, enableAddingActors, tools, useEnv } = options || {};
    const args = ['dist/stdio.js'];
    const env: Record<string, string> = {
        APIFY_TOKEN: process.env.APIFY_TOKEN as string,
    };

    // Set environment variables instead of command line arguments when useEnv is true
    if (useEnv) {
        if (actors !== undefined) {
            env.ACTORS = actors.join(',');
        }
        if (enableAddingActors !== undefined) {
            env.ENABLE_ADDING_ACTORS = enableAddingActors.toString();
        }
        if (tools !== undefined) {
            env.TOOLS = tools.join(',');
        }
    } else {
        // Use command line arguments as before
        if (actors !== undefined) {
            args.push('--actors', actors.join(','));
        }
        if (enableAddingActors !== undefined) {
            args.push('--enable-adding-actors', enableAddingActors.toString());
        }
        if (tools !== undefined) {
            args.push('--tools', tools.join(','));
        }
    }

    const transport = new StdioClientTransport({
        command: 'node',
        args,
        env,
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
 * @param actor - Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".
 */
export async function addActor(client: Client, actor: string): Promise<void> {
    await client.callTool({
        name: HelperTools.ACTOR_ADD,
        arguments: {
            actor,
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
