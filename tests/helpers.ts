import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect } from 'vitest';

import { HelperTools } from '../src/const.js';
import type { TelemetryEnv, ToolCategory, UiMode } from '../src/types.js';

export type McpClientOptions = {
    actors?: string[];
    enableAddingActors?: boolean;
    tools?: (ToolCategory | string)[]; // Tool categories, specific tool or Actor names to include
    useEnv?: boolean; // Use environment variables instead of command line arguments (stdio only)
    clientName?: string; // Client name for identification
    telemetry?: {
        enabled?: boolean; // Enable or disable telemetry (default: false for tests)
        env?: TelemetryEnv; // Telemetry environment (default: 'PROD', only used when telemetry.enabled is true)
    };
    uiMode?: UiMode; // UI mode for tool responses. 'openai' for OpenAI specific widget rendering.
    skyfireMode?: boolean; // Enable Skyfire mode (default: false)
}

function checkApifyToken(): void {
    if (!process.env.APIFY_TOKEN) {
        throw new Error('APIFY_TOKEN environment variable is not set.');
    }
}

function appendSearchParams(url: URL, options?: McpClientOptions): void {
    const { actors, enableAddingActors, tools, telemetry, uiMode, skyfireMode } = options || {};
    if (actors !== undefined) {
        url.searchParams.append('actors', actors.join(','));
    }
    if (enableAddingActors !== undefined) {
        url.searchParams.append('enableAddingActors', enableAddingActors.toString());
    }
    if (tools !== undefined) {
        url.searchParams.append('tools', tools.join(','));
    }
    // Append telemetry parameters (default to false for tests when not explicitly set)
    const telemetryEnabled = telemetry?.enabled !== undefined ? telemetry.enabled : false;
    url.searchParams.append('telemetry-enabled', telemetryEnabled.toString());
    if (uiMode !== undefined) {
        url.searchParams.append('ui', uiMode);
    }
    if (skyfireMode) {
        url.searchParams.append('payment', 'skyfire');
    }
}

export async function createMcpSseClient(
    serverUrl: string,
    options?: McpClientOptions,
): Promise<Client> {
    checkApifyToken();
    const url = new URL(serverUrl);
    appendSearchParams(url, options);

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
        name: options?.clientName || 'sse-client',
        version: '1.0.0',
    });
    await client.connect(transport);

    return client;
}

export async function createMcpStreamableClient(
    serverUrl: string,
    options?: McpClientOptions,
): Promise<Client> {
    checkApifyToken();
    const url = new URL(serverUrl);
    appendSearchParams(url, options);

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
        name: options?.clientName || 'streamable-http-client',
        version: '1.0.0',
    });
    await client.connect(transport);

    return client;
}

export async function createMcpStdioClient(
    options?: McpClientOptions,
): Promise<Client> {
    checkApifyToken();
    const { actors, enableAddingActors, tools, useEnv, telemetry, uiMode, skyfireMode } = options || {};
    const args = ['dist/stdio.js'];
    const env: Record<string, string> = {
        APIFY_TOKEN: process.env.APIFY_TOKEN as string,
    };

    // Default telemetry to disabled for tests to avoid sending Sentry sessions and events
    const telemetryEnabled = telemetry?.enabled ?? false;

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
        env.TELEMETRY_ENABLED = telemetryEnabled.toString();
        if (telemetry?.env !== undefined) {
            env.TELEMETRY_ENV = telemetry.env;
        }
        if (uiMode !== undefined) {
            env.UI_MODE = uiMode;
        }
        if (skyfireMode !== undefined) {
            env.SKYFIRE_MODE = skyfireMode.toString();
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
        args.push('--telemetry-enabled', telemetryEnabled.toString());
        if (telemetry?.env !== undefined && telemetryEnabled) {
            args.push('--telemetry-env', telemetry.env);
        }
        if (uiMode !== undefined) {
            args.push('--ui', uiMode);
        }
        if (skyfireMode !== undefined) {
            args.push('--skyfire', skyfireMode.toString());
        }
    }

    const transport = new StdioClientTransport({
        command: 'node',
        args,
        env,
    });
    const client = new Client({
        name: options?.clientName || 'stdio-client',
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
