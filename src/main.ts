import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Actor } from 'apify';
import type { Request, Response } from 'express';
import express from 'express';

import { getActorsAsTools } from './actorDefinition.js';
import { Routes } from './const.js';
import { processInput } from './input.js';
import { log } from './logger.js';
import { ApifyMcpServer, callActorGetDataset } from './server.js';
import type { Input } from './types.js';

await Actor.init();

const { input } = await processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.info(`Loaded input: ${JSON.stringify(input)} `);

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';
const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL : 'http://localhost';
const POST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_PORT : 3001;

const app = express();

// Set up MCP server with tools
const tools = await getActorsAsTools(input.actorNames);
const mcpServer = new ApifyMcpServer(tools);
let transport: SSEServerTransport;

const HELP_MESSAGE = `Connect to the server with GET request to ${HOST}/sse`
    + ` and then send POST requests to ${HOST}/message.`;

app.route('/')
    .get(async (req: Request, res: Response) => {
        log.info(`Received GET message at: ${req.url}`);
        res.status(200).json({ message: `Actor is using Model Context Protocol. ${HELP_MESSAGE}` }).end();
    })
    .head(async (_req: Request, res: Response) => {
        res.status(200).end();
    });

app.get(Routes.SSE, async (req: Request, res: Response) => {
    log.info(`Received GET message at: ${req.url}`);
    transport = new SSEServerTransport(Routes.MESSAGE, res);
    await mcpServer.connect(transport);
});

app.post(Routes.MESSAGE, async (req: Request, res: Response) => {
    log.info(`Received POST message at: ${req.url}`);
    await transport.handlePostMessage(req, res);
});

// Catch-all for undefined routes
app.use((req: Request, res: Response) => {
    res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}. ${HELP_MESSAGE}` }).end();
});

if (STANDBY_MODE) {
    log.info('Actor is running in the STANDBY mode.');

    app.listen(POST, () => {
        log.info(`The Actor web server is listening for user requests at ${HOST}.`);
    });
} else {
    log.info('Actor is not designed to run in the NORMAL model (use this mode only for debugging purposes)');

    if (input && !input.debugActorName && !input.debugActorInput) {
        await Actor.fail('If you need to debug a specific actor, please provide the debugActorName and debugActorInput fields in the input.');
    }
    await callActorGetDataset(input.debugActorName!, input.debugActorInput!);
    await Actor.exit();
}
