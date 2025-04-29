import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

async function createMCPClient(
    options?: {
        actors: string[];
        enableAddingActors: boolean;
    },
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

describe('MCP STDIO', () => {
    let client: Client;
    beforeEach(async () => {
        client = await createMCPClient();
    });

    afterEach(async () => {
        await client.close();
    });

    it('list default tools', async () => {
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);

        expect(names.length).toEqual(5);
        expect(names).toContain('search-actors');
        expect(names).toContain('get-actor-details');
        expect(names).toContain('apify-slash-rag-web-browser');
        expect(names).toContain('apify-slash-instagram-scraper');
        expect(names).toContain('lukaskrivka-slash-google-maps-with-contact-details');
    });
});
