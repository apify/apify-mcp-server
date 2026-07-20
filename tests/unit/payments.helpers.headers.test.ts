/**
 * Tests that prepareToolCallContext threads the request origin into the ApifyClient
 * it creates, on both the no-provider and provider paths.
 */
import { describe, expect, it, vi } from 'vitest';

import { prepareToolCallContext } from '../../src/payments/helpers.js';
import type { PaymentProvider } from '../../src/payments/types.js';
import type { HelperTool } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { respondRaw } from '../../src/utils/mcp.js';

const { capturedOptions } = vi.hoisted(() => ({ capturedOptions: [] as unknown[] }));

vi.mock('apify-client', () => ({
    ApifyClient: class {
        constructor(options: unknown) {
            capturedOptions.push(options);
        }
    },
    ApifyApiError: class extends Error {},
}));

type RequestConfig = { headers: Record<string, string> };
type CapturedClientOptions = {
    requestInterceptors: ((config: RequestConfig) => RequestConfig)[];
};

function makeTool(): HelperTool {
    return {
        name: 'call-actor',
        description: 'Call an Actor',
        type: TOOL_TYPE.INTERNAL,
        paymentRequired: false,
        inputSchema: { type: 'object', properties: { actor: { type: 'string' } } },
        ajvValidate: vi.fn(() => true) as never,
        call: vi.fn(async () => respondRaw({ content: [] })),
    };
}

function makeNoopProvider(): PaymentProvider {
    return {
        id: 'skyfire',
        allowsUnauthenticated: true,
        decorateToolSchema: (tool) => tool,
        validatePayment: () => null,
        getPaymentHeaders: () => ({}),
        removePaymentFields: (args) => ({ ...args }),
        redactForLogging: (args) => args,
    };
}

function getStaticHeaders(): Record<string, string> {
    const passed = capturedOptions.at(-1) as CapturedClientOptions;
    return passed.requestInterceptors[0]({ headers: {} }).headers;
}

describe('prepareToolCallContext()', () => {
    it('passes the request origin to the created client', () => {
        prepareToolCallContext({
            provider: undefined,
            tool: makeTool(),
            args: {},
            apifyToken: 'apify_api_test_token',
            requestOrigin: 'APIFY_AI',
        });
        expect(getStaticHeaders()['X-Apify-Request-Origin']).toBe('APIFY_AI');
    });

    it('defaults the request origin to MCP', () => {
        prepareToolCallContext({
            provider: undefined,
            tool: makeTool(),
            args: {},
            apifyToken: 'apify_api_test_token',
        });
        expect(getStaticHeaders()['X-Apify-Request-Origin']).toBe('MCP');
    });

    it('threads the request origin on the provider path too', () => {
        prepareToolCallContext({
            provider: makeNoopProvider(),
            tool: makeTool(),
            args: {},
            apifyToken: 'apify_api_test_token',
            requestOrigin: 'APIFY_AI',
        });
        expect(getStaticHeaders()['X-Apify-Request-Origin']).toBe('APIFY_AI');
    });
});
