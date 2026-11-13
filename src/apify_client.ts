import type {
    ActorClient,
    ApifyClientOptions,
    BuildClient,
    DatasetClient,
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
import { ApifyClient as _ApifyClient } from 'apify-client';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { isAxiosError } from 'axios';
import { ProxyAgent } from 'proxy-agent';

import { API_PUBLIC_BASE_URL, API_PUBLIC_BASE_URL_STAGING, MAX_INLINE_BYTES, STAGING_MCP_HOSTNAME } from './const.js';
import { InvalidRequestPathError } from './errors.js';
import type { PaymentHeaders } from './payments/types.js';
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

/**
 * How long an idle keep-alive socket stays open. apify-client builds a private agent per `ApifyClient` and
 * keeps a free socket for the whole request timeout (360 s), so a server that constructs a client per session
 * and per tool call accumulates idle TLS sockets for minutes after each call. An in-flight request
 * is unaffected: axios sets `config.timeout` on the active socket, and the agent timeout applies once it is free.
 */
const FREE_SOCKET_TIMEOUT_MILLIS = 15_000;

/**
 * One keep-alive pool for every client in the process, so sockets are reused across instances and closed
 * when idle. A `ProxyAgent`, like apify-client's own, so `HTTPS_PROXY` and `NO_PROXY` keep working.
 */
const sharedAgent = new ProxyAgent({ keepAlive: true, timeout: FREE_SOCKET_TIMEOUT_MILLIS, scheduling: 'lifo' });

/** An absolute URL as written, before a URL parser resolves it: its path, then its query and fragment. */
const RAW_URL_REGEX = /^[a-z][a-z\d+.-]*:\/\/[^/?#\\]*([^?#]*)(.*)$/is;

/**
 * Set on the config by `sendApifyApiRequest`, whose callers pass a URL with its query string in it. Every other request
 * comes from apify-client, which puts the query in `params`, so its URL may hold no `?` or `#`.
 */
const URL_QUERY_ALLOWED_KEY = 'isUrlQueryAllowed';

type InterceptedRequestConfig = { url?: string; baseURL?: string; [URL_QUERY_ALLOWED_KEY]?: boolean };

/** The URL axios sends to: `url`, joined to `baseURL` unless absolute or protocol-relative, as axios joins them. */
function resolveRequestUrl({ url, baseURL }: InterceptedRequestConfig): string | undefined {
    if (url === undefined || !baseURL || /^([a-z][a-z\d+.-]*:)?\/\//i.test(url)) return url;
    return `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/**
 * Throws unless the request goes to the URL as written: an absolute URL whose path a URL parser leaves unchanged (no
 * dot segment, also percent-encoded, no backslash, tab or newline, no character it percent-encodes) and, outside
 * `sendApifyApiRequest`, with no query or fragment. apify-client puts IDs and record keys into the path as given.
 */
function assertRequestUrlAsWritten(config: InterceptedRequestConfig): void {
    const url = resolveRequestUrl(config);
    const match = url !== undefined && URL.canParse(url) ? RAW_URL_REGEX.exec(url) : null;
    if (!url || !match) throw new InvalidRequestPathError(`The request URL ${url} is not a valid absolute URL.`);
    const [, rawPath, queryAndFragment] = match;
    if (queryAndFragment && !config[URL_QUERY_ALLOWED_KEY]) {
        throw new InvalidRequestPathError(
            `The request path ${rawPath}${queryAndFragment} is not valid: a resource ID or record key cannot contain "?" or "#".`,
        );
    }
    if ((rawPath || '/') !== new URL(url).pathname) {
        throw new InvalidRequestPathError(
            `The request path ${rawPath} is not valid: it has a "." or ".." segment, a backslash, or a character a URL path cannot hold unencoded.`,
        );
    }
}

/** `store` with each record method checking its key first; apify-client writes the key unencoded. */
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

type ExtendedApifyClientOptions = Omit<ApifyClientOptions, 'token'> & {
    token?: string | null | undefined;
    /** Payment headers to forward on outbound API requests (from PaymentProvider.getPaymentHeaders) */
    paymentHeaders?: PaymentHeaders;
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

        const { paymentHeaders, requestOrigin, ...clientOptions } = options;
        // Static headers: request origin plus any payment headers from a PaymentProvider.
        const staticHeaders = {
            [REQUEST_ORIGIN_HEADER]: requestOrigin ?? REQUEST_ORIGIN.MCP,
            ...paymentHeaders,
        };

        super({
            // token null case is handled, we can assert type here
            ...(clientOptions as ApifyClientOptions),
            // Explicit baseUrl wins over env default.
            baseUrl: clientOptions.baseUrl ?? getApifyAPIBaseUrl(),
            // Signed storage links (`getRecordPublicUrl`) are handed to clients, so they take the client-facing origin.
            publicBaseUrl: clientOptions.publicBaseUrl ?? getApifyAPIPublicBaseUrl(),
            userAgentSuffix: USER_AGENT_ORIGIN,
            // Per-request agents win over the instance defaults apify-client sets on first use.
            requestInterceptors: [
                (config) => {
                    assertRequestUrlAsWritten(config);
                    return {
                        ...config,
                        httpAgent: sharedAgent,
                        httpsAgent: sharedAgent,
                        headers: { ...config.headers, ...staticHeaders },
                    };
                },
            ],
        });
        this.requestOrigin = staticHeaders[REQUEST_ORIGIN_HEADER];
    }

    // apify-client writes these IDs into the request path unencoded; each is checked once here, for every caller.
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
 * Sends one request, with no retries, through apify-client's axios instance, which adds the token and the
 * request-origin and payment headers. Check the URL first, with `isApifyApiUri` (`resources/api_resources.ts`)
 * for the API or against the Actor's standby origin (`tools/actors/send_server_actor_request.ts`), and the
 * status after: a non-2xx response resolves, and so does a 3xx with `maxRedirects: 0`. It skips
 * `httpClient.call()`, which retries (a write could apply twice, and a body over the size cap is downloaded
 * again) and turns a streamed error body into a junk message; that also skips its User-Agent. axios aborts a
 * body over `MAX_INLINE_BYTES` mid-stream (checked in axios 1.16.1), so it is never buffered whole.
 */
export async function sendApifyApiRequest(
    apifyClient: ApifyClient,
    config: Pick<
        AxiosRequestConfig,
        'url' | 'method' | 'params' | 'data' | 'headers' | 'responseType' | 'signal' | 'maxRedirects'
    >,
): Promise<AxiosResponse<unknown>> {
    return apifyClient.httpClient.axios.request<unknown>({
        ...config,
        maxContentLength: MAX_INLINE_BYTES,
        // Callers pass the query in the URL; checked before the call, see above.
        [URL_QUERY_ALLOWED_KEY]: true,
    } as AxiosRequestConfig);
}

/** The mid-consumption abort axios raises when a body crosses `maxContentLength`. */
export function isMaxContentLengthAbort(err: unknown): boolean {
    return isAxiosError(err) && err.code === 'ERR_BAD_RESPONSE' && err.message.includes('maxContentLength');
}

/**
 * Reads the body of a `responseType: 'stream'` response from `sendApifyApiRequest` up to `MAX_INLINE_BYTES`:
 * `isTruncated` when axios stopped reading there, with the bytes read before it. Any other failure mid-body
 * propagates.
 */
export async function readBodyToCap(
    response: Pick<AxiosResponse<unknown>, 'data'>,
): Promise<{ body: Buffer; isTruncated: boolean }> {
    const chunks: Buffer[] = [];
    let isTruncated = false;
    try {
        // Chunks are Buffers (`objectMode: false`).
        for await (const chunk of response.data as AsyncIterable<Buffer | string>) {
            chunks.push(Buffer.from(chunk));
        }
    } catch (err) {
        if (!isMaxContentLengthAbort(err)) throw err;
        isTruncated = true;
    }
    return { body: Buffer.concat(chunks), isTruncated };
}

/** The whole body, or `undefined` when it passed the cap: a partial body is never returned. */
export async function readBodyUnderCap(response: Pick<AxiosResponse<unknown>, 'data'>): Promise<Buffer | undefined> {
    const { body, isTruncated } = await readBodyToCap(response);
    return isTruncated ? undefined : body;
}
