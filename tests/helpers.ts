import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect } from 'vitest';

import type { SuiteClientOptions } from './test_kit/index.js';
import { checkToken, resolveToken } from './test_kit/mcp_client.js';

/** stdio client for this repo's dist/stdio.js. Honors the shared `options.token` contract. */
export async function createMcpStdioClient(options?: SuiteClientOptions): Promise<Client> {
    checkToken(options);
    const { actors, tools, useEnv, telemetry, serverMode, payment } = options || {};
    const args = ['dist/stdio.js'];
    const token = resolveToken(options);
    const env: Record<string, string> = {
        ...(token ? { APIFY_TOKEN: token } : {}),
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

/** The only `SuiteClientOptions` key a shared stdio process may differ in. Any other key gets its own process. */
const POOLABLE_OPTION_KEY_SET = new Set<string>(['tools']);

/** `Client` methods that hold per-client state. Refused on a shared client because tests run concurrently. */
const PER_CLIENT_STATE_METHOD_SET = new Set<string>([
    'setNotificationHandler',
    'removeNotificationHandler',
    'setRequestHandler',
    'removeRequestHandler',
    'setLoggingLevel',
    'registerCapabilities',
]);

function isPoolable(options?: SuiteClientOptions): boolean {
    if (!options) return true;
    return Object.entries(options).every(([key, value]) => value === undefined || POOLABLE_OPTION_KEY_SET.has(key));
}

/** A view of a shared client whose `close()` is a no-op and whose per-client state cannot be changed. */
function buildSharedClient(client: Client): Client {
    return new Proxy(client, {
        get(target, property) {
            if (property === 'close') return async () => {};
            if (typeof property === 'string' && PER_CLIENT_STATE_METHOD_SET.has(property)) {
                return () => {
                    throw new Error(
                        `${property}() changes per-client state, but this stdio client is shared with other tests. ` +
                            'Pass `isolated: true` in the case client options.',
                    );
                };
            }
            const value = Reflect.get(target, property);
            // Client methods touch private fields, which resolve only on the real instance.
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/**
 * Share one stdio server process among tests that ask for the same tool list.
 *
 * Every stdio client spawns `node dist/stdio.js`, and booting it costs more than a typical test;
 * the stdio file spawned one process per test and took five times longer than the HTTP files.
 * The tool list is fixed at boot, so tests that differ in nothing else can share a connected client.
 * Tests that pass any other option (`actors`, `payment`, `useEnv`, `clientName`, `isolated`, ...)
 * get their own process, as before.
 *
 * `close()` on a shared client is a no-op; call `closeAll()` once the file is done.
 */
export function createStdioClientPool(): {
    createClient: (options?: SuiteClientOptions) => Promise<Client>;
    closeAll: () => Promise<void>;
} {
    const sharedClients = new Map<string, Promise<Client>>();

    const createClient = async (options?: SuiteClientOptions): Promise<Client> => {
        if (!isPoolable(options)) return createMcpStdioClient(options);
        const key = JSON.stringify(options?.tools ?? null);
        let pending = sharedClients.get(key);
        if (!pending) {
            pending = createMcpStdioClient(options);
            sharedClients.set(key, pending);
            // A failed boot is not cached, so the next test retries.
            pending.catch(() => sharedClients.delete(key));
        }
        return buildSharedClient(await pending);
    };

    const closeAll = async (): Promise<void> => {
        const results = await Promise.allSettled(sharedClients.values());
        sharedClients.clear();
        await Promise.all(results.map((result) => (result.status === 'fulfilled' ? result.value.close() : undefined)));
    };

    return { createClient, closeAll };
}
