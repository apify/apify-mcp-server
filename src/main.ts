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
import type { AuthInfo, Input } from './types.js';

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';

await Actor.init();

const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL as string : 'http://localhost';
const PORT = Actor.isAtHome() ? Number(process.env.ACTOR_STANDBY_PORT) : 3001;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

const authInfo: AuthInfo = {
    value: process.env.APIFY_TOKEN,
    type: 'apify',
};

const input = processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.info('Loaded input', { input: JSON.stringify(input) });

if (STANDBY_MODE) {
    // In standby mode, actors and tools are provided via URL query params per request
    // Start express app
    const app = createExpressApp(HOST);
    log.info('Actor is running in the STANDBY mode.');

    app.listen(PORT, () => {
        log.info('Actor web server listening', { host: HOST, port: PORT });
    });
} else {
    log.info('Actor is not designed to run in the NORMAL model (use this mode only for debugging purposes)');

    if (input && !input.debugActor && !input.debugActorInput) {
        await Actor.fail('If you need to debug a specific Actor, please provide the debugActor and debugActorInput fields in the input');
    }
    const options = { memory: input.maxActorMemoryBytes } as ActorCallOptions;
    const { items } = await callActorGetDataset(input.debugActor!, input.debugActorInput!, authInfo, options);

    await Actor.pushData(items);
    log.info('Pushed items to dataset', { itemCount: items.count });
    await Actor.exit();
}

// So Ctrl+C works locally
process.on('SIGINT', async () => {
    log.info('Received SIGINT, shutting down gracefully...');
    await Actor.exit();
});
