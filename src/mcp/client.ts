import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import log from '@apify/log';

import { REQUEST_ORIGIN, REQUEST_ORIGIN_HEADER } from '../apify_client.js';
import { McpResponseTooLargeError, TimeoutError } from '../errors.js';
import { getHttpStatusCode, sanitizeMezmoMessage } from '../utils/logging.js';
import { ACTORIZED_MCP_CONNECTION_TIMEOUT_MSEC, MAX_ACTOR_MCP_RESPONSE_BYTES } from './const.js';
import { getMCPServerID } from './proxy.js';

export type McpConnectionOptions = { token: string; requestOrigin?: REQUEST_ORIGIN };

/** What one connection reads: `fetch` for its transport, and `signal`, aborted once the bodies pass the limit. */
type ResponseLimit = {
    fetch: (input: Request | URL | string, init?: RequestInit) => Promise<Response>;
    signal: AbortSignal;
};

/**
 * Counts the body bytes of every response on one connection, over both transport attempts, and stops reading at
 * `MAX_ACTOR_MCP_RESPONSE_BYTES`: the body is cancelled and fails with an `McpResponseTooLargeError`, and `signal` is
 * aborted with it.
 */
function createResponseLimit(): ResponseLimit {
    const controller = new AbortController();
    let bytesRead = 0;
    const limitBody = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
        const reader = body.getReader();
        return new ReadableStream({
            async pull(streamController) {
                const { done, value } = await reader.read();
                if (done) {
                    streamController.close();
                    return;
                }
                bytesRead += value.byteLength;
                if (bytesRead <= MAX_ACTOR_MCP_RESPONSE_BYTES) {
                    streamController.enqueue(value);
                    return;
                }
                if (!controller.signal.aborted) controller.abort(new McpResponseTooLargeError());
                streamController.error(controller.signal.reason);
                await reader.cancel(controller.signal.reason);
            },
            async cancel(reason) {
                await reader.cancel(reason);
            },
        });
    };
    return {
        signal: controller.signal,
        fetch: async (input, init) => {
            const response = await fetch(input, init);
            if (!response.body) return response;
            const { status, statusText, headers } = response;
            return new Response(limitBody(response.body), { status, statusText, headers });
        },
    };
}

/**
 * Creates and connects a ModelContextProtocol client.
 * First tries streamable HTTP transport, then falls back to SSE transport.
 */
export async function connectMCPClient(
    url: string,
    options: McpConnectionOptions,
    mcpSessionId?: string,
): Promise<Client | null> {
    const responseLimit = createResponseLimit();
    try {
        return await createMCPStreamableClient(url, options, responseLimit);
    } catch (error) {
        if (error instanceof McpResponseTooLargeError) throw error;
        // If streamable HTTP transport fails on not timeout error, continue with SSE transport
        if (error instanceof TimeoutError) {
            log.warning('Connection to MCP server using streamable HTTP transport timed out', { url, mcpSessionId });
            return null;
        }
        // If streamable HTTP transport fails, fall back to SSE transport
        log.debug('Streamable HTTP transport failed, falling back to SSE transport', {
            url,
            mcpSessionId,
            statusCode: getHttpStatusCode(error),
            errMessage: error instanceof Error ? error.message : String(error),
        });
    }

    try {
        return await createMCPSSEClient(url, options, responseLimit);
    } catch (error) {
        if (error instanceof McpResponseTooLargeError) throw error;
        if (error instanceof TimeoutError) {
            log.warning('Connection to MCP server using SSE transport timed out', { url, mcpSessionId });
            return null;
        }
        // External MCP server unavailability is operational, not a bug.
        // Mezmo (logDNA) promotes log entries to errors when the message contains "error"
        // Sanitize the error message to preserve the soft-fail log level.
        const errMessage = sanitizeMezmoMessage(error instanceof Error ? error.message : String(error));
        log.softFail('MCP server unreachable', {
            url,
            mcpSessionId,
            statusCode: getHttpStatusCode(error),
            errMessage,
        });
        return null;
    }
}

async function withTimeout<T>(millis: number, promise: Promise<T>): Promise<T> {
    let timeoutPid: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutPid = setTimeout(() => reject(new TimeoutError(`Timed out after ${millis} ms.`)), millis);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutPid));
}

async function connectWithTransport(
    url: string,
    transport: SSEClientTransport | StreamableHTTPClientTransport,
    responseLimit: ResponseLimit,
): Promise<Client> {
    const client = new Client({
        name: getMCPServerID(url),
        version: '1.0.0',
    });
    // A response that arrives on an event stream fails only the stream, so the limit's signal fails the request too.
    const request = client.request.bind(client);
    client.request = async (req, resultSchema, options) => {
        const signal = options?.signal ? AbortSignal.any([options.signal, responseLimit.signal]) : responseLimit.signal;
        return await request(req, resultSchema, { ...options, signal });
    };
    await withTimeout(ACTORIZED_MCP_CONNECTION_TIMEOUT_MSEC, client.connect(transport));
    return client;
}

/** Headers on every request to an Actor's MCP server; the request origin is the one the session's API calls carry. */
function buildMCPRequestHeaders({ token, requestOrigin }: McpConnectionOptions): Record<string, string> {
    return { authorization: `Bearer ${token}`, [REQUEST_ORIGIN_HEADER]: requestOrigin ?? REQUEST_ORIGIN.MCP };
}

/**
 * Creates and connects a ModelContextProtocol client using the SSE transport.
 */
async function createMCPSSEClient(
    url: string,
    options: McpConnectionOptions,
    responseLimit: ResponseLimit,
): Promise<Client> {
    const transport = new SSEClientTransport(new URL(url), {
        fetch: responseLimit.fetch,
        requestInit: {
            headers: buildMCPRequestHeaders(options),
        },
        eventSourceInit: {
            // The EventSource package augments EventSourceInit with a "fetch" parameter.
            // You can use this to set additional headers on the outgoing request.
            // Based on this example: https://github.com/modelcontextprotocol/typescript-sdk/issues/118
            async fetch(input: Request | URL | string, init?: RequestInit) {
                const headers = new Headers(init?.headers || {});
                for (const [name, value] of Object.entries(buildMCPRequestHeaders(options))) {
                    headers.set(name, value);
                }
                return responseLimit.fetch(input, { ...init, headers });
            },
            // We have to cast to "any" to use it, since it's non-standard
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    return await connectWithTransport(url, transport, responseLimit);
}

/**
 * Creates and connects a ModelContextProtocol client using the streamable HTTP transport.
 */
async function createMCPStreamableClient(
    url: string,
    options: McpConnectionOptions,
    responseLimit: ResponseLimit,
): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        fetch: responseLimit.fetch,
        requestInit: {
            headers: buildMCPRequestHeaders(options),
        },
    });

    return await connectWithTransport(url, transport, responseLimit);
}
