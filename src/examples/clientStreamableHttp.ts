import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolRequest, ListToolsRequest } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolResultSchema,
    ListToolsResultSchema,
    LoggingMessageNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import { HelperTools } from '../const.js';

log.setLevel(log.LEVELS.DEBUG);

async function main(): Promise<void> {
    // Create a new client with streamable HTTP transport
    const client = new Client({
        name: 'example-client',
        version: '1.0.0',
    });

    const transport = new StreamableHTTPClientTransport(
        new URL('http://localhost:3000/mcp'),
    );

    // Connect the client using the transport and initialize the server
    await client.connect(transport);
    log.debug('Connected to MCP server');

    // Set up notification handlers for server-initiated messages
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        log.debug('Notification received', { level: notification.params.level, data: notification.params.data });
    });

    // List and call tools
    await listTools(client);

    await callSearchTool(client);
    await callActor(client);

    // Keep the connection open to receive notifications
    log.debug('\nKeeping connection open to receive notifications. Press Ctrl+C to exit.');
}

async function listTools(client: Client): Promise<void> {
    try {
        const toolsRequest: ListToolsRequest = {
            method: 'tools/list',
            params: {},
        };
        const toolsResult = await client.request(toolsRequest, ListToolsResultSchema);
        log.debug('Tools available', { count: toolsResult.tools.length });
        for (const tool of toolsResult.tools) {
            log.debug('Tool detail', { name: tool.name, description: tool.description });
        }
        if (toolsResult.tools.length === 0) {
            log.debug('No tools available from the server');
        }
    } catch (error) {
        log.error('Tools not supported by this server', { error });
    }
}

async function callSearchTool(client: Client): Promise<void> {
    try {
        const searchRequest: CallToolRequest = {
            method: 'tools/call',
            params: {
                name: HelperTools.STORE_SEARCH,
                arguments: { search: 'rag web browser', limit: 1 },
            },
        };
        const searchResult = await client.request(searchRequest, CallToolResultSchema);
        log.debug('Search result:');
        const resultContent = searchResult.content || [];
        resultContent.forEach((item) => {
            if (item.type === 'text') {
                log.debug('Search result item', { text: item.text });
            }
        });
    } catch (error) {
        log.error('Error calling greet tool', { error });
    }
}

async function callActor(client: Client): Promise<void> {
    try {
        log.debug('\nCalling Actor...');
        const actorRequest: CallToolRequest = {
            method: 'tools/call',
            params: {
                name: 'apify/rag-web-browser',
                arguments: { query: 'apify mcp server' },
            },
        };
        const actorResult = await client.request(actorRequest, CallToolResultSchema);
        log.debug('Actor results:');
        const resultContent = actorResult.content || [];
        resultContent.forEach((item) => {
            if (item.type === 'text') {
                log.debug('Actor result item', { text: item.text });
            }
        });
    } catch (error) {
        log.error('Error calling Actor', { error });
    }
}

main().catch((error: unknown) => {
    log.error('Error running MCP client', { error: error as Error });
    process.exit(1);
});
