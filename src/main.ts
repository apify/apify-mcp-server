import type { ParsedUrlQuery } from 'querystring';
import { parse } from 'querystring';

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Actor } from 'apify';
import type { ActorCallOptions } from 'apify-client';
import type { Request, Response } from 'express';
import express from 'express';

import { HEADER_READINESS_PROBE, Routes } from './const.js';
import { processInput } from './input.js';
import { log } from './logger.js';
import { ApifyMcpServer } from './server.js';
import { getActorDiscoveryTools, getActorAutoLoadingTools } from './tools.js';
import type { Input } from './types.js';

await Actor.init();

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';
const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL : 'http://localhost';
const PORT = Actor.isAtHome() ? process.env.ACTOR_STANDBY_PORT : 3001;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

const app = express();

const mcpServer = new ApifyMcpServer();
let transport: SSEServerTransport;

const HELP_MESSAGE = `Connect to the server with GET request to ${HOST}/sse?token=YOUR-APIFY-TOKEN`
    + ` and then send POST requests to ${HOST}/message?token=YOUR-APIFY-TOKEN`;

const actorRun = Actor.isAtHome() ? {
    data: {
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
    },
} : {};

/**
 * Process input parameters and update tools
 * If URL contains query parameter actors, add tools from actors, otherwise add tools from default actors
 * @param url
 */
async function processParamsAndUpdateTools(url: string) {
    const params = parse(url.split('?')[1] || '') as ParsedUrlQuery;
    delete params.token;
    log.debug(`Received input parameters: ${JSON.stringify(params)}`);
    const input = await processInput(params as unknown as Input);
    if (input.actors) {
        await mcpServer.addToolsFromActors(input.actors as string[]);
    }
    if (input.enableActorAutoLoading) {
        mcpServer.updateTools(getActorAutoLoadingTools());
    }
    log.debug(`Server is running in STANDBY mode with the following Actors (tools): ${mcpServer.getToolNames()}.
    To use different Actors, provide them in query parameter "actors" or include them in the Actor Task input.`);
}

app.route(Routes.ROOT)
    .get(async (req: Request, res: Response) => {
        if (req.headers && req.get(HEADER_READINESS_PROBE) !== undefined) {
            log.debug('Received readiness probe');
            res.status(200).json({ message: 'Server is ready' }).end();
            return;
        }
        try {
            log.info(`Received GET message at: ${Routes.ROOT}`);
            await processParamsAndUpdateTools(req.url);
            res.status(200).json({ message: `Actor is using Model Context Protocol. ${HELP_MESSAGE}`, data: actorRun }).end();
        } catch (error) {
            log.error(`Error in GET ${Routes.ROOT} ${error}`);
            res.status(500).json({ message: 'Internal Server Error' }).end();
        }
    })
    .head((_req: Request, res: Response) => {
        res.status(200).end();
    });

app.route(Routes.SSE)
    .get(async (req: Request, res: Response) => {
        try {
            log.info(`Received GET message at: ${Routes.SSE}`);
            await processParamsAndUpdateTools(req.url);
            transport = new SSEServerTransport(Routes.MESSAGE, res);
            await mcpServer.connect(transport);
        } catch (error) {
            log.error(`Error in GET ${Routes.SSE}: ${error}`);
            res.status(500).json({ message: 'Internal Server Error' }).end();
        }
    });

app.route(Routes.MESSAGE)
    .post(async (req: Request, res: Response) => {
        try {
            log.info(`Received POST message at: ${Routes.MESSAGE}`);
            if (transport) {
                await transport.handlePostMessage(req, res);
            } else {
                res.status(400).json({
                    message: 'Server is not connected to the client. '
                        + 'Connect to the server with GET request to /sse endpoint',
                });
            }
        } catch (error) {
            log.error(`Error in POST ${Routes.MESSAGE}: ${error}`);
            res.status(500).json({ message: 'Internal Server Error' }).end();
        }
    });

// Catch-all for undefined routes
app.use((req: Request, res: Response) => {
    res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}. ${HELP_MESSAGE}` }).end();
});

const input = await processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.info(`Loaded input: ${JSON.stringify(input)} `);

if (STANDBY_MODE) {
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
