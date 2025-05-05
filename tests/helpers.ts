import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function createMCPSSEClient(
    serverUrl: string,
    options?: {
        actors?: string[];
        enableAddingActors?: boolean;
    },
): Promise<Client> {
    if (!process.env.APIFY_TOKEN) {
        throw new Error('APIFY_TOKEN environment variable is not set.');
    }
    const url = new URL(serverUrl);
    const { actors, enableAddingActors } = options || {};
    if (actors) {
        url.searchParams.append('actors', actors.join(','));
    }
    if (enableAddingActors) {
        url.searchParams.append('enableAddingActors', 'true');
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

export async function createMCPStreamableClient(
    serverUrl: string,
    options?: {
        actors?: string[];
        enableAddingActors?: boolean;
    },
): Promise<Client> {
    if (!process.env.APIFY_TOKEN) {
        throw new Error('APIFY_TOKEN environment variable is not set.');
    }
    const url = new URL(serverUrl);
    const { actors, enableAddingActors } = options || {};
    if (actors) {
        url.searchParams.append('actors', actors.join(','));
    }
    if (enableAddingActors) {
        url.searchParams.append('enableAddingActors', 'true');
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

export async function createMCPStdioClient(
    options?: {
        actors?: string[];
        enableAddingActors?: boolean;
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
