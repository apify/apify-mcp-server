import { AsyncLocalStorage } from 'node:async_hooks';

import type {
    ActorClient,
    ApifyClientOptions,
    ApifyRequestConfig,
    ApifyResponse,
    BuildClient,
    DatasetClient,
    FetchFunction,
    HttpResponseHeaders,
    KeyValueClientGetRecordOptions,
    KeyValueStoreClient,
    LogClient,
    RequestQueueClient,
    RequestQueueUserOptions,
    RunClient,
    ScheduleClient,
    TaskClient,
    UserClient,
    WebhookClient,
    WebhookDispatchClient,
} from 'apify-client';
import { ApifyClient as _ApifyClient, FetchHttpClient } from 'apify-client';
import type { RequestInit as UndiciRequestInit } from 'undici';

import { API_PUBLIC_BASE_URL, API_PUBLIC_BASE_URL_STAGING, MAX_INLINE_BYTES, STAGING_MCP_HOSTNAME } from './const.js';
import { InvalidRequestPathError } from './errors.js';
import { assertValidRecordKey, assertValidResourceId } from './utils/apify_resource_id.js';

// Appended to the client's User-Agent via apify-client's userAgentSuffix option.
const USER_AGENT_ORIGIN = 'Origin/mcp-server';

// Request origin headers
export const REQUEST_ORIGIN_HEADER = 'X-Apify-Request-Origin';

/** Values sent in the X-Apify-Request-Origin header; expected to correspond to `META_ORIGINS` in `@apify/consts` on the backend. */
export const REQUEST_ORIGIN = {
    MCP: 'MCP',
    APIFY_AI: 'APIFY_AI',
} as const;
export type REQUEST_ORIGIN = (typeof REQUEST_ORIGIN)[keyof typeof REQUEST_ORIGIN];

const PROXY_ENV_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];

/** `fetch` narrowed to what this file calls it with: apify-client passes the URL as a string. */
type TransportFetch = (url: string, init: RequestInit) => Promise<Response>;

let proxyFetch: Promise<TransportFetch> | undefined;

/** undici's `fetch` through the proxy the environment names; `NO_PROXY` is honored. One connection pool per process. */
async function loadProxyFetch(): Promise<TransportFetch> {
    const { EnvHttpProxyAgent, fetch: undiciFetch } = await import('undici');
    const dispatcher = new EnvHttpProxyAgent();
    // Cast: `RequestInit` here is undici's too, from the copy of its types that `@types/node` ships.
    return async (url, init) => undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher });
}

/**
 * The `fetch` every client sends through. apify-client v3 does not read `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`
 * on its own, and Node.js reads them only when started with `NODE_USE_ENV_PROXY=1` (22.21 and newer). So when one
 * is set and Node.js is not reading it, requests go through undici with an `EnvHttpProxyAgent`. Otherwise this is
 * the global `fetch`, whose connections are pooled per process and closed a few seconds after they go idle.
 */
const sendThroughTransport: TransportFetch = async (url, init) => {
    const isProxyUnread = process.env.NODE_USE_ENV_PROXY !== '1' && PROXY_ENV_VARS.some((name) => process.env[name]);
    if (!isProxyUnread) return fetch(url, init);
    proxyFetch ??= loadProxyFetch();
    return (await proxyFetch)(url, init);
};

/** An absolute URL as written, before a URL parser resolves it: its path, then its query and fragment. */
const RAW_URL_REGEX = /^[a-z][a-z\d+.-]*:\/\/[^/?#\\]*([^?#]*)(.*)$/is;

/**
 * Throws unless the request goes to the URL as written: an absolute URL whose path a URL parser leaves unchanged (no
 * dot segment, also percent-encoded, no backslash, tab or newline, no character it percent-encodes). apify-client
 * percent-encodes IDs and record keys; a URL passed to `sendApifyApiRequest` is sent as its caller built it.
 */
function assertRequestUrlAsWritten(url: string): void {
    const match = URL.canParse(url) ? RAW_URL_REGEX.exec(url) : null;
    if (!match) throw new InvalidRequestPathError(`The request URL ${url} is not a valid absolute URL.`);
    const [, rawPath] = match;
    if ((rawPath || '/') !== new URL(url).pathname) {
        throw new InvalidRequestPathError(
            `The request path ${rawPath} is not valid: it has a "." or ".." segment, a backslash, or a character a URL path cannot hold unencoded.`,
        );
    }
}

/** `store` with each record method checking its key first, before apify-client percent-encodes it. */
function withRecordKeyChecks(store: KeyValueStoreClient): KeyValueStoreClient {
    const { getRecord, recordExists, setRecord, deleteRecord, getRecordPublicUrl } = store;
    return Object.assign(store, {
        getRecord: async (key: string, options: KeyValueClientGetRecordOptions = {}) =>
            getRecord.call(store, assertValidRecordKey(key), options),
        recordExists: async (key: string) => recordExists.call(store, assertValidRecordKey(key)),
        setRecord: async (...[record, options]: Parameters<KeyValueStoreClient['setRecord']>) =>
            setRecord.call(store, { ...record, key: assertValidRecordKey(record.key) }, options),
        deleteRecord: async (key: string) => deleteRecord.call(store, assertValidRecordKey(key)),
        getRecordPublicUrl: async (key: string) => getRecordPublicUrl.call(store, assertValidRecordKey(key)),
    });
}

/** `run` whose default key-value store checks record keys (`withRecordKeyChecks`). */
function withRunStoreChecks(run: RunClient): RunClient {
    const { keyValueStore } = run;
    return Object.assign(run, { keyValueStore: () => withRecordKeyChecks(keyValueStore.call(run)) });
}

/** `client` whose last run is wrapped by `withRunStoreChecks`. */
function withLastRunStoreChecks<Client extends ActorClient | TaskClient>(client: Client): Client {
    const { lastRun } = client;
    return Object.assign(client, {
        lastRun: (...args: Parameters<Client['lastRun']>) => withRunStoreChecks(lastRun.apply(client, args)),
    });
}

const forwardedHeadersStorage = new AsyncLocalStorage<Record<string, string>>();

/**
 * Runs `fn` so that every Apify API request made from it, including background work it starts, carries `headers`.
 * A host uses it to forward headers that came with the token, such as the Console's admin IP proof.
 * A request the client sends to another origin, such as an Actor's server, does not carry them.
 */
export function runWithForwardedApiHeaders<T>(headers: Record<string, string>, fn: () => T): T {
    return forwardedHeadersStorage.run(headers, fn);
}

/** Set by `sendApifyApiRequest`: the response body of a request made inside it errors once it passes this many bytes. */
const responseCapStorage = new AsyncLocalStorage<number>();

/** Thrown by the body of a `sendApifyApiRequest` response once it passes `MAX_INLINE_BYTES`, after decompression. */
export class ResponseTooLargeError extends Error {
    override readonly name = 'ResponseTooLargeError';

    constructor(
        readonly responseStatus: number,
        readonly responseHeaders: HttpResponseHeaders,
    ) {
        super(`The response body is larger than ${MAX_INLINE_BYTES} bytes.`);
    }
}

/**
 * `response` with a body that yields its first `maxBytes` and then errors with `ResponseTooLargeError`, which
 * also stops the download. A body of exactly `maxBytes` is read whole.
 */
function capResponseBody(response: Response, maxBytes: number): Response {
    if (!response.body) return response;
    const { status, statusText, headers } = response;
    const reader = response.body.getReader();
    let remaining = maxBytes;
    let isOverLimit = false;
    const fail = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
        await reader.cancel();
        controller.error(new ResponseTooLargeError(status, Object.fromEntries(headers)));
    };
    const body = new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                if (isOverLimit) return fail(controller);
                const { done, value } = await reader.read();
                if (done) return controller.close();
                if (value.byteLength <= remaining) {
                    remaining -= value.byteLength;
                    return controller.enqueue(value);
                }
                isOverLimit = true;
                if (remaining === 0) return fail(controller);
                // The stream errors on the next read, so the bytes up to the cap are delivered first.
                return controller.enqueue(value.subarray(0, remaining));
            },
            cancel: async (reason) => reader.cancel(reason),
        },
        // Reads a chunk only once the consumer asks for it, so an error never drops chunks already queued.
        { highWaterMark: 0 },
    );
    return new Response(body, { status, statusText, headers });
}

/**
 * The `fetch` of one client, in place of the request interceptor of apify-client v2. It refuses a URL that is not
 * sent as written, adds the `runWithForwardedApiHeaders` headers to a request to the API origin, and caps the
 * response body of a `sendApifyApiRequest` request.
 */
function buildClientFetch(apiBaseUrl: string): FetchFunction {
    const apiOrigin = new URL(apiBaseUrl).origin;
    return async (url, init) => {
        if (typeof url !== 'string')
            throw new TypeError('The request URL must be a string, as apify-client passes it.');
        assertRequestUrlAsWritten(url);
        const headers = new Headers(init?.headers);
        const forwardedHeaders = new URL(url).origin === apiOrigin ? forwardedHeadersStorage.getStore() : undefined;
        // The request origin is this server's to state, so a forwarded header never replaces it.
        const requestOrigin = headers.get(REQUEST_ORIGIN_HEADER);
        for (const [name, value] of Object.entries(forwardedHeaders ?? {})) headers.set(name, value);
        if (requestOrigin !== null) headers.set(REQUEST_ORIGIN_HEADER, requestOrigin);
        const response = await sendThroughTransport(url, { ...init, headers });
        const maxBytes = responseCapStorage.getStore();
        return maxBytes === undefined ? response : capResponseBody(response, maxBytes);
    };
}

type ExtendedApifyClientOptions = Omit<ApifyClientOptions, 'token'> & {
    token?: string | null | undefined;
    /** Value for the X-Apify-Request-Origin header. Defaults to MCP. */
    requestOrigin?: REQUEST_ORIGIN;
};

export function getApifyAPIBaseUrl(): string {
    // Workaround for Actor server where the platform APIFY_API_BASE_URL did not work with getActorDefinition from actors.ts
    if (process.env.APIFY_IS_AT_HOME) return 'https://api.apify.com';
    return process.env.APIFY_API_BASE_URL || 'https://api.apify.com';
}

/**
 * Apify API origin for every API URL handed to clients. Separate from `getApifyAPIBaseUrl()`, where requests
 * go — the hosted server reaches the API through an internal host clients cannot resolve. Mirrors
 * `getConsoleBaseUrl()` (`utils/console_link.ts`): `APIFY_API_PUBLIC_BASE_URL` when set, the staging API on
 * the staging MCP host, production otherwise.
 */
export function getApifyAPIPublicBaseUrl(): string {
    if (process.env.APIFY_API_PUBLIC_BASE_URL) return process.env.APIFY_API_PUBLIC_BASE_URL;
    return process.env.HOSTNAME === STAGING_MCP_HOSTNAME ? API_PUBLIC_BASE_URL_STAGING : API_PUBLIC_BASE_URL;
}

export class ApifyClient extends _ApifyClient {
    /**
     * Sent in the X-Apify-Request-Origin header; connections to an Actor's MCP server send it too. Always set; optional
     * so a plain apify-client `ApifyClient`, which public methods such as `loadToolsFromInput` accept, stays assignable.
     */
    readonly requestOrigin?: REQUEST_ORIGIN;
    /** Call tracking sent with Store searches. */
    storeSearchTracking?: { traceId?: string; useCase?: string };

    constructor(options: ExtendedApifyClientOptions) {
        /**
         * To publish to DockerHub, we need to run their build task to validate our MCP server.
         * This was failing since we were sending this dummy token to Apify to build the Actor tools.
         * So if we encounter this dummy value, we remove it to use an Apify client as unauthenticated, which is enough
         * for server start and listing of tools.
         */
        if (options.token?.toLowerCase() === 'your-apify-token' || options.token === null) {
            // eslint-disable-next-line no-param-reassign
            delete options.token;
        }

        const { requestOrigin, baseUrl: baseUrlOption, publicBaseUrl, ...httpClientOptions } = options;
        const staticHeaders = {
            [REQUEST_ORIGIN_HEADER]: requestOrigin ?? REQUEST_ORIGIN.MCP,
        };

        // Explicit baseUrl wins over env default.
        const baseUrl = baseUrlOption ?? getApifyAPIBaseUrl();
        // token null case is handled, we can assert type here
        const { token } = httpClientOptions as ApifyClientOptions;

        super({
            ...httpClientOptions,
            token,
            baseUrl,
            // Signed storage links (`getRecordPublicUrl`) are handed to clients, so they take the client-facing origin.
            publicBaseUrl: publicBaseUrl ?? getApifyAPIPublicBaseUrl(),
        });
        // The constructor takes no `fetch`, so the default HTTP client is replaced by one that has it.
        this.httpClient = new FetchHttpClient({
            ...httpClientOptions,
            token,
            headers: { ...httpClientOptions.headers, ...staticHeaders },
            userAgentSuffix: USER_AGENT_ORIGIN,
            fetch: buildClientFetch(baseUrl),
        });
        this.requestOrigin = staticHeaders[REQUEST_ORIGIN_HEADER];
    }

    // Each ID is checked once here, for every caller, before apify-client percent-encodes it into the request path.
    override actor(id: string): ActorClient {
        return withLastRunStoreChecks(super.actor(assertValidResourceId(id, 'Actor')));
    }

    override build(id: string): BuildClient {
        return super.build(assertValidResourceId(id, 'build'));
    }

    override dataset<Data extends Record<string | number, unknown> = Record<string | number, unknown>>(
        id: string,
    ): DatasetClient<Data> {
        return super.dataset<Data>(assertValidResourceId(id, 'dataset'));
    }

    override keyValueStore(id: string): KeyValueStoreClient {
        return withRecordKeyChecks(super.keyValueStore(assertValidResourceId(id, 'key-value store')));
    }

    override log(buildOrRunId: string): LogClient {
        return super.log(assertValidResourceId(buildOrRunId, 'build or run'));
    }

    override requestQueue(id: string, options?: RequestQueueUserOptions): RequestQueueClient {
        return super.requestQueue(assertValidResourceId(id, 'request queue'), options);
    }

    override run(id: string): RunClient {
        return withRunStoreChecks(super.run(assertValidResourceId(id, 'run')));
    }

    override task(id: string): TaskClient {
        return withLastRunStoreChecks(super.task(assertValidResourceId(id, 'task')));
    }

    override schedule(id: string): ScheduleClient {
        return super.schedule(assertValidResourceId(id, 'schedule'));
    }

    override user(id?: string): UserClient {
        return super.user(id === undefined ? id : assertValidResourceId(id, 'user'));
    }

    override webhook(id: string): WebhookClient {
        return super.webhook(assertValidResourceId(id, 'webhook'));
    }

    override webhookDispatch(id: string): WebhookDispatchClient {
        return super.webhookDispatch(assertValidResourceId(id, 'webhook dispatch'));
    }
}

/**
 * Sends one request, with no retries, through apify-client's `httpClient.call()`, which adds the token, the
 * request-origin header and the User-Agent. Check the URL first, with `isApifyApiUri` (`resources/api_resources.ts`)
 * for the API or against the Actor's standby origin (`tools/actors/send_server_actor_request.ts`), and the
 * status after: a non-2xx response resolves, and so does a 3xx with `followRedirects: false`. A write could apply
 * twice if it were retried. The body errors with `ResponseTooLargeError` once it passes `MAX_INLINE_BYTES`, so it
 * is never buffered whole: `call()` rejects with it unless `responseType` is `'stream'`, where reading `data` does.
 */
export async function sendApifyApiRequest<T = unknown>(
    apifyClient: ApifyClient,
    config: Pick<
        ApifyRequestConfig,
        'url' | 'method' | 'params' | 'data' | 'headers' | 'responseType' | 'signal' | 'followRedirects' | 'compression'
    >,
): Promise<ApifyResponse<T>> {
    return responseCapStorage.run(MAX_INLINE_BYTES, async () =>
        apifyClient.httpClient.call<T>({
            ...config,
            // The timeout of apify-client v2, which these requests ran with.
            timeoutSecs: 'long',
            throwOnErrorStatus: false,
            retryStatusCodes: [],
            retryTransportErrors: false,
        }),
    );
}

/**
 * Reads the body of a `responseType: 'stream'` response from `sendApifyApiRequest` up to `MAX_INLINE_BYTES`:
 * `isTruncated` when the body is longer, with its first `MAX_INLINE_BYTES`. Any other failure mid-body
 * propagates.
 */
export async function readBodyToCap(
    response: Pick<ApifyResponse<ReadableStream<Uint8Array>>, 'data'>,
): Promise<{ body: Buffer; isTruncated: boolean }> {
    const chunks: Uint8Array[] = [];
    let isTruncated = false;
    try {
        for await (const chunk of response.data) chunks.push(chunk);
    } catch (err) {
        if (!(err instanceof ResponseTooLargeError)) throw err;
        isTruncated = true;
    }
    return { body: Buffer.concat(chunks), isTruncated };
}

/** The whole body, or `undefined` when it passed the cap: a partial body is never returned. */
export async function readBodyUnderCap(
    response: Pick<ApifyResponse<ReadableStream<Uint8Array>>, 'data'>,
): Promise<Buffer | undefined> {
    const { body, isTruncated } = await readBodyToCap(response);
    return isTruncated ? undefined : body;
}
