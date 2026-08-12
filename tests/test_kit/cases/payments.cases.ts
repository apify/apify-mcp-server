import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';

import { HELPER_TOOLS } from '../../../src/const.js';
import { SKYFIRE_ENABLED_TOOLS } from '../../../src/payments/const.js';
import { ACTOR_EXAMPLE_MCP_SERVER, ACTOR_NORMAL_MODE, asLegacyClient } from '../helpers.js';
import type { Case, CaseCtx } from '../types.js';

// Payment modes need HTTP headers — never stdio.
function notStdio(ctx: CaseCtx): boolean {
    return ctx.transport === 'stdio';
}

/** Skyfire and x402 payment modes. */
export const paymentsCases: Case[] = [
    {
        // isDeploymentTest: skyfire fee gating.
        name: 'should inject skyfire-pay-id parameter into all SKYFIRE_ENABLED_TOOLS when skyfireMode is enabled',
        isDeploymentTest: true,
        skipIf: notStdio,
        run: async (ctx) => {
            const client = await ctx.createClientFn({ payment: 'skyfire', tools: Array.from(SKYFIRE_ENABLED_TOOLS) });
            try {
                const toolsList = await client.listTools();
                const skyfireEnabledToolNames = Array.from(SKYFIRE_ENABLED_TOOLS);

                for (const toolName of skyfireEnabledToolNames) {
                    const tool = toolsList.tools.find((t) => t.name === toolName);
                    expect(tool, `Tool "${toolName}" should exist in the tools list`).toBeDefined();
                    if (!tool) continue;

                    expect(tool.inputSchema, `Tool "${toolName}" should have inputSchema`).toBeDefined();
                    expect(
                        tool.inputSchema && 'properties' in tool.inputSchema,
                        `Tool "${toolName}" should have inputSchema.properties`,
                    ).toBe(true);
                    if (!tool.inputSchema || !('properties' in tool.inputSchema)) continue;

                    const properties = tool.inputSchema.properties as Record<string, unknown>;
                    expect(
                        properties['skyfire-pay-id'],
                        `Tool "${toolName}" should have skyfire-pay-id property in inputSchema`,
                    ).toBeDefined();

                    const skyfireProperty = properties['skyfire-pay-id'] as Record<string, unknown>;
                    expect(skyfireProperty.type, `skyfire-pay-id should have type "string"`).toBe('string');
                    expect(skyfireProperty.description, `skyfire-pay-id should have description`).toBeDefined();

                    expect(
                        tool.description?.includes('skyfire-pay-id'),
                        `Tool "${toolName}" description should mention skyfire-pay-id`,
                    ).toBe(true);
                }
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should advertise x402 metadata on all paymentRequired tools when x402 payment is enabled',
        isDeploymentTest: false,
        skipIf: notStdio,
        run: async (ctx) => {
            // Pin paid-tool set independently of production constants.
            const paidToolNames = [
                HELPER_TOOLS.ACTOR_CALL,
                HELPER_TOOLS.ACTOR_RUNS_GET,
                HELPER_TOOLS.ACTOR_RUNS_LOG,
                HELPER_TOOLS.ACTOR_RUNS_ABORT,
                HELPER_TOOLS.DATASET_GET,
                HELPER_TOOLS.DATASET_GET_ITEMS,
                HELPER_TOOLS.DATASET_SCHEMA_GET,
                HELPER_TOOLS.KEY_VALUE_STORE_GET,
                HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET,
                HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
            ];
            const freeToolNames = [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.DOCS_SEARCH];

            const client = await ctx.createClientFn({ payment: 'x402', tools: [...paidToolNames, ...freeToolNames] });
            try {
                const toolsList = await client.listTools();

                // Positive: paid tools advertise _meta.x402 with both shapes —
                // flat preferred-scheme fields (back-compat) and the full accepts[] array.
                for (const toolName of paidToolNames) {
                    const tool = toolsList.tools.find((t) => t.name === toolName);
                    expect(tool, `Tool "${toolName}" should exist in the tools list`).toBeDefined();

                    const x402 = tool?._meta?.x402 as Record<string, unknown> | undefined;
                    expect(x402, `Tool "${toolName}" should advertise _meta.x402`).toBeDefined();
                    expect(x402?.paymentRequired, `Tool "${toolName}" x402.paymentRequired should be true`).toBe(true);

                    for (const field of ['scheme', 'network', 'asset', 'payTo', 'amount'] as const) {
                        expect(x402?.[field], `Tool "${toolName}" should advertise x402.${field}`).toBeDefined();
                    }

                    const accepts = x402?.accepts as Record<string, unknown>[] | undefined;
                    expect(accepts, `Tool "${toolName}" should advertise x402.accepts[]`).toBeInstanceOf(Array);
                    expect(
                        accepts?.length,
                        `Tool "${toolName}" should advertise at least one accept entry`,
                    ).toBeGreaterThan(0);
                    for (const entry of accepts ?? []) {
                        expect(entry.scheme, `Tool "${toolName}" accepts entry should have a scheme`).toBeTypeOf(
                            'string',
                        );
                    }
                }

                // Negative: free tools must not advertise _meta.x402.
                for (const toolName of freeToolNames) {
                    const tool = toolsList.tools.find((t) => t.name === toolName);
                    expect(tool, `Tool "${toolName}" should exist in the tools list`).toBeDefined();
                    const meta = tool?._meta as Record<string, unknown> | undefined;
                    expect(meta?.x402, `Tool "${toolName}" should not advertise _meta.x402`).toBeUndefined();
                }
            } finally {
                await client.close();
            }
        },
    },
    {
        // Standby MCP Actor sub-tools load in normal mode, drop in payment mode.
        name: 'should filter standby MCP-server Actor from list-tools in payment mode',
        isDeploymentTest: false,
        skipIf: notStdio,
        run: async (ctx) => {
            const isProxiedAddTool = (name: string) => name.endsWith('-add');
            let client = await ctx.createClientFn({ payment: 'x402', actors: [ACTOR_EXAMPLE_MCP_SERVER] });
            try {
                const x402Tools = await client.listTools();
                expect(
                    x402Tools.tools.filter((t) => isProxiedAddTool(t.name)),
                    'standby MCP-server sub-tools should not be loaded in x402 payment mode',
                ).toHaveLength(0);
                await client.close();

                client = await ctx.createClientFn({ payment: 'skyfire', actors: [ACTOR_EXAMPLE_MCP_SERVER] });
                const skyfireTools = await client.listTools();
                expect(
                    skyfireTools.tools.filter((t) => isProxiedAddTool(t.name)),
                    'standby MCP-server sub-tools should not be loaded in skyfire payment mode',
                ).toHaveLength(0);
                await client.close();

                // Outside payment mode, sub-tools must still load.
                client = await ctx.createClientFn({ actors: [ACTOR_EXAMPLE_MCP_SERVER] });
                const normalTools = await client.listTools();
                expect(
                    normalTools.tools.filter((t) => isProxiedAddTool(t.name)),
                    'standby MCP-server sub-tools should be loaded under standard token auth',
                ).not.toHaveLength(0);
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should return error when calling a standby Actor via call-actor in x402 payment mode',
        isDeploymentTest: false,
        skipIf: notStdio,
        run: async (ctx) => {
            const client = await ctx.createClientFn({ payment: 'x402' });
            try {
                const result = await client.callTool({
                    name: 'call-actor',
                    arguments: { actor: ACTOR_EXAMPLE_MCP_SERVER, input: {} },
                });
                expect(result).toBeDefined();
                expect(result.isError).toBe(true);
                const content = result.content as { text: string }[];
                expect(content.length).toBeGreaterThan(0);
                expect(content[0].text).toContain('is not supported in agentic payment mode');
            } finally {
                await client.close();
            }
        },
    },
    {
        // Regression #893: task-mode call-actor must hit the same standby guard (legacy HTTP only).
        name: 'should reject standby Actor in task-mode call-actor under x402 (not 402, not platform error)',
        isDeploymentTest: false,
        skipIf: (ctx) => ctx.transport !== '2025-11-25',
        run: async (ctx) => {
            const client = await ctx.createClientFn({ payment: 'x402' });
            try {
                const stream = asLegacyClient(client).experimental.tasks.callToolStream(
                    { name: 'call-actor', arguments: { actor: ACTOR_EXAMPLE_MCP_SERVER, input: {} } },
                    CallToolResultSchema,
                    { task: { ttl: 60000 } },
                );

                let taskCreated = false;
                let resultText: string | undefined;
                let resultIsError: boolean | undefined;
                for await (const message of stream) {
                    if (message.type === 'taskCreated') {
                        taskCreated = true;
                    } else if (message.type === 'result') {
                        resultIsError = message.result.isError as boolean | undefined;
                        const content = message.result.content as { text: string }[];
                        resultText = content[0]?.text;
                    } else if (message.type === 'error') {
                        throw message.error;
                    }
                }

                // Must create a task, not short-circuit with a sync error.
                expect(
                    taskCreated,
                    'server should create a task even when the eventual result is a standby rejection',
                ).toBe(true);
                expect(resultIsError, 'task result should be flagged as error').toBe(true);
                expect(resultText, 'task result should expose the standby rejection text').toBeDefined();
                expect(resultText).toContain('is not supported in agentic payment mode');
                expect(resultText).not.toContain('x402');
            } finally {
                await client.close();
            }
        },
    },
    {
        // isDeploymentTest: paid tool rejects free access.
        name: 'should return x402 payment error when calling paymentRequired tool without payment signature',
        isDeploymentTest: true,
        skipIf: notStdio,
        run: async (ctx) => {
            const client = await ctx.createClientFn({ tools: ['actors'], payment: 'x402' });
            try {
                const result = await client.callTool({
                    name: HELPER_TOOLS.ACTOR_CALL,
                    arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 } },
                });

                expect(result.isError).toBe(true);
                const content = result.content as { text: string }[];
                expect(content[0].text).toContain('x402');

                // 402 results must expose PaymentRequired via structuredContent.
                const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
                expect(structured, 'x402 402 tool result should expose structuredContent').toBeDefined();
                expect(structured?.x402Version, 'structuredContent.x402Version should be set').toBeDefined();
                expect(structured?.accepts, 'structuredContent.accepts should be an array').toBeInstanceOf(Array);
            } finally {
                await client.close();
            }
        },
    },
];
