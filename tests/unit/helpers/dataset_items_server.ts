import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { ApifyClient } from '../../../src/apify_client.js';

/**
 * One response of the dataset items endpoint. `items` is sent as the JSON body with `total` in the
 * pagination header; `body` replaces it as raw text. `reset` breaks the connection before the headers.
 */
export type DatasetItemsServerResponse = {
    status?: number;
    items?: unknown[];
    total?: number;
    body?: string;
    gzip?: boolean;
    reset?: boolean;
};

/**
 * A local stand-in for the Apify API's `GET /v2/datasets/{id}/items`. `serve` registers a sequence of
 * responses for a dataset ID or name, one per request, the last one repeated; any other dataset gets the
 * API's 404 `record-not-found`. `requests` lists the request lines (path and query) and User-Agents sent
 * for a dataset. `client` does not retry; `createClient` takes other options.
 */
export type DatasetItemsServer = {
    client: ApifyClient;
    createClient: (options: { maxRetries?: number; minDelayBetweenRetriesMillis?: number }) => ApifyClient;
    serve: (id: string, responses: DatasetItemsServerResponse[]) => void;
    requests: (id: string) => { line: string; userAgent?: string }[];
    close: () => Promise<void>;
};

export async function startDatasetItemsServer(): Promise<DatasetItemsServer> {
    const routes = new Map<string, DatasetItemsServerResponse[]>();
    const seen = new Map<string, { line: string; userAgent?: string }[]>();
    const server: Server = createServer((req, res) => {
        const line = req.url ?? '';
        const id = /^\/v2\/datasets\/([^/?]+)\/items(?:\?|$)/.exec(line)?.[1];
        const responses = id === undefined ? undefined : routes.get(decodeURIComponent(id));
        if (id === undefined || responses === undefined) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'record-not-found', message: 'Dataset was not found' } }));
            return;
        }
        const key = decodeURIComponent(id);
        const requests = seen.get(key) ?? [];
        requests.push({ line, userAgent: req.headers['user-agent'] });
        seen.set(key, requests);
        const response = responses[Math.min(requests.length - 1, responses.length - 1)];
        if (response.reset) {
            req.socket.destroy();
            return;
        }
        const { status = 200, items = [], total = items.length, gzip = false } = response;
        const body = Buffer.from(response.body ?? JSON.stringify(items));
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'x-apify-pagination-total': String(total),
            ...(gzip && { 'content-encoding': 'gzip' }),
        });
        // The client stops reading at its size limit and closes the connection; that is not an error here.
        res.on('error', () => {});
        res.end(gzip ? gzipSync(body) : body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const createClient = (options: { maxRetries?: number; minDelayBetweenRetriesMillis?: number }) =>
        new ApifyClient({ token: 'test-token', baseUrl, maxRetries: 0, ...options });
    return {
        client: createClient({}),
        createClient,
        serve: (id, responses) => routes.set(id, responses),
        requests: (id) => seen.get(id) ?? [],
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
