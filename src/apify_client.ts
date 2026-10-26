import type { ApifyClientOptions } from 'apify-client';
import { ApifyClient as _ApifyClient } from 'apify-client';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { isAxiosError } from 'axios';

import { API_PUBLIC_BASE_URL, API_PUBLIC_BASE_URL_STAGING, MAX_INLINE_BYTES, STAGING_MCP_HOSTNAME } from './const.js';
import type { PaymentHeaders } from './payments/types.js';

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
            requestInterceptors: [(config) => ({ ...config, headers: { ...config.headers, ...staticHeaders } })],
        });
        this.requestOrigin = staticHeaders[REQUEST_ORIGIN_HEADER];
    }
}

/**
 * Sends one request, with no retries, through apify-client's axios instance, which adds the token and the
 * request-origin and payment headers. Check the URL first, with `isApifyApiUri` (`resources/api_resources.ts`)
 * for the API or against the Actor's standby origin (`tools/actors/send_server_actor_request.ts`), and the
 * status after: a non-2xx response resolves, and so does a 3xx with `maxRedirects: 0`. It skips
 * `httpClient.call()`, which retries (a write could apply twice, and a body over the size cap is downloaded
 * again) and turns a streamed error body into a junk message; that also skips its `HTTPS_PROXY` support and
 * User-Agent. axios aborts a body over `MAX_INLINE_BYTES` mid-stream (checked in axios 1.16.1), so it is
 * never buffered whole.
 */
export async function sendApifyApiRequest(
    apifyClient: ApifyClient,
    config: Pick<
        AxiosRequestConfig,
        'url' | 'method' | 'params' | 'data' | 'headers' | 'responseType' | 'signal' | 'maxRedirects'
    >,
): Promise<AxiosResponse<unknown>> {
    return apifyClient.httpClient.axios.request<unknown>({ ...config, maxContentLength: MAX_INLINE_BYTES });
}

/** The mid-consumption abort axios raises when a body crosses `maxContentLength`. */
export function isMaxContentLengthAbort(err: unknown): boolean {
    return isAxiosError(err) && err.code === 'ERR_BAD_RESPONSE' && err.message.includes('maxContentLength');
}

/**
 * Reads the body of a `responseType: 'stream'` response from `sendApifyApiRequest`; `undefined` when it passed
 * `MAX_INLINE_BYTES`, where axios stopped reading. Any other failure mid-body propagates, so a partial body is
 * never returned.
 */
export async function readBodyUnderCap(response: Pick<AxiosResponse<unknown>, 'data'>): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    try {
        // Chunks are Buffers (`objectMode: false`).
        for await (const chunk of response.data as AsyncIterable<Buffer | string>) {
            chunks.push(Buffer.from(chunk));
        }
    } catch (err) {
        if (isMaxContentLengthAbort(err)) return undefined;
        throw err;
    }
    return Buffer.concat(chunks);
}
