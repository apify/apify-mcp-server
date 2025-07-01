/**
 * Serves as an Actor MCP SSE server entry point.
 * This file needs to be named `main.ts` to be recognized by the Apify platform.
 */

import { Actor } from 'apify';
import type { ActorCallOptions } from 'apify-client';

import log from '@apify/log';

import { createExpressApp } from './actor/server.js';
import { processInput } from './input.js';
import { callActorGetDataset } from './tools/index.js';
import type { Input } from './types.js';

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';

await Actor.init();

const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL as string : 'http://localhost';
const PORT = Actor.isAtHome() ? Number(process.env.ACTOR_STANDBY_PORT) : 3001;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

const input = processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.info(`Loaded input: ${JSON.stringify(input)} `);

if (STANDBY_MODE) {
    let actorsToLoad: string[] = [];
    // TODO: in standby mode the input loading does not actually work,
    // we should remove this since we are using the URL query parameters to load Actors
    // Load only Actors specified in the input
    // If you wish to start without any Actor, create a task and leave the input empty
    if (input.actors && input.actors.length > 0) {
        const { actors } = input;
        actorsToLoad = Array.isArray(actors) ? actors : actors.split(',');
    }
    // Include Actors to load in the MCP server options for backwards compatibility
    const app = createExpressApp(HOST, {
        enableAddingActors: Boolean(input.enableAddingActors),
        enableDefaultActors: false,
        actors: actorsToLoad,
    });
    log.info('Actor is running in the STANDBY mode.');

    app.listen(PORT, () => {
        log.info(`The Actor web server is listening for user requests at ${HOST}`);
    });
} else {
    log.info('Actor is not designed to run in the NORMAL model (use this mode only for debugging purposes)');

    if (input && !input.debugActor && !input.debugActorInput) {
        await Actor.fail('If you need to debug a specific Actor, please provide the debugActor and debugActorInput fields in the input');
    }
    const options = { memory: input.maxActorMemoryBytes } as ActorCallOptions;
    const { datasetInfo, items } = await callActorGetDataset(input.debugActor!, input.debugActorInput!, process.env.APIFY_TOKEN, options);

    await Actor.pushData(items);
    log.info(`Pushed ${datasetInfo?.itemCount} items to the dataset`);
    await Actor.exit();
}

// So Ctrl+C works locally
process.on('SIGINT', async () => {
    log.info('Received SIGINT, shutting down gracefully...');
    await Actor.exit();
});
