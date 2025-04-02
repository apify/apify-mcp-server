/*
This file serves as an Actor MCP SSE server entry point.
*/

import { Actor } from 'apify';
import type { ActorCallOptions } from 'apify-client';

import { processInput } from './input.js';
import { log } from './logger.js';
import { ApifyMcpServer } from './mcp-server.js';
import { createServerApp } from './server.js';
import { getActorDiscoveryTools, getActorAutoLoadingTools } from './tools.js';
import type { Input } from './types.js';
import { isActorStandby } from './utils.js';

await Actor.init();

const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL as string : 'http://localhost';
const PORT = Actor.isAtHome() ? Number(process.env.ACTOR_STANDBY_PORT) : 3001;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

const mcpServer = new ApifyMcpServer();

const actorRunData = Actor.isAtHome() ? {
    id: process.env.ACTOR_RUN_ID,
    actId: process.env.ACTOR_ID,
    userId: process.env.APIFY_USER_ID,
    startedAt: process.env.ACTOR_STARTED_AT,
    finishedAt: null,
    status: 'RUNNING',
    meta: {
        origin: process.env.APIFY_META_ORIGIN,
    },
    options: {
        build: process.env.ACTOR_BUILD_NUMBER,
        memoryMbytes: process.env.ACTOR_MEMORY_MBYTES,
    },
    buildId: process.env.ACTOR_BUILD_ID,
    defaultKeyValueStoreId: process.env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID,
    defaultDatasetId: process.env.ACTOR_DEFAULT_DATASET_ID,
    defaultRequestQueueId: process.env.ACTOR_DEFAULT_REQUEST_QUEUE_ID,
    buildNumber: process.env.ACTOR_BUILD_NUMBER,
    containerUrl: process.env.ACTOR_WEB_SERVER_URL,
    standbyUrl: process.env.ACTOR_STANDBY_URL,
} : {};

const input = await processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.info(`Loaded input: ${JSON.stringify(input)} `);

if (isActorStandby()) {
    const app = createServerApp(HOST, mcpServer, actorRunData);
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
        await Actor.fail('If you need to debug a specific actor, please provide the debugActor and debugActorInput fields in the input');
    }
    const options = { memory: input.maxActorMemoryBytes } as ActorCallOptions;
    await mcpServer.callActorGetDataset(input.debugActor!, input.debugActorInput!, options);
    await Actor.exit();
}
