#!/usr/bin/env node
/*
 This file provides essential functions and tools for MCP servers, serving as a library.
 The ActorsMcpServer should be the only class exported from the package

 Also, it serves as the main entry point for smithery deployment.
*/
import type { z } from 'zod';

import { ActorsMcpServer } from './mcp/server.js';
import type { Input, ToolCategory } from './types';
import { serverConfigSchemaSmithery as configSchema } from './types.js';
import { loadToolsFromInput } from './utils/tools-loader.js';

// Export the config schema for Smithery. The export must be named configSchema
export { configSchema };

/**
 * Main entrypoint for Smithery deployment do not change signature of this function.
 * @returns
 */
export default function ({ config: _config }: { config: z.infer<typeof configSchema> }) {
    try {
        const apifyToken = _config.apifyToken || process.env.APIFY_TOKEN || '';
        const enableAddingActors = _config.enableAddingActors ?? true;
        const actors = _config.actors || '';
        const actorList = actors ? actors.split(',').map((a: string) => a.trim()) : [];
        const toolCategoryKeys = _config.tools ? _config.tools.split(',').map((t: string) => t.trim()) : [];

        // Validate environment
        if (!apifyToken) {
            // eslint-disable-next-line no-console
            console.warn('APIFY_TOKEN is required but not set in the environment variables or config. Some tools may not work properly.');
        } else {
            process.env.APIFY_TOKEN = apifyToken; // Ensure token is set in the environment
        }

        const server = new ActorsMcpServer({ enableAddingActors, enableDefaultActors: false });

        const input: Input = {
            actors: actorList.length ? actorList : [],
            enableAddingActors,
            tools: toolCategoryKeys as ToolCategory[],
        };

        return {
            async connect(transport: any) {
                const tools = await loadToolsFromInput(input, apifyToken, actorList.length === -1);
                server.upsertTools(tools);
                return await server.server.connect(transport);
            },
        };
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
        throw e;
    }
}
