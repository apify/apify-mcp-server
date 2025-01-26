#!/usr/bin/env node
/**
 * Model Context Protocol (MCP) server for Apify Actors
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ApifyClientOptions } from 'apify';
import { Actor } from 'apify';
import type { ActorCallOptions } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { AxiosRequestConfig } from 'axios';

import { filterSchemaProperties, getActorDefinition, getActorsAsTools, shortenProperties } from './actorDefinition.js';
import {
    ACTOR_OUTPUT_MAX_CHARS_PER_ITEM,
    ACTOR_OUTPUT_TRUNCATED_MESSAGE,
    defaults,
    InternalTools,
    SERVER_NAME,
    SERVER_VERSION,
    USER_AGENT_ORIGIN,
} from './const.js';
import {
    RemoveActorToolArgsSchema,
    AddActorToToolsArgsSchema,
    DiscoverActorsArgsSchema,
    searchActorsByKeywords,
    GetActorDefinition,
} from './internalActorTools.js';
import { log } from './logger.js';
import type { SchemaProperties, Tool } from './types.js';

/**
 * Create Apify MCP server
 */
export class ApifyMcpServer {
    private server: Server;
    private tools: Map<string, Tool>;
    private maxMemoryMbytes: number;

    constructor(memoryMbytes: number = defaults.maxMemoryMbytes) {
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
        this.maxMemoryMbytes = memoryMbytes;
        this.setupErrorHandling();
        this.setupToolHandlers();
    }

    /**
     * Adds a User-Agent header to the request config.
     * @param config
     * @private
     */
    private addUserAgent(config: AxiosRequestConfig): AxiosRequestConfig {
        const updatedConfig = { ...config };
        updatedConfig.headers = updatedConfig.headers ?? {};
        updatedConfig.headers['User-Agent'] = `${updatedConfig.headers['User-Agent'] ?? ''}; ${USER_AGENT_ORIGIN}`;
        return updatedConfig;
    }

    /**
     * Calls an Apify actor and retrieves the dataset items.
     *
     * It requires the `APIFY_TOKEN` environment variable to be set.
     * If the `APIFY_IS_AT_HOME` the dataset items are pushed to the Apify dataset.
     *
     * @param {string} actorName - The name of the actor to call.
     * @param {ActorCallOptions} callOptions - The options to pass to the actor.
     * @param {unknown} input - The input to pass to the actor.
     * @returns {Promise<object[]>} - A promise that resolves to an array of dataset items.
     * @throws {Error} - Throws an error if the `APIFY_TOKEN` is not set
     */
    public async callActorGetDataset(
        actorName: string,
        input: unknown,
        callOptions: ActorCallOptions | undefined = undefined,
    ): Promise<object[]> {
        if (!process.env.APIFY_TOKEN) {
            throw new Error('APIFY_TOKEN is required but not set. Please set it as an environment variable');
        }
        const name = actorName.replace('_', '/');
        try {
            log.info(`Calling actor ${name} with input: ${JSON.stringify(input)}`);

            const options: ApifyClientOptions = { requestInterceptors: [this.addUserAgent] };
            const client = new ApifyClient({ ...options, token: process.env.APIFY_TOKEN });
            const actorClient = client.actor(name);

            const results = await actorClient.call(input, callOptions);
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

    public getToolNames(): string[] {
        return Array.from(this.tools.keys());
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
            return { tools: Array.from(this.tools.values()) };
        });

        /**
         * Handles the request to call a tool.
         * @param {object} request - The request object containing tool name and arguments.
         * @throws {Error} - Throws an error if the tool is unknown or arguments are invalid.
         */
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            // Anthropic can't handle '/' in tool names. The replace is only necessary when calling the tool from stdio clients.
            const tool = this.tools.get(name) || this.tools.get(name.replace('/', '_'));
            if (!tool) {
                throw new Error(`Unknown tool: ${name}`);
            }
            if (!args) {
                throw new Error(`Missing arguments for tool: ${name}`);
            }
            log.info(`Validate arguments for tool: ${tool.name} with arguments: ${JSON.stringify(args)}`);
            if (!tool.ajvValidate(args)) {
                throw new Error(`Invalid arguments for tool ${tool.name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(tool?.ajvValidate.errors)}`);
            }

            try {
                switch (name) {
                    case InternalTools.ADD_ACTOR_TO_TOOLS: {
                        const parsed = AddActorToToolsArgsSchema.parse(args);
                        await this.addToolsFromActors([parsed.name.replace('_', '/')]);
                        return { content: [{ type: 'text', text: `Actor ${args.name} was added to tools` }] };
                    }
                    case InternalTools.REMOVE_ACTOR_FROM_TOOLS: {
                        const parsed = RemoveActorToolArgsSchema.parse(args);
                        this.tools.delete(parsed.name.replace('/', '_'));
                        return { content: [{ type: 'text', text: `Actor ${args.name} was removed from tools` }] };
                    }
                    case InternalTools.DISCOVER_ACTORS: {
                        const parsed = DiscoverActorsArgsSchema.parse(args);
                        const actors = await searchActorsByKeywords(
                            parsed.search,
                            parsed.limit,
                            parsed.offset,
                        );
                        return { content: actors?.map((item) => ({ type: 'text', text: JSON.stringify(item) })) };
                    }
                    case InternalTools.GET_ACTOR_DETAILS: {
                        const parsed = GetActorDefinition.parse(args);
                        const v = await getActorDefinition(parsed.name.replace('_', '/'));
                        if (v && v.input && 'properties' in v.input && v.input) {
                            const properties = filterSchemaProperties(v.input.properties as { [key: string]: SchemaProperties });
                            v.input.properties = shortenProperties(properties);
                        }
                        const actorDefinitionShort = { description: v?.description, readme: v?.readme, input: v?.input };
                        return { content: [{ type: 'text', text: JSON.stringify(actorDefinitionShort) }] };
                    }
                    default: {
                        const items = await this.callActorGetDataset(tool.actorName, args, { memory: tool.memoryMbytes } as ActorCallOptions);
                        const content = items.map((item) => {
                            const text = JSON.stringify(item).slice(0, ACTOR_OUTPUT_MAX_CHARS_PER_ITEM);
                            return text.length === ACTOR_OUTPUT_MAX_CHARS_PER_ITEM
                                ? { type: 'text', text: `${text} ... ${ACTOR_OUTPUT_TRUNCATED_MESSAGE}` }
                                : { type: 'text', text };
                        });
                        return { content };
                    }
                }
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
