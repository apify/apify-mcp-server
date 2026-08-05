import type { Client as StatelessClient } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect } from 'vitest';

import { createMcpStatelessClient, createMcpStreamableClient, type SuiteClientOptions } from '../src/test_kit/index.js';

// Re-exported so this repo's own suite keeps its existing names — the factories themselves
// now live in src/test_kit/mcp_client.ts (published behind the "./test-kit" export) so
// apify-mcp-server-internal can import the same code instead of maintaining its own copy.
export { createMcpStatelessClient, createMcpStreamableClient };
export type McpClientOptions = SuiteClientOptions;

/**
 * Both client generations the integration suite drives: the v1 SDK client on the `stdio` and
 * `2025-11-25` dimensions, the v2 client on `2026-07-28`. One suite run exercises both.
 */
export type McpSuiteClient = Client | StatelessClient;

/** stdio spawns this repo's own dist/stdio.js — not something a hosted-deploy consumer needs. */
export async function createMcpStdioClient(options?: McpClientOptions): Promise<Client> {
    if (!options?.payment && !process.env.APIFY_TOKEN) {
        throw new Error('APIFY_TOKEN environment variable is not set.');
    }
    const { actors, tools, useEnv, telemetry, serverMode, payment } = options || {};
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
        if (tools !== undefined) {
            env.TOOLS = tools.join(',');
        }
        env.TELEMETRY_ENABLED = telemetryEnabled.toString();
        if (telemetry?.env !== undefined) {
            env.TELEMETRY_ENV = telemetry.env;
        }
        if (serverMode !== undefined) {
            env.UI_MODE = serverMode;
        }
        if (payment !== undefined) {
            env.PAYMENT = payment;
        }
    } else {
        // Use command line arguments as before
        if (actors !== undefined) {
            args.push('--actors', actors.join(','));
        }
        if (tools !== undefined) {
            args.push('--tools', tools.join(','));
        }
        args.push('--telemetry-enabled', telemetryEnabled.toString());
        if (telemetry?.env !== undefined && telemetryEnabled) {
            args.push('--telemetry-env', telemetry.env);
        }
        if (serverMode !== undefined) {
            args.push('--ui', serverMode);
        }
        if (payment !== undefined) {
            args.push('--payment', payment);
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
    if (options?.clientCapabilities) client.registerCapabilities(options.clientCapabilities);
    await client.connect(transport);

    return client;
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
