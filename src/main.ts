/**
 * Serves as an Actor MCP SSE server entry point.
 * This file needs to be named `main.ts` to be recognized by the Apify platform.
 */

import { Actor } from 'apify';
import type { ActorCallOptions } from 'apify-client';
import { z } from 'zod';

import log from '@apify/log';

import { createExpressApp } from './actor/server.js';
import { callActorGetDataset } from './tools/index.js';

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';

await Actor.init();

const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL as string : 'http://localhost';
const PORT = Actor.isAtHome() ? Number(process.env.ACTOR_STANDBY_PORT) : 3001;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

if (STANDBY_MODE) {
    const app = createExpressApp(HOST);
    log.info('Actor is running in the STANDBY mode.');

    app.listen(PORT, () => {
        log.info('Actor web server listening', { host: HOST, port: PORT });
    });
} else {
    log.info('Actor is not designed to run in the NORMAL model (use this mode only for debugging purposes)');

    const inputSchema = z.object({
        maxActorMemoryBytes: z.number().int().min(0).max(4096),
        debugActor: z.string(),
        debugActorInput: z.record(z.string(), z.unknown()),
    });
    const input = inputSchema.parse(await Actor.getInput());

    log.info(`Loaded input: ${JSON.stringify(input)} `);

    const options = { memory: input.maxActorMemoryBytes } as ActorCallOptions;
    const { items } = await callActorGetDataset(input.debugActor, input.debugActorInput, process.env.APIFY_TOKEN, options);

    await Actor.pushData(items);
    log.info('Pushed items to dataset', { itemCount: items.count });
    await Actor.exit();
}

// So Ctrl+C works locally
process.on('SIGINT', async () => {
    log.info('Received SIGINT, shutting down gracefully...');
    await Actor.exit();
});
