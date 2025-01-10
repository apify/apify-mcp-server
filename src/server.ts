#!/usr/bin/env node
/**
 * Model Context Protocol (MCP) server for Apify Actors
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Actor } from 'apify';
import { ApifyClient } from 'apify-client';

import { getActorsAsTools } from './actorDefinition.js';
import { defaults, SERVER_NAME, SERVER_VERSION } from './const.js';
import { log } from './logger.js';
import type { Tool } from './types';

/**
 * Create Apify MCP server
 */
export class ApifyMcpServer {
    private server: Server;
    private tools: Map<string, Tool>;

    constructor() {
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
        this.tools = new Map();
        this.setupErrorHandling();
        this.setupToolHandlers();
    }

    /**
     * Calls an Apify actor and retrieves the dataset items.
     *
     * It requires the `APIFY_API_TOKEN` environment variable to be set.
     * If the `APIFY_IS_AT_HOME` the dataset items are pushed to the Apify dataset.
     *
     * @param {string} actorName - The name of the actor to call.
     * @param {unknown} input - The input to pass to the actor.
     * @returns {Promise<object[]>} - A promise that resolves to an array of dataset items.
     * @throws {Error} - Throws an error if the `APIFY_API_TOKEN` is not set
     */
    public async callActorGetDataset(actorName: string, input: unknown): Promise<object[]> {
        if (!process.env.APIFY_API_TOKEN) {
            throw new Error('APIFY_API_TOKEN is required but not set. Please set it as an environment variable');
        }
        const name = actorName.replace('_', '/');
        try {
            log.info(`Calling actor ${name} with input: ${JSON.stringify(input)}`);
            const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
            const actorClient = client.actor(name);

            const results = await actorClient.call(input);
            const dataset = await client.dataset(results.defaultDatasetId).listItems();
            log.info(`Actor ${name} finished with ${dataset.items.length} items`);

            if (process.env.APIFY_IS_AT_HOME) {
                await Actor.pushData(dataset.items);
                log.info(`Pushed ${dataset.items.length} items to the dataset`);
            }
            return dataset.items;
        } catch (error) {
            log.error(`Error calling actor: ${error}. Actor: ${name}, input: ${JSON.stringify(input)}`);
            throw new Error(`Error calling actor: ${error}`);
        }
    }

    public async addToolsFromActors(actors: string[]) {
        const tools = await getActorsAsTools(actors);
        this.updateTools(tools);
    }

    public async addToolsFromDefaultActors() {
        await this.addToolsFromActors(defaults.actors);
    }

    public updateTools(tools: Tool[]): void {
        for (const tool of tools) {
            this.tools.set(tool.name, tool);
            log.info(`Added/Updated tool: ${tool.name}`);
        }
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

    private setupToolHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return { tools: this.tools.values() };
        });

        /**
         * Handles the request to call a tool.
         * @param {object} request - The request object containing tool name and arguments.
         * @throws {Error} - Throws an error if the tool is unknown or arguments are invalid.
         */
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            const tool = this.tools.get(name);
            if (!tool) {
                throw new Error(`Unknown tool: ${name}`);
            }

            log.info(`Validate arguments for tool: ${name} with arguments: ${JSON.stringify(args)}`);
            if (!tool.ajvValidate(args)) {
                throw new Error(`Invalid arguments for tool ${name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(tool?.ajvValidate.errors)}`);
            }

            try {
                const items = await this.callActorGetDataset(name, args);
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
