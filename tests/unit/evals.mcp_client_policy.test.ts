import { describe, expect, it } from 'vitest';

import { McpClient } from '../../evals/workflows/mcp_client.js';
import type { McpTool } from '../../evals/workflows/types.js';

function createConnectedClient(policy: ConstructorParameters<typeof McpClient>[1]): McpClient {
    const client = new McpClient(60, policy);
    Object.assign(client, {
        client: {
            callTool: async () => ({ isError: false, content: [{ type: 'text', text: 'ok' }] }),
        },
    });
    return client;
}

describe('McpClient.callTool()', () => {
    it('rejects a disallowed tool', async () => {
        const client = createConnectedClient({ disallowedTools: ['add-actor'] });
        const result = await client.callTool({ name: 'add-actor', arguments: {} });

        expect(result.success).toBe(false);
        expect(result.policyViolation).toContain('forbids tool');
    });

    it('rejects a call-actor target outside the allowlist', async () => {
        const client = createConnectedClient({ allowedCallActorTargets: ['apify/code-runtime'] });
        const result = await client.callTool({
            name: 'call-actor',
            arguments: { actor: 'apify/instagram-scraper' },
        });

        expect(result.success).toBe(false);
        expect(result.policyViolation).toContain('does not allow');
    });

    it('allows an MCP tool suffix on an allowed Actor target', async () => {
        const client = createConnectedClient({ allowedCallActorTargets: ['apify/code-runtime'] });
        const result = await client.callTool({
            name: 'call-actor',
            arguments: { actor: 'apify/code-runtime:run' },
        });

        expect(result.success).toBe(true);
        expect(result.policyViolation).toBeUndefined();
    });
});

describe('McpClient.getTools()', () => {
    it('hides disallowed tools from the agent', async () => {
        const client = new McpClient(60, { disallowedTools: ['add-actor'] });
        const tools: McpTool[] = [
            { name: 'add-actor', inputSchema: { type: 'object' } },
            { name: 'call-actor', inputSchema: { type: 'object' } },
        ];
        Object.assign(client, { client: { listTools: async () => ({ tools }) } });
        await (client as unknown as { loadTools: () => Promise<void> }).loadTools();

        expect(client.getTools().map((tool) => tool.name)).toEqual(['call-actor']);
    });
});
