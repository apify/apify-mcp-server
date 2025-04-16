/**
 * Serves as an Actor MCP SSE server entry point.
 * This file needs to be named `main.ts` to be recognized by the Apify platform.
 */

import { Actor } from 'apify';
import type { ActorCallOptions } from 'apify-client';

import log from '@apify/log';

import { processInput } from './actor/input.js';
import { createExpressApp } from './actor/server.js';
import type { Input } from './actor/types';
import { ActorsMcpServer } from './mcp-server.js';
import {
    actorDefinitionTool,
    addTool,
    callActorGetDataset,
    removeTool,
    searchTool,
} from './tools/index.js';

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';

await Actor.init();

const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL as string : 'http://localhost';
const PORT = Actor.isAtHome() ? Number(process.env.ACTOR_STANDBY_PORT) : 3000;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

const mcpServer = new ActorsMcpServer();

const input = processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.info(`Loaded input: ${JSON.stringify(input)} `);

if (STANDBY_MODE) {
    const app = createExpressApp(HOST, mcpServer);
    log.info('Actor is running in the STANDBY mode.');
    const tools = [searchTool, actorDefinitionTool];
    if (input.enableActorAutoLoading) {
        tools.push(addTool, removeTool);
    }
    mcpServer.updateTools(tools);
    app.listen(PORT, () => {
        log.info(`The Actor web server is listening for user requests at ${HOST}`);
    });
} else {
    log.info('Actor is not designed to run in the NORMAL model (use this mode only for debugging purposes)');

    if (input && !input.debugActor && !input.debugActorInput) {
        await Actor.fail('If you need to debug a specific Actor, please provide the debugActor and debugActorInput fields in the input');
    }
    const options = { memory: input.maxActorMemoryBytes } as ActorCallOptions;
    const items = await callActorGetDataset(input.debugActor!, input.debugActorInput!, process.env.APIFY_TOKEN, options);

    await Actor.pushData(items);
    log.info(`Pushed ${items.length} items to the dataset`);
    await Actor.exit();
}
