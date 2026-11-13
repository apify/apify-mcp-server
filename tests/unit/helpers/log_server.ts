import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ApifyClient } from '../../../src/apify_client.js';

/**
 * One response of the log endpoint. `reset` breaks the connection before the headers or after the body;
 * `fillerBytes` streams that many more bytes after `body`, as fast as the client reads them.
 */
export type LogResponse = {
    status?: number;
    body?: string;
    contentType?: string;
    reset?: 'before-headers' | 'mid-body';
    fillerBytes?: number;
};

/**
 * A local stand-in for the Apify API's run and build log endpoints (`/v2/actor-runs/{id}/log`,
 * `/v2/actor-builds/{id}/log`). `serveLog` serves a log under a fresh ID, `serveResponses` a sequence of
 * responses, one per request, the last one repeated. Any other path returns the API's 404 `record-not-found`.
 * `requestCount` counts the requests to an ID, `userAgent` is the last one's User-Agent and `bytesWritten`
 * what its last response wrote. `client` does not retry; `createClient` takes other options.
 */
export type LogServer = {
    client: ApifyClient;
    createClient: (options: { maxRetries?: number; minDelayBetweenRetriesMillis?: number }) => ApifyClient;
    serveLog: (body: string) => string;
    serveResponses: (responses: LogResponse[]) => string;
    requestCount: (id: string) => number;
    userAgent: (id: string) => string | undefined;
    bytesWritten: (id: string) => number;
    close: () => Promise<void>;
};

/** `count` lines, 'line 1' to 'line N', without a final newline. */
export const numberedLog = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

export async function startLogServer(): Promise<LogServer> {
    const routes = new Map<
        string,
        { responses: LogResponse[]; requests: number; userAgent?: string; bytesWritten: number }
    >();
    const server: Server = createServer((req, res) => {
        const id = /^\/v2\/actor-(?:runs|builds)\/([^/?]+)\/log(?:\?|$)/.exec(req.url ?? '')?.[1];
        const route = id === undefined ? undefined : routes.get(id);
        if (route === undefined) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'record-not-found', message: 'Record not found' } }));
            return;
        }
        const {
            status = 200,
            body = '',
            contentType = 'text/plain; charset=utf-8',
            reset,
            fillerBytes = 0,
        } = route.responses[Math.min(route.requests, route.responses.length - 1)];
        route.requests++;
        route.userAgent = req.headers['user-agent'];
        route.bytesWritten = 0;
        if (reset === 'before-headers') {
            req.socket.destroy();
            return;
        }
        res.writeHead(status, { 'content-type': contentType });
        // Resolves once the chunk is handed to the socket, so a client that stops reading stops the writes.
        const write = async (chunk: string | Buffer) =>
            new Promise<boolean>((resolve) => {
                res.write(chunk, (err) => {
                    if (!err) route.bytesWritten += chunk.length;
                    resolve(!err);
                });
            });
        void (async () => {
            let isOpen = body === '' || (await write(body));
            const filler = Buffer.alloc(64 * 1024, 'x');
            for (let sent = 0; isOpen && sent < fillerBytes; sent += filler.length) isOpen = await write(filler);
            if (reset === 'mid-body') res.socket?.destroy();
            else res.end();
        })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const createClient = (options: { maxRetries?: number; minDelayBetweenRetriesMillis?: number }) =>
        new ApifyClient({ token: 'test-token', baseUrl, maxRetries: 0, ...options });
    const serveResponses = (responses: LogResponse[]) => {
        const id = `log${routes.size + 1}`;
        routes.set(id, { responses, requests: 0, bytesWritten: 0 });
        return id;
    };
    return {
        client: createClient({}),
        createClient,
        serveLog: (body) => serveResponses([{ body }]),
        serveResponses,
        requestCount: (id) => routes.get(id)?.requests ?? 0,
        userAgent: (id) => routes.get(id)?.userAgent,
        bytesWritten: (id) => routes.get(id)?.bytesWritten ?? 0,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
