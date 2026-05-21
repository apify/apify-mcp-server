/**
 * Regression tests for issue #875 — `getActorsAsTools` must drop standby /
 * MCP-server Actors when an external payment provider is active. Without this
 * filter, an x402/Skyfire session would advertise (e.g.) `apify/rag-web-browser`
 * in tools/list and then fail at call-time with "Agentic payments are not
 * supported for standby Actors".
 *
 * Cache pre-population skips the Apify-API lookup; module mocks stub the MCP
 * server connection so the test stays purely in-memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { actorDefinitionPrunedCache } from '../../src/state.js';
import { getActorsAsTools } from '../../src/tools/core/actor_tools_factory.js';
import type {
    ActorDefinitionPruned,
    ActorDefinitionWithInfo,
    ToolEntry,
} from '../../src/types.js';
import type { PaymentProvider } from '../../src/payments/types.js';

// ---------------------------------------------------------------------------
// Module mocks — MCP-server-actor path would otherwise dial the network.
//
// `vi.mock` factories are hoisted above local `const` declarations, so the
// sentinel name shared with the mock factory must come from `vi.hoisted`.
// ---------------------------------------------------------------------------

const { MCP_SERVER_SENTINEL_TOOL_NAME } = vi.hoisted(() => ({
    MCP_SERVER_SENTINEL_TOOL_NAME: 'mcp-server-sentinel-tool',
}));

vi.mock('../../src/mcp/client.js', () => ({
    // A truthy non-null value is enough — getMCPServerTools is mocked too.
    connectMCPClient: vi.fn().mockResolvedValue({
        close: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('../../src/mcp/proxy.js', () => ({
    // Produces one sentinel tool per MCP-server Actor so the test can detect
    // whether the MCP-server path ran at all.
    getMCPServerTools: vi.fn().mockResolvedValue([
        {
            type: 'actor',
            name: MCP_SERVER_SENTINEL_TOOL_NAME,
            actorId: 'mcp-server-actor-id',
            actorFullName: 'mcp-org/mcp-actor',
            description: 'sentinel',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: undefined,
            ajvValidate: (() => true) as never,
            paymentRequired: true,
        } satisfies Partial<ToolEntry> as unknown as ToolEntry,
    ]),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NORMAL_ACTOR_NAME = 'normal-org/normal-actor';
const MCP_ACTOR_NAME = 'mcp-org/mcp-actor';

function normalActorFixture(): ActorDefinitionWithInfo {
    return {
        definition: {
            id: 'normal-actor-id',
            actorFullName: NORMAL_ACTOR_NAME,
            description: 'A normal Actor',
            input: { type: 'object', properties: {} },
            defaultRunOptions: { build: 'latest', memoryMbytes: 1024, timeoutSecs: 60 },
        } as unknown as ActorDefinitionPruned,
        info: { actorStandby: { isEnabled: false } } as never,
    };
}

function mcpServerActorFixture(): ActorDefinitionWithInfo {
    return {
        definition: {
            id: 'mcp-server-actor-id',
            actorFullName: MCP_ACTOR_NAME,
            description: 'An MCP server Actor',
            input: { type: 'object', properties: {} },
            defaultRunOptions: { build: 'latest', memoryMbytes: 1024, timeoutSecs: 60 },
            webServerMcpPath: '/mcp',
        } as unknown as ActorDefinitionPruned,
        info: { actorStandby: { isEnabled: true } } as never,
    };
}

function fakePaymentProvider(): PaymentProvider {
    return {
        id: 'x402',
        decorateToolSchema: (t) => t,
        validatePayment: () => null,
        getPaymentHeaders: () => ({}),
        removePaymentFields: (a) => a,
        allowsUnauthenticated: true,
    } as unknown as PaymentProvider;
}

// `apifyClient.token` must be truthy for the MCP-server path to attempt
// connecting (otherwise `getMCPServersAsTools` short-circuits to []).
const apifyClient = { token: 'test-token' } as unknown as ApifyClient;

// `TTLLRUCache.set` overwrites in place, so repeated seeding across tests is
// idempotent — no `clear()` needed (the cache class doesn't expose one).
beforeEach(() => {
    actorDefinitionPrunedCache.set(NORMAL_ACTOR_NAME, normalActorFixture());
    actorDefinitionPrunedCache.set(MCP_ACTOR_NAME, mcpServerActorFixture());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getActorsAsTools — payment-provider filter', () => {
    it('includes MCP-server Actors when no paymentProvider is configured', async () => {
        const tools = await getActorsAsTools([NORMAL_ACTOR_NAME, MCP_ACTOR_NAME], apifyClient);

        const toolNames = tools.map((t) => t.name);
        expect(toolNames).toContain(MCP_SERVER_SENTINEL_TOOL_NAME);
        expect(toolNames.length).toBeGreaterThanOrEqual(2);
    });

    it('drops MCP-server Actors when a paymentProvider is configured', async () => {
        const tools = await getActorsAsTools([NORMAL_ACTOR_NAME, MCP_ACTOR_NAME], apifyClient, {
            paymentProvider: fakePaymentProvider(),
        });

        const toolNames = tools.map((t) => t.name);
        expect(toolNames).not.toContain(MCP_SERVER_SENTINEL_TOOL_NAME);
    });

    it('still exposes normal (non-standby) Actors under a paymentProvider', async () => {
        const tools = await getActorsAsTools([NORMAL_ACTOR_NAME, MCP_ACTOR_NAME], apifyClient, {
            paymentProvider: fakePaymentProvider(),
        });

        const normalTool = tools.find((t) => t.actorFullName === NORMAL_ACTOR_NAME);
        expect(normalTool, 'normal Actor must still load under a paymentProvider').toBeDefined();
    });
});
