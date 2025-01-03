#!/usr/bin/env node

/**
 * Model Context Protocol (MCP) server for RAG Web Browser Actor
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';
import { log } from 'apify';
import { ApifyClient } from 'apify-client';
import dotenv from 'dotenv';

import { SERVER_NAME, SERVER_VERSION } from './const.js';

dotenv.config({ path: '../.env' });

const argToken = process.argv.find((arg) => arg.startsWith('APIFY_API_TOKEN='))?.split('=')[1];
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || argToken;

export async function callActorGetDataset(actorName: string, input: unknown): Promise<object[]> {
    if (!APIFY_API_TOKEN) {
        throw new Error('APIFY_API_TOKEN is required but not set. '
            + 'Please set it in your environment variables or pass it as a command-line argument.');
    }
    try {
        log.info(`Calling actor ${actorName} with input: ${JSON.stringify(input)}`);
        const client = new ApifyClient({ token: APIFY_API_TOKEN });
        const actorClient = client.actor(actorName);

        const results = await actorClient.call(input);
        const dataset = await client.dataset(results.defaultDatasetId).listItems();
        return dataset.items;
    } catch (error) {
        log.error(`Error calling actor: ${error}. Actor: ${actorName}, input: ${JSON.stringify(input)}`);
        throw new Error(`Error calling actor: ${error}`);
    }
}

/**
 * Create an MCP server with a tool to call RAG Web Browser Actor
 */
export class ApifyMcpServer {
    private server: Server;
    private readonly tools: { name: string; description: string; inputSchema: object, ajvValidate: ValidateFunction}[];
    private readonly availableTools: string[];

    constructor(tools: { name: string; description: string; inputSchema: object, ajvValidate: ValidateFunction}[]) {
        this.server = new Server(
            {
                name: SERVER_NAME,
                version: SERVER_VERSION,
            },
            {
                capabilities: {
                    tools: {},
                },
            },
        );
        this.tools = tools;
        this.availableTools = tools.map((tool) => tool.name);
        this.setupErrorHandling();
        this.setupToolHandlers();
    }

    private setupErrorHandling(): void {
        this.server.onerror = (error) => {
            console.error('[MCP Error]', error); // eslint-disable-line no-console
        };
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }

    private validateArguments(name: string, args: unknown): unknown {
        const tool = this.tools.find((x) => x.name === name);
        if (!tool?.ajvValidate(args)) {
            throw new Error(`Invalid arguments for tool ${name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(tool?.ajvValidate.errors)}`);
        }
        return args;
    }

    private setupToolHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: this.tools,
            };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            if (!this.availableTools.includes(name)) {
                throw new Error(`Unknown tool: ${name}`);
            }
            try {
                log.info(`Validating arguments for tool: ${name} with arguments: ${JSON.stringify(args)}`);
                const validatedArgs = this.validateArguments(name, args);
                const items = await callActorGetDataset(name, validatedArgs);
                return { content: items.map((item) => ({ type: 'text', text: JSON.stringify(item) })) };
            } catch (error) {
                log.error(`Error calling tool: ${error}`);
                throw new Error(`Error calling tool: ${error}`);
            }
        });
    }

    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }
}
