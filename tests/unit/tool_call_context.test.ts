import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareToolCallContext } from '../../src/mcp/tool_call_context.js';
import { REDACTION_PLACEHOLDER } from '../../src/resources/api_resources.js';
import type { HelperTool } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { respondRaw } from '../../src/utils/mcp.js';

const { capturedClientOptions } = vi.hoisted(() => ({ capturedClientOptions: [] as unknown[] }));

vi.mock('../../src/apify_client.js', () => ({
    ApifyClient: class {
        constructor(options: unknown) {
            capturedClientOptions.push(options);
        }
    },
}));

const MOCK_APIFY_TOKEN = 'apify_api_test_token' as const;

beforeEach(() => {
    capturedClientOptions.length = 0;
});

function makeTool(): HelperTool {
    return {
        name: 'call-actor',
        description: 'Call an Actor',
        type: TOOL_TYPE.INTERNAL,
        inputSchema: { type: 'object', properties: { actor: { type: 'string' } } },
        ajvValidate: vi.fn(() => true) as never,
        call: vi.fn(async () => respondRaw({ content: [] })),
    };
}

describe('argument copies', () => {
    it('keeps logSafeArgs intact when AJV strips a key from toolArgs in place', () => {
        const args = { actor: 'apify/rag-web-browser', unknownExtra: 'should-be-stripped' };
        const result = prepareToolCallContext({
            tool: makeTool(),
            args,
            apifyToken: MOCK_APIFY_TOKEN,
        });
        expect(result.toolArgs).toEqual(args);

        // What AJV's removeAdditional does to the copy it validates.
        delete result.toolArgs.unknownExtra;

        expect(result.toolArgsRedacted).toEqual({ actor: 'apify/rag-web-browser', unknownExtra: 'should-be-stripped' });
    });

    it("applies the tool's redactArgs to logSafeArgs", () => {
        const args = { actor: 'apify/rag-web-browser', secret: 'hide-me' };
        const tool = {
            ...makeTool(),
            redactArgs: (toolArgs: Record<string, unknown>) => ({ ...toolArgs, secret: '[REDACTED]' }),
        };
        const result = prepareToolCallContext({ tool, args, apifyToken: MOCK_APIFY_TOKEN });

        expect(result.toolArgsRedacted).toEqual({ actor: 'apify/rag-web-browser', secret: '[REDACTED]' });
        expect(result.toolArgs).toEqual({ actor: 'apify/rag-web-browser', secret: 'hide-me' });
    });
});

describe('the logged Actor name', () => {
    // The `actor` argument is whatever the caller sent, so a value that is no Actor name can be a pasted secret.
    it('is replaced when the argument is not an Actor ID or name', () => {
        const result = prepareToolCallContext({
            tool: makeTool(),
            args: { actor: '--header "Authorization: Bearer secret-value"', input: {} },
            apifyToken: MOCK_APIFY_TOKEN,
        });

        expect(result.toolArgsRedacted).toEqual({ actor: REDACTION_PLACEHOLDER, input: {} });
    });

    it("is replaced in the copy the tool's redactArgs returns", () => {
        const tool = { ...makeTool(), redactArgs: (args: Record<string, unknown>) => ({ actor: args.actor }) };
        const result = prepareToolCallContext({
            tool,
            args: { actor: 'Bearer secret-value' },
            apifyToken: MOCK_APIFY_TOKEN,
        });

        expect(result.toolArgsRedacted).toEqual({ actor: REDACTION_PLACEHOLDER });
    });
});

describe('requestOrigin forwarding', () => {
    it('forwards requestOrigin to the ApifyClient', () => {
        prepareToolCallContext({
            tool: makeTool(),
            args: {},
            apifyToken: MOCK_APIFY_TOKEN,
            requestOrigin: 'APIFY_AI',
        });
        expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'APIFY_AI' });
    });
});
