/**
 * This file serves as an Actor MCP SSE server entry point.
 */

import { Actor } from 'apify';
import type { ActorCallOptions } from 'apify-client';

import { callActorGetDataset } from './actors/call.js';
import { processInput } from './input.js';
import { log } from './logger.js';
import { ApifyMcpServer } from './mcp-server.js';
import { createExpressApp } from './server.js';
import { getActorAutoLoadingTools, getActorDiscoveryTools } from './tools/index.js';
import type { Input } from './types.js';
import { getActorRunData, isActorStandby } from './utils.js';

await Actor.init();

const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL as string : 'http://localhost';
const PORT = Actor.isAtHome() ? Number(process.env.ACTOR_STANDBY_PORT) : 3001;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

const mcpServer = new ApifyMcpServer();

const input = processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.info(`Loaded input: ${JSON.stringify(input)} `);

if (isActorStandby()) {
    const app = createExpressApp(HOST, mcpServer, getActorRunData() || {});
    log.info('Actor is running in the STANDBY mode.');
    await mcpServer.addToolsFromDefaultActors();
    mcpServer.updateTools(getActorDiscoveryTools());
    if (input.enableActorAutoLoading) {
        mcpServer.updateTools(getActorAutoLoadingTools());
    }
    app.listen(PORT, () => {
        log.info(`The Actor web server is listening for user requests at ${HOST}`);
    });
} else {
    log.info('Actor is not designed to run in the NORMAL model (use this mode only for debugging purposes)');

    if (input && !input.debugActor && !input.debugActorInput) {
        await Actor.fail('If you need to debug a specific Actor, please provide the debugActor and debugActorInput fields in the input');
    }
    const options = { memory: input.maxActorMemoryBytes } as ActorCallOptions;
    await callActorGetDataset(input.debugActor!, input.debugActorInput!, process.env.APIFY_TOKEN, options);
    await Actor.exit();
}
